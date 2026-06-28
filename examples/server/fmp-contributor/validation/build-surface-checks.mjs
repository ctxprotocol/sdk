// Builds marketplace-surface-checks.latest.json for fmp-contributor.
// - publicAuthProbe: probes https://mcp.ctxprotocol.com/fmp/mcp (initialize ok,
//   tools/list returns 27, tools/call blocked for unauth => auth is ON).
// - autoQuerySummary: derived from pipeline-query-results.json (no re-run cost).
// - executeValidation + externalAccuracyCheck: merged from vps-execute-smoke.json
//   (produced by smoke-fmp-execute.mjs via the sanctioned SSH temp-port smoke).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_MCP_URL = "https://mcp.ctxprotocol.com/fmp/mcp";
const PAID_RESULTS = path.resolve(__dirname, "pipeline-query-results.json");
const SMOKE = path.resolve(__dirname, "vps-execute-smoke.json");
const OUT = path.resolve(__dirname, "marketplace-surface-checks.latest.json");
const TOOL_ID = "15c60ca5-94c9-4257-89c4-542a4745e89f";

function tryParseJson(t) { try { return JSON.parse(t); } catch { return null; } }
function extractSseJson(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((l) => l.length > 0 && l !== "[DONE]");
  if (lines.length === 0) return tryParseJson(text);
  for (let i = lines.length - 1; i >= 0; i--) { const j = tryParseJson(lines[i]); if (j) return j; }
  return tryParseJson(lines.join("\n"));
}

async function publicAuthProbe() {
  const init = await fetch(PUBLIC_MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fmp-public-auth-probe", version: "1.0.0" } } }),
    signal: AbortSignal.timeout(30_000),
  });
  const initText = await init.text();
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) return { initializeStatus: init.status, toolsListStatus: 0, toolsCallStatus: 0, toolCount: 0, rpcAuthBlocked: false, pass: false, note: `no session id: ${initText.slice(0, 200)}` };

  await fetch(PUBLIC_MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) });

  const listRes = await fetch(PUBLIC_MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/list", params: {} }) });
  const listJson = extractSseJson(await listRes.text());
  const toolCount = Array.isArray(listJson?.result?.tools) ? listJson.result.tools.length : 0;

  const callRes = await fetch(PUBLIC_MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId }, body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method: "tools/call", params: { name: "get_company_profile", arguments: { symbols: ["AAPL"] } } }) });
  const callJson = extractSseJson(await callRes.text());
  const rpcAuthBlocked = !!(callJson?.error && typeof callJson.error.message === "string" && /auth|unauthorized|forbidden|signature|token|payment|credit/i.test(callJson.error.message));
  return {
    initializeStatus: init.status,
    toolsListStatus: listRes.status,
    toolsCallStatus: callRes.status,
    toolCount,
    rpcAuthBlocked,
    pass: init.ok && listRes.ok && toolCount > 0 && (callRes.status === 401 || callRes.status === 403 || rpcAuthBlocked),
  };
}

function deriveAutoQuerySummary() {
  const results = JSON.parse(readFileSync(PAID_RESULTS, "utf8"));
  const REFUSAL = /I am unable to|I cannot provide|I'm unable to|I do not have|no data available|could not fulfill/i;
  const runs = results.map((r) => {
    const outcome = r.outcomeType ?? "unknown";
    const tools = Array.isArray(r.toolsUsed) ? r.toolsUsed : [];
    const toolCalls = r.developerTrace?.summary?.toolCalls ?? tools.length;
    const routedToTarget = tools.some((t) => /FMP|fmp/i.test(t.name ?? ""));
    const responseText = r.responseText ?? "";
    const isRefusal = REFUSAL.test(responseText);
    const hasData = /[$]\s?\d|\b\d+(?:\.\d+)?%|\b\d[\d,]*(?:\.\d+)?\b|revenue|earnings|dividend|price|market cap|sector|score|yield/i.test(responseText);
    const passed = outcome === "answer" && toolCalls > 0 && routedToTarget && hasData && !isRefusal && outcome !== "error";
    return {
      id: r.id,
      prompt: r.query,
      status: passed ? "pass" : "fail",
      outcomeType: outcome,
      toolCalls,
      routedToTarget,
      responsePreview: responseText.slice(0, 500),
      hasData,
      looksGeneric: isRefusal,
      developerTraceSummary: r.developerTrace?.summary ?? null,
    };
  });
  return {
    promptCount: runs.length,
    passedCount: runs.filter((r) => r.status === "pass").length,
    failedCount: runs.filter((r) => r.status !== "pass").length,
    routedCount: runs.filter((r) => r.routedToTarget === true).length,
    runs,
  };
}

async function main() {
  console.log("Running public auth probe against", PUBLIC_MCP_URL);
  const authProbe = await publicAuthProbe();
  console.log(`  publicAuthProbe: ${authProbe.pass ? "PASS" : "FAIL"} (toolCount=${authProbe.toolCount}, callStatus=${authProbe.toolsCallStatus}, rpcAuthBlocked=${authProbe.rpcAuthBlocked})`);

  const autoQuerySummary = deriveAutoQuerySummary();
  console.log(`  autoQuery: ${autoQuerySummary.passedCount}/${autoQuerySummary.promptCount} passed, ${autoQuerySummary.failedCount} failed`);

  let executeValidation = { discoveredToolName: "FMP Equities Intelligence", discoveredMethodCount: 0, passedMethodCount: 0, failedMethodCount: 0, methods: [], note: "smoke not run" };
  let externalAccuracyCheck = { status: "FAIL", notes: ["smoke not run"] };
  if (existsSync(SMOKE)) {
    const s = JSON.parse(readFileSync(SMOKE, "utf8"));
    if (s.executeValidation) executeValidation = s.executeValidation;
    if (s.externalAccuracyCheck) externalAccuracyCheck = s.externalAccuracyCheck;
    console.log(`  executeValidation: ${executeValidation.passedMethodCount}/${executeValidation.discoveredMethodCount} methods passed, ${executeValidation.failedMethodCount} failed`);
    console.log(`  externalAccuracyCheck: ${externalAccuracyCheck.status}`);
  } else {
    console.log("  WARNING: vps-execute-smoke.json missing; run smoke-fmp-execute.mjs first.");
  }

  const output = {
    generatedAt: new Date().toISOString(),
    toolId: TOOL_ID,
    publicMcpUrl: PUBLIC_MCP_URL,
    autoQuerySummary,
    executeValidation,
    publicAuthProbe: authProbe,
    externalAccuracyCheck,
  };
  writeFileSync(OUT, JSON.stringify(output, null, 2) + "\n", "utf8");
  const ts = new Date().toISOString().replaceAll(":", "-");
  writeFileSync(path.resolve(__dirname, `marketplace-surface-checks-${ts}.json`), JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Saved ${OUT}`);
}

await main();
