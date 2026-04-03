import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ContextClient, ContextError } from "../../../../dist/index.js";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const LOCAL_MCP_URL = "http://localhost:4003/mcp";
const LOCAL_CONTEXT_BASE_URL = "http://localhost:3000";
const PUBLIC_MCP_URL = "https://mcp.ctxprotocol.com/polymarket/mcp";
const CONTEXT_REQUEST_TIMEOUT_MS = 180_000;
const CONTEXT_STREAM_TIMEOUT_MS = 180_000;
const MAX_TRANSIENT_QUERY_RETRIES = 2;
const TRANSIENT_QUERY_RETRY_BASE_DELAY_MS = 1_500;
const PROMPT_POOL_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");
const OUTPUT_DIR = __dirname;

loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

function normalizeEnvString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function assertPresent(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function serializeError(error) {
  if (error instanceof ContextError) {
    return {
      name: error.name,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(typeof error.statusCode === "number"
        ? { statusCode: error.statusCode }
        : {}),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

const TRANSIENT_QUERY_ERROR_PATTERNS = [
  /auth_unavailable/iu,
  /api key authentication is temporarily unavailable/iu,
  /an error occurred while executing a database query/iu,
  /\bquery_failed\b/iu,
  /\betimedout\b/iu,
];

function isTransientQueryFailure(errorLike) {
  const message =
    errorLike && typeof errorLike === "object" && typeof errorLike.message === "string"
      ? errorLike.message
      : "";
  return TRANSIENT_QUERY_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getTransientRetryDelayMs(attempt) {
  return TRANSIENT_QUERY_RETRY_BASE_DELAY_MS * 2 ** attempt;
}

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

function hasConcreteDataSignals(answer) {
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return false;
  }

  return (
    /[$€£]\s?\d/iu.test(answer) ||
    /\b\d+(?:\.\d+)?%/u.test(answer) ||
    /\b\d[\d,]*(?:\.\d+)?\b/u.test(answer) ||
    /\bliquidity\b|\bvolume\b|\bspread\b|\bslippage\b|\bodds\b|\bprobab/iu.test(
      answer
    )
  );
}

function hasDecisionSignal(answer) {
  return /best|worst|rank|prefer|avoid|edge|tradable|liquid|cleanest|passive|conviction|risk\/reward/iu.test(
    answer
  );
}

function looksGeneric(answer) {
  return /cannot access live|can't access live|do not have real-time|i do not have access|it depends without current data/iu.test(
    answer
  );
}

function normalizeIdentifier(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

async function createMcpSession(targetUrl) {
  const response = await fetch(targetUrl, {
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
        clientInfo: {
          name: "polymarket-surface-checks",
          version: "1.0.0",
        },
      },
    }),
  });

  const sessionId = response.headers.get("mcp-session-id");
  const payload = await response.text();
  assertPresent(sessionId, `Missing MCP session id during initialize: ${payload}`);

  await fetch(targetUrl, {
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

async function mcpJsonRpc(targetUrl, sessionId, method, params = {}) {
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    }),
  });

  const text = await response.text();
  const json = extractSseJson(text);
  if (!json) {
    throw new Error(`Could not parse MCP response for ${method}: ${text}`);
  }
  if (json.error) {
    throw new Error(
      typeof json.error.message === "string"
        ? json.error.message
        : `Unknown MCP error for ${method}`
    );
  }
  return json.result;
}

async function listTools(sessionId) {
  const result = await mcpJsonRpc(LOCAL_MCP_URL, sessionId, "tools/list", {});
  return Array.isArray(result.tools) ? result.tools : [];
}

async function callTool(sessionId, name, args) {
  const result = await mcpJsonRpc(LOCAL_MCP_URL, sessionId, "tools/call", {
    name,
    arguments: args,
  });

  return result.structuredContent && typeof result.structuredContent === "object"
    ? result.structuredContent
    : null;
}

