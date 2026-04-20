import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshReleaseDecision } from "./refresh-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDICES = [11, 12, 17, 18];
const RERUN = "reviewer-iter2-rerun.json";

function classifyDifferentiation(paidText, freeText) {
  const p = paidText ?? ""; const f = freeText ?? "";
  const hasNumsPaid = /\d+\.\d+|\d{2,}/.test(p);
  const hasTs = /20\d{2}-\d{2}-\d{2}/.test(p) || /fetched at/i.test(p) || /as of/i.test(p);
  if (!hasNumsPaid && p.length < 80) return "low_differentiation";
  if (f.length < 30) return "high_differentiation";
  if (hasTs && hasNumsPaid) return "high_differentiation";
  if (p.length > f.length * 1.2) return "moderate_differentiation";
  return "low_differentiation";
}

const rerun = JSON.parse(readFileSync(path.join(__dirname, RERUN), "utf8"));
const base = JSON.parse(readFileSync(path.join(__dirname, "reviewer-evaluation.json"), "utf8"));
const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const free = JSON.parse(readFileSync(path.join(__dirname, "free-baseline-results.json"), "utf8"));

if (rerun.perQueryEvaluations.length !== INDICES.length) throw new Error("len mismatch");
const next = { ...base, perQueryEvaluations: [...base.perQueryEvaluations] };
for (let k=0;k<INDICES.length;k++) {
  const i=INDICES[k]; const ev=rerun.perQueryEvaluations[k];
  if (paid[i].query !== ev.query) throw new Error(`query mismatch at ${i}`);
  next.perQueryEvaluations[i]=ev;
}

let high=0,medium=0,low=0; const highDiffLowSat=[];
for (let i=0;i<next.perQueryEvaluations.length;i++) {
  const d=classifyDifferentiation(paid[i].responseText, free[i].freeResponse);
  next.perQueryEvaluations[i].differentiation=d;
  if (d==="high_differentiation") high++; else if (d==="moderate_differentiation") medium++; else low++;
  if (d==="high_differentiation" && next.perQueryEvaluations[i].satisfactionMean<3.0) highDiffLowSat.push(i);
}
const means=next.perQueryEvaluations.map(e=>e.satisfactionMean);
const mean=Math.round((means.reduce((a,b)=>a+b,0)/means.length)*1000)/1000;
let fH=0,fM=0,fL=0; const fIds=[];
for (const e of next.perQueryEvaluations) { const f=e.traceAssessment?.fragilityRisk??"low"; if (f==="high"){fH++;fIds.push(e.query.slice(0,80));} else if (f==="medium") fM++; else fL++; }
const n=next.perQueryEvaluations.length;
const levers=new Set([...(base.aggregate?.topImprovementLevers??[]), ...next.perQueryEvaluations.flatMap(e=>e.traceAssessment?.improvementLever?[e.traceAssessment.improvementLever]:[])]);
next.reviewedAt=new Date().toISOString();
next.aggregate={
  satisfactionMean:mean, satisfactionMin:Math.min(...means), queryCount:n,
  queriesAbove4:next.perQueryEvaluations.filter(e=>e.satisfactionMean>=4.0).length,
  queriesBelow3:next.perQueryEvaluations.filter(e=>e.satisfactionMean<3.0).length,
  fragilityReport:{highCount:fH,mediumCount:fM,lowCount:fL,highFragilityRate:Math.round((fH/n)*1000)/1000,highFragilityQueryIds:fIds},
  differentiationSummary:{high_differentiation:high,moderate_differentiation:medium,low_differentiation:low,baselineBeatenRate:Math.round(((high+medium)/n)*1000)/1000},
  highDifferentiationLowSatisfactionIndices:highDiffLowSat,
  topImprovementLevers:[...levers].slice(0,12),
};
const out=JSON.stringify(next,null,2)+"\n";
writeFileSync(path.join(__dirname,"reviewer-evaluation.json"),out);
writeFileSync(path.join(__dirname,"..","reviewer-evaluation.json"),out);
refreshReleaseDecision();
console.log(`mean=${mean} below3=${next.aggregate.queriesBelow3} lowDiff=${low}/${n}`);
