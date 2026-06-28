// Builds reviewer-input.json: per-prompt { id, query, responseText, developerTrace,
// freeResponse, autoWeak, autoWeakReason, groundedEntity, alphaCategory } merged from
// pipeline-query-results.json + free-baseline-results.json. The pipeline-reviewer
// subagent reads this and writes reviewer-evaluation.json.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAID = path.resolve(__dirname, "pipeline-query-results.json");
const FREE = path.resolve(__dirname, "free-baseline-results.json");
const OUT = path.resolve(__dirname, "reviewer-input.json");

const REFUSAL = /I am unable to|I cannot provide|I'm unable to|I'm not able to|I do not have|no data available|could not fulfill/i;
const RESOLUTION_FAIL = /slug not found|event not found|market not found|could not resolve/i;

function main() {
  const paid = JSON.parse(readFileSync(PAID, "utf8"));
  let free = [];
  try { free = JSON.parse(readFileSync(FREE, "utf8")); } catch { free = []; }
  const freeById = new Map(free.map((f) => [f.id, f.freeResponse ?? ""]));

  const input = paid.map((r) => {
    const outcome = r.outcomeType ?? "unknown";
    const tools = Array.isArray(r.toolsUsed) ? r.toolsUsed : [];
    const toolCalls = r.developerTrace?.summary?.toolCalls ?? tools.length;
    const responseText = r.responseText ?? "";
    const isRefusal = REFUSAL.test(responseText) || RESOLUTION_FAIL.test(responseText);
    const autoWeak = outcome === "error" || outcome === "capability_miss" || isRefusal || toolCalls === 0 || outcome !== "answer";
    const autoWeakReason = outcome === "error" ? "error_or_timeout" : outcome === "capability_miss" ? "capability_miss_no_tool_selected" : isRefusal ? "refusal_language" : toolCalls === 0 ? "zero_tool_calls" : null;
    return {
      id: r.id,
      query: r.query,
      groundedEntity: r.groundedEntity ?? null,
      alphaCategory: r.alphaCategory ?? null,
      expectedChartShape: r.expectedChartShape ?? null,
      responseText,
      developerTrace: r.developerTrace,
      toolsUsed: tools.map((t) => t.name),
      outcomeType: outcome,
      freeResponse: freeById.get(r.id) ?? "",
      autoWeak,
      autoWeakReason,
    };
  });
  writeFileSync(OUT, JSON.stringify(input, null, 2) + "\n", "utf8");
  const autoWeakCount = input.filter((x) => x.autoWeak).length;
  console.log(`Wrote ${OUT}`);
  console.log(`  prompts=${input.length} autoWeak=${autoWeakCount}`);
  console.log(`  autoWeak ids: ${input.filter((x) => x.autoWeak).map((x) => x.id).join(", ")}`);
}

main();
