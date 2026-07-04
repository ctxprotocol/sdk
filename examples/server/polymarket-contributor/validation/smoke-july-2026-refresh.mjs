// Smoke test for the July 2026 upstream-refresh tools.
// Usage: MCP_URL=http://127.0.0.1:4503/mcp node validation/smoke-july-2026-refresh.mjs
import { randomUUID } from "node:crypto";

const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:4503/mcp";

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
        clientInfo: { name: "july-2026-refresh-smoke", version: "1.0.0" },
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
  const startedAt = Date.now();
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
    isError: json?.result?.isError === true,
    parsed: contentText ? tryParseJson(contentText) : null,
    latencyMs: Date.now() - startedAt,
  };
}

const sessionId = await createMcpSession(MCP_URL);

// Resolve a live high-volume binary market + a multi-outcome event for fixtures.
const top = await mcpCallTool(sessionId, "get_top_markets", {
  limit: 5,
  sortBy: "volume24h",
});
const fixtureMarket = (top.parsed?.markets ?? [])[0] ?? {};
const fixtureTokenId =
  fixtureMarket.yesTokenId ?? fixtureMarket.tokenIds?.[0] ?? fixtureMarket.tokenId ?? "";
const fixtureConditionId = fixtureMarket.conditionId ?? "";

if (!fixtureTokenId || !fixtureConditionId) {
  console.error("Could not resolve a live fixture market from get_top_markets");
  console.error(JSON.stringify(fixtureMarket).slice(0, 500));
  process.exit(1);
}

const results = {};
const failures = [];

function record(name, result, ok, evidence) {
  results[name] = {
    pass: ok && !result.isError,
    latencyMs: result.latencyMs,
    evidence,
  };
  if (!ok || result.isError) {
    failures.push(name);
    results[name].raw = JSON.stringify(result.parsed)?.slice(0, 400);
  }
}

// 1. get_price_history interval mode (regression)
{
  const r = await mcpCallTool(sessionId, "get_price_history", {
    tokenId: fixtureTokenId,
    interval: "1w",
    fidelity: 180,
  });
  const points = r.parsed?.history?.length ?? 0;
  record("get_price_history:interval", r, points > 5, {
    mode: r.parsed?.mode,
    points,
    spanDays: r.parsed?.summary?.spanDays,
  });
}

// 2. get_price_history deep window mode (60 days, chunked)
{
  const r = await mcpCallTool(sessionId, "get_price_history", {
    tokenId: fixtureTokenId,
    daysBack: 60,
    maxPoints: 200,
  });
  const spanDays = r.parsed?.summary?.spanDays ?? 0;
  const raw = r.parsed?.summary?.rawDataPoints ?? 0;
  record("get_price_history:deep-window-60d", r, spanDays > 20 && raw > 100, {
    mode: r.parsed?.mode,
    spanDays,
    rawDataPoints: raw,
    returnedPoints: r.parsed?.history?.length,
    windowsFetched: r.parsed?.coverage?.windowsFetched,
  });
}

// 3. get_batch_price_history interval mode
{
  const tokenIds = (top.parsed?.markets ?? [])
    .flatMap((m) => [m.yesTokenId, ...(m.tokenIds ?? []), m.tokenId])
    .filter(Boolean)
    .slice(0, 4);
  const r = await mcpCallTool(sessionId, "get_batch_price_history", {
    tokenIds,
    interval: "1w",
    fidelity: 360,
  });
  const seriesCount = Object.keys(r.parsed?.series ?? {}).length;
  const rankedFirst = r.parsed?.ranking?.[0];
  record("get_batch_price_history:interval", r, seriesCount === tokenIds.length, {
    tokensRequested: tokenIds.length,
    seriesReturned: seriesCount,
    topMover: rankedFirst,
  });
}

// 4. get_batch_price_history deep window mode (30 days)
{
  const r = await mcpCallTool(sessionId, "get_batch_price_history", {
    tokenIds: [fixtureTokenId],
    daysBack: 30,
  });
  const series = r.parsed?.series?.[fixtureTokenId];
  record(
    "get_batch_price_history:deep-window-30d",
    r,
    (series?.summary?.rawDataPoints ?? 0) > 50,
    {
      rawDataPoints: series?.summary?.rawDataPoints,
      changePercent: series?.summary?.changePercent,
    }
  );
}

// 5. get_orderbook_history (7d sampled)
{
  const r = await mcpCallTool(sessionId, "get_orderbook_history", {
    tokenId: fixtureTokenId,
    hoursBack: 168,
    samples: 12,
    depthLevels: 2,
  });
  const snapshots = r.parsed?.snapshots?.length ?? 0;
  record("get_orderbook_history:7d", r, snapshots >= 5, {
    snapshots,
    totalUpstream: r.parsed?.summary?.totalSnapshotsUpstream,
    spreadTrend: r.parsed?.summary?.trend,
  });
}

