import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pipelinePath = path.join(__dirname, "pipeline-query-results.json");
const weakPath = path.join(__dirname, "weak-query-rerun-results.json");

const pipeline = JSON.parse(readFileSync(pipelinePath, "utf8"));
const weak = JSON.parse(readFileSync(weakPath, "utf8"));

const mergedIndices = [];
const skipped = [];

for (const [key, row] of Object.entries(weak)) {
  const i = Number.parseInt(key, 10);
  if (!Number.isInteger(i) || i < 0 || i >= pipeline.length) {
    continue;
  }
  const hasAnswer =
    row.outcomeType === "answer" &&
    typeof row.responseText === "string" &&
    row.responseText.length > 0;
  if (!hasAnswer) {
    skipped.push({ index: i, reason: row.outcomeType ?? "no-text", error: row.error });
    continue;
  }
  pipeline[i] = {
    ...pipeline[i],
    responseText: row.responseText,
    developerTrace: row.developerTrace,
    outcomeType: row.outcomeType,
    latencyMs: row.latencyMs ?? pipeline[i].latencyMs,
  };
  mergedIndices.push(i);
}

mergedIndices.sort((a, b) => a - b);
writeFileSync(pipelinePath, `${JSON.stringify(pipeline, null, 2)}\n`);
console.log(`Merged ${mergedIndices.length} rows into pipeline-query-results.json:`, mergedIndices.join(", "));
if (skipped.length > 0) {
  console.log("Skipped:", JSON.stringify(skipped, null, 2));
}
