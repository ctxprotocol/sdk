import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const OUTPUT_PATH = path.resolve(__dirname, "q1-rerun-result.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const QUERY = "On the 'US recession in 2026' market, break down the last 24 hours of trading by size bucket. Are whale trades (>$1000) net buying YES or NO, and does that diverge from what small traders are doing?";

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

console.log("Running Q1 rerun...");
const startMs = Date.now();

const response = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
  method: "POST",
  headers: {
    accept: "text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({
    query: QUERY,
    tools: [TOOL_ID],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    clarificationPolicy: "return",
    stream: true,
  }),
  signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
});

const payload = await response.text();
if (!response.ok) {
  console.error(`Failed: ${response.status} ${payload.slice(0, 400)}`);
  process.exit(1);
}

const events = parseSseEvents(payload);
const doneEvent = [...events].reverse().find(
  (e) => e.type === "done" && e.result && typeof e.result === "object"
);
if (!doneEvent) {
  console.error("No done event");
  process.exit(1);
}

const result = doneEvent.result;
const latencyMs = Date.now() - startMs;

console.log(`Done in ${(latencyMs / 1000).toFixed(1)}s`);
console.log(`OutcomeType: ${result.outcomeType}`);
console.log(`Response preview: ${(result.response || "").slice(0, 500)}`);

await writeFile(OUTPUT_PATH, JSON.stringify({
  query: QUERY,
  responseText: result.response ?? "",
  developerTrace: result.developerTrace ?? null,
  outcomeType: result.outcomeType ?? "unknown",
  latencyMs,
}, null, 2) + "\n", "utf8");
console.log(`Saved to ${OUTPUT_PATH}`);