async function resolveSampleMarket(sessionId) {
  const topMarkets = await callTool(sessionId, "get_top_markets", {
    sortBy: "recent_activity",
    minLiquidity: 100_000,
    limit: 5,
  });
  const firstMarket = Array.isArray(topMarkets?.markets) ? topMarkets.markets[0] : null;
  if (!firstMarket || typeof firstMarket !== "object") {
    throw new Error("Failed to resolve a live sample market for execute validation.");
  }

  const title =
    typeof firstMarket.title === "string" && firstMarket.title.trim().length > 0
      ? firstMarket.title.trim()
      : "top live polymarket market";
  const slug =
    typeof firstMarket.slug === "string" && firstMarket.slug.trim().length > 0
      ? firstMarket.slug.trim()
      : null;
  const conditionId =
    typeof firstMarket.conditionId === "string" && firstMarket.conditionId.trim().length > 0
      ? firstMarket.conditionId.trim()
      : null;
  if (!slug || !conditionId) {
    throw new Error("Sample market did not include slug and conditionId.");
  }

  const outcomes = await callTool(sessionId, "get_event_outcomes", {
    slug,
    limit: 4,
  });
  const outcomeRows = Array.isArray(outcomes?.outcomes) ? outcomes.outcomes : [];
  const tokenIds = outcomeRows
    .map((row) =>
      row && typeof row === "object" && typeof row.tokenId === "string"
        ? row.tokenId.trim()
        : ""
    )
    .filter((value) => value.length > 0)
    .slice(0, 4);

  if (tokenIds.length === 0) {
    throw new Error("Sample market outcomes did not expose token IDs.");
  }

  return {
    title,
    slug,
    conditionId,
    tokenIds,
    primaryTokenId: tokenIds[0],
  };
}

function summarizeAutoQueryResult(result) {
  const toolsUsed = Array.isArray(result.toolsUsed)
    ? result.toolsUsed.map((tool) => ({
        id: tool.id,
        name: tool.name,
        skillCalls: tool.skillCalls,
      }))
    : [];

  const toolCalls =
    result.developerTrace?.summary?.toolCalls ??
    toolsUsed.reduce((sum, tool) => sum + (tool.skillCalls ?? 0), 0);

  const routedToTarget = toolsUsed.some(
    (tool) =>
      tool.id === TOOL_ID ||
      (typeof tool.name === "string" && /polymarket/iu.test(tool.name))
  );
  const responseText = typeof result.response === "string" ? result.response : "";
  const passed =
    result.outcomeType === "answer" &&
    routedToTarget &&
    toolCalls > 0 &&
    hasConcreteDataSignals(responseText) &&
    !looksGeneric(responseText);

  return {
    status: passed ? "pass" : "fail",
    outcomeType: result.outcomeType,
    toolCalls,
    routedToTarget,
    toolsUsed,
    durationMs: result.durationMs,
    responsePreview: responseText.slice(0, 500),
    hasData: hasConcreteDataSignals(responseText),
    actionable: hasDecisionSignal(responseText),
    looksGeneric: looksGeneric(responseText),
    developerTraceSummary: result.developerTrace?.summary ?? null,
  };
}

function buildExecuteArgs(methodName, sampleMarket) {
  switch (methodName) {
    case "search_and_get_outcomes":
      return { query: sampleMarket.title };
    case "get_event_by_slug":
      return { slug: sampleMarket.slug };
    case "get_prices":
      return { tokenIds: sampleMarket.tokenIds.slice(0, 2) };
    case "get_market_parameters":
      return { tokenId: sampleMarket.primaryTokenId };
    case "get_spreads":
      return { tokenIds: sampleMarket.tokenIds.slice(0, 2) };
    case "get_market_open_interest":
      return { conditionId: sampleMarket.conditionId };
    default:
      return {};
  }
}

function resultMatchesRequiredShape(resultValue, schema) {
  if (!resultValue || typeof resultValue !== "object") {
    return false;
  }

  const requiredKeys = Array.isArray(schema?.required) ? schema.required : [];
  return requiredKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(resultValue, key)
  );
}

