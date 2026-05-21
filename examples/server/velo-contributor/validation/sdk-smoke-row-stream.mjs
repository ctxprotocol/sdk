import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { ContextClient } from "@ctxprotocol/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "d8e62b2b-d939-42d0-ad18-a0b2bda112ec";
const VELO_MCP_URL = "https://mcp.ctxprotocol.com/velo/mcp";
const OUTPUT_PATH = path.resolve(__dirname, "sdk-smoke-row-stream.latest.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY in context-sdk/.env.local");
}

const client = new ContextClient({
  apiKey,
  requestTimeoutMs: 600_000,
});

const begin = Date.now() - 3 * 365 * 24 * 60 * 60 * 1000;
const end = Date.now();

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSseJson(text) {
  const dataLines = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  if (dataLines.length === 0) {
    return tryParseJson(text);
  }
  return tryParseJson(dataLines.join("\n"));
}

async function createVeloMcpSession() {
  const response = await fetch(VELO_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "velo-sdk-smoke-row-stream", version: "1.0.0" },
      },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(`No MCP session id: ${await response.text()}`);
  }
  await fetch(VELO_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  return sessionId;
}

async function callVeloMcpTool(sessionId, name, args) {
  const response = await fetch(VELO_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  if (response.status === 401) {
    const authError = new Error(
      "Deployed Velo MCP requires Context auth (401). Use query.run assertions as the primary gate."
    );
    authError.code = "VELO_MCP_UNAUTHORIZED";
    throw authError;
  }
  const json = extractSseJson(text);
  if (!json) {
    throw new Error(`Unparseable MCP response for ${name}: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    throw new Error(
      `${name} MCP error: ${json.error.message || JSON.stringify(json.error)}`
    );
  }
  return json.result?.structuredContent ?? null;
}

/** Direct deployed-MCP call — validates contributor coverage without marketplace execute gating. */
async function executeGetMarketRowsViaDirectMcp() {
  const startedAt = Date.now();
  const sessionId = await createVeloMcpSession();
  const structured = await callVeloMcpTool(sessionId, "get_market_rows", {
    type: "futures",
    exchanges: ["binance-futures"],
    products: ["BTCUSDT"],
    columns: ["funding_rate"],
    begin,
    end,
    resolution: "1d",
  });

  return {
    mode: "direct-mcp.get_market_rows",
    durationMs: Date.now() - startedAt,
    rowCount: structured?.rowCount ?? null,
    coverage: structured?.coverage ?? null,
    ok: Boolean(structured?.rowCount),
  };
}

function countGetMarketRowsFromTrace(trace) {
  const timeline = Array.isArray(trace?.timeline) ? trace.timeline : [];
  let count = 0;
  for (const step of timeline) {
    if (step?.stepType !== "tool-call" && step?.event !== "tool-call") {
      continue;
    }
    const toolName = step?.tool?.name ?? step?.toolName ?? step?.name ?? "";
    if (String(toolName).includes("get_market_rows")) {
      count += 1;
    }
  }
  const rawToolCalls = trace?.toolCalls;
  if (Array.isArray(rawToolCalls)) {
    const fromArray = rawToolCalls.filter((call) =>
      String(call.methodName ?? call.toolName ?? call.name ?? "").includes(
        "get_market_rows"
      )
    ).length;
    count = Math.max(count, fromArray);
  }
  return count;
}

async function runPinnedQuery(prompt = REGRESSION_QUERY_PROMPT) {
  const startedAt = Date.now();
  const answer = await client.query.run({
    query: prompt,
    tools: [TOOL_ID],
    queryDepth: "deep",
    includeDeveloperTrace: true,
    includeData: false,
  });

  const trace = answer.developerTrace;
  const rawToolCalls = trace?.summary?.toolCalls;
  const toolCalls = Array.isArray(rawToolCalls)
    ? rawToolCalls
    : Array.isArray(trace?.toolCalls)
      ? trace.toolCalls
      : [];
  const getMarketRowsCallCount = countGetMarketRowsFromTrace(trace);

  const controllerContract = answer.controllerContract ?? null;
  const stopReason =
    answer.stopReason ??
    controllerContract?.outcome?.stopReason ??
    null;

  return {
    mode: "query.run",
    durationMs: Date.now() - startedAt,
    outcomeType: answer.outcomeType,
    stopReason,
    toolsUsed: answer.toolsUsed?.map((tool) => tool.name) ?? [],
    toolCallCount: trace?.summary?.toolCalls ?? toolCalls.length,
    getMarketRowsCallCount,
    responsePreview: (answer.response ?? "").slice(0, 500),
    traceSummary: trace?.summary ?? null,
  };
}

function assertCoverageFix(executeResult) {
  const coverage = executeResult?.coverage;
  if (!coverage || typeof coverage !== "object") {
    return "execute: missing coverage object";
  }
  if (coverage.coverage_status !== "upstream_end_natural") {
    return `execute: expected coverage_status upstream_end_natural, got ${coverage.coverage_status}`;
  }
  if (coverage.likely_truncated === true) {
    return "execute: likely_truncated must be false for upstream_end_natural";
  }
  return null;
}

function assertQueryRegression(queryResult) {
  if (queryResult?.outcomeType !== "answer") {
    return `query: expected outcomeType answer, got ${queryResult?.outcomeType}`;
  }
  const preview = queryResult?.responsePreview ?? "";
  if (!preview.includes("upstream_end_natural")) {
    return "query: response should mention upstream_end_natural coverage";
  }
  const callCount = queryResult?.getMarketRowsCallCount ?? 0;
  const totalToolCalls = queryResult?.toolCallCount ?? 0;
  if (callCount > 2) {
    return `query: expected getMarketRowsCallCount <= 2, got ${callCount}`;
  }
  if (totalToolCalls > 8) {
    return `query: expected trace toolCalls <= 8 (thrash guard), got ${totalToolCalls}`;
  }
  const stopReason = queryResult?.stopReason ?? "";
  if (stopReason === "bounded_same_endpoint_guardrail") {
    return "query: stopReason must not be bounded_same_endpoint_guardrail";
  }
  if (stopReason === "bounded_upstream_abort_guardrail") {
    return "query: stopReason must not be bounded_upstream_abort_guardrail";
  }
  return null;
}

const REGRESSION_QUERY_PROMPT =
  "Plot full available Coinglass and Velo funding-rate history for BTC on binance-futures. Use Velo get_market_rows with daily resolution for the longest window you can return in one call (omit limit). Report coverage_status and do not refetch if upstream_end_natural.";

const assertOnly = process.argv.includes("--assert-only");

let report = {
  testedAt: new Date().toISOString(),
  toolId: TOOL_ID,
  baseUrl: "https://www.ctxprotocol.com",
  endpoint: "https://mcp.ctxprotocol.com/velo/mcp",
  execute: null,
  query: null,
  assertions: [],
  errors: [],
};

if (assertOnly) {
  const prior = JSON.parse(await readFile(OUTPUT_PATH, "utf8"));
  report = {
    ...report,
    testedAt: prior.testedAt ?? report.testedAt,
    execute: prior.execute ?? null,
    query: prior.query ?? null,
    errors: [],
  };
  console.log("assert-only: re-validating", OUTPUT_PATH);
} else {
try {
  report.execute = await executeGetMarketRowsViaDirectMcp();
  console.log("execute", JSON.stringify(report.execute, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (error?.code === "VELO_MCP_UNAUTHORIZED") {
    report.execute = { mode: "direct-mcp.get_market_rows", skipped: true, reason: message };
    console.warn("direct-mcp skipped (auth):", message);
  } else {
    report.errors.push({ stage: "direct-mcp.get_market_rows", message });
    console.error("direct-mcp.get_market_rows failed:", message);
  }
}

const skipQuery = process.env.SMOKE_SKIP_QUERY === "1";
if (!skipQuery) {
  try {
    report.query = await runPinnedQuery();
    console.log("query", JSON.stringify(report.query, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.errors.push({ stage: "query.run", message });
    console.error("query.run failed:", message);
  }
} else {
  report.query = {
    mode: "query.run",
    skipped: true,
    reason: "SMOKE_SKIP_QUERY=1",
  };
}
}

if (report.execute?.skipped) {
  report.assertions.push({
    stage: "direct-mcp.get_market_rows",
    skipped: true,
    reason: report.execute.reason,
  });
} else {
  const executeCoverageFailure = report.execute
    ? assertCoverageFix(report.execute)
    : "direct-mcp: stage did not run";
  if (executeCoverageFailure) {
    report.assertions.push({
      stage: "direct-mcp.get_market_rows",
      failure: executeCoverageFailure,
    });
  } else {
    report.assertions.push({ stage: "direct-mcp.get_market_rows", ok: true });
  }
}

const queryRegressionFailure =
  report.query?.skipped === true
    ? "query: stage skipped (set SMOKE_SKIP_QUERY only for local dev; run full smoke before release)"
    : report.query
      ? assertQueryRegression(report.query)
      : "query: stage did not run";
if (queryRegressionFailure) {
  report.assertions.push({ stage: "query.run", failure: queryRegressionFailure });
} else {
  report.assertions.push({ stage: "query.run", ok: true });
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${OUTPUT_PATH}`);
console.log("assertions", JSON.stringify(report.assertions, null, 2));

const failedAssertions = report.assertions.filter((entry) => entry.failure);
const queryAssertionOk = report.assertions.some(
  (entry) => entry.stage === "query.run" && entry.ok === true
);
const executeCoverageOk = report.assertions.some(
  (entry) => entry.stage === "direct-mcp.get_market_rows" && entry.ok === true
);
if (failedAssertions.length > 0 || report.errors.length > 0 || !queryAssertionOk) {
  process.exitCode = 1;
}
if (!executeCoverageOk && !report.assertions.some((e) => e.stage === "direct-mcp.get_market_rows" && e.skipped)) {
  console.warn("direct-mcp coverage check skipped or failed; query.run is the primary gate.");
}
