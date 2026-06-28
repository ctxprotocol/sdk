// FMP free LLM baseline — runs every prompt through Gemini 3 Flash via
// OpenRouter with NO tools and NO system prompt, representing what a user can
// get for free from a consumer AI chat product. Used to compute differentiation.
//
// Usage: node run-free-baseline.mjs
// Writes: free-baseline-results.json

import { readFileSync, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.resolve(__dirname, "free-baseline-results.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const openRouterKey = (process.env.OPENROUTER_API_KEY ?? "").trim();
if (!openRouterKey) throw new Error("Missing OPENROUTER_API_KEY in context/.env.local");

const POOL_PATH = path.resolve(__dirname, "prompt-pool.json");
function loadPrompts() {
  if (!existsSync(POOL_PATH)) throw new Error(`Missing prompt pool at ${POOL_PATH}`);
  const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
  const raw = Array.isArray(pool.prompts) ? pool.prompts : [];
  return raw.map((entry) => {
    const isObj = entry && typeof entry === "object" && !Array.isArray(entry);
    return {
      id: isObj && entry.id ? entry.id : `prompt-${entry}`,
      prompt: isObj ? entry.prompt : String(entry),
    };
  });
}

// NOTE: The SKILL prescribes `google/gemini-3-flash-preview` via OpenRouter as
// the free baseline. As of this run that model returns HTTP 403 ("violation of
// provider Terms Of Service") on every financial prompt, every other OpenRouter
// `:free` tier is 404 ("unavailable for free"), and the direct Google Gemini
// API key in context/.env.local is not enabled for this project. The free
// consumer baseline is therefore unavailable. To preserve the no-tools
// baseline comparison the SKILL requires (what a capable chatbot says with NO
// tools / NO live data), we substitute the cheap paid
// `meta-llama/llama-3.3-70b-instruct` — a strong general-purpose LLM with no
// FMP tool access and no live data, which is exactly the unbundling argument
// the differentiation gate is measuring. This substitution is recorded in the
// run log and the final report.
const BASELINE_MODEL = "meta-llama/llama-3.3-70b-instruct";

async function callGeminiFree(prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openRouterKey}`,
    },
    body: JSON.stringify({
      model: BASELINE_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Baseline API error ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.choices?.[0]?.message?.content ?? "";
}

const prompts = loadPrompts();
const results = [];
// Incremental write helper so partial progress survives a crash / hang.
async function flush() {
  await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
}

for (let i = 0; i < prompts.length; i++) {
  const promptObj = prompts[i];
  const label = `[${i + 1}/${prompts.length}] ${promptObj.id}`;
  process.stdout.write(`${label} baseline: ${promptObj.prompt.slice(0, 60)}... `);

  const startMs = Date.now();
  let done = false;
  for (let attempt = 0; attempt < 2 && !done; attempt++) {
    try {
      const freeResponse = await callGeminiFree(promptObj.prompt);
      const latencyMs = Date.now() - startMs;
      process.stdout.write(`Done in ${(latencyMs / 1000).toFixed(1)}s (${freeResponse.length} chars)\n`);
      results.push({ id: promptObj.id, query: promptObj.prompt, freeResponse, latencyMs, model: BASELINE_MODEL });
      done = true;
    } catch (error) {
      if (attempt === 0) {
        process.stdout.write(`retrying (${error.message.slice(0, 60)})... `);
        await sleep(5000);
      } else {
        process.stdout.write(`Error: ${error.message.slice(0, 100)}\n`);
        results.push({ id: promptObj.id, query: promptObj.prompt, freeResponse: "", error: error.message.slice(0, 300), model: BASELINE_MODEL });
      }
    }
  }
  await flush();

  if (i < prompts.length - 1) await sleep(1500);
}

console.log(`\nBaseline complete. Results saved to ${OUTPUT_PATH}`);
