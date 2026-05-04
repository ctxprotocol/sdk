#!/usr/bin/env node
// Validates that get_top_markets no longer 422s when the LLM passes
// minTotalVolume=0 + maxTotalVolume=0 (the exact bug from the prior pipeline run).
// Run AFTER: POLYMARKET_ALLOW_UNAUTH_MCP=true PORT=4003 npx tsx server.ts

const BASE = process.env.POLYMARKET_BASE_URL || "http://localhost:4003";

function jsonHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  };
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: jsonHeaders(headers),
    body: JSON.stringify(body),
  });
  const sessionId = res.headers.get("mcp-session-id");
  const text = await res.text();
  // Streamable HTTP responds as SSE; pull the first JSON payload.
  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  const json = dataLine ? JSON.parse(dataLine.slice(6)) : null;
  return { status: res.status, sessionId, body: json, raw: text };
}

async function main() {
  const init = await postJson("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-422-fix", version: "0.0.1" },
    },
  });
  if (init.status !== 200 || !init.sessionId) {
    console.error("MCP init failed", init);
    process.exit(1);
  }
  console.log("MCP session:", init.sessionId);

  // Required follow-up: notifications/initialized
  await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: jsonHeaders({ "mcp-session-id": init.sessionId }),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });

  const cases = [
    {
      label: "BUG REPRO: minTotalVolume=0 + maxTotalVolume=0 (was 422)",
      args: { sortBy: "total_volume", limit: 5, minTotalVolume: 0, maxTotalVolume: 0 },
    },
    {
      label: "minTotalVolume=0 alone (zero sentinel)",
      args: { sortBy: "total_volume", limit: 5, minTotalVolume: 0 },
    },
    {
      label: "inverted range minTotalVolume=1e7 + maxTotalVolume=1e6",
      args: {
        sortBy: "total_volume",
        limit: 5,
        minTotalVolume: 10_000_000,
        maxTotalVolume: 1_000_000,
      },
    },
    {
      label: "minLiquidity=0 (zero sentinel)",
      args: { sortBy: "liquidity", limit: 5, minLiquidity: 0 },
    },
    {
      label: "valid: minTotalVolume=10_000_000 (sanity check)",
      args: { sortBy: "total_volume", limit: 3, minTotalVolume: 10_000_000 },
    },
    {
      label: "no filters (control)",
      args: { sortBy: "total_volume", limit: 3 },
    },
  ];

  let allPassed = true;

  for (const c of cases) {
    const result = await postJson(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1e9),
        method: "tools/call",
        params: { name: "get_top_markets", arguments: c.args },
      },
      { "mcp-session-id": init.sessionId }
    );

    const ok = result.status === 200 && !result.body?.error;
    let returned = 0;
    let filtersApplied;
    let preview;
    if (ok) {
      try {
        const text = result.body?.result?.content?.[0]?.text;
        const parsed = text ? JSON.parse(text) : result.body?.result?.structuredContent;
        returned = parsed?.markets?.length ?? 0;
        filtersApplied = parsed?.filtersApplied;
        preview = parsed?.markets?.[0]?.title;
      } catch {}
    }

    console.log(
      `${ok && returned > 0 ? "PASS" : "FAIL"} | ${c.label}\n` +
        `       args=${JSON.stringify(c.args)}\n` +
        `       status=${result.status} returned=${returned} preview=${preview ?? "—"}\n` +
        `       filtersApplied=${JSON.stringify(filtersApplied) ?? "—"}\n` +
        (result.body?.error ? `       error=${JSON.stringify(result.body.error)}\n` : "")
    );
    if (!ok || returned === 0) {
      allPassed = false;
    }
  }

  console.log(allPassed ? "\nALL CASES PASSED" : "\nSOME CASES FAILED");
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
