import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const research = JSON.parse(readFileSync(path.join(__dirname, "vertical-alpha-research.json"), "utf8"));
const ids = research.mustWinPrompts.map((p) => p.id);

const REFUSALS = [
  /I am unable to/i,
  /I cannot provide/i,
  /I'?m unable to/i,
  /I'?m not able to/i,
  /I do not have/i,
  /no data available/i,
  /could not fulfill/i,
];
const RESOLUTION = [
  /slug not found/i,
  /event not found/i,
  /market not found/i,
  /could not resolve/i,
];

const flags = [];
for (let i = 0; i < paid.length; i++) {
  const r = paid[i];
  const id = ids[i];
  const text = r.responseText || "";
  const trace = r.developerTrace || {};
  const toolCalls = Array.isArray(trace.toolCallHistory) ? trace.toolCallHistory.length : 0;
  const reasons = [];
  for (const rx of REFUSALS) if (rx.test(text)) reasons.push(`refusal:${rx}`);
  for (const rx of RESOLUTION) if (rx.test(text)) reasons.push(`resolution:${rx}`);
  if (toolCalls === 0) reasons.push("zero_tool_calls");
  if (r.outcomeType === "error") reasons.push("http_error");
  if (r.outcomeType === "clarification_required") reasons.push("clarification_required");
  flags.push({
    id,
    query: r.query,
    outcomeType: r.outcomeType,
    toolCalls,
    autoWeak: reasons.length > 0,
    autoWeakReason: reasons[0] || null,
    reasons,
  });
}

writeFileSync(
  path.join(__dirname, "failure-gate.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), flags }, null, 2) + "\n"
);

const weak = flags.filter((f) => f.autoWeak);
console.log(`autoWeak: ${weak.length}/${flags.length}`);
for (const w of weak) console.log(`  ${w.id}: ${w.autoWeakReason} (tools=${w.toolCalls})`);
