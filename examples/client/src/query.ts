import {
  ContextClient,
  ContextError,
  type QueryDeveloperTrace,
} from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}

const client = new ContextClient({ apiKey });

function summarizeDeveloperTrace(trace: QueryDeveloperTrace | undefined): {
  retries: number;
  toolCalls: number;
  loops: number;
} {
  const timeline = trace?.timeline ?? [];
  const countStep = (stepType: string): number =>
    timeline.filter(
      (step) => step.stepType === stepType || step.event === stepType
    ).length;

  return {
    retries: trace?.summary?.retryCount ?? countStep("retry"),
    toolCalls: trace?.summary?.toolCalls ?? countStep("tool-call"),
    loops: trace?.summary?.loopCount ?? countStep("loop"),
  };
}

async function main() {
  try {
    const answer = await client.query.run({
      query:
        "What are the top whale movements on Base, and what confidence checks did you run?",
      queryDepth: "deep",
      includeDeveloperTrace: true,
    });
    console.log("Response:", answer.response);
    console.log("Total cost (USD):", answer.cost.totalCostUsd);
    console.log("Duration (ms):", answer.durationMs);
    console.log("Tools used:", answer.toolsUsed);
    console.log(
      "Developer trace summary:",
      summarizeDeveloperTrace(answer.developerTrace)
    );

    // tools omitted => auto-discovery, tools: ["id"] => manual selected tools, tools: [] => direct synthesis (no tool execution)
    // Manual overload shape: await client.query.run({ query: "Analyze whale activity", tools: ["tool-uuid"] });
    const manualToolId = answer.toolsUsed.at(0)?.id;
    if (manualToolId) {
      const manualAnswer = await client.query.run({
        query: "Summarize those whale movements in 3 bullets.",
        tools: [manualToolId],
      });
      console.log("Manual mode response:", manualAnswer.response);
    }
  } catch (error) {
    if (error instanceof ContextError) {
      console.error("Context Protocol error:", error.message);
      switch (error.code) {
        case "no_wallet":
        case "insufficient_allowance":
        case "payment_failed":
        case "query_failed":
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
