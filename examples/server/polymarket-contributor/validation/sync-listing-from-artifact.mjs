/**
 * Push marketplace listing fields from marketplace-validation-artifact.json
 * via ContextClient.developer.updateTool() (pipeline Step 1D).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { ContextClient } from "../../../../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_PATH = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");

loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) {
  throw new Error("Missing CONTEXT_API_KEY");
}

const raw = await readFile(ARTIFACT_PATH, "utf8");
const artifact = JSON.parse(raw);
const toolId = artifact.toolIdOrName;
const { generatedDescription, formFields } = artifact;
if (!toolId || typeof generatedDescription !== "string") {
  throw new Error("artifact missing toolIdOrName or generatedDescription");
}

const client = new ContextClient({
  apiKey,
  baseUrl: "https://www.ctxprotocol.com",
});

const updates = {
  description: generatedDescription,
  ...(formFields?.name ? { name: formFields.name } : {}),
  ...(formFields?.category ? { category: formFields.category } : {}),
};

const result = await client.developer.updateTool(toolId, updates);
process.stdout.write(`${JSON.stringify({ ok: true, updatedAt: result.updatedAt }, null, 2)}\n`);
