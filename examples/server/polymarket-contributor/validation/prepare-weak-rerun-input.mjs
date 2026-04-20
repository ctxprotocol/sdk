import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function trimStr(s, max) { if (typeof s !== "string") return s; return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`; }
function trimValue(v, maxJson) { if (v == null) return v; const s = typeof v === "string" ? v : JSON.stringify(v); if (s.length <= maxJson) return v; return trimStr(s, maxJson); }
function trimTrace(trace) {
  if (!trace || typeof trace !== "object") return trace;
  const out = { ...trace };
  if (Array.isArray(out.toolCallHistory)) out.toolCallHistory = out.toolCallHistory.map((e) => ({ ...e, result: trimValue(e.result, 6000), args: e.args, toolName: e.toolName }));
  out.initialCode = trimStr(String(out.initialCode ?? ""), 14000);
  out.finalCode = trimStr(String(out.finalCode ?? ""), 14000);
  if (out.executionResult && typeof out.executionResult === "object") { const er = { ...out.executionResult }; if (typeof er.logs === "string") er.logs = trimStr(er.logs, 8000); out.executionResult = er; }
  if (out.toolSchemas && typeof out.toolSchemas === "object") { const slim = {}; for (const [name, def] of Object.entries(out.toolSchemas)) { if (!def || typeof def !== "object") continue; slim[name] = { description: trimStr(String(def.description ?? ""), 800), inputSchema: trimValue(def.inputSchema, 2500) }; } out.toolSchemas = slim; }
  if (Array.isArray(out.timeline)) out.timeline = out.timeline.slice(0, 40);
  return out;
}

const INDICES = JSON.parse(process.env.INDICES ?? "[4,9,11,12,13,15,17,18]");
const OUT = process.env.OUT ?? path.join(__dirname, "reviewer-weak-rerun-input.json");

const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const free = JSON.parse(readFileSync(path.join(__dirname, "free-baseline-results.json"), "utf8"));
const research = JSON.parse(readFileSync(path.join(__dirname, "vertical-alpha-research.json"), "utf8"));
const ids = research.mustWinPrompts.map((p) => p.id);

const tuples = INDICES.map((i) => ({
  promptId: ids[i],
  query: paid[i].query,
  responseText: paid[i].responseText,
  freeResponse: free[i].freeResponse ?? "",
  developerTrace: trimTrace(paid[i].developerTrace),
}));

writeFileSync(OUT, JSON.stringify(tuples, null, 0) + "\n");
console.log(`wrote ${tuples.length} tuples -> ${OUT}, ${statSync(OUT).size} bytes`);
