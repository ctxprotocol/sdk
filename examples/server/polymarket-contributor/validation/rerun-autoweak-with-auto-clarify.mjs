import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL = (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });
const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const INDICES = [5, 6, 8, 9, 12, 14, 15, 18];
const full = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));

function parseSse(text) {
  return text.split(/\r?\n\r?\n/u).map(c=>c.trim()).filter(Boolean).map(c=>c.split(/\r?\n/u).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n")).filter(d=>d&&d!=="[DONE]").map(d=>{try{return JSON.parse(d)}catch{return null}}).filter(Boolean);
}

async function runQuery(prompt) {
  const body = {
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
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await response.text();
  if (!response.ok) throw new Error(`status ${response.status}: ${payload.slice(0, 300)}`);
  const events = parseSse(payload);
  const done = [...events].reverse().find(e=>e.type==="done"&&e.result);
  if (!done) throw new Error("no done event");
  return done.result;
}

for (const i of INDICES) {
  const prompt = full[i].query;
  console.log(`[${i}] ${prompt.slice(0, 80)}...`);
  const start = Date.now();
  try {
    const r = await runQuery(prompt);
    full[i] = {
      query: prompt,
      responseText: r.response ?? "",
      developerTrace: r.developerTrace ?? null,
      outcomeType: r.outcomeType ?? "unknown",
      latencyMs: Date.now() - start,
      toolsUsed: r.toolsUsed ?? [],
    };
    console.log(`[${i}] done ${((Date.now()-start)/1000).toFixed(1)}s outcome=${full[i].outcomeType}`);
  } catch (e) {
    console.log(`[${i}] ERR ${e.message.slice(0, 160)}`);
  }
  await sleep(500);
}

writeFileSync(path.join(__dirname, "pipeline-query-results.json"), JSON.stringify(full, null, 2) + "\n");
console.log("merged back into pipeline-query-results.json");