async function runAutoQueryChecks(client, promptPool) {
  const selectedPrompts = promptPool
    .filter((prompt) => prompt.showcaseCandidate === true)
    .slice(0, 5);
  const runs = [];

  for (const promptRecord of selectedPrompts) {
    const runNumber = runs.length + 1;
    console.log(`[auto-query ${runNumber}/${selectedPrompts.length}] ${promptRecord.id}`);
    let completed = false;

    for (let attempt = 0; attempt <= MAX_TRANSIENT_QUERY_RETRIES; attempt += 1) {
      try {
        const result = await client.query.run({
          query: promptRecord.prompt,
          queryDepth: "deep",
          responseShape: "answer_with_evidence",
          includeDeveloperTrace: true,
        });
        const summary = summarizeAutoQueryResult(result);

        if (
          summary.outcomeType === "answer" &&
          summary.toolCalls === 0 &&
          attempt < MAX_TRANSIENT_QUERY_RETRIES
        ) {
          const retryDelayMs = getTransientRetryDelayMs(attempt);
          console.log(
            `  answer returned without tool calls; retrying in ${retryDelayMs}ms`
          );
          await sleep(retryDelayMs);
          continue;
        }

        runs.push({
          id: promptRecord.id,
          prompt: promptRecord.prompt,
          retryCount: attempt,
          ...summary,
        });
        const latestRun = runs.at(-1);
        console.log(
          `  status=${latestRun?.status ?? "fail"} outcome=${latestRun?.outcomeType ?? "error"} toolCalls=${latestRun?.toolCalls ?? 0} routed=${latestRun?.routedToTarget === true ? "yes" : "no"} durationMs=${latestRun?.durationMs ?? 0}`
        );
        completed = true;
        break;
      } catch (error) {
        const serialized = serializeError(error);
        const shouldRetry =
          attempt < MAX_TRANSIENT_QUERY_RETRIES && isTransientQueryFailure(serialized);

        if (shouldRetry) {
          const retryDelayMs = getTransientRetryDelayMs(attempt);
          console.log(
            `  transient auto-query failure (${serialized.message}); retrying in ${retryDelayMs}ms`
          );
          await sleep(retryDelayMs);
          continue;
        }

        runs.push({
          id: promptRecord.id,
          prompt: promptRecord.prompt,
          status: "fail",
          error: serialized,
          retryCount: attempt,
        });
        console.log(`  status=fail error=${serialized.message}`);
        completed = true;
        break;
      }
    }

    if (!completed) {
      runs.push({
        id: promptRecord.id,
        prompt: promptRecord.prompt,
        status: "fail",
        error: {
          name: "RetryExhaustedError",
          message: "Auto-query retries exhausted without a terminal result.",
        },
        retryCount: MAX_TRANSIENT_QUERY_RETRIES,
      });
      console.log("  status=fail error=Auto-query retries exhausted without a terminal result.");
    }

    await sleep(400);
  }

  return {
    promptCount: runs.length,
    passedCount: runs.filter((run) => run.status === "pass").length,
    failedCount: runs.filter((run) => run.status !== "pass").length,
    routedCount: runs.filter((run) => run.routedToTarget === true).length,
    runs,
  };
}

async function resolveMarketplaceTool(client) {
  const candidateLists = [
    await client.discovery.search({
      query: "polymarket",
      limit: 10,
      mode: "execute",
      surface: "execute",
      requireExecutePricing: true,
    }),
    await client.discovery.search({
      query: "polymarket",
      limit: 10,
    }),
    await client.discovery.getFeatured(20, {
      mode: "execute",
      requireExecutePricing: true,
    }),
  ];

  for (const candidates of candidateLists) {
    const match = candidates.find((candidate) => candidate.id === TOOL_ID);
    if (match) {
      return match;
    }
  }

  throw new Error(
    `Unable to resolve marketplace tool ${TOOL_ID} from discovery.search().`
  );
}

