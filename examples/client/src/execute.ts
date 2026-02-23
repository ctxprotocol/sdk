import { ContextClient, ContextError } from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}

const client = new ContextClient({ apiKey });

async function main() {
  try {
    const tools = await client.discovery.search({
      query: "crypto prices",
      mode: "execute",
      surface: "execute",
      requireExecutePricing: true,
    });

    const executeTool = tools.find((tool) =>
      tool.mcpTools?.some((method) =>
        Boolean(method.executePriceUsd ?? method._meta?.pricing?.executeUsd)
      )
    );

    const executeMethod =
      executeTool?.mcpTools?.find((method) =>
        Boolean(method.executePriceUsd ?? method._meta?.pricing?.executeUsd)
      ) ?? executeTool?.mcpTools?.[0];

    if (!executeTool || !executeMethod) {
      console.log("No execute-eligible methods found for this query.");
      return;
    }

    const started = await client.tools.startSession({ maxSpendUsd: "2.00" });
    const sessionId = started.session.sessionId;
    if (!sessionId) {
      throw new Error("Expected execute session ID from startSession.");
    }

    const executeOnce = async (symbol: string) => {
      const result = await client.tools.execute({
        toolId: executeTool.id,
        toolName: executeMethod.name,
        args: { symbol },
        sessionId,
      });

      console.log(`Executed ${executeMethod.name} for ${symbol}`);
      console.log("Method price (USD):", result.method.executePriceUsd);
      console.log("Session spent (USD):", result.session.spent);
      console.log("Session remaining (USD):", result.session.remaining);
    };

    await executeOnce("BTC/USDT");
    await executeOnce("ETH/USDT");
    await executeOnce("SOL/USDT");

    const closed = await client.tools.closeSession(sessionId);
    console.log("Session closed status:", closed.session.status);

    const finalSession = await client.tools.getSession(sessionId);
    console.log("Final session state:", finalSession.session);
  } catch (error) {
    if (error instanceof ContextError) {
      console.error("Context Protocol error:", error.message);
      switch (error.code) {
        case "method_not_execute_eligible":
        case "session_budget_exceeded":
        case "session_closed":
        case "session_expired":
          console.error("Error code:", error.code);
          return;
        default:
          throw error;
      }
    }
    throw error;
  }
}

main();
