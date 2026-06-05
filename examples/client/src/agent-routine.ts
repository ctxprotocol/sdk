/// <reference lib="dom" />

import {
  ContextClient,
  ContextError,
  type QueryResult,
  type Tool,
} from "@ctxprotocol/sdk";

declare const process: {
  env: Record<string, string | undefined>;
};

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}

const client = new ContextClient({ apiKey });

const routineQuestion =
  process.env.CONTEXT_ROUTINE_QUESTION ??
  "Using available premium order-flow tools, analyze BTC over the last 60 days at 1h resolution. Return evidence for whether high-timeframe bias favors long, short, or neutral.";

const pinnedToolIds = (process.env.CONTEXT_ROUTINE_TOOL_IDS ?? "")
  .split(",")
  .map((toolId) => toolId.trim())
  .filter((toolId) => toolId.length > 0);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDataUrl(result: QueryResult): string | undefined {
  if (result.dataUrl) {
    return result.dataUrl;
  }

  if (result.outcomeType !== "answer" || !isRecord(result.artifacts)) {
    return undefined;
  }

  const artifactDataUrl = result.artifacts.dataUrl;
  if (typeof artifactDataUrl === "string" && artifactDataUrl.length > 0) {
    return artifactDataUrl;
  }

  const canonicalDataRef = result.artifacts.canonicalDataRef;
  if (!isRecord(canonicalDataRef)) {
    return undefined;
  }

  const publicDataUrl = canonicalDataRef.publicDataUrl;
  return typeof publicDataUrl === "string" && publicDataUrl.length > 0
    ? publicDataUrl
    : undefined;
}

async function fetchJsonDataUrl(dataUrl: string): Promise<unknown> {
  const response = await fetch(dataUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch dataUrl: ${response.status}`);
  }
  return response.json();
}

function summarizeDataShape(data: unknown): string {
  if (Array.isArray(data)) {
    return `array(${data.length})`;
  }

  if (isRecord(data)) {
    const keys = Object.keys(data).slice(0, 12);
    return `object keys: ${keys.join(", ") || "(none)"}`;
  }

  return typeof data;
}

function deriveRoutineSignal(result: QueryResult, fullData: unknown): {
  bias: "long" | "short" | "neutral";
  confidence: "high" | "medium" | "low";
  reason: string;
} {
  const text = [
    result.response,
    result.outcomeType === "answer" ? result.summary : "",
    result.outcomeType === "answer" ? result.confidence?.reason : "",
  ]
    .join("\n")
    .toLowerCase();

  const longSignals = ["long", "bullish", "accumulation", "spot bid"].filter(
    (term) => text.includes(term)
  ).length;
  const shortSignals = [
    "short",
    "bearish",
    "distribution",
    "perp selling",
  ].filter((term) => text.includes(term)).length;

  if (longSignals > shortSignals) {
    return {
      bias: "long",
      confidence: longSignals >= shortSignals + 2 ? "medium" : "low",
      reason: `Evidence text leaned long; fetched data shape was ${summarizeDataShape(fullData)}.`,
    };
  }

  if (shortSignals > longSignals) {
    return {
      bias: "short",
      confidence: shortSignals >= longSignals + 2 ? "medium" : "low",
      reason: `Evidence text leaned short; fetched data shape was ${summarizeDataShape(fullData)}.`,
    };
  }

  return {
    bias: "neutral",
    confidence: "low",
    reason: `Evidence text was mixed; fetched data shape was ${summarizeDataShape(fullData)}.`,
  };
}

function printRoutineRecipe(result: QueryResult, dataUrl: string | undefined) {
  console.log("Suggested routine recipe:");
  console.log("Question template:", routineQuestion);
  console.log("Response shape: evidence_only");
  console.log("Full-data handoff: includeDataUrl=true");
  console.log(
    "Pinned tool candidates:",
    result.toolsUsed.map((tool) => ({
      id: tool.id,
      name: tool.name,
    }))
  );
  console.log("Data URL:", dataUrl ?? "No dataUrl returned");
}

function getExecuteEligibleMethod(tool: Tool) {
  return tool.mcpTools?.find((method) =>
    Boolean(method.executePriceUsd ?? method._meta?.pricing?.executeUsd)
  );
}

async function discoverExecuteUpgradePath() {
  const executeTools = await client.discovery.search({
    query: routineQuestion,
    mode: "execute",
    surface: "execute",
    requireExecutePricing: true,
    limit: 5,
  });

  const candidate = executeTools
    .map((tool) => ({ tool, method: getExecuteEligibleMethod(tool) }))
    .find(({ method }) => Boolean(method));

  if (!candidate?.method) {
    console.log(
      "No execute-eligible method found for this routine. Keep using pinned Query."
    );
    return;
  }

  console.log("Execute upgrade candidate:");
  console.log("Tool:", candidate.tool.name, candidate.tool.id);
  console.log("Method:", candidate.method.name);
  console.log("Input schema:", candidate.method.inputSchema ?? {});
}

async function main() {
  try {
    console.log("Running Context analyst routine");
    console.log("Question:", routineQuestion);
    console.log(
      pinnedToolIds.length > 0
        ? `Pinned Query toolIds: ${pinnedToolIds.join(", ")}`
        : "Auto Mode: no pinned toolIds"
    );

    const result = await client.query.run({
      query: routineQuestion,
      ...(pinnedToolIds.length > 0 ? { tools: pinnedToolIds } : {}),
      responseShape: "evidence_only",
      includeDataUrl: true,
    });

    if (result.outcomeType === "capability_miss") {
      console.log("Capability miss:", result.capabilityMiss);
      return;
    }

    const dataUrl = resolveDataUrl(result);
    const fullData = dataUrl ? await fetchJsonDataUrl(dataUrl) : null;
    const signal = deriveRoutineSignal(result, fullData);

    console.log("Routine signal:", signal);
    printRoutineRecipe(result, dataUrl);
    console.log("Computed artifacts:", result.computedArtifacts ?? []);

    if (process.env.CONTEXT_ROUTINE_DISCOVER_EXECUTE === "true") {
      await discoverExecuteUpgradePath();
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
