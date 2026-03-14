import { ContextClient } from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}
const baseUrl = process.env.CONTEXT_BASE_URL;
const explicitToolId = process.env.CONTEXT_TOOL_ID;

const client = new ContextClient({
  apiKey,
  ...(baseUrl ? { baseUrl } : {}),
});

async function main() {
  const sourceTool = explicitToolId
    ? { id: explicitToolId, name: "(explicit tool ID)" }
    : (await client.discovery.search("kalshi", 5))[0] ??
      (await client.discovery.getFeatured(1))[0];

  if (!sourceTool) {
    throw new Error("Unable to find a marketplace tool for verification.");
  }

  console.log("Selected tool for verification:", {
    id: sourceTool.id,
    name: sourceTool.name,
  });

  const tool = await client.discovery.get(sourceTool.id);

  console.log("Fetched by ID:", {
    id: tool.id,
    name: tool.name,
    descriptionLength: tool.description.length,
    mcpToolCount: tool.mcpTools?.length ?? 0,
  });

  if (tool.id !== sourceTool.id) {
    throw new Error(`Expected tool ID ${sourceTool.id}, received ${tool.id}`);
  }

  if (!explicitToolId && tool.name !== sourceTool.name) {
    throw new Error(`Expected tool name ${sourceTool.name}, received ${tool.name}`);
  }

  if (tool.description.trim().length === 0) {
    throw new Error("Expected fetched tool description to be non-empty.");
  }

  if (
    !explicitToolId &&
    (tool.mcpTools?.length ?? 0) !== (sourceTool.mcpTools?.length ?? 0)
  ) {
    throw new Error("Fetched tool MCP method count does not match discovery result.");
  }

  console.log("PASS: discovery.get() returned the expected tool payload.");
}

main()
  .finally(() => client.close())
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
