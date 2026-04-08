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
const PROMPTS = (() => {
  if (existsSync(POOL_PATH)) {
    const pool = JSON.parse(readFileSync(POOL_PATH, "utf8"));
    if (Array.isArray(pool.prompts) && pool.prompts.length > 0) {
      return pool.prompts;
    }
  }
  return ["Polymarket baseline placeholder"];
})();

async function callGeminiFree(prompt) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${openRouterKey}`,
    },
    body: JSON.stringify({
      model: "google/gemini-3-flash-preview",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data.choices?.[0]?.message?.content ?? "";
}

const results = [];
for (let i = 0; i < PROMPTS.length; i++) {
  const prompt = PROMPTS[i];
  const label = `[${i + 1}/${PROMPTS.length}]`;
  console.log(`${label} Gemini baseline: ${prompt.slice(0, 60)}...`);

  try {
    const startMs = Date.now();
    const freeResponse = await callGeminiFree(prompt);
    const latencyMs = Date.now() - startMs;
    console.log(`${label} Done in ${(latencyMs / 1000).toFixed(1)}s (${freeResponse.length} chars)`);
    results.push({ query: prompt, freeResponse, latencyMs });
  } catch (error) {
    console.log(`${label} Error: ${error.message.slice(0, 100)}`);
    results.push({ query: prompt, freeResponse: "", error: error.message.slice(0, 300) });
  }

  if (i < PROMPTS.length - 1) await sleep(1000);
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
console.log(`\nBaseline complete. Results saved to ${OUTPUT_PATH}`);
