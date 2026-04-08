import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL || "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;

const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");
const WEAK_PATH = path.join(__dirname, "weak-query-traces-for-improver.json");
const OUT_PATH = path.join(__dirname, "weak-query-rerun-results-improver.json");

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

async function runDirectStreamingQuery({ apiKey, requestBody, idempotencyKey }) {
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
      ...requestBody,
      stream: true,
    }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(
      `Stream query failed with status ${String(response.status)}: ${payload.slice(0, 400)}`
    );
  }

  const events = parseSseEvents(payload);
  const finalDoneEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "done" &&
        event.result &&
        typeof event.result === "object"
    );

  if (!finalDoneEvent) {
    throw new Error(`Missing done result in stream payload: ${payload.slice(-800)}`);
  }

  return finalDoneEvent.result;
}

const apiKey = (process.env.CONTEXT_API_KEY || "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY (load context-sdk/.env.local or context/.env.local)");
}

const weakRaw = await readFile(WEAK_PATH, "utf8");
const weakEntries = JSON.parse(weakRaw);

const results = [];
for (const entry of weakEntries) {
  const index = entry.index;
  const query = entry.query;
  const idempotencyKey = randomUUID();
  const requestBody = {
    query,
    tools: [TOOL_ID],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    clarificationPolicy: "return",
  };

  try {
    const result = await runDirectStreamingQuery({
      apiKey,
      requestBody,
      idempotencyKey,
    });
    results.push({
      index,
      query,
      responseText:
        typeof result.response === "string" ? result.response : JSON.stringify(result.response),
      developerTrace: result.developerTrace ?? null,
    });
  } catch (error) {
    results.push({
      index,
      query,
      responseText: "",
      developerTrace: {
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

await writeFile(OUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${results.length} reruns to ${OUT_PATH}\n`);
