import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function trimStr(s, max) {
  if (typeof s !== "string") return s;
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

function trimValue(v, maxJson) {
  if (v === null || v === undefined) return v;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.length <= maxJson) return typeof v === "string" ? v : v;
  return trimStr(s, maxJson);
}

function trimTrace(trace) {
  if (!trace || typeof trace !== "object") return trace;
  const out = { ...trace };
  if (Array.isArray(out.toolCallHistory)) {
    out.toolCallHistory = out.toolCallHistory.map((e) => ({
      ...e,
      result: trimValue(e.result, 6_000),
      args: e.args,
      toolName: e.toolName,
    }));
  }
  out.initialCode = trimStr(String(out.initialCode ?? ""), 14_000);
  out.finalCode = trimStr(String(out.finalCode ?? ""), 14_000);
  if (out.executionResult && typeof out.executionResult === "object") {
    const er = { ...out.executionResult };
    if (typeof er.logs === "string") er.logs = trimStr(er.logs, 8_000);
    out.executionResult = er;
  }
  if (out.toolSchemas && typeof out.toolSchemas === "object") {
    const slim = {};
    for (const [name, def] of Object.entries(out.toolSchemas)) {
      if (!def || typeof def !== "object") continue;
      slim[name] = {
        description: trimStr(String(def.description ?? ""), 800),
        inputSchema: trimValue(def.inputSchema, 2_500),
      };
    }
    out.toolSchemas = slim;
  }
  if (Array.isArray(out.timeline)) {
    out.timeline = out.timeline.slice(0, 40);
  }
  return out;
}

const paid = JSON.parse(readFileSync(path.join(__dirname, "pipeline-query-results.json"), "utf8"));
const free = JSON.parse(readFileSync(path.join(__dirname, "free-baseline-results.json"), "utf8"));

if (paid.length !== free.length) {
  throw new Error(`Length mismatch paid=${paid.length} free=${free.length}`);
}

const tuples = paid.map((p, i) => {
  const f = free[i];
  if (p.query !== f.query) {
    throw new Error(`Query mismatch at ${i}`);
  }
  return {
    query: p.query,
    responseText: p.responseText,
    freeResponse: f.freeResponse ?? "",
    developerTrace: trimTrace(p.developerTrace),
  };
});

const half = Math.ceil(tuples.length / 2);
const batch1 = tuples.slice(0, half);
const batch2 = tuples.slice(half);

writeFileSync(path.join(__dirname, "reviewer-batch-1.json"), JSON.stringify(batch1, null, 0) + "\n");
writeFileSync(path.join(__dirname, "reviewer-batch-2.json"), JSON.stringify(batch2, null, 0) + "\n");

const s1 = readFileSync(path.join(__dirname, "reviewer-batch-1.json"), "utf8").length;
const s2 = readFileSync(path.join(__dirname, "reviewer-batch-2.json"), "utf8").length;
console.log(`batch1 ${batch1.length} tuples, ${s1} bytes; batch2 ${batch2.length} tuples, ${s2} bytes`);
