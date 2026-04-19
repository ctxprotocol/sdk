import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL =
  (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const WALL_TIMEOUT_MS = 360_000;
const MAX_RETRIES = 1;
// Weak prompt indices in pipeline-query-results.json: p12=11, p13=12, p18=17, p19=18
const INDICES = [11, 12, 17, 18];
const PROMPT_IDS = ["p12", "p13", "p18", "p19"];

const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");
const RESULTS_PATH = path.join(__dirname, "pipeline-query-results.json");
const RERUN_PATH = path.join(__dirname, "weak-query-rerun-results-iteration-2.json");

loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

function tryParseJson(value) { try { return JSON.parse(value); } catch { return null; } }
function parseSseEvents(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((c) => c.trim())
    .filter((c) => c.length)
    .map((c) =>
      c.split(/\r?\n/u).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
    )
    .filter((d) => d.length && d !== "[DONE]")
    .map(tryParseJson)
    .filter((e) => e && typeof e === "object");
}

async function runQuery({ apiKey, query }) {
  const res = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      query,
      tools: [TOOL_ID],
      responseShape: "answer_with_evidence",
      queryDepth: "deep",
      includeDeveloperTrace: true,
      clarificationPolicy: "auto",
      stream: true,
    }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await res.text();
  if (!res.ok) throw new Error(`status ${res.status}: ${payload.slice(0, 400)}`);
  const events = parseSseEvents(payload);
  const done = [...events].reverse().find(
    (e) => e.type === "done" && e.result && typeof e.result === "object"
  );
  if (!done) throw new Error(`missing done: ${payload.slice(-400)}`);
  return done.result;
}

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

const all = JSON.parse(await readFile(RESULTS_PATH, "utf8"));
const rerun = [];

for (let i = 0; i < INDICES.length; i++) {
  const idx = INDICES[i];
  const pid = PROMPT_IDS[i];
  const entry = all[idx];
  const query = entry.query;
  const start = Date.now();
  let result = null;
  let err = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      result = await runQuery({ apiKey, query });
      err = null;
      break;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
  }
  const latencyMs = Date.now() - start;
  const merged = {
    query,
    responseText:
      typeof result?.response === "string"
        ? result.response
        : result?.response ? JSON.stringify(result.response) : "",
    developerTrace: result?.developerTrace ?? (err ? { error: err } : null),
    outcomeType: result?.outcomeType ?? (err ? "error" : "unknown"),
    latencyMs,
    toolsUsed: result?.toolsUsed ?? entry.toolsUsed ?? [],
  };
  all[idx] = merged;
  rerun.push({ promptId: pid, index: idx, ...merged, error: err });
  process.stdout.write(
    `[${pid}] idx=${idx} outcome=${merged.outcomeType} calls=${(merged.developerTrace?.toolCallHistory || []).length} latency=${latencyMs}ms\n`
  );
}

await writeFile(RESULTS_PATH, `${JSON.stringify(all, null, 2)}\n`, "utf8");
await writeFile(RERUN_PATH, `${JSON.stringify(rerun, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote merged results to ${RESULTS_PATH}\n`);
