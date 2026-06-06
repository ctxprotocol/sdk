import { ContextClient, type SuggestedPrompt } from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}

const toolId = process.env.CONTEXT_TOOL_ID;
if (!toolId) {
  throw new Error("Set CONTEXT_TOOL_ID to a tool owned by CONTEXT_API_KEY.");
}

const baseUrl = process.env.CONTEXT_BASE_URL;
const client = new ContextClient({
  apiKey,
  ...(baseUrl ? { baseUrl } : {}),
});

const testPrompts: SuggestedPrompt[] = [
  {
    text: "What are the strongest markets to inspect right now?",
    source: "sdk",
  },
  {
    text: "Compare the top opportunities by liquidity and freshness.",
    source: "sdk",
  },
  {
    text: "Show me a ranked summary with the key evidence fields.",
    source: "sdk",
  },
  {
    text: "Which result has the best risk-adjusted signal today?",
    source: "sdk",
  },
  {
    text: "Explain the most important changes since yesterday.",
    source: "sdk",
  },
];

async function main() {
  const originalTool = await client.discovery.get(toolId);
  const originalPrompts = originalTool.suggestedPrompts ?? [];

  console.log("Original suggested prompt count:", originalPrompts.length);

  const updated = await client.developer.updateTool(toolId, {
    suggestedPrompts: testPrompts,
  });

  if (updated.suggestedPrompts.length !== testPrompts.length) {
    throw new Error("PATCH response did not include the expected prompt count.");
  }

  const fetched = await client.discovery.get(toolId);
  if ((fetched.suggestedPrompts ?? []).length !== testPrompts.length) {
    throw new Error("GET response did not round-trip suggested prompts.");
  }

  await client.developer.updateTool(toolId, {
    suggestedPrompts: originalPrompts,
  });

  console.log("PASS: suggestedPrompts update and restore round-trip succeeded.");
}

main()
  .finally(() => client.close())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
