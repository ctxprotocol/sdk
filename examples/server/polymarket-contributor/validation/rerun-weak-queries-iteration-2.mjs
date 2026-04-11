import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 1;
const WEAK_IDS = ["q1", "q5", "q12", "q13", "q17"];

const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");
const REVIEWER_PATH = path.join(__dirname, "reviewer-evaluation.json");
const WEAK_TRACE_PATH = path.join(
  __dirname,
  "weak-query-traces-for-improver-iteration-2.json"
);
const RESULT_PATH = path.join(
  __dirname,
  "weak-query-rerun-results-iteration-2.json"
);
const TUPLE_PATH = path.join(__dirname, "reviewer-rerun-2-tuples.json");

loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

function tryParseJson(value) {
  try {
    return JSON.parse(value);
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

async function runQuery({ apiKey, query }) {
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
      query,
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
    throw new Error(
      `Query failed with status ${String(response.status)}: ${payload.slice(0, 400)}`
    );
  }

  const events = parseSseEvents(payload);
  const doneEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "done" &&
        event.result &&
        typeof event.result === "object"
    );

  if (!doneEvent) {
    throw new Error(`Missing done result in stream payload: ${payload.slice(-800)}`);
  }

  return doneEvent.result;
}

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY");
}

const reviewer = JSON.parse(await readFile(REVIEWER_PATH, "utf8"));
const weakBaseline = JSON.parse(await readFile(WEAK_TRACE_PATH, "utf8"));

const reviewerById = new Map(
  reviewer.perQueryEvaluations.map((entry, index) => [
    entry.id,
    {
      ...entry,
      index,
    },
  ])
);
const baselineById = new Map(weakBaseline.map((entry) => [entry.id, entry]));

const rerunEntries = [];
for (const id of WEAK_IDS) {
  const reviewerEntry = reviewerById.get(id);
  const baselineEntry = baselineById.get(id);
  if (!reviewerEntry || !baselineEntry) {
    throw new Error(`Missing baseline data for ${id}`);
  }

  const startMs = Date.now();
  let result = null;
  let errorMessage = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      result = await runQuery({ apiKey, query: reviewerEntry.query });
      errorMessage = null;
      break;
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_RETRIES) {
        break;
      }
    }
  }

  rerunEntries.push({
    id,
    index: reviewerEntry.index,
    query: reviewerEntry.query,
    responseText:
      typeof result?.response === "string"
        ? result.response
        : result?.response
          ? JSON.stringify(result.response)
          : "",
    developerTrace: result?.developerTrace ?? (errorMessage ? { error: errorMessage } : null),
    outcomeType: result?.outcomeType ?? (errorMessage ? "error" : "unknown"),
    autoWeak: reviewerEntry.autoWeak ?? false,
    autoWeakReason: reviewerEntry.autoWeakReason ?? null,
    latencyMs: Date.now() - startMs,
    error: errorMessage,
  });
}

const reviewerTuples = rerunEntries.map((entry) => ({
  id: entry.id,
  query: entry.query,
  responseText: entry.responseText,
  freeResponse: baselineById.get(entry.id)?.freeResponse ?? null,
  developerTrace: entry.developerTrace,
  autoWeak: entry.autoWeak,
  autoWeakReason: entry.autoWeakReason,
}));

await writeFile(RESULT_PATH, `${JSON.stringify(rerunEntries, null, 2)}\n`, "utf8");
await writeFile(TUPLE_PATH, `${JSON.stringify(reviewerTuples, null, 2)}\n`, "utf8");

process.stdout.write(
  `Wrote ${String(rerunEntries.length)} reruns to ${RESULT_PATH}\n`
);
process.stdout.write(
  `Wrote ${String(reviewerTuples.length)} reviewer tuples to ${TUPLE_PATH}\n`
);
