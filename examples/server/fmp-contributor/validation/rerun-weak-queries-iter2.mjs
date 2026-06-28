// Iteration re-run: re-executes the weak/autoWeak prompts (satisfactionMean < 4.0
// OR autoWeak) from reviewer-evaluation.json against the SAME /api/v1/query route
// (now that the marketplace listing exposes all 27 methods), then merges the
// fresh results back into pipeline-query-results.json (with a backup). This is
// the measure step of an improvement iteration.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "15c60ca5-94c9-4257-89c4-542a4745e89f";
const CONTEXT_BASE_URL = (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 420_000; // bump to 420s to give complex prompts a bit more room
const MAX_RETRIES = 2;
const TRANSIENT_RETRY_MS = 15_000;
const RESULTS_PATH = path.resolve(__dirname, "pipeline-query-results.json");
const BACKUP_PATH = path.resolve(__dirname, `pipeline-query-results.pre-iter2.json`);
const RERUN_PATH = path.resolve(__dirname, "rerun-results.iter2.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });
const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

function readJson(p) { return JSON.parse(readFileSync(p, "utf8")); }

function tryParseJson(t) { try { return JSON.parse(t); } catch { return null; } }
function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/).map((c) => c.trim()).filter((c) => c.length > 0)
    .map((c) => c.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n"))
    .filter((d) => d.length > 0 && d !== "[DONE]").map((d) => tryParseJson(d)).filter((e) => e && typeof e === "object");
}
function isTransient(payload, status) {
  if (status === 503) return true;
  if (typeof payload !== "string") return false;
  return /auth_unavailable|service unavailable|rate.?limit|503|temporarily/i.test(payload);
}

async function runQuery(promptObj) {
  const idempotencyKey = randomUUID();
  const body = { query: promptObj.prompt, tools: [TOOL_ID], responseShape: "answer_with_evidence", queryDepth: "deep", includeDeveloperTrace: true, clarificationPolicy: "auto", stream: true };
  const res = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: { accept: "text/event-stream", "content-type": "application/json", authorization: `Bearer ${apiKey}`, "x-api-key": apiKey, "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await res.text();
  if (!res.ok) { const e = new Error(`Query failed ${res.status}: ${payload.slice(0, 300)}`); e.status = res.status; e.transient = isTransient(payload, res.status); throw e; }
  const events = parseSseEvents(payload);
  const done = [...events].reverse().find((e) => e.type === "done" && e.result && typeof e.result === "object");
  if (!done) { const e = new Error(`No done event: ${payload.slice(-300)}`); e.transient = false; throw e; }
  return done.result;
}

async function main() {
  const reviewer = readJson(path.resolve(__dirname, "reviewer-evaluation.json"));
  const pool = readJson(path.resolve(__dirname, "prompt-pool.json"));
  const prompts = (pool.prompts ?? []).map((e) => ({ id: e.id, prompt: e.prompt, groundedEntity: e.groundedEntity, alphaCategory: e.alphaCategory, difficulty: e.difficulty, expectedChartShape: e.expectedChartShape, toolsLikelyUsed: e.toolsLikelyUsed ?? [], answerabilityNote: e.answerabilityNote }));
  const byId = new Map(prompts.map((p) => [p.id, p]));
  const weakIds = (reviewer.perQueryEvaluations ?? []).filter((e) => e.satisfactionMean < 4.0 || e.autoWeak).map((e) => e.promptId ?? e.id);
  console.log(`Re-running ${weakIds.length} weak/autoWeak prompts: ${weakIds.join(", ")}`);

  const existing = readJson(RESULTS_PATH);
  const existingById = new Map(existing.map((r) => [r.id, r]));
  if (!existsSync(BACKUP_PATH)) copyFileSync(RESULTS_PATH, BACKUP_PATH);

  // Resume support: load already-saved rerun results so we skip them on restart.
  const rerunResults = [];
  const doneRerunIds = new Set();
  if (existsSync(RERUN_PATH)) {
    try {
      const prev = readJson(RERUN_PATH);
      if (Array.isArray(prev)) {
        for (const r of prev) { rerunResults.push(r); doneRerunIds.add(r.id); existingById.set(r.id, r); }
        console.log(`Resuming: ${prev.length} already-saved rerun results loaded (${[...doneRerunIds].join(", ")}).`);
      }
    } catch { /* ignore corrupt */ }
  }

  const todoIds = weakIds.filter((id) => !doneRerunIds.has(id));
  console.log(`To run: ${todoIds.length} prompts: ${todoIds.join(", ")}`);
  for (let i = 0; i < todoIds.length; i++) {
    const id = todoIds[i];
    const promptObj = byId.get(id);
    if (!promptObj) { console.log(`[${i + 1}/${todoIds.length}] ${id} -- not found in prompt-pool, skipping`); continue; }
    const label = `[${i + 1}/${todoIds.length}] ${id}`;
    process.stdout.write(`${label} Running... `);
    const startMs = Date.now();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await runQuery(promptObj);
        const latencyMs = Date.now() - startMs;
        const outcomeType = result.outcomeType ?? "unknown";
        const tools = result.toolsUsed ?? [];
        const entry = { id, query: promptObj.prompt, groundedEntity: promptObj.groundedEntity, alphaCategory: promptObj.alphaCategory, difficulty: promptObj.difficulty, expectedChartShape: promptObj.expectedChartShape, toolsLikelyUsed: promptObj.toolsLikelyUsed, answerabilityNote: promptObj.answerabilityNote, responseText: result.response ?? "", developerTrace: result.developerTrace ?? null, outcomeType, latencyMs, toolsUsed: tools, cost: result.cost ?? null, rerunIteration: 1 };
        rerunResults.push(entry);
        existingById.set(id, entry);
        process.stdout.write(`Done ${(latencyMs / 1000).toFixed(1)}s outcome=${outcomeType} tools=${tools.map((t) => t.name).join(",") || "none"}\n`);
        break;
      } catch (e) {
        if (attempt < MAX_RETRIES) { const w = e.transient ? TRANSIENT_RETRY_MS : 2000; process.stdout.write(`retry ${attempt + 1} (${e.message.slice(0, 60)}) wait ${w}ms... `); await sleep(w); continue; }
        const latencyMs = Date.now() - startMs;
        const entry = { id, query: promptObj.prompt, groundedEntity: promptObj.groundedEntity, alphaCategory: promptObj.alphaCategory, difficulty: promptObj.difficulty, expectedChartShape: promptObj.expectedChartShape, toolsLikelyUsed: promptObj.toolsLikelyUsed, answerabilityNote: promptObj.answerabilityNote, responseText: "", developerTrace: null, outcomeType: "error", latencyMs, toolsUsed: [], error: e.message.slice(0, 500), rerunIteration: 1 };
        rerunResults.push(entry);
        existingById.set(id, entry);
        process.stdout.write(`Failed after retries: ${e.message.slice(0, 100)}\n`);
      }
    }
    await writeFile(RERUN_PATH, JSON.stringify(rerunResults, null, 2) + "\n", "utf8");
    if (i < todoIds.length - 1) await sleep(2000);
  }

  // Merge back, preserving original order.
  const merged = existing.map((r) => existingById.get(r.id) ?? r);
  await writeFile(RESULTS_PATH, JSON.stringify(merged, null, 2) + "\n", "utf8");
  const answers = rerunResults.filter((r) => r.outcomeType === "answer").length;
  const errors = rerunResults.filter((r) => r.outcomeType === "error").length;
  const cap = rerunResults.filter((r) => r.outcomeType === "capability_miss").length;
  console.log(`\nRe-run complete. ${rerunResults.length} prompts re-run: answers=${answers} capability_miss=${cap} errors=${errors}`);
  console.log(`Merged back into ${RESULTS_PATH} (backup at ${BACKUP_PATH})`);
}

await main().catch((e) => { console.error("FATAL:", e.message); process.exitCode = 1; });
