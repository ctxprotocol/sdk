import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ContextClient, ContextError } from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) throw new Error("Set CONTEXT_API_KEY before running this script.");

const FMP_TOOL_ID = "15c60ca5-94c9-4257-89c4-542a4745e89f";
const OUT = "/Users/alex/Documents/context-sdk/examples/server/fmp-contributor/validation/query-validation-results.json";

// Auto-discovery prompts (NO pin) — must route to the FMP listing via discovery.
const AUTO_PROMPTS = [
  "What's the current stock price and P/E ratio of NVIDIA?",
  "Show me today's biggest stock market gainers on US exchanges.",
  "Screen for large-cap US technology stocks with low beta.",
  "What's the latest analyst price target consensus for Apple stock?",
  "Compare the current stock valuations of Microsoft and Google.",
];

// Pinned must-win + cluster prompts (pinned to FMP).
const PINNED_PROMPTS = [
  { id: "MW1", cluster: "workflow/composite", alpha: "live-multisignal-brief", prompt: "Build a full financial brief on Microsoft (MSFT): current price and daily move, TTM valuation ratios, analyst target consensus and rating split, plus the latest news." },
  { id: "MW2", cluster: "comparison", alpha: "cross-entity-comparison", prompt: "Compare AAPL, MSFT, and GOOGL right now on price, daily change %, market cap, P/E, and EPS side by side." },
  { id: "MW3", cluster: "discovery/screen", alpha: "threshold-screening", prompt: "Screen for US Technology stocks with market cap over $50B, beta under 1.3, and price above $100; list the top 15 with sector and exchange." },
  { id: "MW4", cluster: "movers", alpha: "intraday-momentum", prompt: "What are today's biggest stock gainers and most active stocks on US exchanges, and do any names appear on both lists?" },
  { id: "MW5", cluster: "analysis/technical", alpha: "technical-signal-freshness", prompt: "What's the latest 14-period RSI for AMD on the daily timeframe, and is it overbought (>70) or oversold (<30)?" },
  { id: "MW6", cluster: "fundamentals-trend", alpha: "fundamental-trend", prompt: "Pull TSLA's last 8 quarterly income statements and summarize the revenue and net income trend." },
  { id: "MW7", cluster: "analyst", alpha: "analyst-consensus", prompt: "What is the current analyst price-target consensus and buy/hold/sell rating distribution for NVDA?" },
  { id: "MW8", cluster: "workflow/ceiling", alpha: "threshold-screening", prompt: "I'm researching semiconductors: screen for large-cap semiconductor names, then for the top 2 give me current quote, TTM P/E and ROE, and analyst target consensus." },
  { id: "MW9", cluster: "analysis/valuation", alpha: "cross-entity-comparison", prompt: "Is META cheap or expensive right now versus its fundamentals? Give current P/E, P/B, ROE, and net margin (TTM) and the analyst target vs current price." },
  { id: "MW10", cluster: "time-sensitive", alpha: "technical-signal-freshness", prompt: "Given AAPL's current price relative to its 50- and 200-day averages and latest RSI, is momentum bullish or bearish today?" },
  { id: "EDGE1", cluster: "edge/ambiguity", alpha: "discovery", prompt: "Find the ticker for the company people call 'Big Blue' and give its current quote and sector." },
  { id: "EDGE2", cluster: "edge/sparse", alpha: "analyst-consensus", prompt: "Give the current analyst price target consensus for Berkshire Hathaway (BRK-B); if some analyst data is unavailable, say so explicitly." },
];

const APOLOGY = /\b(i (?:can'?t|cannot|am unable|do not have|don'?t have)|unable to (?:provide|answer|find)|no data (?:available|found)|couldn'?t find|i do not have access|i'm sorry)\b/i;

function extractToolCalls(trace) {
  const tl = trace?.timeline ?? [];
  return tl
    .filter((s) => (s.stepType || s.event) === "tool-call")
    .map((s) => {
      const resultStr = JSON.stringify(s.metadata?.result ?? null);
      return {
        method: s.tool?.name ?? null,
        status: s.status ?? null,
        args: s.metadata?.args ?? null,
        resultPreview: resultStr ? resultStr.slice(0, 900) : null,
        resultBytes: resultStr ? resultStr.length : 0,
      };
    });
}

