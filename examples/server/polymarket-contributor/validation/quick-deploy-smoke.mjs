import { randomUUID } from "node:crypto";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:4003/mcp";
const TAIWAN =
  "0xd9fb1184af0064e5e34b129f5b79afa5a17b7e32f2953ab05efed82315fee6d4";

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
        clientInfo: { name: "quick-deploy-smoke", version: "1.0.0" },
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
  };
}

const sessionId = await createMcpSession(MCP_URL);

const flow = await mcpCallTool(sessionId, "analyze_whale_flow", {
  conditionId: TAIWAN,
});

const generic = await mcpCallTool(sessionId, "analyze_single_market_whales", {
  marketQuery:
    "For a Polymarket political market, chart top-holder skew versus 24h trade-flow direction, quantify whale–retail divergence, and state which side has edge if any.",
});

const market = generic.parsed?.selectedMarket ?? generic.parsed?.market ?? {};
const flowCoverage = flow.parsed?.tradeCoverage ?? flow.parsed?.tradeSample ?? {};
const genericCoverage =
  generic.parsed?.whaleFlow?.tradeCoverage ??
  generic.parsed?.whaleFlow?.tradeSample ??
  {};
const volume24h = market.volume24h ?? genericCoverage.reportedMarketVolume24h ?? 0;
const whaleDefs = flow.parsed?.sizeBucketDefinitions ?? {};

const checks = {
  flowHasTradeCoverage: Boolean(flow.parsed?.tradeCoverage),
  flowHasLargeBucket: Boolean(whaleDefs.large),
  flowWhaleThreshold: whaleDefs.whale,
  flowFetchedTrades: flowCoverage.fetchedTrades,
  flowCoverageLevel: flowCoverage.coverageLevel,
  flowPagesFetched: flowCoverage.pagesFetched,
  genericMarketTitle: market.title,
  genericSelectionReason: market.selectionReason ?? generic.parsed?.selectionReason,
  genericVolume24h: volume24h,
  genericHasRecentActivity: volume24h > 10_000,
};

const pass =
  checks.flowHasTradeCoverage &&
  checks.flowHasLargeBucket &&
  typeof checks.flowWhaleThreshold === "string" &&
  checks.flowWhaleThreshold.includes("10") &&
  checks.flowFetchedTrades > 0 &&
  checks.flowPagesFetched >= 1 &&
  Boolean(checks.genericMarketTitle) &&
  !/^0x[a-f0-9]{64}$/i.test(String(checks.genericMarketTitle)) &&
  checks.genericHasRecentActivity;

console.log(
  JSON.stringify(
    {
      pass,
      checks,
      flowSnippet: {
        netFlow: flow.parsed?.netFlow,
        tradeCoverage: flow.parsed?.tradeCoverage,
        sizeBuckets: flow.parsed?.sizeBuckets,
      },
      genericSnippet: {
        title: checks.genericMarketTitle,
        volume24h: checks.genericVolume24h,
        selectionReason: checks.genericSelectionReason,
      },
    },
    null,
    2,
  ),
);

process.exit(pass ? 0 : 1);