async function runExecuteValidation(client, sampleMarket) {
  const tool = await resolveMarketplaceTool(client);
  const targetMethods = [
    "search_and_get_outcomes",
    "get_event_by_slug",
    "get_prices",
    "get_market_parameters",
    "get_spreads",
    "get_market_open_interest",
  ];
  const methods = targetMethods
    .map((name) => tool.mcpTools?.find((method) => method.name === name))
    .filter(Boolean);

  const session = await client.tools.startSession({ maxSpendUsd: "1.00" });
  const sessionId = session.session.sessionId;
  assertPresent(sessionId, "Expected execute session ID.");

  const methodRuns = [];

  try {
    for (const method of methods) {
      const args = buildExecuteArgs(method.name, sampleMarket);
      const startedAt = Date.now();
      console.log(`[execute] ${method.name}`);
      try {
        const result = await client.tools.execute({
          toolId: TOOL_ID,
          toolName: method.name,
          args,
          sessionId,
        });
        const durationMs = Date.now() - startedAt;
        methodRuns.push({
          methodName: method.name,
          args,
          status: resultMatchesRequiredShape(result.result, method.outputSchema)
            ? "pass"
            : "fail",
          durationMs,
          executePriceUsd: result.method.executePriceUsd,
          sessionSpentUsd: result.session.spent,
          sessionRemainingUsd: result.session.remaining,
          resultKeys:
            result.result && typeof result.result === "object"
              ? Object.keys(result.result)
              : [],
        });
        const latestRun = methodRuns.at(-1);
        console.log(
          `  status=${latestRun?.status ?? "fail"} durationMs=${latestRun?.durationMs ?? 0} executeUsd=${latestRun?.executePriceUsd ?? "n/a"}`
        );
      } catch (error) {
        methodRuns.push({
          methodName: method.name,
          args,
          status: "fail",
          error: serializeError(error),
        });
        const serialized = serializeError(error);
        console.log(`  status=fail error=${serialized.message}`);
      }

      await sleep(300);
    }
  } finally {
    await client.tools.closeSession(sessionId);
  }

  return {
    discoveredToolName: tool.name,
    discoveredMethodCount: Array.isArray(tool.mcpTools) ? tool.mcpTools.length : 0,
    passedMethodCount: methodRuns.filter((run) => run.status === "pass").length,
    failedMethodCount: methodRuns.filter((run) => run.status !== "pass").length,
    methods: methodRuns,
  };
}

async function runPublicAuthProbe() {
  const initializeResponse = await fetch(PUBLIC_MCP_URL, {
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
        clientInfo: {
          name: "polymarket-public-auth-probe",
          version: "1.0.0",
        },
      },
    }),
  });

  const initializeText = await initializeResponse.text();
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  assertPresent(
    sessionId,
    `Public initialize did not return an MCP session id: ${initializeText.slice(0, 400)}`
  );

  await fetch(PUBLIC_MCP_URL, {
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

  const listResponse = await fetch(PUBLIC_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/list",
      params: {},
    }),
  });
  const listText = await listResponse.text();
  const listJson = extractSseJson(listText);
  const toolCount = Array.isArray(listJson?.result?.tools)
    ? listJson.result.tools.length
    : 0;

  const callResponse = await fetch(PUBLIC_MCP_URL, {
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
      params: {
        name: "search_markets",
        arguments: {
          query: "Trump election",
          status: "live",
          limit: 1,
        },
      },
    }),
  });
  const callText = await callResponse.text();
  const callJson = extractSseJson(callText);
  const rpcAuthBlocked =
    callJson?.error &&
    typeof callJson.error.message === "string" &&
    /auth|unauthorized|forbidden|signature|token/iu.test(callJson.error.message);

  return {
    initializeStatus: initializeResponse.status,
    toolsListStatus: listResponse.status,
    toolsCallStatus: callResponse.status,
    toolCount,
    rpcAuthBlocked,
    pass:
      initializeResponse.ok &&
      listResponse.ok &&
      toolCount > 0 &&
      (callResponse.status === 401 ||
        callResponse.status === 403 ||
        rpcAuthBlocked === true),
  };
}

async function runExternalAccuracyCheck(sessionId) {
  const localRanking = await callTool(sessionId, "get_top_markets", {
    sortBy: "total_volume",
    includeNearResolved: true,
    limit: 5,
  });
  const localMarkets = Array.isArray(localRanking?.markets) ? localRanking.markets : [];

  const upstreamResponse = await fetch(
    "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=5&offset=0&order=volume&ascending=false"
  );
  if (!upstreamResponse.ok) {
    throw new Error(`Upstream Gamma check failed with status ${upstreamResponse.status}`);
  }
  const upstreamEvents = await upstreamResponse.json();
  const upstreamRows = Array.isArray(upstreamEvents) ? upstreamEvents : [];

  const localTop = localMarkets.slice(0, 3).map((market) => ({
    title: typeof market.title === "string" ? market.title : "",
    slug: typeof market.slug === "string" ? market.slug : "",
  }));
  const upstreamTop = upstreamRows.slice(0, 3).map((event) => ({
    title: typeof event?.title === "string" ? event.title : "",
    slug: typeof event?.slug === "string" ? event.slug : "",
  }));

  const upstreamLookup = new Set(
    upstreamTop.flatMap((entry) => [
      normalizeIdentifier(entry.slug),
      normalizeIdentifier(entry.title),
    ])
  );

  const overlap = localTop.filter((entry) => {
    const slugKey = normalizeIdentifier(entry.slug);
    const titleKey = normalizeIdentifier(entry.title);
    return upstreamLookup.has(slugKey) || upstreamLookup.has(titleKey);
  });

  return {
    status: overlap.length >= 2 ? "PASS" : "FAIL",
    overlapTop3: overlap.length,
    localTopMarkets: localTop,
    upstreamTopMarkets: upstreamTop,
    notes:
      overlap.length >= 2
        ? [
            "The contributor's top-volume ranking materially matched the raw Gamma upstream top-three set.",
            "No obvious wrong-universe regression was detected in the fresh external spot check.",
          ]
        : [
            "The contributor's top-volume ranking diverged from the raw Gamma upstream top-three set.",
            "This looks like a potential wrong-universe regression and should be treated as a release blocker.",
          ],
  };
}

