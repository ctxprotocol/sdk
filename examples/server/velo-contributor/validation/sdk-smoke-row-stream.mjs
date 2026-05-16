import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { ContextClient } from "@ctxprotocol/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "d8e62b2b-d939-42d0-ad18-a0b2bda112ec";
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

async function executeGetMarketRows() {
  const startedAt = Date.now();
  const result = await client.tools.execute({
    toolId: TOOL_ID,
    toolName: "get_market_rows",
    args: {
      type: "futures",
      exchanges: ["binance-futures"],
      products: ["BTCUSDT"],
      columns: ["close_price"],
      begin,
      end,
      resolution: "1d",
    },
  });

  const payload = result.result;
  const structured =
    payload && typeof payload === "object" && "structuredContent" in payload
      ? payload.structuredContent
      : payload;

  return {
    mode: "tools.execute",
    durationMs: Date.now() - startedAt,
    rowCount: structured?.rowCount ?? null,
    coverage: structured?.coverage ?? null,
    ok: Boolean(structured?.rowCount),
  };
}

async function runPinnedQuery() {
  const prompt =
    "For binance-futures BTCUSDT, use Velo get_market_rows with daily resolution for the past 3 years (omit limit). Report rowCount and coverage.stream_completed / coverage.stop_reason from the tool output.";
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
  const getMarketRowsCalls = toolCalls.filter((call) =>
    String(call.toolName ?? call.name ?? "").includes("get_market_rows")
  );

  return {
    mode: "query.run",
    durationMs: Date.now() - startedAt,
    outcomeType: answer.outcomeType,
    toolsUsed: answer.toolsUsed?.map((tool) => tool.name) ?? [],
    toolCallCount: toolCalls.length,
    getMarketRowsCallCount: getMarketRowsCalls.length,
    responsePreview: (answer.response ?? "").slice(0, 500),
    traceSummary: trace?.summary ?? null,
  };
}

const report = {
  testedAt: new Date().toISOString(),
  toolId: TOOL_ID,
  baseUrl: "https://www.ctxprotocol.com",
  endpoint: "https://mcp.ctxprotocol.com/velo/mcp",
  execute: null,
  query: null,
  errors: [],
};

try {
  report.execute = await executeGetMarketRows();
  console.log("execute", JSON.stringify(report.execute, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.errors.push({ stage: "tools.execute", message });
  console.error("tools.execute failed:", message);
}

try {
  report.query = await runPinnedQuery();
  console.log("query", JSON.stringify(report.query, null, 2));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.errors.push({ stage: "query.run", message });
  console.error("query.run failed:", message);
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Wrote ${OUTPUT_PATH}`);

const executeOk =
  report.execute?.rowCount != null && report.execute.rowCount > 1000;
const queryOk =
  report.query?.outcomeType === "answer" && (report.query?.getMarketRowsCallCount ?? 0) > 0;

if (!executeOk && !queryOk && report.errors.length > 0) {
  process.exitCode = 1;
}
