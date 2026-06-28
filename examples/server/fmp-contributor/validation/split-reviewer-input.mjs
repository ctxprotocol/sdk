// Splits reviewer-input.json into N batch files (reviewer-input-batch-K.json)
// so each reviewer subagent call gets a manageable chunk.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN = path.resolve(__dirname, "reviewer-input.json");
const BATCHES = Number(process.argv[2] ?? 3);

function main() {
  const input = JSON.parse(readFileSync(IN, "utf8"));
  const n = input.length;
  const size = Math.ceil(n / BATCHES);
  for (let k = 0; k < BATCHES; k += 1) {
    const slice = input.slice(k * size, Math.min((k + 1) * size, n));
    const out = path.resolve(__dirname, `reviewer-input-batch-${k + 1}.json`);
    writeFileSync(out, JSON.stringify(slice, null, 2) + "\n", "utf8");
    console.log(`batch ${k + 1}: ${slice.length} prompts -> ${out} ids: ${slice.map((s) => s.id).join(", ")}`);
  }
}

main();
