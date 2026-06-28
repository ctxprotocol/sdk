// FMP paid SDK sweep — runs every prompt in prompt-pool.json through the
// Context /api/v1/query route pinned to the fmp-contributor TOOL_ID with
// queryDepth: "deep" and includeDeveloperTrace: true. The Context route
// resolves the tool to its remote MCP endpoint (https://mcp.ctxprotocol.com/fmp/mcp)
// which holds the real FMP_API_KEY, so no local FMP key is required.
//
// Usage: node run-pipeline-queries.mjs
// Writes: pipeline-query-results.json

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "15c60ca5-94c9-4257-89c4-542a4745e89f";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 2;
const TRANSIENT_RETRY_MS = 15_000;
const OUTPUT_PATH = path.resolve(__dirname, "pipeline-query-results.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const POOL_PATH = path.resolve(__dirname, "prompt-pool.json");
function loadPrompts() {
  if (!existsSync(POOL_PATH)) throw new Error(`Missing prompt pool at ${POOL_PATH}`);
  const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
  const raw = Array.isArray(pool.prompts) ? pool.prompts : [];
  if (raw.length === 0) throw new Error("prompt-pool.json has no prompts");
  return raw.map((entry) => {
    const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
    const promptText = isObj ? entry.prompt : String(entry);
    return {
      id: isObj && entry.id ? entry.id : `prompt-${randomUUID().slice(0, 8)}`,
      prompt: promptText,
      groundedEntity: isObj ? entry.groundedEntity ?? null : null,
      alphaCategory: isObj ? entry.alphaCategory ?? null : null,
      difficulty: isObj ? entry.difficulty ?? null : null,
      expectedChartShape: isObj ? entry.expectedChartShape ?? null : null,
      toolsLikelyUsed: isObj ? entry.toolsLikelyUsed ?? [] : [],
      answerabilityNote: isObj ? entry.answerabilityNote ?? "" : "",
    };
  });
}

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

function isTransient(payload, status) {
  if (status === 503) return true;
  if (typeof payload !== "string") return false;
  return /auth_unavailable|service unavailable|rate.?limit|503|temporarily/i.test(payload);
}

async function runQuery(promptObj) {
  const idempotencyKey = randomUUID();
  const requestBody = {
    query: promptObj.prompt,
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
    const err = new Error(`Query failed status ${response.status}: ${payload.slice(0, 300)}`);
    err.status = response.status;
    err.payload = payload;
    err.transient = isTransient(payload, response.status);
    throw err;
  }

  const events = parseSseEvents(payload);
  const doneEvent = [...events].reverse().find(
    (e) => e.type === "done" && e.result && typeof e.result === "object"
  );
  if (!doneEvent) {
    const err = new Error(`No done event in response: ${payload.slice(-400)}`);
    err.transient = false;
    throw err;
  }
  return doneEvent.result;
}

const prompts = loadPrompts();
const results = [];
for (let i = 0; i < prompts.length; i++) {
  const promptObj = prompts[i];
  const label = `[${i + 1}/${prompts.length}] ${promptObj.id}`;
  console.log(`${label} Running: ${promptObj.prompt.slice(0, 90)}...`);
  const startMs = Date.now();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runQuery(promptObj);
      const latencyMs = Date.now() - startMs;
      const outcomeType = result.outcomeType ?? "unknown";
      console.log(`${label} Done in ${(latencyMs / 1000).toFixed(1)}s — outcome: ${outcomeType}, tools: ${(result.toolsUsed ?? []).map((t) => t.name).join(",") || "none"}`);
      results.push({
        id: promptObj.id,
        query: promptObj.prompt,
        groundedEntity: promptObj.groundedEntity,
        alphaCategory: promptObj.alphaCategory,
        difficulty: promptObj.difficulty,
        expectedChartShape: promptObj.expectedChartShape,
        toolsLikelyUsed: promptObj.toolsLikelyUsed,
        answerabilityNote: promptObj.answerabilityNote,
        responseText: result.response ?? "",
        developerTrace: result.developerTrace ?? null,
        outcomeType,
        latencyMs,
        toolsUsed: result.toolsUsed ?? [],
        cost: result.cost ?? null,
      });
      break;
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      const transient = error.transient === true;
      if (attempt < MAX_RETRIES) {
        const wait = transient ? TRANSIENT_RETRY_MS : 2000;
        console.log(`${label} Error (retry ${attempt + 1}/${MAX_RETRIES}, wait ${wait}ms): ${error.message.slice(0, 120)}`);
        await sleep(wait);
        continue;
      }
      console.log(`${label} Failed after retries: ${error.message.slice(0, 150)}`);
      results.push({
        id: promptObj.id,
        query: promptObj.prompt,
        groundedEntity: promptObj.groundedEntity,
        alphaCategory: promptObj.alphaCategory,
        difficulty: promptObj.difficulty,
        expectedChartShape: promptObj.expectedChartShape,
        toolsLikelyUsed: promptObj.toolsLikelyUsed,
        answerabilityNote: promptObj.answerabilityNote,
        responseText: "",
        developerTrace: null,
        outcomeType: "error",
        latencyMs,
        toolsUsed: [],
        error: error.message.slice(0, 500),
      });
    }
  }
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
const answers = results.filter((r) => r.outcomeType === "answer").length;
const errors = results.filter((r) => r.outcomeType === "error").length;
console.log(`\nAll queries complete. Results saved to ${OUTPUT_PATH}`);
console.log(`  Total: ${results.length}, Answers: ${answers}, Errors: ${errors}`);
