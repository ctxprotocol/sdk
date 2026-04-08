import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshReleaseDecision } from "./refresh-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @param {string} paidText @param {string} freeText */
function classifyDifferentiation(paidText, freeText) {
  const p = paidText ?? "";
  const f = freeText ?? "";
  const hasNumsPaid = /\d+\.\d+|\d{2,}/.test(p);
  const hasTs =
    /20\d{2}-\d{2}-\d{2}/.test(p) || /fetched at/i.test(p) || /as of/i.test(p);
  if (!hasNumsPaid && p.length < 80) return "low_differentiation";
  if (f.length < 30 || (!freeText && f.length === 0)) return "high_differentiation";
  if (hasTs && hasNumsPaid) return "high_differentiation";
  if (p.length > f.length * 1.2) return "moderate_differentiation";
  return "low_differentiation";
}

const batch1Path = path.join(__dirname, "weak-reviewer-batch1-output.json");
const batch2Path = path.join(__dirname, "weak-reviewer-batch2-output.json");
const evalPath = path.join(__dirname, "reviewer-evaluation.json");
const paidPath = path.join(__dirname, "pipeline-query-results.json");
const freePath = path.join(__dirname, "free-baseline-results.json");
const contributorRoot = path.join(__dirname, "..");

const batch1 = JSON.parse(readFileSync(batch1Path, "utf8"));
const batch2 = JSON.parse(readFileSync(batch2Path, "utf8"));
const base = JSON.parse(readFileSync(evalPath, "utf8"));
const paid = JSON.parse(readFileSync(paidPath, "utf8"));
const free = JSON.parse(readFileSync(freePath, "utf8"));

const indicesBatch1 = [0, 2, 3, 8, 10];
const indicesBatch2 = [11, 13, 15, 16];

if (batch1.perQueryEvaluations.length !== indicesBatch1.length) {
  throw new Error(`batch1 length ${batch1.perQueryEvaluations.length}`);
}
if (batch2.perQueryEvaluations.length !== indicesBatch2.length) {
  throw new Error(`batch2 length ${batch2.perQueryEvaluations.length}`);
}

const next = { ...base, perQueryEvaluations: [...base.perQueryEvaluations] };

for (let k = 0; k < indicesBatch1.length; k++) {
  const i = indicesBatch1[k];
  const ev = batch1.perQueryEvaluations[k];
  if (paid[i].query !== ev.query) {
    throw new Error(`batch1 query mismatch at index ${i}`);
  }
  next.perQueryEvaluations[i] = ev;
}

for (let k = 0; k < indicesBatch2.length; k++) {
  const i = indicesBatch2[k];
  const ev = batch2.perQueryEvaluations[k];
  if (paid[i].query !== ev.query) {
    throw new Error(`batch2 query mismatch at index ${i}`);
  }
  next.perQueryEvaluations[i] = ev;
}

let high = 0;
let medium = 0;
let low = 0;
const highDiffLowSat = [];

for (let i = 0; i < next.perQueryEvaluations.length; i++) {
  if (paid[i].query !== next.perQueryEvaluations[i].query) {
    throw new Error(`paid/query mismatch at ${i}`);
  }
  const diff = classifyDifferentiation(paid[i].responseText, free[i].freeResponse);
  next.perQueryEvaluations[i].differentiation = diff;
  if (diff === "high_differentiation") high += 1;
  else if (diff === "moderate_differentiation") medium += 1;
  else low += 1;
  if (diff === "high_differentiation" && next.perQueryEvaluations[i].satisfactionMean < 3.0) {
    highDiffLowSat.push(i);
  }
}

const means = next.perQueryEvaluations.map((e) => e.satisfactionMean);
const satisfactionMeanAgg =
  Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 1000) / 1000;

let fragHigh = 0;
let fragMed = 0;
let fragLow = 0;
const highFragilityQueryIds = [];
for (let i = 0; i < next.perQueryEvaluations.length; i++) {
  const fr = next.perQueryEvaluations[i].traceAssessment?.fragilityRisk ?? "low";
  if (fr === "high") {
    fragHigh += 1;
    highFragilityQueryIds.push(next.perQueryEvaluations[i].query.slice(0, 80));
  } else if (fr === "medium") fragMed += 1;
  else fragLow += 1;
}

const n = next.perQueryEvaluations.length;
const levers = new Set([
  ...(base.aggregate?.topImprovementLevers ?? []),
  ...next.perQueryEvaluations.flatMap((e) =>
    e.traceAssessment?.improvementLever ? [e.traceAssessment.improvementLever] : []
  ),
]);

next.reviewedAt = new Date().toISOString();
next.aggregate = {
  satisfactionMean: satisfactionMeanAgg,
  satisfactionMin: Math.min(...means),
  queryCount: n,
  queriesAbove4: next.perQueryEvaluations.filter((e) => e.satisfactionMean >= 4.0).length,
  queriesBelow3: next.perQueryEvaluations.filter((e) => e.satisfactionMean < 3.0).length,
  fragilityReport: {
    highCount: fragHigh,
    mediumCount: fragMed,
    lowCount: fragLow,
    highFragilityRate: Math.round((fragHigh / n) * 1000) / 1000,
    highFragilityQueryIds,
  },
  differentiationSummary: {
    high_differentiation: high,
    moderate_differentiation: medium,
    low_differentiation: low,
    baselineBeatenRate: Math.round(((high + medium) / n) * 1000) / 1000,
  },
  highDifferentiationLowSatisfactionIndices: highDiffLowSat,
  topImprovementLevers: [...levers].slice(0, 12),
};

const outJson = `${JSON.stringify(next, null, 2)}\n`;
writeFileSync(evalPath, outJson);
writeFileSync(path.join(contributorRoot, "reviewer-evaluation.json"), outJson);
refreshReleaseDecision();

console.log(
  `Wrote reviewer-evaluation.json mean=${satisfactionMeanAgg} below3=${next.aggregate.queriesBelow3} lowDiff=${low}/${n}`
);
