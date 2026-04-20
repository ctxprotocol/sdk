import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const BASE = (process.env.CONTEXT_BASE_URL ?? "").trim() || "http://localhost:3000";
const API_KEY = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!API_KEY) throw new Error("Missing CONTEXT_API_KEY");

const PROMPTS = [
  {
    id: "q1",
    prompt:
      "Within the 'Paris Saint-Germain FC vs. Liverpool FC' event, what are the current implied probabilities, best bids, best asks, and spreads for 'Will Paris Saint-Germain FC win on 2026-04-08?', 'Will Paris Saint-Germain FC vs. Liverpool FC end in a draw?', and 'Will Liverpool FC win on 2026-04-08?'?",
  },
  {
    id: "q11",
    prompt:
      "Inside the 'The Masters - Winner ' event, compare Xander Schauffele, Cameron Young, and Akshay Bhatia on current price, spread, and which one is easiest to exit size in.",
  },
];

function parseSse(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((c) => c.trim())
    .filter(Boolean)
    .map((chunk) =>
      chunk
        .split(/\r?\n/u)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n")
    )
    .filter((d) => d && d !== "[DONE]")
    .map((d) => {
      try {
        return JSON.parse(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function runOne({ id, prompt }) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
      "x-api-key": API_KEY,
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({
      query: prompt,
      tools: [TOOL_ID],
      responseShape: "answer_with_evidence",
      queryDepth: "deep",
      includeDeveloperTrace: true,
      clarificationPolicy: "auto",
      stream: true,
    }),
    signal: AbortSignal.timeout(300_000),
  });
  const txt = await res.text();
  if (!res.ok) {
    console.error(`${id} http ${res.status}: ${txt.slice(0, 300)}`);
    return { id, error: `http ${res.status}` };
  }
  const events = parseSse(txt);
  const done = [...events].reverse().find((e) => e.type === "done" && e.result);
  if (!done) return { id, error: "no done event" };
  const r = done.result;
  const tc = Array.isArray(r.developerTrace?.toolCallHistory)
    ? r.developerTrace.toolCallHistory.length
    : (r.developerTrace?.toolCalls ?? 0);
  const toolNames = Array.isArray(r.developerTrace?.toolCallHistory)
    ? r.developerTrace.toolCallHistory.map((c) => c.toolName || c.name)
    : [];
  const routedToTarget = toolNames.length > 0;
  const summary = {
    id,
    durationMs: Date.now() - t0,
    outcomeType: r.outcomeType ?? "unknown",
    toolCalls: tc,
    toolNames,
    routedToTarget,
    responsePreview: (r.response ?? "").slice(0, 400),
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const results = [];
for (const p of PROMPTS) {
  results.push(await runOne(p));
}

await writeFile(
  path.resolve(__dirname, "rerun-q1-q11-iter3.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2) + "\n",
  "utf8"
);
console.log("\nWrote rerun-q1-q11-iter3.json");
