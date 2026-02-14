import { ContextClient, ContextError } from "@ctxprotocol/sdk";

// Initialize the client
// In production, use: apiKey: process.env.CONTEXT_API_KEY!
const client = new ContextClient({
  apiKey: "sk_live_your_api_key_here",
  // Uncomment for local development:
  // baseUrl: "http://localhost:3000",
});

async function main() {
  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 1. DISCOVER TOOLS
    // ═══════════════════════════════════════════════════════════════════════
    console.log("🔍 Searching for gas price tools...\n");

    const tools = await client.discovery.search("gas prices");

    if (tools.length === 0) {
      console.log("No tools found for this query.");
      return;
    }

    console.log(`Found ${tools.length} tool(s):\n`);

    tools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name}`);
      console.log(`   ID: ${tool.id}`);
      console.log(`   Description: ${tool.description}`);
      console.log(`   Price: ${tool.price} USDC`);
      console.log(`   Category: ${tool.category ?? "N/A"}`);
      console.log(`   Verified: ${tool.isVerified ? "✓" : "✗"}`);

      if (tool.mcpTools && tool.mcpTools.length > 0) {
        console.log(`   Available methods:`);
        tool.mcpTools.forEach((mcpTool) => {
          console.log(`     - ${mcpTool.name}: ${mcpTool.description}`);

          // Show schemas if available (useful for LLM integration)
          if (mcpTool.inputSchema) {
            console.log(`       Input Schema: ${JSON.stringify(mcpTool.inputSchema)}`);
          }
          if (mcpTool.outputSchema) {
            console.log(`       Output Schema: ${JSON.stringify(mcpTool.outputSchema)}`);
          }
        });
      }
      console.log();
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2. USE SCHEMAS FOR LLM PROMPT GENERATION
    // ═══════════════════════════════════════════════════════════════════════
    const selectedTool = tools[0];

    if (!selectedTool.mcpTools || selectedTool.mcpTools.length === 0) {
      console.log("Selected tool has no available methods.");
      return;
    }

    const methodToCall = selectedTool.mcpTools[0];

    // Example: Build an LLM prompt using the schemas
    console.log("📝 Example LLM Prompt Generation:\n");
    console.log("─".repeat(60));

    const llmPrompt = `You have access to the following tool:

Tool: ${methodToCall.name}
Description: ${methodToCall.description}

${methodToCall.inputSchema ? `Input Schema:\n${JSON.stringify(methodToCall.inputSchema, null, 2)}` : "No input schema defined."}

${methodToCall.outputSchema ? `Output Schema:\n${JSON.stringify(methodToCall.outputSchema, null, 2)}` : "No output schema defined."}

Generate the correct arguments as JSON to get gas prices for Ethereum mainnet.`;

    console.log(llmPrompt);
    console.log("─".repeat(60));
    console.log();

    // ═══════════════════════════════════════════════════════════════════════
    // 3. EXECUTE A TOOL
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`⚡ Executing: ${selectedTool.name} → ${methodToCall.name}\n`);

    const result = await client.tools.execute({
      toolId: selectedTool.id,
      toolName: methodToCall.name,
      args: {
        chainId: 1, // Ethereum mainnet
      },
    });

    console.log("✅ Execution successful!\n");
    console.log("Tool:", result.tool.name);
    console.log("Result:", JSON.stringify(result.result, null, 2));
    console.log(`\n⏱️  Duration: ${result.durationMs}ms`);

    // ═══════════════════════════════════════════════════════════════════════
    // 4. VALIDATE RESULT AGAINST OUTPUT SCHEMA
    // ═══════════════════════════════════════════════════════════════════════
    if (methodToCall.outputSchema) {
      console.log("\n📋 Output matches expected schema:");
      console.log(JSON.stringify(methodToCall.outputSchema, null, 2));
    }
  } catch (error) {
    // ═══════════════════════════════════════════════════════════════════════
    // ERROR HANDLING
    // ═══════════════════════════════════════════════════════════════════════
    if (error instanceof ContextError) {
      console.error("❌ Context Protocol Error:");
      console.error(`   Message: ${error.message}`);
      if (error.code) console.error(`   Code: ${error.code}`);
      if (error.statusCode) console.error(`   HTTP Status: ${error.statusCode}`);

      // Guide users to resolve common issues
      switch (error.code) {
        case "no_wallet":
          console.log(`\n💡 Solution: Set up your wallet at ${error.helpUrl}`);
          break;
        case "insufficient_allowance":
          console.log(`\n💡 Solution: Set a spending cap at ${error.helpUrl}`);
          break;
        case "payment_failed":
          console.log("\n💡 Solution: Check your USDC balance and try again");
          break;
        case "execution_failed":
          console.log("\n💡 The tool encountered an error during execution");
          break;
      }
    } else {
      throw error;
    }
  }
}

main();
