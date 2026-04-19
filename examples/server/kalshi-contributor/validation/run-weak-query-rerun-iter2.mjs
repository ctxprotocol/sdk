#!/usr/bin/env node

/**
 * Re-run the 9 weak queries from iteration 1 against localhost:3000 with
 * includeDeveloperTrace: true. Writes weak-query-rerun-iter2.json for the
 * pipeline-reviewer. Iteration 2 ablation: recoveryHints on empty/weak
 * discovery responses + fanoutHint on get_event/get_event_by_slug.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = Number.parseInt(
  process.env.KALSHI_QUERY_TIMEOUT_MS ?? "300000",
  10
);
const MAX_TRANSIENT_RETRIES = 1;

const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(
  __dirname,
  "../../../../../context/.env.local"
);
loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

const POOL_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const OUTPUT_PATH = path.resolve(__dirname, "weak-query-rerun-iter2.json");

// From release-decision.json weakQueries.entries (post-iter1) — 9 prompts.
const WEAK_PROMPT_IDS = [
  "kalshi-001",
  "kalshi-005",
  "kalshi-008",
  "kalshi-010",
  "kalshi-011",
  "kalshi-013",
  "kalshi-014",
  "kalshi-016",
  "kalshi-018",
];

function normalizeEnvString(value) {
  return typeof value === "string" ? value.trim() : "";
}

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

async function runStreamingQuery({ apiKey, requestBody, idempotencyKey }) {
  const response = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ ...requestBody, stream: true }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${payload.slice(0, 500)}`);
  }
  const events = parseSseEvents(payload);
  const finalDone = [...events]
    .reverse()
    .find(
      (ev) => ev.type === "done" && ev.result && typeof ev.result === "object"
    );
  if (!finalDone) {
    throw new Error(`Missing done event: ${payload.slice(-500)}`);
  }
  return finalDone.result;
}

async function runOne({ promptId, query, toolId, apiKey }) {
  const startedAt = new Date().toISOString();
  const requestBody = {
    query,
    tools: [toolId],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    clarificationPolicy: "return",
  };
  let lastError = null;
  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      const idempotencyKey = randomUUID();
      const result = await runStreamingQuery({
        apiKey,
        requestBody,
        idempotencyKey,
      });
      const developerTrace = result.developerTrace ?? null;
      const summary = developerTrace?.summary ?? {};
      const toolCalls = summary.toolCalls ?? 0;
      const outcomeType = result.outcomeType ?? "answer";
      const responseText = result.response ?? "";
      return {
        promptId,
        query,
        response: responseText,
        outcomeType,
        toolCalls,
        developerTrace,
        startedAt,
        completedAt: new Date().toISOString(),
        attempt,
        error: null,
      };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_TRANSIENT_RETRIES) {
        await sleep(2000);
      }
    }
  }
  return {
    promptId,
    query,
    response: "",
    outcomeType: "error",
    toolCalls: 0,
    developerTrace: null,
    startedAt,
    completedAt: new Date().toISOString(),
    error: {
      name: lastError?.name ?? "Error",
      message: lastError?.message ?? String(lastError),
    },
  };
}

async function main() {
  const apiKey = normalizeEnvString(process.env.CONTEXT_API_KEY);
  if (!apiKey) {
    throw new Error("Missing CONTEXT_API_KEY");
  }
  const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
  const toolId = pool.toolId;
  const byId = new Map(pool.prompts.map((p) => [p.id, p]));
  const targets = WEAK_PROMPT_IDS.map((id) => {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`Missing prompt ${id} in pool`);
    }
    return { id, query: entry.prompt };
  });

  console.log(
    `[rerun-iter2] running ${targets.length} weak queries against ${CONTEXT_BASE_URL} (toolId=${toolId})`
  );
  const results = [];
  const startedAll = Date.now();
  for (let i = 0; i < targets.length; i += 1) {
    const { id, query } = targets[i];
    const t0 = Date.now();
    console.log(`[${i + 1}/${targets.length}] ${id} :: ${query.slice(0, 80)}...`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOne({ promptId: id, query, toolId, apiKey });
    const ms = Date.now() - t0;
    console.log(
      `[${i + 1}/${targets.length}] ${id} done in ${(ms / 1000).toFixed(1)}s toolCalls=${result.toolCalls} outcome=${result.outcomeType}${
        result.error ? ` error=${result.error.message.slice(0, 120)}` : ""
      }`
    );
    results.push(result);
    // eslint-disable-next-line no-await-in-loop
    await writeFile(
      OUTPUT_PATH,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          contextBaseUrl: CONTEXT_BASE_URL,
          toolId,
          iteration: 2,
          fixedRootCauseCategory: "iterative_recovery_failure",
          results,
          progress: { completed: i + 1, total: targets.length },
        },
        null,
        2
      ),
      "utf8"
    );
  }
  const totalMs = Date.now() - startedAll;
  console.log(`[rerun-iter2] complete in ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`[rerun-iter2] wrote ${OUTPUT_PATH}`);
  const zeroToolCalls = results.filter((r) => r.toolCalls === 0).length;
  console.log(
    `[rerun-iter2] zero-toolCall count: ${zeroToolCalls} / ${results.length}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
