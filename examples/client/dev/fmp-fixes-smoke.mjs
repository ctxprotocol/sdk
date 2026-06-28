// Focused re-smoke for the 2 fixed methods + ownership tier behavior.
// Usage: node fmp-fixes-smoke.mjs <base-url>
import { writeFileSync } from "node:fs";
const base = process.argv[2] ?? "http://localhost:4099/mcp";

async function sseJson(res) {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) throw new Error(`no data line:\n${text.slice(0, 400)}`);
  return JSON.parse(dataLine.slice(5).trim());
}

const initRes = await fetch(base, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fmp-fix-smoke", version: "1.0" } } }),
});
const sid = initRes.headers.get("mcp-session-id");
if (!sid) throw new Error(`no session; init status ${initRes.status}`);
await sseJson(initRes);
await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });

const calls = [
  { name: "get_sec_filings", args: { symbol: "META", limit: 3 } },
  { name: "get_sec_filings", args: { symbol: "AAPL", limit: 3 } },
  { name: "get_sector_performance", args: { date: "2026-06-26" } },
  { name: "get_ownership", args: { symbol: "AAPL", holderLimit: 5 } },
  { name: "get_valuation", args: { symbol: "NVDA", limit: 2 } },
  { name: "get_quality_scores", args: { symbol: "TSLA" } },
  { name: "get_macro_calendar", args: { limit: 5 } },
];

const out = [];
for (const c of calls) {
  const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sid }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: c.name, arguments: c.args } }) });
  let json;
  try { json = await sseJson(res); } catch (e) { out.push({ ...c, ok: false, error: e.message }); console.log(`FAIL ${c.name} ${JSON.stringify(c.args)} -> ${e.message}`); continue; }
  const sc = json.result?.structuredContent;
  const isError = json.result?.isError === true;
  const pe = sc?.partialErrors ?? null;
  const describe = (k) => { const v = sc?.[k]; if (Array.isArray(v)) return `${v.length}`; if (v && typeof v === "object") return "obj"; return JSON.stringify(v)?.slice(0, 24); };
  const keys = sc ? Object.keys(sc).filter((k) => k !== "fetchedAt") : [];
  const summary = isError ? `ERROR: ${json.result?.content?.[0]?.text?.slice(0, 140)}` : keys.map((k) => `${k}=${describe(k)}`).join(", ");
  out.push({ ...c, ok: !isError, partialErrors: pe, summary });
  console.log(`${!isError ? "OK  " : "ERR "} ${c.name} ${JSON.stringify(c.args)} -> ${summary}`);
  if (pe && Object.keys(pe).length > 0) console.log(`      partialErrors: ${JSON.stringify(pe)}`);
}
writeFileSync("/tmp/fmp_fixes_smoke.json", JSON.stringify(out, null, 2));
console.log(`\n${out.filter((r) => r.ok).length}/${out.length} ok -> /tmp/fmp_fixes_smoke.json`);
