import { randomUUID } from "node:crypto";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:4003/mcp";
const HOT_MARKET =
  "0x421bc1929df1429cf2cb94f80c1ce6a3ed0d1f0b7a2749b9890075f94eb549e9";

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSseJson(text) {
  const dataLines = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  if (dataLines.length === 0) {
    return tryParseJson(text);
  }
  return tryParseJson(dataLines.join("\n"));
}

async function createMcpSession(targetUrl) {
  const response = await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "filtered-trades-smoke", version: "1.0.0" },
      },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(`No session id: ${await response.text()}`);
  }
  await fetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  return sessionId;
}

async function mcpCallTool(sessionId, name, args) {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await response.text();
  const json = extractSseJson(text);
  const contentText =
    json?.result?.content?.find((c) => c.type === "text")?.text ?? "";
  return {
    isError: json?.result?.isError,
    parsed: contentText ? JSON.parse(contentText) : null,
    rawError: json?.error,
  };
}

function allTradesAtLeast(trades, minUsd) {
  return (
    Array.isArray(trades) &&
    trades.length > 0 &&
    trades.every((trade) => Number(trade.notional ?? 0) >= minUsd)
  );
}

const sessionId = await createMcpSession(MCP_URL);

const flow = await mcpCallTool(sessionId, "analyze_whale_flow", {
  conditionId: HOT_MARKET,
  hoursBack: 24,
});

const filteredTrades1k = await mcpCallTool(sessionId, "get_market_trades", {
  conditionId: HOT_MARKET,
  limit: 20,
  hoursBack: 24,
  coverageMode: "deep",
  minNotional: 1000,
});

const rawTrades = await mcpCallTool(sessionId, "get_market_trades", {
  conditionId: HOT_MARKET,
  limit: 20,
  hoursBack: 24,
  coverageMode: "deep",
});

const whaleTrades = await mcpCallTool(sessionId, "get_market_trades", {
  conditionId: HOT_MARKET,
  limit: 20,
  hoursBack: 24,
  coverageMode: "deep",
  minNotional: 10_000,
});

const buyTrades = await mcpCallTool(sessionId, "get_market_trades", {
  conditionId: HOT_MARKET,
  limit: 20,
  hoursBack: 24,
  coverageMode: "deep",
  side: "BUY",
});

const activity = await mcpCallTool(sessionId, "summarize_live_market_activity", {
  conditionId: HOT_MARKET,
  tradeLimit: 10,
  hoursBack: 24,
  minNotional: 1000,
});

const flowCoverage = flow.parsed?.tradeCoverage ?? {};
const sizeFilteredCoverage = flowCoverage.sizeFilteredTradeCoverage ?? {};
const filteredCoverage1k = filteredTrades1k.parsed?.tradeCoverage ?? {};
const rawCoverage = rawTrades.parsed?.tradeCoverage ?? {};
const whaleCoverage = whaleTrades.parsed?.tradeCoverage ?? {};
const buyCoverage = buyTrades.parsed?.tradeCoverage ?? {};
const activityCoverage = activity.parsed?.tradeCoverage ?? {};

const rawNotionals = (rawTrades.parsed?.trades ?? []).map((trade) =>
  Number(trade.notional ?? 0)
);
const rawHasSub1k =
  rawNotionals.length > 0 && Math.min(...rawNotionals) < 1_000;

const checks = {
  flowHasDualSampleStrategy:
    flowCoverage.sampleStrategy === "raw_recent_plus_size_filtered_large_trades",
  flowHasRawTradeCoverage: Boolean(flowCoverage.rawTradeCoverage),
  flowHasSizeFilteredTradeCoverage: Boolean(flowCoverage.sizeFilteredTradeCoverage),
  flowSizeFilteredRows:
    Number(sizeFilteredCoverage.rowsFetched ?? 0) > 0 ||
    Number(sizeFilteredCoverage.recentRowsAnalyzed ?? 0) > 0,
  filteredTrades1kScope:
    filteredCoverage1k.coverageScope === "filtered_public_tape",
  filteredTrades1kMinUsd: allTradesAtLeast(filteredTrades1k.parsed?.trades, 1000),
  rawTradesUnfilteredScope: rawCoverage.coverageScope === "all_public_tape",
  rawTradesHasMixedSizes:
    Array.isArray(rawTrades.parsed?.trades) &&
    rawTrades.parsed.trades.length > 0 &&
    rawHasSub1k,
  whaleTradesScope: whaleCoverage.coverageScope === "filtered_public_tape",
  whaleTradesMinUsd: allTradesAtLeast(whaleTrades.parsed?.trades, 10_000),
  buyTradesAllBuy:
    Array.isArray(buyTrades.parsed?.trades) &&
    buyTrades.parsed.trades.length > 0 &&
    buyTrades.parsed.trades.every((trade) => trade.side === "BUY"),
  buyTradesHasData: (buyTrades.parsed?.trades?.length ?? 0) > 0,
  activityHasTradeCoverage: Boolean(activity.parsed?.tradeCoverage),
  activityFilteredScope:
    activityCoverage.coverageScope === "filtered_public_tape",
  activityHasTrades:
    Array.isArray(activity.parsed?.recentTrades) &&
    activity.parsed.recentTrades.length > 0,
};

const pass = Object.values(checks).every(Boolean);

console.log(
  JSON.stringify(
    {
      pass,
      checks,
      flowSnippet: {
        sampleStrategy: flowCoverage.sampleStrategy,
        rawRows: flowCoverage.rawTradeCoverage?.rowsFetched,
        sizeFilteredRows: sizeFilteredCoverage.rowsFetched,
        canMakeWhaleClaim: flowCoverage.canMakeWhaleClaim,
        sizeBuckets: flow.parsed?.sizeBuckets,
      },
      rawTradesSnippet: {
        tradeCount: rawTrades.parsed?.trades?.length ?? 0,
        coverageScope: rawCoverage.coverageScope,
        minNotional: Math.min(...rawNotionals, Infinity),
        maxNotional: Math.max(...rawNotionals, 0),
      },
      whaleTradesSnippet: {
        tradeCount: whaleTrades.parsed?.trades?.length ?? 0,
        coverageScope: whaleCoverage.coverageScope,
        topNotional: whaleTrades.parsed?.trades?.[0]?.notional,
      },
      buyTradesSnippet: {
        tradeCount: buyTrades.parsed?.trades?.length ?? 0,
        sides: [...new Set((buyTrades.parsed?.trades ?? []).map((t) => t.side))],
      },
      filteredTrades1kSnippet: {
        tradeCount: filteredTrades1k.parsed?.trades?.length ?? 0,
        coverageScope: filteredCoverage1k.coverageScope,
      },
      activitySnippet: {
        tradeCount: activity.parsed?.recentTrades?.length ?? 0,
        coverageScope: activityCoverage.coverageScope,
      },
    },
    null,
    2
  )
);

process.exit(pass ? 0 : 1);
