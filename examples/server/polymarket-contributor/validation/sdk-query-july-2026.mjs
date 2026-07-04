import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL = (process.env.CONTEXT_BASE_URL ?? "").trim() || "https://www.ctxprotocol.com";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 1;
const CONCURRENCY = 3;
const OUTPUT_PATH = path.resolve(__dirname, "sdk-query-results-july-2026.json");

// Load CONTEXT_API_KEY from context-sdk/.env.local (skill: source of truth)
loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY (context-sdk/.env.local)");

// 10 must-win (j1-j10) + 2 regression = 12 (skill minimum)
const POOL = JSON.parse(readFileSync(path.resolve(__dirname, "prompt-pool.json"), "utf8"));
const REGRESSION_PICKS = new Set([
  POOL.prompts[11], // slippage $50k buy
  POOL.prompts[15], // sum-to-one arb check
]);
const PROMPTS = POOL.prompts.slice(0, 10).concat([...REGRESSION_PICKS]);
console.log(`Production SDK Query validation: ${PROMPTS.length} prompts | target=${CONTEXT_BASE_URL} | concurrency=${CONCURRENCY}`);

function tryParseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/u).map((c) => c.trim()).filter((c) => c.length > 0)
    .map((c) => c.split(/\r?\n/u).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"))
    .filter((d) => d.length > 0 && d !== "[DONE]").map((d) => tryParseJson(d))
    .filter((e) => e && typeof e === "object");
}

async function runQuery(prompt) {
  const requestBody = {
    query: prompt,
    tools: [TOOL_ID],
    responseShape: "answer_with_evidence",
    queryDepth: "deep",
    includeDeveloperTrace: true,
    clarificationPolicy: "auto",
    stream: true,
    // No agentModelId: let the multi-model librarian pick (per contributor skill)
  };
  const response = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`Query ${response.status}: ${payload.slice(0, 400)}`);
  const events = parseSseEvents(payload);
  const done = [...events].reverse().find((e) => e.type === "done" && e.result && typeof e.result === "object");
  if (!done) throw new Error(`No done event: ${payload.slice(-400)}`);
  return done.result;
}

function summarizeTrace(trace) {
  if (!trace || typeof trace !== "object") return null;
  const s = trace.summary ?? {};
  const toolCalls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
  const methodNames = toolCalls.map((c) => c?.method ?? c?.name ?? c?.toolName).filter(Boolean);
  return {
    summaryToolCalls: s.toolCalls ?? toolCalls.length ?? 0,
    retryCount: s.retryCount ?? 0,
    loopCount: s.loopCount ?? 0,
    fallbackCount: s.fallbackCount ?? 0,
    methodsCalled: [...new Set(methodNames)].slice(0, 12),
  };
}

async function runOne(idx, prompt) {
  const label = `[${idx + 1}/${PROMPTS.length}]`;
  const startMs = Date.now();
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await runQuery(prompt);
      const latencyMs = Date.now() - startMs;
      const trace = summarizeTrace(result.developerTrace);
      const newMethods = (trace?.methodsCalled ?? []).filter((m) =>
        ["get_batch_price_history","get_orderbook_history","get_market_positions","get_trader_leaderboard","find_reward_markets","get_sports_context","get_price_history"].includes(m)
      );
      const pass = result.outcomeType === "answer" && (trace?.summaryToolCalls ?? 0) > 0;
      console.log(`${label} ${pass ? "PASS" : "FAIL"} ${(latencyMs/1000).toFixed(1)}s outcome=${result.outcomeType ?? "?"} toolCalls=${trace?.summaryToolCalls ?? 0} methods=[${(trace?.methodsCalled ?? []).slice(0,5).join(",")}] new=[${newMethods.join(",")}]`);
      return { query: prompt, outcomeType: result.outcomeType ?? "unknown", latencyMs, toolsUsed: result.toolsUsed ?? [], trace, responseSnippet: (result.response ?? "").slice(0, 200), pass, newMethodsFired: newMethods };
    } catch (error) {
      if (attempt < MAX_RETRIES) { await sleep(2000); continue; }
      const latencyMs = Date.now() - startMs;
      console.log(`${label} FAIL ${(latencyMs/1000).toFixed(1)}s ${error.message.slice(0, 120)}`);
      return { query: prompt, outcomeType: "error", latencyMs, error: error.message.slice(0, 400), pass: false, newMethodsFired: [] };
    }
  }
}

// Bounded concurrency
const results = new Array(PROMPTS.length);
let next = 0;
async function worker() {
  while (true) {
    const i = next++;
    if (i >= PROMPTS.length) return;
    results[i] = await runOne(i, PROMPTS[i]);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
const answers = results.filter((r) => r?.pass).length;
const errors = results.filter((r) => r?.outcomeType === "error").length;
const newMethodHits = results.flatMap((r) => r?.newMethodsFired ?? []);
console.log(`\nDone. ${answers}/${results.length} passed (toolCalls>0 + answer). ${errors} errors.`);
console.log(`New-method firings across runs: ${[...new Set(newMethodHits)].join(", ") || "(none)"} (${newMethodHits.length} total hits)`);
console.log(`Results: ${OUTPUT_PATH}`);
