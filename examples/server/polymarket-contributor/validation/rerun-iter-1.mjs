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
const RESULTS_PATH = path.resolve(__dirname, "pipeline-query-results.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

// Indices in pipeline-query-results.json that correspond to the 8 weak queries.
// promptId mapping: p5=4, p10=9, p12=11, p13=12, p14=13, p16=15, p18=17, p19=18
const TARGET_INDICES = [4, 9, 11, 12, 13, 15, 17, 18];
const PROMPT_ID_BY_INDEX = {
  4: "p5",
  9: "p10",
  11: "p12",
  12: "p13",
  13: "p14",
  15: "p16",
  17: "p18",
  18: "p19",
};

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

const REFUSAL_MARKERS = [
  /i (?:can(?:not|'t)|am unable to|don't have)/i,
  /as an ai/i,
];

function isAutoWeak(responseText, toolCalls) {
  if (!toolCalls || toolCalls === 0) return true;
  if (!responseText || responseText.trim().length < 20) return true;
  return REFUSAL_MARKERS.some((rx) => rx.test(responseText));
}

const raw = await readFile(RESULTS_PATH, "utf8");
const allResults = JSON.parse(raw);

const outcomes = [];

for (const idx of TARGET_INDICES) {
  const promptId = PROMPT_ID_BY_INDEX[idx];
  const existing = allResults[idx];
  if (!existing) {
    console.log(`[${promptId}] idx ${idx} missing in results file, skipping`);
    continue;
  }
  const prompt = existing.query;
  const label = `[${promptId} idx=${idx}]`;
  console.log(`${label} Running: ${prompt.slice(0, 90)}...`);
  const startMs = Date.now();

  let finalResult = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      finalResult = await runQuery(prompt);
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        console.log(`${label} retrying: ${err.message.slice(0, 120)}`);
        await sleep(2000);
      }
    }
  }
  const latencyMs = Date.now() - startMs;

  if (!finalResult) {
    console.log(`${label} FAILED: ${lastErr?.message?.slice(0, 160)}`);
    outcomes.push({
      promptId,
      outcomeType: "error",
      toolCalls: 0,
      autoWeak: true,
      latencyMs,
      error: lastErr?.message?.slice(0, 500) ?? "unknown",
    });
    allResults[idx] = {
      ...existing,
      responseText: "",
      developerTrace: null,
      outcomeType: "error",
      latencyMs,
      error: lastErr?.message?.slice(0, 500) ?? "unknown",
    };
    continue;
  }

  const responseText = finalResult.response ?? "";
  const trace = finalResult.developerTrace ?? null;
  const toolCalls =
    trace?.summary?.toolCalls ??
    (Array.isArray(trace?.toolCallHistory) ? trace.toolCallHistory.length : 0) ??
    0;
  const outcomeType = finalResult.outcomeType ?? "answer";
  const autoWeak = isAutoWeak(responseText, toolCalls);

  console.log(
    `${label} ${(latencyMs / 1000).toFixed(1)}s outcome=${outcomeType} toolCalls=${toolCalls} autoWeak=${autoWeak}`
  );

  outcomes.push({
    promptId,
    outcomeType,
    toolCalls,
    autoWeak,
    latencyMs,
  });

  allResults[idx] = {
    ...existing,
    responseText,
    developerTrace: trace,
    outcomeType,
    latencyMs,
    toolsUsed: finalResult.toolsUsed ?? existing.toolsUsed,
  };
  // Persist after every query so a crash still saves partial progress.
  await writeFile(RESULTS_PATH, `${JSON.stringify(allResults, null, 2)}\n`, "utf8");
}

console.log("\nRerun complete.");
console.log(JSON.stringify(outcomes, null, 2));
