import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL = (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 420_000;
const MAX_RETRIES = 1;
const RESULTS_PATH = path.resolve(__dirname, "pipeline-query-results.json");
const POOL_PATH = path.resolve(__dirname, "prompt-pool.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const TARGET_INDICES = [11, 12, 17, 18]; // p12, p13, p18, p19
const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
const results = JSON.parse(readFileSync(RESULTS_PATH, "utf8"));

function tryParseJson(t) { try { return JSON.parse(t); } catch { return null; } }
function parseSseEvents(text) {
  return text.split(/\r?\n\r?\n/u).map(c => c.trim()).filter(Boolean)
    .map(c => c.split(/\r?\n/u).filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n"))
    .filter(d => d.length > 0 && d !== "[DONE]")
    .map(tryParseJson).filter(e => e && typeof e === "object");
}

async function runQuery(prompt) {
  const body = {
    query: prompt, tools: [TOOL_ID], responseShape: "answer_with_evidence",
    queryDepth: "deep", includeDeveloperTrace: true, clarificationPolicy: "auto", stream: true,
  };
  const r = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream", "content-type": "application/json",
      authorization: `Bearer ${apiKey}`, "x-api-key": apiKey,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${payload.slice(0, 400)}`);
  const events = parseSseEvents(payload);
  const done = [...events].reverse().find(e => e.type === "done" && e.result);
  if (!done) throw new Error(`No done event: ${payload.slice(-400)}`);
  return done.result;
}

for (const idx of TARGET_INDICES) {
  const prompt = pool.prompts[idx];
  const label = `[idx ${idx} / p${idx + 1}]`;
  console.log(`${label} ${prompt.slice(0, 90)}...`);
  const start = Date.now();
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      const res = await runQuery(prompt);
      const latencyMs = Date.now() - start;
      console.log(`${label} done ${(latencyMs / 1000).toFixed(1)}s outcome=${res.outcomeType}`);
      results[idx] = {
        query: prompt,
        responseText: res.response ?? "",
        developerTrace: res.developerTrace ?? null,
        outcomeType: res.outcomeType ?? "unknown",
        latencyMs,
        toolsUsed: res.toolsUsed ?? [],
      };
      break;
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        console.log(`${label} retry: ${e.message.slice(0, 120)}`);
        await sleep(3000); attempt++; continue;
      }
      console.log(`${label} FAILED: ${e.message.slice(0, 160)}`);
      results[idx] = {
        query: prompt, responseText: "", developerTrace: null,
        outcomeType: "error", latencyMs: Date.now() - start,
        error: e.message.slice(0, 500),
      };
      break;
    }
  }
}

await writeFile(RESULTS_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(`Merged reruns into ${RESULTS_PATH}`);