// 6. get_market_positions (PnL-aware holders)
{
  const r = await mcpCallTool(sessionId, "get_market_positions", {
    conditionId: fixtureConditionId,
    sortBy: "TOTAL_PNL",
    limit: 5,
  });
  const outcomes = r.parsed?.outcomes ?? [];
  const firstPosition = outcomes[0]?.positions?.[0];
  record(
    "get_market_positions",
    r,
    outcomes.length > 0 && typeof firstPosition?.avgPrice === "number",
    {
      outcomes: outcomes.length,
      totalPositions: r.parsed?.summary?.totalPositionsReturned,
      samplePosition: firstPosition,
    }
  );
}

// 7. get_trader_leaderboard
{
  const r = await mcpCallTool(sessionId, "get_trader_leaderboard", {
    category: "POLITICS",
    timePeriod: "WEEK",
    orderBy: "PNL",
    limit: 5,
  });
  const traders = r.parsed?.traders ?? [];
  record("get_trader_leaderboard", r, traders.length > 0 && traders[0].wallet, {
    traders: traders.length,
    top: traders[0],
  });
}

// 8. get_wallet_profile (uses the top leaderboard wallet)
{
  const leaderboardWallet = results.get_trader_leaderboard?.evidence?.top?.wallet;
  const r = await mcpCallTool(sessionId, "get_wallet_profile", {
    address: leaderboardWallet ?? "0xb1ca909e848cc24ec4e220ce1c453bc290c51705",
  });
  record(
    "get_wallet_profile",
    r,
    (r.parsed?.marketsTraded ?? 0) > 0 || (r.parsed?.profile?.name ?? "") !== "",
    {
      name: r.parsed?.profile?.name,
      marketsTraded: r.parsed?.marketsTraded,
      portfolioValue: r.parsed?.portfolioValue,
      leaderboard: r.parsed?.leaderboard,
    }
  );
}

// 9. find_reward_markets
{
  const r = await mcpCallTool(sessionId, "find_reward_markets", {
    minDailyRateUsd: 10,
    limit: 5,
  });
  const rewardMarkets = r.parsed?.rewardMarkets ?? [];
  record(
    "find_reward_markets",
    r,
    rewardMarkets.length > 0 && rewardMarkets[0].totalDailyRateUsd >= 10,
    {
      returned: rewardMarkets.length,
      scanned: r.parsed?.summary?.totalConfigsScanned,
      top: {
        question: rewardMarkets[0]?.question,
        rate: rewardMarkets[0]?.totalDailyRateUsd,
        minSize: rewardMarkets[0]?.rewardsMinSize,
        maxSpread: rewardMarkets[0]?.rewardsMaxSpreadCents,
      },
    }
  );
}

// 10. get_sports_context
{
  const r = await mcpCallTool(sessionId, "get_sports_context", {
    league: "nba",
    teamQuery: "lakers",
    includeMarketTypes: true,
  });
  const sports = r.parsed?.sports ?? [];
  const teams = r.parsed?.teams ?? [];
  record("get_sports_context", r, sports.length > 0, {
    sports: sports.length,
    nbaTags: sports[0]?.tags,
    teams: teams.map((t) => t.name).slice(0, 3),
    marketTypes: (r.parsed?.marketTypes ?? []).slice(0, 6),
  });
}

// 11. compare_event_outcome_quotes momentum path (rewired to batch history)
{
  const r = await mcpCallTool(sessionId, "compare_event_outcome_quotes", {
    eventQuery: "World Cup Winner",
    includeHistory: true,
    maxOutcomes: 5,
  });
  const outcomes = r.parsed?.outcomes ?? r.parsed?.matchedOutcomes ?? [];
  const withHistory = outcomes.filter((o) => o.historyWindow);
  record(
    "compare_event_outcome_quotes:momentum",
    r,
    outcomes.length > 0 && withHistory.length > 0,
    {
      outcomes: outcomes.length,
      withHistoryWindow: withHistory.length,
      sample: outcomes[0]
        ? {
            name: outcomes[0].matchedName,
            priceChangePercent: outcomes[0].priceChangePercent,
            historyWindow: outcomes[0].historyWindow,
          }
        : null,
    }
  );
}

// 12. get_events keyset pagination (two pages via nextCursor)
{
  const page1 = await mcpCallTool(sessionId, "get_events", { limit: 5 });
  const cursor = page1.parsed?.nextCursor;
  const page2 = cursor
    ? await mcpCallTool(sessionId, "get_events", { limit: 5, afterCursor: cursor })
    : { isError: true, parsed: null, latencyMs: 0 };
  const page1Ids = new Set((page1.parsed?.events ?? []).map((e) => e.id));
  const page2Events = page2.parsed?.events ?? [];
  const noOverlap = page2Events.every((e) => !page1Ids.has(e.id));
  record(
    "get_events:keyset-pagination",
    page2,
    Boolean(cursor) && page2Events.length > 0 && noOverlap,
    {
      page1Count: page1.parsed?.count,
      hasCursor: Boolean(cursor),
      page2Count: page2Events.length,
      noOverlap,
    }
  );
}

const pass = failures.length === 0;
console.log(
  JSON.stringify(
    {
      pass,
      fixture: {
        title: fixtureMarket.title ?? fixtureMarket.question,
        conditionId: fixtureConditionId,
        tokenId: `${fixtureTokenId.slice(0, 12)}...`,
      },
      failures,
      results,
    },
    null,
    2
  )
);
process.exit(pass ? 0 : 1);