async function main() {
  const contextApiKey = normalizeEnvString(process.env.CONTEXT_API_KEY);
  assertPresent(contextApiKey, "Missing CONTEXT_API_KEY in context-sdk/.env.local");

  console.log("Resolving local MCP session and sample market...");
  const promptPool = JSON.parse(await readFile(PROMPT_POOL_PATH, "utf8"));
  const localSessionId = await createMcpSession(LOCAL_MCP_URL);
  const localTools = await listTools(localSessionId);
  const sampleMarket = await resolveSampleMarket(localSessionId);

  const client = new ContextClient({
    apiKey: contextApiKey,
    baseUrl: LOCAL_CONTEXT_BASE_URL,
    requestTimeoutMs: CONTEXT_REQUEST_TIMEOUT_MS,
    streamTimeoutMs: CONTEXT_STREAM_TIMEOUT_MS,
  });

  try {
    console.log("Running marketplace auto-query checks...");
    const autoQuerySummary = await runAutoQueryChecks(client, promptPool);
    console.log(
      `Auto-query complete: ${autoQuerySummary.passedCount}/${autoQuerySummary.promptCount} passed`
    );
    console.log("Running representative execute validation...");
    const executeValidation = await runExecuteValidation(client, sampleMarket);
    console.log(
      `Execute validation complete: ${executeValidation.passedMethodCount}/${executeValidation.methods.length} passed`
    );
    console.log("Running public auth probe...");
    const publicAuthProbe = await runPublicAuthProbe();
    console.log(`Public auth probe complete: ${publicAuthProbe.pass ? "PASS" : "FAIL"}`);
    console.log("Running external accuracy check...");
    const externalAccuracyCheck = await runExternalAccuracyCheck(localSessionId);
    console.log(`External accuracy check complete: ${externalAccuracyCheck.status}`);

    const timestamp = new Date().toISOString().replaceAll(":", "-");
    const latestPath = path.join(OUTPUT_DIR, "marketplace-surface-checks.latest.json");
    const timestampedPath = path.join(
      OUTPUT_DIR,
      `marketplace-surface-checks-${timestamp}.json`
    );

    const output = {
      generatedAt: new Date().toISOString(),
      toolId: TOOL_ID,
      localMcpUrl: LOCAL_MCP_URL,
      localContextBaseUrl: LOCAL_CONTEXT_BASE_URL,
      publicMcpUrl: PUBLIC_MCP_URL,
      localToolCount: localTools.length,
      sampleMarket,
      autoQuerySummary,
      executeValidation,
      publicAuthProbe,
      externalAccuracyCheck,
    };

    await writeFile(latestPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    await writeFile(timestampedPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

    console.log(`Saved ${latestPath}`);
    console.log(`Saved ${timestampedPath}`);
    console.log(
      `Auto query: ${autoQuerySummary.passedCount}/${autoQuerySummary.promptCount} passed`
    );
    console.log(
      `Execute: ${executeValidation.passedMethodCount}/${executeValidation.methods.length} passed`
    );
    console.log(
      `Public auth contract: ${publicAuthProbe.pass ? "PASS" : "FAIL"}`
    );
    console.log(`External accuracy: ${externalAccuracyCheck.status}`);
  } finally {
    client.close();
  }
}

void main().catch((error) => {
  const serialized = serializeError(error);
  console.error(serialized.message);
  process.exitCode = 1;
});
