#!/usr/bin/env node

/**
 * Paid Context /api/v1/query + free Gemini (OpenRouter) for Hyperliquid contributor.
 * Writes full-enhancement-results.latest.json for pipeline-release-decision.mjs.
 * Skips local MCP direct answerability (optional); uses neutral answerability notes.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FREE_MODEL_ID = "google/gemini-3-flash-preview";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const HYPERLIQUID_MCP_HEALTH_URL =
  (process.env.HYPERLIQUID_MCP_HEALTH_URL ?? "").trim() || "http://localhost:4002/health";
const WALL_TIMEOUT_MS = Number.parseInt(process.env.HYPERLIQUID_QUERY_TIMEOUT_MS ?? "240000", 10);
const MAX_TRANSIENT_QUERY_RETRIES = 2;
const TRANSIENT_QUERY_RETRY_BASE_DELAY_MS = 1_500;
const MAX_PROMPTS = Number.parseInt(process.env.HYPERLIQUID_MAX_PROMPTS ?? "0", 10);
const MERGE_EXISTING = (process.env.HYPERLIQUID_MERGE ?? "").trim() === "1";
const PROMPT_IDS = new Set(
  (process.env.HYPERLIQUID_PROMPT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
);

const POOL_JSON_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const SNAPSHOT_PATH = path.resolve(__dirname, "live-market-snapshot.json");
const OUTPUT_DIR = __dirname;
const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");

function loadEnvFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) {
        continue;
      }
      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 0) {
        continue;
      }
      const key = trimmed.slice(0, separatorIndex).trim();
      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Optional local env file.
  }
}

loadEnvFile(SDK_ENV_PATH);
loadEnvFile(CONTEXT_ENV_PATH);

const CROSS_VENUE_IDS = new Set();

function normalizeEnvString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
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
    body: JSON.stringify({ ...requestBody, stream: true }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(`Stream query failed with status ${String(response.status)}: ${payload.slice(0, 500)}`);
  }

  const events = parseSseEvents(payload);
  const finalDoneEvent = [...events]
    .reverse()
    .find(
      (event) => event.type === "done" && event.result && typeof event.result === "object"
    );

  if (!finalDoneEvent) {
    throw new Error(`Missing done result in stream: ${payload.slice(-800)}`);
  }

  return finalDoneEvent.result;
}

function hasConcreteDataSignals(answer) {
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return false;
  }
  return (
    /[$€£]\s?\d/iu.test(answer) ||
    /\b\d+(?:\.\d+)?%/u.test(answer) ||
    /\b\d[\d,]*(?:\.\d+)?\b/u.test(answer) ||
    /\bliquidity\b|\bvolume\b|\bspread\b|\bprobab|\bticker\b|\bhyperliquid\b/iu.test(answer)
  );
}

function hasCurrentFreshnessCue(answer) {
  return /right now|currently|as of|live|today|current|latest|recent/iu.test(answer);
}

function hasDecisionSignal(answer) {
  return /best|worst|rank|prefer|avoid|edge|tradable|liquid|conviction|risk\/reward/iu.test(answer);
}

function looksGeneric(answer) {
  return /cannot access live|can't access live|do not have real-time|i do not have access|unable to access/iu.test(
    answer
  );
}

function serializeError(error) {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: "UnknownError", message: String(error) };
}

async function assertContributorHealthy() {
  const response = await fetch(HYPERLIQUID_MCP_HEALTH_URL, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(
      `Hyperliquid contributor health check failed: ${HYPERLIQUID_MCP_HEALTH_URL} returned HTTP ${response.status}`
    );
  }
}

const TRANSIENT_QUERY_ERROR_PATTERNS = [
  /auth_unavailable/iu,
  /503/iu,
  /query_failed/iu,
  /\betimedout\b/iu,
];

function isTransientQueryFailure(errorLike) {
  const message =
    errorLike && typeof errorLike === "object" && typeof errorLike.message === "string"
      ? errorLike.message
      : "";
  return TRANSIENT_QUERY_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getTransientRetryDelayMs(attempt) {
  return TRANSIENT_QUERY_RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function extractOpenRouterText(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if (typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

async function runFreeBaseline(prompt, openRouterKey) {
  const request = {
    model: FREE_MODEL_ID,
    messages: [{ role: "user", content: prompt }],
  };
  const startedAt = new Date().toISOString();
  const start = Date.now();
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": CONTEXT_BASE_URL,
        "X-Title": "Hyperliquid pipeline evaluation",
      },
      body: JSON.stringify(request),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${await response.text()}`);
    }
    const json = await response.json();
    const answer = extractOpenRouterText(json.choices?.[0]?.message?.content);
    return {
      evaluation: {
        answer,
        latencyMs,
        hasData: hasConcreteDataSignals(answer),
        fresh: !looksGeneric(answer) && hasCurrentFreshnessCue(answer),
        actionable: hasDecisionSignal(answer),
      },
      raw: { startedAt, latencyMs, request, response: json },
    };
  } catch (error) {
    return {
      evaluation: {
        answer: "",
        latencyMs: Date.now() - start,
        hasData: false,
        fresh: false,
        actionable: false,
        error: serializeError(error),
      },
      raw: { startedAt, latencyMs: Date.now() - start, request, error: serializeError(error) },
    };
  }
}

function classifyDifferentiation(freeEvaluation, paidEvaluation) {
  if (paidEvaluation.outcomeType !== "answer" || paidEvaluation.toolCalls === 0) {
    return "low_differentiation";
  }
  if (
    freeEvaluation.error ||
    !freeEvaluation.hasData ||
    !freeEvaluation.fresh ||
    looksGeneric(freeEvaluation.answer)
  ) {
    return "high_differentiation";
  }
  if (
    paidEvaluation.qualityScore >= 4 &&
    (!freeEvaluation.actionable || !hasDecisionSignal(freeEvaluation.answer))
  ) {
    return "moderate_differentiation";
  }
  if (
    paidEvaluation.qualityScore > 0 &&
    paidEvaluation.qualityScore > (freeEvaluation.hasData ? 2 : 1)
  ) {
    return "moderate_differentiation";
  }
  return "low_differentiation";
}

function determinePromptStatus(paidEvaluation) {
  return (
    paidEvaluation.outcomeType === "answer" &&
    paidEvaluation.toolCalls > 0 &&
    paidEvaluation.qualityScore >= 4 &&
    paidEvaluation.looksGeneric !== true
  );
}

function summarizeRuns(promptRuns) {
  const total = promptRuns.length;
  const passed = promptRuns.filter((run) => run.status === "pass").length;
  const mustWinRuns = promptRuns.filter((run) => run.mustWin);
  const mustWinPassed = mustWinRuns.filter((run) => run.status === "pass").length;
  const differentiationCounts = {
    high: promptRuns.filter((run) => run.differentiation === "high_differentiation").length,
    moderate: promptRuns.filter((run) => run.differentiation === "moderate_differentiation").length,
    low: promptRuns.filter((run) => run.differentiation === "low_differentiation").length,
  };
  return {
    totalPrompts: total,
    passedPrompts: passed,
    passRate: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    mustWinPromptCount: mustWinRuns.length,
    mustWinPassedPrompts: mustWinPassed,
    mustWinPassRate:
      mustWinRuns.length === 0 ? 0 : Number((mustWinPassed / mustWinRuns.length).toFixed(4)),
    differentiationCounts,
    baselineBeatenRate:
      mustWinRuns.length === 0
        ? 0
        : Number(
            (
              mustWinRuns.filter((run) => run.differentiation !== "low_differentiation").length /
              mustWinRuns.length
            ).toFixed(4)
          ),
  };
}

async function runPaidPrompt(prompt, apiKey, toolId) {
  const startedAt = new Date().toISOString();
  const transport = "stream";
  const queryOptions = {
    query: prompt,
    tools: [toolId],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    // Production SDK surface defaults to "auto" — match that here so the
    // full-enhancement gate sees the same behavior a live buyer/agent sees.
    // "return" was making this harness fail the same prompts the live
    // librarian would have auto-resolved, producing a false blocker signal.
    clarificationPolicy: "auto",
    idempotencyKey: randomUUID(),
  };
  const requestBody = {
    query: queryOptions.query,
    tools: queryOptions.tools,
    responseShape: queryOptions.responseShape,
    queryDepth: queryOptions.queryDepth,
    includeDeveloperTrace: queryOptions.includeDeveloperTrace,
    clarificationPolicy: queryOptions.clarificationPolicy,
    stream: true,
  };

  for (let attempt = 0; attempt <= MAX_TRANSIENT_QUERY_RETRIES; attempt += 1) {
    try {
      const result = await runDirectStreamingQuery({
        apiKey,
        requestBody,
        idempotencyKey: queryOptions.idempotencyKey,
      });
      const answer = result.response ?? "";
      const toolsUsed = Array.isArray(result.toolsUsed)
        ? result.toolsUsed.map((tool) => ({
            id: tool.id,
            name: tool.name,
            skillCalls: tool.skillCalls,
          }))
        : [];
      const toolCalls =
        result.developerTrace?.summary?.toolCalls ??
        toolsUsed.reduce((sum, tool) => sum + (tool.skillCalls ?? 0), 0);
      const outcomeType = result.outcomeType ?? "answer";
      const qualityScore = Math.max(
        0,
        Math.min(
          5,
          (outcomeType === "answer" ? 2 : 0) +
            (toolCalls > 0 ? 1 : 0) +
            (hasConcreteDataSignals(answer) ? 1 : 0) +
            (hasDecisionSignal(answer) ? 1 : 0) +
            (hasCurrentFreshnessCue(answer) ? 1 : 0) -
            (looksGeneric(answer) ? 2 : 0)
        )
      );

      if (toolCalls === 0 && attempt < MAX_TRANSIENT_QUERY_RETRIES) {
        await sleep(getTransientRetryDelayMs(attempt));
        queryOptions.idempotencyKey = randomUUID();
        continue;
      }

      return {
        evaluation: {
          answer,
          latencyMs: result.durationMs,
          transport,
          outcomeType,
          toolCalls,
          toolsUsed,
          developerTraceSummary: result.developerTrace?.summary ?? null,
          dataUrl: typeof result.dataUrl === "string" ? result.dataUrl : null,
          hasData: hasConcreteDataSignals(answer),
          actionable: hasDecisionSignal(answer),
          fresh: hasCurrentFreshnessCue(answer) || /fetched|hyperliquid|ticker/iu.test(answer),
          looksGeneric: looksGeneric(answer),
          qualityScore,
        },
        raw: {
          startedAt,
          transport,
          queryOptions,
          requestBody,
          result,
          retryCount: attempt,
        },
      };
    } catch (error) {
      const serialized = serializeError(error);
      const shouldRetry = attempt < MAX_TRANSIENT_QUERY_RETRIES && isTransientQueryFailure(serialized);
      if (shouldRetry) {
        await sleep(getTransientRetryDelayMs(attempt));
        queryOptions.idempotencyKey = randomUUID();
        continue;
      }
      return {
        evaluation: {
          answer: "",
          latencyMs: null,
          transport,
          outcomeType: /timeout/iu.test(serialized.message) ? "timeout" : "error",
          toolCalls: 0,
          toolsUsed: [],
          developerTraceSummary: null,
          dataUrl: null,
          hasData: false,
          actionable: false,
          fresh: false,
          looksGeneric: true,
          qualityScore: 0,
          error: serialized,
        },
        raw: { startedAt, transport, queryOptions, requestBody, error: serialized, retryCount: attempt },
      };
    }
  }
  throw new Error("runPaidPrompt: exhausted retries");
}

async function loadSnapshotMarkets() {
  try {
    const raw = await readFile(SNAPSHOT_PATH, "utf8");
    const j = tryParseJson(raw);
    return Array.isArray(j?.markets) ? j.markets : [];
  } catch {
    return [];
  }
}

function buildPromptRecords() {
  const fileJson = JSON.parse(readFileSync(POOL_JSON_PATH, "utf8"));
  const toolId = fileJson.toolId;
  const basePrompts = (fileJson.prompts ?? []).filter(
    (p) =>
      !CROSS_VENUE_IDS.has(p.id) &&
      (PROMPT_IDS.size === 0 || PROMPT_IDS.has(p.id))
  );
  const records = basePrompts.map((p) => ({
    id: p.id,
    prompt: p.prompt,
    mustWin: p.mustWin !== false,
    category: "hyperliquid",
    alphaCategory: p.alphaCategory ?? "General",
    showcaseCandidate: p.showcaseCandidate === true,
  }));
  return { toolId, records };
}

async function main() {
  const contextApiKey = normalizeEnvString(process.env.CONTEXT_API_KEY);
  const openRouterApiKey = normalizeEnvString(process.env.OPENROUTER_API_KEY);
  if (!contextApiKey) {
    throw new Error("Missing CONTEXT_API_KEY");
  }
  if (!openRouterApiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  await assertContributorHealthy();

  const { toolId, records: baseRecords } = buildPromptRecords();
  const fullPromptRecords = [...baseRecords];
  const latestPath = path.join(OUTPUT_DIR, "full-enhancement-results.latest.json");

  let previousById = new Map();
  let previousRawById = new Map();
  if (MERGE_EXISTING) {
    try {
      const prevRaw = await readFile(latestPath, "utf8");
      const prev = tryParseJson(prevRaw);
      if (prev && Array.isArray(prev.promptRuns)) {
        for (const row of prev.promptRuns) {
          if (row && typeof row.id === "string") {
            previousById.set(row.id, row);
          }
        }
      }
      if (prev && Array.isArray(prev.rawPromptRuns)) {
        for (const row of prev.rawPromptRuns) {
          if (row && typeof row.id === "string") {
            previousRawById.set(row.id, row);
          }
        }
      }
    } catch {
      previousById = new Map();
      previousRawById = new Map();
    }
  }

  let promptRecords = fullPromptRecords;
  if (MERGE_EXISTING) {
    promptRecords = fullPromptRecords.filter((p) => !previousById.has(p.id));
  } else if (MAX_PROMPTS > 0) {
    promptRecords = fullPromptRecords.slice(0, MAX_PROMPTS);
  }

  const staticAnswerability = {
    upstreamAnswerability: "answerable",
    answerabilityNote:
      "SDK evaluation path against Context query API; local Hyperliquid MCP direct checks not required for this artifact.",
    checks: [],
  };

  const promptRuns = [];
  const rawPromptRuns = [];

  if (MERGE_EXISTING) {
    for (const pr of fullPromptRecords) {
      const kept = previousById.get(pr.id);
      const keptRaw = previousRawById.get(pr.id);
      if (kept && keptRaw) {
        promptRuns.push(kept);
        rawPromptRuns.push(keptRaw);
      }
    }
  }

  for (let index = 0; index < promptRecords.length; index += 1) {
    const promptRecord = promptRecords[index];
    process.stdout.write(
      `\n[${index + 1}/${promptRecords.length}] ${promptRecord.id} (merge=${MERGE_EXISTING ? "yes" : "no"})\n`
    );

    const freeRun = await runFreeBaseline(promptRecord.prompt, openRouterApiKey);
    await sleep(400);

    const paidRun = await runPaidPrompt(promptRecord.prompt, contextApiKey, toolId);
    const differentiation = classifyDifferentiation(freeRun.evaluation, paidRun.evaluation);
    const status = determinePromptStatus(paidRun.evaluation) ? "pass" : "fail";

    promptRuns.push({
      id: promptRecord.id,
      prompt: promptRecord.prompt,
      mustWin: promptRecord.mustWin,
      category: promptRecord.category,
      alphaCategory: promptRecord.alphaCategory,
      showcaseCandidate: promptRecord.showcaseCandidate === true,
      status,
      transport: paidRun.evaluation.transport,
      qualityScore: paidRun.evaluation.qualityScore,
      latencyMs: paidRun.evaluation.latencyMs,
      toolsUsed: paidRun.evaluation.toolsUsed,
      toolCalls: paidRun.evaluation.toolCalls,
      outcomeType: paidRun.evaluation.outcomeType,
      upstreamAnswerability: staticAnswerability.upstreamAnswerability,
      answerabilityNote: staticAnswerability.answerabilityNote,
      differentiation,
      freeLlmBaselineBeaten: differentiation !== "low_differentiation",
      comparisonNote: `${promptRecord.id}: paid vs free differentiation=${differentiation}`,
      freeBaseline: {
        modelId: FREE_MODEL_ID,
        answerPreview: freeRun.evaluation.answer.slice(0, 500),
        hasData: freeRun.evaluation.hasData,
        fresh: freeRun.evaluation.fresh,
        actionable: freeRun.evaluation.actionable,
        latencyMs: freeRun.evaluation.latencyMs,
        ...(freeRun.evaluation.error ? { error: freeRun.evaluation.error } : {}),
      },
      paidQuery: {
        answerPreview: paidRun.evaluation.answer.slice(0, 500),
        transport: paidRun.evaluation.transport,
        hasData: paidRun.evaluation.hasData,
        fresh: paidRun.evaluation.fresh,
        actionable: paidRun.evaluation.actionable,
        looksGeneric: paidRun.evaluation.looksGeneric,
        developerTraceSummary: paidRun.evaluation.developerTraceSummary,
        dataUrl: paidRun.evaluation.dataUrl,
        ...(paidRun.evaluation.error ? { error: paidRun.evaluation.error } : {}),
      },
    });

    rawPromptRuns.push({
      id: promptRecord.id,
      prompt: promptRecord.prompt,
      answerability: staticAnswerability,
      freeRun: freeRun.raw,
      paidRun: paidRun.raw,
    });

    await sleep(500);
  }

  if (MERGE_EXISTING) {
    const order = fullPromptRecords.map((p) => p.id);
    const runMap = new Map(promptRuns.map((r) => [r.id, r]));
    const rawMap = new Map(rawPromptRuns.map((r) => [r.id, r]));
    promptRuns.length = 0;
    rawPromptRuns.length = 0;
    for (const id of order) {
      const r = runMap.get(id);
      const rw = rawMap.get(id);
      if (r && rw) {
        promptRuns.push(r);
        rawPromptRuns.push(rw);
      }
    }
  }

  const summary = summarizeRuns(promptRuns);
  const output = {
    generatedAt: new Date().toISOString(),
    runType: "hyperliquid-unified-evaluation",
    toolId,
    localMcpUrl: "http://localhost:4002/mcp",
    localContextBaseUrl: CONTEXT_BASE_URL,
    freeModelId: FREE_MODEL_ID,
    surfaceClassification: "mixed",
    surfaceTable: [],
    promptPoolSource: "full-enhancement-prompt-pool.json + live snapshot extras",
    promptRuns,
    summary,
    rawPromptRuns,
  };

  await writeFile(latestPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`\nSaved ${latestPath}\n`);
  process.stdout.write(
    `Pass rate: ${Math.round(summary.passRate * 100)}% (${summary.passedPrompts}/${summary.totalPrompts})\n`
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
