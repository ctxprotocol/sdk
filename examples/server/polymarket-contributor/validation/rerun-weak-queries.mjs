import { randomUUID } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";
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
const OUTPUT_PATH = path.resolve(__dirname, "weak-query-rerun-results.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const WEAK_QUERIES = [
  "What's the current liquidity depth on Polymarket's highest-volume political market right now? Simulate exiting a $10,000 YES position and show me the expected slippage versus the current midpoint.",
  "On the most active prediction market about Fed interest rate decisions on Polymarket, what's the whale vs retail trading flow in the last 24 hours? Are big traders and small traders betting the same direction?",
  "Which Polymarket markets have seen the biggest volume spike in the last 6 hours compared to their weekly average? For the top 3, is the move driven by whale buying or retail?",
  "Run a full high-conviction analysis on Polymarket markets related to US recession or economic downturn: combine liquidity, whale flow, efficiency, top holder positioning, and resolution rules into one actionable brief.",
  "For the biggest multi-outcome sports event on Polymarket right now, which specific outcomes are whales betting on? How does their positioning compare to the current odds?",
];

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
    clarificationPolicy: "return",
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
for (let i = 0; i < WEAK_QUERIES.length; i++) {
  const prompt = WEAK_QUERIES[i];
  const label = `[${i + 1}/${WEAK_QUERIES.length}]`;
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
      console.log(`${label} Failed: ${error.message.slice(0, 100)}`);
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
console.log(`\nRerun complete. Results saved to ${OUTPUT_PATH}`);
console.log(`  Total: ${results.length}, Answers: ${results.filter((r) => r.outcomeType === "answer").length}`);
