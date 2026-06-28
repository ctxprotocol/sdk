// Merges reviewer-evaluation-batch-*.json into reviewer-evaluation.json,
// applies the deterministic autoWeak cap (autoWeak prompts capped at
// satisfactionMean 2.0), and recomputes the aggregate block the
// release-decision hook reads (satisfactionMean, fragilityReport,
// differentiationCounts, baselineBeatenRate, queryCount, queriesBelow3, etc.).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INPUT = path.resolve(__dirname, "reviewer-input.json");
const OUT = path.resolve(__dirname, "reviewer-evaluation.json");

function readJson(p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }

function classifyDiff(paid, free) {
  // high: paid has specific live data free lacks; low: paid ~= free generic.
  const paidHasData = /[$]\s?\d|\b\d+(?:\.\d+)?%|\b\d[\d,]*\b|revenue|earnings|dividend|sector|score|yield/i.test(paid ?? "");
  const freeGeneric = /I (do not|don't) have|I (cannot|can't) (access|provide)|as of (my last|the latest)|I don't have real-time|I don't have access to (real-time|live)/i.test(free ?? "");
  if (paidHasData && freeGeneric) return "high_differentiation";
  if (paidHasData && !freeGeneric) return "moderate_differentiation";
  return "low_differentiation";
}

function main() {
  const input = JSON.parse(readFileSync(INPUT, "utf8"));
  const autoWeakById = new Map(input.map((r) => [r.id, r.autoWeak]));
  const freeById = new Map(input.map((r) => [r.id, r.freeResponse ?? ""]));
  const paidById = new Map(input.map((r) => [r.id, r.responseText ?? ""]));

  const batchFiles = readdirSync(__dirname).filter((f) => /^reviewer-evaluation-batch-\d+\.json$/.test(f)).sort();
  const perQuery = [];
  for (const f of batchFiles) {
    const data = readJson(path.resolve(__dirname, f));
    if (Array.isArray(data?.perQueryEvaluations)) perQuery.push(...data.perQueryEvaluations);
  }
  if (perQuery.length === 0) throw new Error("No reviewer-evaluation-batch-*.json found with perQueryEvaluations.");

  // Preserve input order.
  const order = input.map((r) => r.id);
  const byId = new Map(perQuery.map((e) => [e.promptId ?? e.id, e]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);

  // Apply autoWeak cap + differentiation.
  for (const e of ordered) {
    const id = e.promptId ?? e.id;
    if (autoWeakById.get(id)) {
      e.autoWeak = true;
      e.autoWeakReason = input.find((r) => r.id === id)?.autoWeakReason ?? "auto_weak";
      if (typeof e.satisfactionMean !== "number" || e.satisfactionMean > 2.0) {
        e.satisfactionMean = 2.0;
      }
      if (e.satisfactionScores) {
        for (const k of Object.keys(e.satisfactionScores)) e.satisfactionScores[k] = Math.min(e.satisfactionScores[k], 2);
      }
    } else {
      e.autoWeak = false;
    }
    e.differentiation = classifyDiff(paidById.get(id), freeById.get(id));
  }

  // Recompute aggregate.
  const means = ordered.map((e) => e.satisfactionMean);
  const satisfactionMean = means.reduce((a, b) => a + b, 0) / (means.length || 1);
  const frag = { high: 0, medium: 0, low: 0, highIds: [] };
  for (const e of ordered) {
    const risk = e.traceAssessment?.fragilityRisk ?? "low";
    if (risk === "high") { frag.high += 1; frag.highIds.push(e.promptId ?? e.id); }
    else if (risk === "medium") frag.medium += 1;
    else frag.low += 1;
  }
  const diffCounts = { high_differentiation: 0, moderate_differentiation: 0, low_differentiation: 0 };
  let baselineBeaten = 0;
  for (const e of ordered) {
    diffCounts[e.differentiation] = (diffCounts[e.differentiation] ?? 0) + 1;
    if (e.differentiation !== "low_differentiation") baselineBeaten += 1;
  }
  const queryCount = ordered.length;
  const queriesBelow3 = ordered.filter((e) => e.satisfactionMean < 3.0).length;
  const weakCount = ordered.filter((e) => e.satisfactionMean < 4.0).length;
  const aggregate = {
    satisfactionMean: Math.round(satisfactionMean * 1000) / 1000,
    satisfactionMin: Math.min(...means),
    queryCount,
    queriesAbove4: ordered.filter((e) => e.satisfactionMean >= 4.0).length,
    queriesBelow3,
    weakQueryCount: weakCount,
    weakQueryRate: Math.round((weakCount / (queryCount || 1)) * 1000) / 1000,
    fragilityReport: {
      highCount: frag.high, mediumCount: frag.medium, lowCount: frag.low,
      highFragilityRate: Math.round((frag.high / (queryCount || 1)) * 1000) / 1000,
      highFragilityQueryIds: frag.highIds,
    },
    differentiationCounts: diffCounts,
    differentiationSummary: { ...diffCounts, baselineBeatenRate: Math.round((baselineBeaten / (queryCount || 1)) * 10000) / 10000 },
    baselineBeatenRate: Math.round((baselineBeaten / (queryCount || 1)) * 10000) / 10000,
    topImprovementLevers: ["Improve tool descriptions so scout selects insider_activity / congressional_trades / sec_filings on relevant prompts (capability_miss root cause)", "Reduce agent wall-time on multi-step sector/relative-value prompts (timeout root cause)", "Tighten synthesis to surface the specific FMP fields the buyer asked for"],
  };

  const output = {
    reviewedAt: new Date().toISOString(),
    reviewSource: "pipeline-reviewer (3 parallel batches, glm-5.2-max) + autoWeak cap 2.0 + differentiation classifier",
    perQueryEvaluations: ordered,
    aggregate,
  };
  writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(`  queryCount=${queryCount} satisfactionMean=${aggregate.satisfactionMean} weakRate=${aggregate.weakQueryRate} baselineBeatenRate=${aggregate.baselineBeatenRate} highFragilityRate=${aggregate.fragilityReport.highFragilityRate}`);
  console.log(`  differentiation: ${JSON.stringify(diffCounts)}`);
  console.log(`  autoWeak capped: ${ordered.filter((e) => e.autoWeak).length}`);
}

main();
