#!/usr/bin/env node
/**
 * Per-run free-LLM baseline for the showcase pipeline.
 * Calls OpenRouter (google/gemini-2.0-flash-exp:free) on each candidate prompt
 * with NO contributor tools, no live data — just the model's general
 * knowledge — so the buyer reviewer can compare paid vs free and emit a
 * differentiation classification per the SKILL.
 *
 * Output: SHOWCASE_DIR/showcase-free-baseline.latest.json
 *   {
 *     schemaVersion: "2026-04-30",
 *     contributor: "polymarket-contributor",
 *     model: "google/gemini-2.0-flash-exp:free",
 *     generatedAt: ISO,
 *     successCount: N,
 *     errorCount: N,
 *     responses: [{ promptId, prompt, freeResponse, status, errorReason? }]
 *   }
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const SHOWCASE_DIR = "/Users/alex/Documents/context-sdk/examples/server/polymarket-contributor/showcase";
const VALIDATION_PATH = path.join(SHOWCASE_DIR, "showcase-validation.latest.json");
const CANDIDATES_PATH = path.join(SHOWCASE_DIR, "showcase-candidates.json");
const OUTPUT_PATH = path.join(SHOWCASE_DIR, "showcase-free-baseline.latest.json");

const MODEL = "google/gemini-2.5-flash";
const FALLBACK_MODELS = [
  "google/gemini-2.0-flash-001",
  "google/gemini-flash-1.5",
];
const PER_PROMPT_TIMEOUT_MS = 60_000;
const RETRY_BACKOFF_MS = [2_000, 6_000, 15_000];

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  process.stderr.write("OPENROUTER_API_KEY not set\n");
  process.exit(1);
}

const validation = JSON.parse(readFileSync(VALIDATION_PATH, "utf8"));
const candidatesPool = JSON.parse(readFileSync(CANDIDATES_PATH, "utf8"));
const promptIdToPrompt = new Map();
for (const c of candidatesPool.candidates ?? []) {
  promptIdToPrompt.set(c.id, c.prompt);
}

const tasks = (validation.summaries ?? []).map((s) => ({
  promptId: s.id,
  prompt: s.prompt,
}));

console.log(`Baseline: ${tasks.length} prompts, model=${MODEL}`);

const SYSTEM_PROMPT = `You are a knowledgeable assistant answering an end-user question.
You do NOT have access to live market APIs, real-time prices, or any external tools.
Answer using only your general knowledge and reasoning. If the question asks for live data
(current prices, today's volumes, today's odds, recent price history), do your best by
acknowledging the limitation and giving the most useful response you can — discuss the
market broadly, reason about plausible probabilities, suggest where the user could look up
the live data, etc. Aim for ~150-300 words. Use plain text (no JSON). Do NOT make up
specific live numbers; you may cite well-known historical data if relevant.`;

async function callOpenRouter(prompt, modelOverride) {
  const useModel = modelOverride ?? MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_PROMPT_TIMEOUT_MS);
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://ctxprotocol.com",
        "X-Title": "Context Showcase Baseline",
      },
      body: JSON.stringify({
        model: useModel,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
        max_tokens: 800,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`HTTP ${res.status}: ${txt.slice(0, 400)}`);
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content ?? "";
    if (!content || typeof content !== "string") {
      throw new Error(`Empty content from model. Raw: ${JSON.stringify(json).slice(0, 400)}`);
    }
    return { freeResponse: content, model: useModel };
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(prompt) {
  let lastErr = null;
  const candidates = [MODEL, ...FALLBACK_MODELS];
  for (const candidateModel of candidates) {
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
      try {
        return await callOpenRouter(prompt, candidateModel);
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`  attempt ${attempt + 1} failed (${candidateModel}): ${msg.slice(0, 140)}\n`);
        const isPermanent = /HTTP 404|No endpoints found|invalid model|model_not_found/i.test(msg);
        if (isPermanent) {
          break;
        }
        if (attempt < RETRY_BACKOFF_MS.length - 1) {
          await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt]));
        }
      }
    }
  }
  throw lastErr ?? new Error("baseline call failed");
}

const responses = [];
let successCount = 0;
let errorCount = 0;

for (let i = 0; i < tasks.length; i += 1) {
  const t = tasks[i];
  const startedAt = new Date().toISOString();
  console.log(`[${i + 1}/${tasks.length}] ${t.promptId}`);
  try {
    const result = await callWithRetry(t.prompt);
    responses.push({
      promptId: t.promptId,
      prompt: t.prompt,
      freeResponse: result.freeResponse,
      model: result.model,
      status: "ok",
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    successCount += 1;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    responses.push({
      promptId: t.promptId,
      prompt: t.prompt,
      freeResponse: "",
      model: MODEL,
      status: "error",
      errorReason: msg,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
    errorCount += 1;
  }
  // Brief gap to be polite to OpenRouter
  await new Promise((r) => setTimeout(r, 1_500));
  // Persist progress incrementally so we can resume / observe
  writeFileSync(
    OUTPUT_PATH,
    JSON.stringify(
      {
        schemaVersion: "2026-04-30",
        contributor: "polymarket-contributor",
        model: MODEL,
        fallbackModels: FALLBACK_MODELS,
        generatedAt: new Date().toISOString(),
        promptCount: tasks.length,
        completedCount: i + 1,
        successCount,
        errorCount,
        responses,
      },
      null,
      2
    )
  );
}

console.log(`\nDone. ${successCount} succeeded, ${errorCount} failed. Wrote ${OUTPUT_PATH}.`);
