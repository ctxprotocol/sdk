/**
 * Smoke test for analyze_market_liquidity marketState detection.
 *
 * Exercises three cases that must be handled distinctly:
 *  1. A resolved market (PSG vs Liverpool 2026-04-08, YES won at $1.00).
 *     Must return marketState="closed_resolved", winningOutcome="Yes",
 *     settlementPrices.yes=1, marketSlug/polymarketUrl populated with the
 *     real slug (no hallucinated "will-paris-saint-germain-fc-win-..." junk).
 *  2. A known live outcome (one of the 2026 FIFA WC winner outcomes) to
 *     confirm we did not regress the tradeable path.
 *  3. Resolution via marketQuery (server-side search), to confirm slug/url
 *     are surfaced when the caller doesn't pass a conditionId.
 *
 * This is a local MCP test — it hits http://localhost:4003/mcp which is
 * expected to be running the polymarket-contributor server in bypass-auth
 * mode (POLYMARKET_ALLOW_UNAUTH_MCP=true).
 */

import { randomUUID } from "node:crypto";

const LOCAL_MCP_URL = "http://localhost:4003/mcp";

// Known resolved market: PSG vs Liverpool, YES token won at $1.
const PSG_CONDITION_ID =
  "0x1c16b60c7e7ddb559964cd64c8f7d5c33adc83c3fbd0fd124587a8adc1ded8dd";
const PSG_EXPECTED_SLUG = "ucl-psg1-liv1-2026-04-08-psg1";

// Known live outcome: Spain to win 2026 FIFA World Cup (same conditionId the
// deep-whale-scan smoke test uses).
const LIVE_OUTCOME_CONDITION_ID =
  "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892";

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

async function createMcpSession() {
  const response = await fetch(LOCAL_MCP_URL, {
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
        clientInfo: { name: "smoke-market-state", version: "1.0.0" },
      },
    }),
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) {
    throw new Error(`No session id: ${await response.text()}`);
  }
  await fetch(LOCAL_MCP_URL, {
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

async function callTool(sessionId, name, args) {
  const response = await fetch(LOCAL_MCP_URL, {
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
  if (!json) {
    throw new Error(`Unparseable response for ${name}: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    throw new Error(`${name} error: ${json.error.message || JSON.stringify(json.error)}`);
  }
  return json.result?.structuredContent ?? null;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  ok  ${label}: ${JSON.stringify(actual)}`);
}

function assertTrue(value, label) {
  if (!value) {
    throw new Error(`FAIL ${label}: expected truthy, got ${JSON.stringify(value)}`);
  }
  console.log(`  ok  ${label}: ${JSON.stringify(value)}`);
}

async function main() {
  const sessionId = await createMcpSession();

  console.log("\n=== case 1: resolved market (PSG vs Liverpool, YES won) ===");
  const psg = await callTool(sessionId, "analyze_market_liquidity", {
    conditionId: PSG_CONDITION_ID,
  });
  console.log(JSON.stringify(psg, null, 2).slice(0, 900));
  assertEqual(psg.marketState, "closed_resolved", "psg.marketState");
  assertEqual(psg.isTradeable, false, "psg.isTradeable");
  assertEqual(psg.winningOutcome, "Yes", "psg.winningOutcome");
  assertEqual(psg.settlementPrices?.yes, 1, "psg.settlementPrices.yes");
  assertEqual(psg.settlementPrices?.no, 0, "psg.settlementPrices.no");
  assertEqual(psg.marketSlug, PSG_EXPECTED_SLUG, "psg.marketSlug");
  assertEqual(
    psg.polymarketUrl,
    `https://polymarket.com/market/${PSG_EXPECTED_SLUG}`,
    "psg.polymarketUrl"
  );
  assertTrue(
    typeof psg.recommendation === "string" && /resolved|redeem/i.test(psg.recommendation),
    "psg.recommendation mentions resolution/redeem"
  );
  assertTrue(
    typeof psg.depth?.note === "string" && /resolved|redeem|closed/i.test(psg.depth.note),
    "psg.depth.note explains non-tradeable zero depth"
  );
  assertEqual(psg.liquidityScore, "illiquid", "psg.liquidityScore");

  console.log("\n=== case 2: live tradeable market (Spain 2026 WC winner YES) ===");
  const live = await callTool(sessionId, "analyze_market_liquidity", {
    conditionId: LIVE_OUTCOME_CONDITION_ID,
  });
  assertEqual(live.marketState, "tradeable", "live.marketState");
  assertEqual(live.isTradeable, true, "live.isTradeable");
  assertTrue(typeof live.marketSlug === "string" && live.marketSlug.length > 0, "live.marketSlug populated");
  assertTrue(
    typeof live.polymarketUrl === "string" && live.polymarketUrl.startsWith("https://polymarket.com/market/"),
    "live.polymarketUrl populated"
  );
  assertTrue(typeof live.depth?.totalDepthUsd === "number", "live.depth.totalDepthUsd number");
  assertTrue(typeof live.whaleCost?.sell5k?.slippagePercent === "number", "live sell5k slippage number");

  console.log("\n=== case 3: marketQuery resolves the PSG market ===");
  const viaQuery = await callTool(sessionId, "analyze_market_liquidity", {
    marketQuery: "Will Paris Saint-Germain FC win on 2026-04-08?",
  });
  console.log(JSON.stringify({
    marketState: viaQuery.marketState,
    isTradeable: viaQuery.isTradeable,
    marketSlug: viaQuery.marketSlug,
    polymarketUrl: viaQuery.polymarketUrl,
    winningOutcome: viaQuery.winningOutcome,
  }, null, 2));
  // NOTE: search ranking may not always surface the exact resolved market
  // if live matches exist. We assert the softer invariant: whatever it
  // resolves to, the response must have a real slug and a real polymarketUrl
  // (never null / hallucinated).
  assertTrue(
    typeof viaQuery.marketSlug === "string" && viaQuery.marketSlug.length > 0,
    "viaQuery.marketSlug is a real slug"
  );
  assertTrue(
    typeof viaQuery.polymarketUrl === "string" &&
      viaQuery.polymarketUrl.startsWith("https://polymarket.com/market/") &&
      !viaQuery.polymarketUrl.includes("will-paris-saint-germain-fc-win-on-"),
    "viaQuery.polymarketUrl is a real URL (not hallucinated question-slug)"
  );

  console.log("\nall assertions passed.");
}

main().catch((error) => {
  console.error("\nsmoke-market-state FAILED:", error.message);
  process.exit(1);
});
