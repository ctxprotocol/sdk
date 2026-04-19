import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 1;
const OUTPUT_PATH = path.resolve(__dirname, "pipeline-query-results.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const POOL_PATH = path.resolve(__dirname, "prompt-pool.json");
const MUST_WIN_PROMPTS = (() => {
  if (existsSync(POOL_PATH)) {
    const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
    if (Array.isArray(pool.prompts) && pool.prompts.length > 0) {
      return pool.prompts;
    }
  }
  return [
    "What's the current liquidity depth on Polymarket's top political market? If I wanted to exit a $10,000 YES position, how much slippage would I face?",
    "Are there any verified arbitrage opportunities on Polymarket right now where buying both YES and NO on the same market costs less than $1? Show me the markets with the best edge.",
  ];
})();

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function parseSseEvents(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) =>
      chunk
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => tryParseJson(data))
    .filter((event) => event && typeof event === "object");
}

async function runQuery(prompt) {
  const idempotencyKey = randomUUID();
  const requestBody = {
    query: prompt,
    tools: [TOOL_ID],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    clarificationPolicy: "auto",
    stream: true,
  };

  const response = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`Query failed with status ${response.status}: ${payload.slice(0, 400)}`);
  }

  const events = parseSseEvents(payload);
  const doneEvent = [...events].reverse().find(
    (e) => e.type === "done" && e.result && typeof e.result === "object"
  );
  if (!doneEvent) throw new Error(`No done event in response: ${payload.slice(-500)}`);
  return doneEvent.result;
}

const results = [];
for (let i = 0; i < MUST_WIN_PROMPTS.length; i++) {
  const prompt = MUST_WIN_PROMPTS[i];
  const label = `[${i + 1}/${MUST_WIN_PROMPTS.length}]`;
  console.log(`${label} Running: ${prompt.slice(0, 80)}...`);
  const startMs = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runQuery(prompt);
      const latencyMs = Date.now() - startMs;
      console.log(`${label} Done in ${(latencyMs / 1000).toFixed(1)}s — outcomeType: ${result.outcomeType ?? "unknown"}`);

      results.push({
        query: prompt,
        responseText: result.response ?? "",
        developerTrace: result.developerTrace ?? null,
        outcomeType: result.outcomeType ?? "unknown",
        latencyMs,
        toolsUsed: result.toolsUsed ?? [],
      });
      break;
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      if (attempt < MAX_RETRIES) {
        console.log(`${label} Error (retrying): ${error.message.slice(0, 100)}`);
        await sleep(2000);
        continue;
      }
      console.log(`${label} Failed after retries: ${error.message.slice(0, 100)}`);
      results.push({
        query: prompt,
        responseText: "",
        developerTrace: null,
        outcomeType: "error",
        latencyMs,
        error: error.message.slice(0, 500),
      });
    }
  }
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(`\nAll queries complete. Results saved to ${OUTPUT_PATH}`);
console.log(`  Total: ${results.length}, Answers: ${results.filter((r) => r.outcomeType === "answer").length}, Errors: ${results.filter((r) => r.outcomeType === "error").length}`);
