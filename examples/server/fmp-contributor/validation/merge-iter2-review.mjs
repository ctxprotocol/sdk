// Merges reviewer-evaluation-iter2.json (re-review of the 4 re-run weak queries)
// into reviewer-evaluation.json: overrides the 4 entries by promptId, re-applies
// autoWeak cap, recomputes differentiation for the 4, and recomputes the aggregate.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = path.resolve(__dirname, "reviewer-evaluation.json");
const ITER2 = path.resolve(__dirname, "reviewer-evaluation-iter2.json");
const INPUT = path.resolve(__dirname, "reviewer-input.json");

function classifyDiff(paid, free) {
  const paidHasData = /[$]\s?\d|\b\d+(?:\.\d+)?%|\b\d[\d,]*\b|revenue|earnings|dividend|sector|score|yield/i.test(paid ?? "");
  const freeGeneric = /I (do not|don't) have|I (cannot|can't) (access|provide)|as of (my last|the latest)|I don't have real-time|I don't have access to (real-time|live)/i.test(free ?? "");
  if (paidHasData && freeGeneric) return "high_differentiation";
  if (paidHasData && !freeGeneric) return "moderate_differentiation";
  return "low_differentiation";
}

function main() {
  const base = JSON.parse(readFileSync(BASE, "utf8"));
  const iter2 = JSON.parse(readFileSync(ITER2, "utf8"));
  const input = JSON.parse(readFileSync(INPUT, "utf8"));
  const autoWeakById = new Map(input.map((r) => [r.id, r.autoWeak]));
  const freeById = new Map(input.map((r) => [r.id, r.freeResponse ?? ""]));
  const paidById = new Map(input.map((r) => [r.id, r.responseText ?? ""]));

  const iter2ById = new Map((iter2.perQueryEvaluations ?? []).map((e) => [e.promptId ?? e.id, e]));
  const overridden = new Set();
  const ordered = base.perQueryEvaluations.map((e) => {
    const id = e.promptId ?? e.id;
    const fresh = iter2ById.get(id);
    if (fresh) {
      overridden.add(id);
      const merged = { ...fresh, promptId: id };
      merged.autoWeak = Boolean(autoWeakById.get(id));
      if (merged.autoWeak && (typeof merged.satisfactionMean !== "number" || merged.satisfactionMean > 2.0)) {
        merged.satisfactionMean = 2.0;
        if (merged.satisfactionScores) for (const k of Object.keys(merged.satisfactionScores)) merged.satisfactionScores[k] = Math.min(merged.satisfactionScores[k], 2);
      }
      merged.differentiation = classifyDiff(paidById.get(id), freeById.get(id));
      return merged;
    }
    return e;
  });
  const missing = [...iter2ById.keys()].filter((id) => !overridden.has(id));
  if (missing.length) console.log(`WARN: iter2 entries not in base (will be appended): ${missing.join(", ")}`);
  for (const id of missing) {
    const fresh = iter2ById.get(id);
    ordered.push({ ...fresh, promptId: id, autoWeak: Boolean(autoWeakById.get(id)), differentiation: classifyDiff(paidById.get(id), freeById.get(id)) });
  }

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
  const weakCount = ordered.filter((e) => e.satisfactionMean < 4.0).length;
  const aggregate = {
    satisfactionMean: Math.round(satisfactionMean * 1000) / 1000,
    satisfactionMin: Math.min(...means),
    queryCount,
    queriesAbove4: ordered.filter((e) => e.satisfactionMean >= 4.0).length,
    queriesBelow3: ordered.filter((e) => e.satisfactionMean < 3.0).length,
    weakQueryCount: weakCount,
    weakQueryRate: Math.round((weakCount / (queryCount || 1)) * 1000) / 1000,
    fragilityReport: { highCount: frag.high, mediumCount: frag.medium, lowCount: frag.low, highFragilityRate: Math.round((frag.high / (queryCount || 1)) * 1000) / 1000, highFragilityQueryIds: frag.highIds },
    differentiationCounts: diffCounts,
    differentiationSummary: { ...diffCounts, baselineBeatenRate: Math.round((baselineBeaten / (queryCount || 1)) * 10000) / 10000 },
    baselineBeatenRate: Math.round((baselineBeaten / (queryCount || 1)) * 10000) / 10000,
    topImprovementLevers: base.aggregate?.topImprovementLevers ?? [],
  };
  const output = { reviewedAt: new Date().toISOString(), reviewSource: "pipeline-reviewer iter2 override (4 re-run weak queries) + autoWeak cap 2.0 + differentiation classifier", perQueryEvaluations: ordered, aggregate };
  writeFileSync(BASE, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote ${BASE}`);
  console.log(`  overridden=${overridden.size} queryCount=${queryCount} satisfactionMean=${aggregate.satisfactionMean} weakRate=${aggregate.weakQueryRate} baselineBeatenRate=${aggregate.baselineBeatenRate} highFragilityRate=${aggregate.fragilityReport.highFragilityRate}`);
  console.log(`  differentiation: ${JSON.stringify(diffCounts)}`);
  console.log(`  weak remaining: ${ordered.filter((e) => e.satisfactionMean < 4.0).map((e) => `${e.promptId}=${e.satisfactionMean}`).join(", ") || "none"}`);
}

main();
