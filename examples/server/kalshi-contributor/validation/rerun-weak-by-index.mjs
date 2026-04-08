import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "5cc326fb-500d-4c17-bc5f-ade143210636";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 1;

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY");
}

const reviewerPath = path.join(__dirname, "reviewer-evaluation.json");
const reviewer = JSON.parse(readFileSync(reviewerPath, "utf8"));
const indices = reviewer.perQueryEvaluations
  .map((entry, index) => (entry.satisfactionMean < 4 ? index : -1))
  .filter((index) => index >= 0);

if (indices.length === 0) {
  throw new Error("No weak queries found in reviewer-evaluation.json");
}

const pipelinePath = path.join(__dirname, "pipeline-query-results.json");
const pipelineResults = JSON.parse(readFileSync(pipelinePath, "utf8"));

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

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Missing response body reader");
  }

  const decoder = new TextDecoder();
  let payload = "";
  let buffered = "";
  let doneResult = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = decoder.decode(value, { stream: true });
    payload += chunk;
    buffered += chunk;

    const parts = buffered.split(/\r?\n\r?\n/u);
    buffered = parts.pop() ?? "";

    for (const part of parts) {
      const events = parseSseEvents(part);
      const doneEvent = events.find(
        (event) => event.type === "done" && event.result && typeof event.result === "object"
      );
      if (doneEvent) {
        doneResult = doneEvent.result;
        await reader.cancel();
        break;
      }
    }

    if (doneResult) {
      break;
    }
  }

  if (!response.ok) {
    throw new Error(`Query failed with status ${response.status}: ${payload.slice(0, 400)}`);
  }

  if (!doneResult) {
    throw new Error(`No done event in response: ${payload.slice(-500)}`);
  }

  return doneResult;
}

const results = [];
for (const index of indices) {
  const prompt = pipelineResults[index]?.query;
  if (!prompt) {
    throw new Error(`Missing query at index ${index}`);
  }

  const startMs = Date.now();
  console.log(`[weak ${index}] ${prompt.slice(0, 100)}...`);
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const result = await runQuery(prompt);
      results.push({
        index,
        promptId: reviewer.perQueryEvaluations[index]?.promptId ?? null,
        query: prompt,
        responseText: result.response ?? "",
        developerTrace: result.developerTrace ?? null,
        outcomeType: result.outcomeType ?? "unknown",
        latencyMs: Date.now() - startMs,
      });
      console.log(
        `[weak ${index}] done in ${((Date.now() - startMs) / 1000).toFixed(1)}s`
      );
      break;
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        console.log(
          `[weak ${index}] retry after error: ${
            error instanceof Error ? error.message.slice(0, 160) : String(error)
          }`
        );
        await sleep(2000);
        continue;
      }

      results.push({
        index,
        promptId: reviewer.perQueryEvaluations[index]?.promptId ?? null,
        query: prompt,
        responseText: "",
        developerTrace: null,
        outcomeType: "error",
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startMs,
      });
      console.log(
        `[weak ${index}] failed in ${((Date.now() - startMs) / 1000).toFixed(1)}s`
      );
    }
  }

  await writeFile(
    path.join(__dirname, "weak-query-rerun-results.json"),
    `${JSON.stringify(results, null, 2)}\n`
  );
  await sleep(800);
}

process.stdout.write(
  `${JSON.stringify(
    {
      rerunCount: results.length,
      outputPath: path.join(__dirname, "weak-query-rerun-results.json"),
    },
    null,
    2
  )}\n`
);
