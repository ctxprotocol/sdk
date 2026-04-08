import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshReleaseDecision } from "./refresh-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseChunk(raw) {
  const t = raw.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    return JSON.parse(fence[1].trim());
  }
  return JSON.parse(t);
}

const c0 = parseChunk(readFileSync(path.join(__dirname, "_reviewer_chunk_raw_0.txt"), "utf8"));
const c1 = parseChunk(readFileSync(path.join(__dirname, "_reviewer_chunk_raw_1.txt"), "utf8"));
const c2 = parseChunk(readFileSync(path.join(__dirname, "_reviewer_chunk_raw_2.txt"), "utf8"));
const c3 = parseChunk(readFileSync(path.join(__dirname, "_reviewer_chunk_raw_3.txt"), "utf8"));
const c4 = parseChunk(readFileSync(path.join(__dirname, "_reviewer_chunk_raw_4.txt"), "utf8"));

const perQueryEvaluations = [
  ...c0.perQueryEvaluations,
  ...c1.perQueryEvaluations,
  ...c2.perQueryEvaluations,
  ...c3.perQueryEvaluations,
  ...c4.perQueryEvaluations,
];

if (perQueryEvaluations.length !== 20) {
  throw new Error(`Expected 20 evaluations, got ${perQueryEvaluations.length}`);
}

const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const free = JSON.parse(readFileSync(path.join(__dirname, "free-baseline-results.json"), "utf8"));

function classifyDifferentiation(query, paidText, freeText) {
  const p = (paidText ?? "").toLowerCase();
  const f = (freeText ?? "").toLowerCase();
  const hasNumsPaid = /\d+\.\d+|\d{2,}/.test(paidText ?? "");
  const hasTs =
    /20\d{2}-\d{2}-\d{2}/.test(paidText ?? "") || /fetched at/i.test(paidText ?? "");
  if (!hasNumsPaid && p.length < 80) return "low_differentiation";
  if (f.length < 30 || (!freeText && f.length === 0)) return "high_differentiation";
  const paidNums = (paidText ?? "").match(/\d\.\d{3,}/g) ?? [];
  const freeNums = (freeText ?? "").match(/\d\.\d{3,}/g) ?? [];
  const overlap =
    paidNums.length > 0 &&
    freeNums.some((n) => paidNums.includes(n));
  if (hasTs && hasNumsPaid && !overlap) return "high_differentiation";
  if (hasNumsPaid && p.length > f.length * 1.2) return "moderate_differentiation";
  if (overlap && paidText.length < freeText.length * 1.1) return "low_differentiation";
  return "moderate_differentiation";
}

const means = perQueryEvaluations.map((e) => e.satisfactionMean);
const satisfactionMeanAgg =
  Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 1000) / 1000;

const highDiffLowSat = [];
for (let i = 0; i < 20; i++) {
  const diff = classifyDifferentiation(
    paid[i].query,
    paid[i].responseText,
    free[i].freeResponse
  );
  perQueryEvaluations[i].differentiation = diff;
  if (diff === "high_differentiation" && perQueryEvaluations[i].satisfactionMean < 3.0) {
    highDiffLowSat.push(i);
  }
}

let high = 0;
let medium = 0;
let low = 0;
const highIds = [];
for (let i = 0; i < perQueryEvaluations.length; i++) {
  const fr = perQueryEvaluations[i].traceAssessment?.fragilityRisk ?? "low";
  if (fr === "high") {
    high += 1;
    highIds.push(`#${i} ${perQueryEvaluations[i].query.slice(0, 60)}…`);
  } else if (fr === "medium") {
    medium += 1;
  } else {
    low += 1;
  }
}

const queriesAbove4 = perQueryEvaluations.filter((e) => e.satisfactionMean >= 4.0).length;
const queriesBelow3 = perQueryEvaluations.filter((e) => e.satisfactionMean < 3.0).length;

const out = {
  reviewedAt: new Date().toISOString(),
  perQueryEvaluations,
  aggregate: {
    satisfactionMean: satisfactionMeanAgg,
    satisfactionMin: Math.min(...means),
    queryCount: 20,
    queriesAbove4,
    queriesBelow3,
    fragilityReport: {
      highCount: high,
      mediumCount: medium,
      lowCount: low,
      highFragilityRate: Math.round((high / 20) * 1000) / 1000,
      highFragilityQueryIds: highIds,
    },
    topImprovementLevers: [
      "Surface fetchedAt and avoid past-query framing in synthesis for all liquidity and market scans.",
      "Harden market-discovery fallbacks (try/catch on check_market_rules 404, paginate get_top_markets when competitive returns empty, do not substitute non-crypto for crypto filters).",
      "Fix contributor find_correlated_markets / find_arbitrage_opportunities limit semantics and summarize_live_market_activity timeouts.",
    ],
    gateCheck: {
      satisfactionMeanGte3_5: satisfactionMeanAgg >= 3.5,
      noHighDiffBelow3: highDiffLowSat.length === 0,
      highFragilityLte0_3: high / 20 <= 0.3,
      highDiffBelow3Indices: highDiffLowSat,
    },
  },
};

writeFileSync(
  path.join(__dirname, "reviewer-evaluation.json"),
  `${JSON.stringify(out, null, 2)}\n`,
  "utf8"
);
refreshReleaseDecision();
console.log("Wrote reviewer-evaluation.json", { satisfactionMeanAgg, high, highDiffLowSat });
