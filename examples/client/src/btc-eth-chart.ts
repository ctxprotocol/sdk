import {
  ContextClient,
  ContextError,
  type QueryComputedArtifact,
} from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this example.");
}

const baseUrl = process.env.CONTEXT_BASE_URL ?? "http://localhost:3000";

const client = new ContextClient({
  apiKey,
  baseUrl,
  requestTimeoutMs: 600_000,
});

const QUERY = [
  "Using BTC and ETH daily price data, calculate the last 90 days of daily returns,",
  "compare cumulative return, annualized volatility, and annualized Sharpe ratio,",
  "and include both:",
  "1. an inline return-series chart comparing BTC vs ETH cumulative returns over time",
  "2. a compact metric table with the computed BTC/ETH metrics.",
  "Then explain which asset had better risk-adjusted performance.",
].join(" ");

function summarizeChart(
  artifact: Extract<QueryComputedArtifact, { kind: "chart" }>
) {
  return {
    title: artifact.title,
    type: artifact.spec.type,
    xKey: artifact.spec.xKey,
    seriesKeys: artifact.spec.series.map((s) => s.key),
    rowCount: artifact.data.length,
    sampleRow: artifact.data[0],
  };
}

function summarizeMetricTable(
  artifact: Extract<QueryComputedArtifact, { kind: "metric_table" }>
) {
  return {
    title: artifact.title,
    rowCount: artifact.rows.length,
    rows: artifact.rows,
  };
}

async function main() {
  console.log("→ Hitting", baseUrl);
  console.log("→ Query:\n   ", QUERY);
  const start = Date.now();
  try {
    const answer = await client.query.run({
      query: QUERY,
      includeDeveloperTrace: false,
      includeData: false,
    });
    const elapsedMs = Date.now() - start;
    console.log("\n=== RESPONSE ===");
    console.log("durationMs:", answer.durationMs);
    console.log("elapsedMsRoundTrip:", elapsedMs);
    console.log("toolsUsed:", answer.toolsUsed.map((t) => t.name));
    console.log("totalCostUsd:", answer.cost.totalCostUsd);

    if (answer.outcomeType === "answer") {
      console.log("\n--- response text ---");
      console.log(answer.response);
    } else {
      console.log("\noutcomeType:", answer.outcomeType);
    }

    const computed = answer.computedArtifacts ?? [];
    console.log(`\n=== computedArtifacts (${computed.length}) ===`);
    if (computed.length === 0) {
      console.log("⚠ No computed artifacts returned.");
    }

    for (const [i, artifact] of computed.entries()) {
      console.log(`\n--- artifact #${i + 1} (kind=${artifact.kind}) ---`);
      if (artifact.kind === "chart") {
        if (!artifact.spec || !Array.isArray(artifact.data)) {
          console.error(
            "⚠ Chart artifact is missing the new structured shape:",
            artifact
          );
          process.exitCode = 2;
          continue;
        }
        console.log(JSON.stringify(summarizeChart(artifact), null, 2));
      } else if (artifact.kind === "metric_table") {
        console.log(JSON.stringify(summarizeMetricTable(artifact), null, 2));
      } else {
        console.warn("⚠ Unknown artifact kind:", artifact);
      }
    }

    const chartCount = computed.filter((a) => a.kind === "chart").length;
    const tableCount = computed.filter((a) => a.kind === "metric_table").length;
    console.log("\n=== SUMMARY ===");
    console.log("chart artifacts:", chartCount);
    console.log("metric_table artifacts:", tableCount);
    if (chartCount === 0) {
      console.error("✗ Expected at least 1 chart artifact, got 0.");
      process.exitCode = 1;
    }
    if (tableCount === 0) {
      console.error("✗ Expected at least 1 metric_table artifact, got 0.");
      process.exitCode = 1;
    }
    if (chartCount > 0 && tableCount > 0) {
      console.log("✓ Both chart and metric_table artifacts received.");
    }
  } catch (error) {
    if (error instanceof ContextError) {
      console.error("Context Protocol error:", error.message);
      console.error("code:", error.code);
      console.error("statusCode:", error.statusCode);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

main();
