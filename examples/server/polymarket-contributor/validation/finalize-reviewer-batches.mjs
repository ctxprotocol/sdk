import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshReleaseDecision } from "./refresh-release-decision.mjs";
import {
  getRequiredPathInput,
  parseReviewerPayloadSource,
} from "./reviewer-helper-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

const batch1Path = getRequiredPathInput({
  flagName: "--batch1",
  envName: "REVIEWER_BATCH_1_PATH",
  description: "reviewer batch 1 output path",
});
const batch2Path = getRequiredPathInput({
  flagName: "--batch2",
  envName: "REVIEWER_BATCH_2_PATH",
  description: "reviewer batch 2 output path",
});

const b1 = parseReviewerPayloadSource(batch1Path);
const b2 = parseReviewerPayloadSource(batch2Path);

if (!Array.isArray(b1.perQueryEvaluations) || !Array.isArray(b2.perQueryEvaluations)) {
  throw new Error("Reviewer batch inputs must contain perQueryEvaluations arrays.");
}

const perQueryEvaluations = [...b1.perQueryEvaluations, ...b2.perQueryEvaluations];

const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const free = JSON.parse(readFileSync(path.join(__dirname, "free-baseline-results.json"), "utf8"));

if (perQueryEvaluations.length !== paid.length || paid.length !== free.length) {
  throw new Error(
    `Length mismatch evaluations=${perQueryEvaluations.length} paid=${paid.length} free=${free.length}`
  );
}

let high = 0;
let medium = 0;
let low = 0;
const highDiffLowSat = [];

for (let i = 0; i < perQueryEvaluations.length; i++) {
  if (paid[i].query !== perQueryEvaluations[i].query) {
    throw new Error(`Query mismatch at ${i}`);
  }
  const diff = classifyDifferentiation(paid[i].responseText, free[i].freeResponse);
  perQueryEvaluations[i].differentiation = diff;
  if (diff === "high_differentiation") high += 1;
  else if (diff === "moderate_differentiation") medium += 1;
  else low += 1;
  if (diff === "high_differentiation" && perQueryEvaluations[i].satisfactionMean < 3.0) {
    highDiffLowSat.push(i);
  }
}

const means = perQueryEvaluations.map((e) => e.satisfactionMean);
const satisfactionMeanAgg =
  Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 1000) / 1000;

let fragHigh = 0;
let fragMed = 0;
let fragLow = 0;
const highFragilityQueryIds = [];
for (let i = 0; i < perQueryEvaluations.length; i++) {
  const fr = perQueryEvaluations[i].traceAssessment?.fragilityRisk ?? "low";
  if (fr === "high") {
    fragHigh += 1;
    highFragilityQueryIds.push(perQueryEvaluations[i].query.slice(0, 80));
  } else if (fr === "medium") fragMed += 1;
  else fragLow += 1;
}

const n = perQueryEvaluations.length;
const out = {
  reviewedAt: new Date().toISOString(),
  perQueryEvaluations,
  aggregate: {
    satisfactionMean: satisfactionMeanAgg,
    satisfactionMin: Math.min(...means),
    queryCount: n,
    queriesAbove4: perQueryEvaluations.filter((e) => e.satisfactionMean >= 4.0).length,
    queriesBelow3: perQueryEvaluations.filter((e) => e.satisfactionMean < 3.0).length,
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
    topImprovementLevers: [
      ...new Set([
        ...(b1.aggregate?.topImprovementLevers ?? []),
        ...(b2.aggregate?.topImprovementLevers ?? []),
      ]),
    ].slice(0, 8),
  },
};

writeFileSync(path.join(__dirname, "reviewer-evaluation.json"), `${JSON.stringify(out, null, 2)}\n`);
refreshReleaseDecision();
console.log(
  `Wrote reviewer-evaluation.json mean=${satisfactionMeanAgg} highFragRate=${out.aggregate.fragilityReport.highFragilityRate} lowDiff=${low}/${n}`
);

if (low / n > 0.5) {
  console.warn("WARNING: >50% low_differentiation — value proposition review suggested.");
}
if (highDiffLowSat.length > 0) {
  console.warn("WARNING: high_differentiation with satisfaction < 3.0 at indices:", highDiffLowSat);
}
