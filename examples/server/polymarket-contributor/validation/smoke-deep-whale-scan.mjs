import { randomUUID } from "node:crypto";

const LOCAL_MCP_URL = "http://localhost:4003/mcp";

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
        clientInfo: { name: "smoke-deep-whale-scan", version: "1.0.0" },
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

async function mcpJsonRpc(sessionId, method, params = {}) {
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
      method,
      params,
    }),
  });
  const text = await response.text();
  const json = extractSseJson(text);
  if (!json) throw new Error(`Unparseable response for ${method}: ${text.slice(0, 200)}`);
  if (json.error) throw new Error(`${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

async function callTool(sessionId, name, args) {
  const result = await mcpJsonRpc(sessionId, "tools/call", { name, arguments: args });
  return result?.structuredContent ?? null;
}

const OUTCOMES = [
  { name: "Spain", conditionId: "0x7976b8dbacf9077eb1453a62bcefd6ab2df199acd28aad276ff0d920d6992892" },
  { name: "France", conditionId: "0x9b6fef249040fd17e9c107955b37ac2c3e923509b6b0ff01cc463a331ddeb894" },
  { name: "England", conditionId: "0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f" },
  { name: "Switzerland", conditionId: "0x3a26ca6425e2d98f14935670bc22cdb0744defc6f6d83c65f8c413a921c5c70c" },
  { name: "NewZealand", conditionId: "0x9e5f9d8c384f8fe368b195fa9a780be58643dff7360588a4e577012df8af00a7" },
  { name: "SouthKorea", conditionId: "0x65307f30dce84ac35e41813035d3c04933da830dc4efbbb2fcdc4b282700ef3b" },
];

async function main() {
  const sessionId = await createMcpSession(LOCAL_MCP_URL);

  console.log("=== get_top_holders deep scan for each outcome ===");
  const results = [];
  for (const { name, conditionId } of OUTCOMES) {
    const t0 = Date.now();
    const out = await callTool(sessionId, "get_top_holders", {
      conditionId,
      outcome: "YES",
      limit: 20,
      deepFetch: true,
    });
    const ms = Date.now() - t0;
    const yesScanned = out?.holdersScanned?.yes ?? null;
    const yesWhale = out?.positionValueSummary?.yesWhaleCount ?? null;
    const yesTotal = out?.positionValueSummary?.yesTotalValue ?? null;
    results.push({ name, ms, yesScanned, yesWhale, yesTotal, scanMode: out?.scanMode });
    console.log(
      `  ${name.padEnd(12)} scanMode=${out?.scanMode ?? "?"} scanned=${yesScanned} whales=${yesWhale} total=$${yesTotal} in ${ms}ms${out?.perSideScanCeilingHit ? " [ceiling-hit]" : ""}`
    );
  }

  console.log("\n=== analyze_event_whale_breakdown with shortlist ===");
  const t0 = Date.now();
  const ev = await callTool(sessionId, "analyze_event_whale_breakdown", {
    slug: "2026-fifa-world-cup-winner-595",
    outcomes: ["Spain", "France", "England", "Switzerland", "New Zealand", "South Korea"],
  });
  console.log(`duration=${Date.now() - t0}ms`);
  if (Array.isArray(ev?.whalesByOutcome)) {
    for (const row of ev.whalesByOutcome) {
      console.log(
        `  rank=${row.rank} ${String(row.outcome).padEnd(14)} whales=${row.whaleCount} scanned=${row.holdersScanned} total=$${row.totalWhaleValue} topWhale=$${row.topWhalePosition} conviction=${row.convictionLevel}`
      );
    }
  } else {
    console.log("no whalesByOutcome in response:", JSON.stringify(ev).slice(0, 500));
  }

  const distinctWhaleCounts = new Set(results.map((r) => r.yesWhale).filter((x) => x != null));
  const anyAbove20 = results.some((r) => (r.yesWhale ?? 0) > 20);
  console.log(
    `\nsummary: distinct_whaleCounts=${distinctWhaleCounts.size}/${results.length} any_above_20=${anyAbove20}`
  );
}

main().catch((error) => {
  console.error("smoke test failed:", error);
  process.exit(1);
});