function classify({ pinned, result }) {
  const ok = result?.success !== false;
  const toolCalls = result?.developerTrace?.summary?.toolCalls ?? 0;
  const resp = result?.response ?? "";
  const respOk = resp.trim().length > 40;
  const apologetic = APOLOGY.test(resp.slice(0, 300)) && toolCalls === 0;
  const routedToFMP = (result?.toolsUsed ?? []).some((t) => t.id === FMP_TOOL_ID);
  const pass = ok && toolCalls > 0 && respOk && !apologetic && (pinned ? true : routedToFMP);
  return { pass, ok, toolCalls, respOk, apologetic, routedToFMP };
}

async function runOne(client, { prompt, pinned }) {
  const started = Date.now();
  try {
    const result = await client.query.run({
      query: prompt,
      ...(pinned ? { tools: [FMP_TOOL_ID] } : {}),
      includeData: true,
      includeDeveloperTrace: true,
    });
    const verdict = classify({ pinned, result });
    return {
      ok: true,
      durationMs: result.durationMs ?? Date.now() - started,
      costUsd: result.cost?.totalCostUsd ?? null,
      outcomeType: result.outcomeType ?? null,
      toolsUsed: (result.toolsUsed ?? []).map((t) => ({ id: t.id, name: t.name, skillCalls: t.skillCalls })),
      traceSummary: result.developerTrace?.summary ?? null,
      toolCalls: extractToolCalls(result.developerTrace),
      responsePreview: (result.response ?? "").slice(0, 700),
      verdict,
    };
  } catch (error) {
    return {
      ok: false,
      durationMs: Date.now() - started,
      error: error instanceof ContextError
        ? { name: error.name, message: error.message, code: error.code, statusCode: error.statusCode }
        : { name: error?.name ?? "Error", message: error?.message ?? String(error) },
      verdict: { pass: false },
    };
  }
}

async function main() {
  const client = new ContextClient({ apiKey });
  const reports = [];
  let n = 0;
  const total = AUTO_PROMPTS.length + PINNED_PROMPTS.length;

  console.log(`=== AUTO-DISCOVERY (${AUTO_PROMPTS.length}) ===`);
  for (const prompt of AUTO_PROMPTS) {
    n += 1;
    console.log(`[${n}/${total}] AUTO: ${prompt}`);
    const r = await runOne(client, { prompt, pinned: false });
    reports.push({ phase: "auto-discovery", prompt, ...r });
    console.log(`   pass=${r.verdict?.pass} routedFMP=${r.verdict?.routedToFMP} toolCalls=${r.verdict?.toolCalls ?? "-"} cost=${r.costUsd ?? "-"} ${r.error ? "ERR:" + r.error.message : ""}`);
    await sleep(500);
  }

  console.log(`\n=== PINNED VALIDATION (${PINNED_PROMPTS.length}) ===`);
  for (const p of PINNED_PROMPTS) {
    n += 1;
    console.log(`[${n}/${total}] ${p.id}: ${p.prompt.slice(0, 70)}...`);
    const r = await runOne(client, { prompt: p.prompt, pinned: true });
    reports.push({ phase: "pinned", promptId: p.id, cluster: p.cluster, alphaCategory: p.alpha, prompt: p.prompt, ...r });
    console.log(`   pass=${r.verdict?.pass} toolCalls=${r.verdict?.toolCalls ?? "-"} methods=${(r.toolCalls ?? []).map((t) => t.method).join("+") || "-"} cost=${r.costUsd ?? "-"} dur=${r.durationMs}ms ${r.error ? "ERR:" + r.error.message : ""}`);
    await sleep(500);
  }

  const auto = reports.filter((r) => r.phase === "auto-discovery");
  const pinned = reports.filter((r) => r.phase === "pinned");
  const passCount = reports.filter((r) => r.verdict?.pass).length;
  const totalCost = reports.reduce((s, r) => s + Number(r.costUsd ?? 0), 0);

  const summary = {
    generatedAt: new Date().toISOString(),
    toolId: FMP_TOOL_ID,
    totalPrompts: total,
    passCount,
    failCount: total - passCount,
    autoRouteToFMP: `${auto.filter((r) => r.verdict?.routedToFMP).length}/${auto.length}`,
    pinnedPass: `${pinned.filter((r) => r.verdict?.pass).length}/${pinned.length}`,
    totalCostUsd: Number(totalCost.toFixed(6)),
    avgDurationMs: Math.round(reports.reduce((s, r) => s + (r.durationMs ?? 0), 0) / reports.length),
  };

  await writeFile(OUT, JSON.stringify({ summary, reports }, null, 2), "utf8");
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote ${OUT}`);
}

void main().catch((e) => {
  console.error("FATAL:", e?.message);
  process.exit(1);
});
