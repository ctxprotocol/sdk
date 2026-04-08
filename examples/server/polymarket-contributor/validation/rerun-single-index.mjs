import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 420_000;

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const index = Number.parseInt(process.argv[2] ?? "18", 10);
const full = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const prompt = full[index]?.query;
if (!prompt) throw new Error(`No query at index ${index}`);

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

const idempotencyKey = randomUUID();
const response = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
  method: "POST",
  headers: {
    accept: "text/event-stream",
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
    "Idempotency-Key": idempotencyKey,
  },
  body: JSON.stringify({
    query: prompt,
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
  throw new Error(`Query failed ${response.status}: ${payload.slice(0, 400)}`);
}

const events = parseSseEvents(payload);
const doneEvent = [...events].reverse().find(
  (e) => e.type === "done" && e.result && typeof e.result === "object"
);
if (!doneEvent) {
  throw new Error(`No done event: ${payload.slice(-600)}`);
}

const result = doneEvent.result;
const weakPath = path.join(__dirname, "weak-query-rerun-results.json");
const weak = JSON.parse(readFileSync(weakPath, "utf8"));
weak[String(index)] = {
  query: prompt,
  responseText: result.response ?? "",
  developerTrace: result.developerTrace ?? null,
  outcomeType: result.outcomeType ?? "unknown",
  latencyMs: 0,
};
writeFileSync(weakPath, `${JSON.stringify(weak, null, 2)}\n`);
console.log(`Patched weak-query-rerun-results.json [${index}] outcome=${result.outcomeType}`);
