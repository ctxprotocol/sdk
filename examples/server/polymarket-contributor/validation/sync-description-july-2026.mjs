import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";
import { ContextClient } from "@ctxprotocol/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";

// Load CONTEXT_API_KEY from context-sdk/.env.local (skill: source of truth)
loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY (context-sdk/.env.local)");

// Read generatedDescription + showcasePrompts from the validation artifact
const ART = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const artifact = JSON.parse(readFileSync(ART, "utf8"));
const description = artifact.generatedDescription;
const showcase = artifact.promptSets?.showcasePrompts ?? [];

if (!description) throw new Error("Artifact missing generatedDescription");
if (!Array.isArray(showcase) || showcase.length < 7 || showcase.length > 10) {
  throw new Error(`Artifact showcasePrompts count out of [7,10]: ${showcase.length}`);
}

const suggestedPrompts = showcase.map((text) => ({ text, source: "sdk" }));

console.log(`Description sync: ${TOOL_ID}`);
console.log(`  description length: ${description.length} chars`);
console.log(`  suggestedPrompts: ${suggestedPrompts.length}`);
console.log(`  target: production (ContextClient default https://www.ctxprotocol.com)`);

const client = new ContextClient({ apiKey });
try {
  const updated = await client.developer.updateTool(TOOL_ID, { description, suggestedPrompts });
  console.log("\n=== UPDATE RESULT ===");
  console.log("  id:", updated.id);
  console.log("  name:", updated.name);
  console.log("  category:", updated.category);
  console.log("  updatedAt:", updated.updatedAt);
  console.log("  returned description length:", (updated.description ?? "").length);
  console.log("  returned suggestedPrompts:", (updated.suggestedPrompts ?? []).length);
  if ((updated.description ?? "").length !== description.length) {
    console.log("  WARN: returned description length differs from sent -- server may have normalized.");
  }
  console.log("\nDescription sync: PASS");
} catch (e) {
  console.error("\nDescription sync: FAIL");
  console.error("  error:", e?.message ?? String(e));
  if (e?.code) console.error("  code:", e.code);
  if (e?.status) console.error("  status:", e.status);
  process.exit(1);
} finally {
  client.close?.();
}
