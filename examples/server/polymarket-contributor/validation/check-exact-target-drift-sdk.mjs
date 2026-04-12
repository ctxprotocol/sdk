import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { ContextClient } from "../../../../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const PROMPT_POOL_PATH = path.join(__dirname, "full-enhancement-prompt-pool.json");
const OUTPUT_PATH = path.join(__dirname, "sdk-exact-target-check.latest.json");

loadDotEnv({ path: SDK_ENV_PATH, override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY");
}

const baseUrl = (process.env.CONTEXT_BASE_URL ?? "http://localhost:3000").trim();
const client = new ContextClient({
  apiKey,
  baseUrl,
  requestTimeoutMs: 180_000,
  streamTimeoutMs: 180_000,
});

const targetIds = ["q12"];
const promptPool = JSON.parse(await readFile(PROMPT_POOL_PATH, "utf8"));
const promptMap = new Map(promptPool.map((entry) => [entry.id, entry]));

const results = [];
for (const id of targetIds) {
  const promptEntry = promptMap.get(id);
  if (!promptEntry) {
    throw new Error(`Missing prompt ${id}`);
  }

  const startedAt = Date.now();
  try {
    const result = await client.query.run({
      query: promptEntry.prompt,
      tools: [TOOL_ID],
      responseShape: "answer_with_evidence",
      includeDeveloperTrace: true,
      queryDepth: "deep",
      clarificationPolicy: "auto",
    });
    results.push({
      id,
      latencyMs: Date.now() - startedAt,
      result,
    });
    process.stdout.write(`[ok] ${id} latency=${String(Date.now() - startedAt)}ms\n`);
  } catch (error) {
    results.push({
      id,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    process.stdout.write(
      `[error] ${id} ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`Wrote ${OUTPUT_PATH}\n`);
