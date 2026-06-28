// Converts pipeline-query-results.json (paid SDK sweep) into
// full-enhancement-results.latest.json with the summary.passRate the
// release-decision hook reads, plus per-prompt records for the artifact.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN = path.resolve(__dirname, "pipeline-query-results.json");
const OUT = path.resolve(__dirname, "full-enhancement-results.latest.json");

const REFUSAL = /I am unable to|I cannot provide|I'm unable to|I'm not able to|I do not have|no data available|could not fulfill/i;
const RESOLUTION_FAIL = /slug not found|event not found|market not found|could not resolve/i;

function hasConcreteData(text) {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  return /[$]\s?\d|\b\d+(?:\.\d+)?%|\b\d[\d,]*(?:\.\d+)?\b|revenue|earnings|dividend|price|market cap|sector|score|yield/i.test(text);
}

function main() {
  const results = JSON.parse(readFileSync(IN, "utf8"));
  const records = [];
  let answered = 0;
  let autoWeak = 0;
  for (const r of results) {
    const outcome = r.outcomeType ?? "unknown";
    const tools = Array.isArray(r.toolsUsed) ? r.toolsUsed : [];
    const toolCalls = r.developerTrace?.summary?.toolCalls ?? tools.length;
    const routedToTarget = tools.some((t) => /FMP|fmp/i.test(t.name ?? ""));
    const responseText = r.responseText ?? "";
    const isRefusal = REFUSAL.test(responseText) || RESOLUTION_FAIL.test(responseText);
    const hasData = hasConcreteData(responseText);
    const passed = outcome === "answer" && toolCalls > 0 && routedToTarget && hasData && !isRefusal && outcome !== "error";
    if (passed) answered += 1;
    const autoWeakFlag = outcome === "error" || outcome === "capability_miss" || isRefusal || toolCalls === 0 || outcome !== "answer";
    if (autoWeakFlag) autoWeak += 1;
    records.push({
      id: r.id,
      prompt: r.query,
      outcomeType: outcome,
      toolCalls,
      routedToTarget,
      toolsUsed: tools.map((t) => t.name),
      responsePreview: responseText.slice(0, 400),
      hasConcreteData: hasData,
      isRefusal,
      autoWeak: autoWeakFlag,
      autoWeakReason: outcome === "error" ? "error_or_timeout" : outcome === "capability_miss" ? "capability_miss_no_tool" : isRefusal ? "refusal_language" : toolCalls === 0 ? "zero_tool_calls" : null,
      latencyMs: r.latencyMs,
      status: passed ? "pass" : "fail",
    });
  }
  const total = records.length;
  const passRate = total > 0 ? answered / total : 0;
  const output = {
    generatedAt: new Date().toISOString(),
    contributor: "fmp-contributor",
    source: "pipeline-query-results.json",
    summary: {
      total,
      answered,
      autoWeakCount: autoWeak,
      passRate: Math.round(passRate * 1000) / 1000,
      avgLatencyMs: Math.round(records.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / (total || 1)),
    },
    results: records,
  };
  writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(`  total=${total} answered=${answered} autoWeak=${autoWeak} passRate=${passRate.toFixed(3)}`);
}

main();
