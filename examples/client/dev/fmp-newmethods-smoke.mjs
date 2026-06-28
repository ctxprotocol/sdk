// Smoke test the 14 new fmp-contributor methods against a local unauth MCP process.
// Usage: node fmp-newmethods-smoke.mjs <base-url>   (e.g. http://localhost:4099/mcp)
import { writeFileSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:4099/mcp";

async function sseJson(res) {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`no data line in SSE:\n${text.slice(0, 400)}`);
  return JSON.parse(dataLine.slice(5).trim());
}

async function main() {
  const initRes = await fetch(base, {
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
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "fmp-smoke", version: "1.0" },
      },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error(`no mcp-session-id; init status ${initRes.status}`);
  const initJson = await sseJson(initRes);
  console.log("initialized:", initJson.result?.serverInfo, "session:", sid.slice(0, 8) + "...");

  // send initialized notification (no response expected)
  await fetch(base, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  const calls = [
    { name: "get_peers", args: { symbol: "AAPL" } },
    { name: "get_earnings", args: { symbol: "NVDA", mode: "surprises", limit: 3 } },
    { name: "get_earnings", args: { mode: "calendar", from: "2026-06-27", to: "2026-07-11", limit: 5 } },
    { name: "get_dividends", args: { symbol: "AAPL", mode: "history", limit: 3 } },
    { name: "get_insider_activity", args: { symbol: "NVDA", limit: 3 } },
    { name: "get_sec_filings", args: { symbol: "META", limit: 3 } },
    { name: "get_sec_filings", args: { from: "2026-06-20", to: "2026-06-27", limit: 3 } },
    { name: "get_ownership", args: { symbol: "AAPL", holderLimit: 5 } },
    { name: "get_growth", args: { symbol: "AMZN", period: "annual", limit: 2 } },
    { name: "get_revenue_segments", args: { symbol: "AAPL", segment: "both", limit: 3 } },
    { name: "get_congressional_trades", args: { symbol: "NVDA", chamber: "both", limit: 3 } },
    { name: "get_index_constituents", args: { index: "dowjones" } },
    { name: "get_valuation", args: { symbol: "NVDA", limit: 2 } },
    { name: "get_quality_scores", args: { symbol: "TSLA" } },
    { name: "get_sector_performance", args: {} },
    { name: "get_macro_calendar", args: { limit: 5 } },
  ];

  const results = [];
  for (const c of calls) {
    const res = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: c.name, arguments: c.args } }),
    });
    let json;
    try {
      json = await sseJson(res);
    } catch (e) {
      results.push({ ...c, ok: false, error: e.message, status: res.status });
      console.log(`FAIL ${c.name} ${JSON.stringify(c.args)} -> ${e.message}`);
      continue;
    }
    const sc = json.result?.structuredContent;
    const partialErrors = sc?.partialErrors ?? null;
    const isError = json.result?.isError === true;
    const topKeys = sc ? Object.keys(sc).filter((k) => k !== "fetchedAt") : [];
    const summary = (() => {
      if (isError) return `ERROR: ${json.result?.content?.[0]?.text?.slice(0, 120)}`;
      const parts = [];
      for (const k of topKeys) {
        const v = sc[k];
        if (Array.isArray(v)) parts.push(`${k}=${v.length}`);
        else if (v && typeof v === "object") parts.push(`${k}=obj`);
        else parts.push(`${k}=${JSON.stringify(v)?.slice(0, 30)}`);
      }
      return parts.join(", ");
    })();
    const ok = !isError;
    results.push({ ...c, ok, isError, partialErrors, summary });
    console.log(`${ok ? "OK  " : "ERR "} ${c.name} ${JSON.stringify(c.args)} -> ${summary}`);
  }

  writeFileSync("/tmp/fmp_newmethods_smoke.json", JSON.stringify(results, null, 2));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nSUMMARY: ${pass}/${results.length} calls returned data (non-error).`);
  console.log("details -> /tmp/fmp_newmethods_smoke.json");
}

main().catch((e) => {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
});
