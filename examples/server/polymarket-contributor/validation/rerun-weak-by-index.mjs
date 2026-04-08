import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const reviewerPath = path.join(__dirname, "reviewer-evaluation.json");
const reviewer = JSON.parse(readFileSync(reviewerPath, "utf8"));
const FIXABLE_ROOT_CAUSES = new Set([
  "synthesis_issue",
  "code_generation_error",
  "contributor_tool_schema_gap",
  "contributor_tool_bug",
  "tool_selection_error",
]);
const INDICES = reviewer.perQueryEvaluations
  .map((entry, index) =>
    entry.satisfactionMean < 4 &&
    FIXABLE_ROOT_CAUSES.has(entry.traceAssessment?.rootCauseCategory)
      ? index
      : -1
  )
  .filter((index) => index >= 0);
if (INDICES.length === 0) {
  throw new Error("No fixable weak queries found in reviewer-evaluation.json");
}
console.log(`Fixable weak indices (${INDICES.length}): ${INDICES.join(", ")}`);

const pipelinePath = path.join(__dirname, "pipeline-query-results.json");
const full = JSON.parse(readFileSync(pipelinePath, "utf8"));

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
for (const i of INDICES) {
  const prompt = full[i]?.query;
  if (!prompt) throw new Error(`Missing query at index ${i}`);
  const label = `[weak ${i}]`;
  console.log(`${label} Running: ${prompt.slice(0, 72)}...`);
  const startMs = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runQuery(prompt);
      const latencyMs = Date.now() - startMs;
      console.log(`${label} Done in ${(latencyMs / 1000).toFixed(1)}s`);
      results.push({
        index: i,
        query: prompt,
        responseText: result.response ?? "",
        developerTrace: result.developerTrace ?? null,
        outcomeType: result.outcomeType ?? "unknown",
        latencyMs,
      });
      break;
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.log(`${label} retry: ${error.message.slice(0, 120)}`);
        await sleep(2000);
        continue;
      }
      results.push({
        index: i,
        query: prompt,
        responseText: "",
        developerTrace: null,
        outcomeType: "error",
        error: error.message,
        latencyMs: Date.now() - startMs,
      });
    }
  }
  await sleep(800);
}

await writeFile(
  path.join(__dirname, "weak-query-rerun-results.json"),
  `${JSON.stringify(results, null, 2)}\n`
);
console.log("Wrote weak-query-rerun-results.json");
