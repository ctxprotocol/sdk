// Runs ON the VPS (piped via SSH). Smokes every fmp-contributor method via
// tools/call against a one-off unauth temp server on port 4099 that reuses the
// production .env FMP_API_KEY. Auto-fills required args from each tool's
// inputSchema using a sample-entity map so we don't have to hardcode 27 arg
// shapes. Prints a single JSON line to stdout: { executeValidation, externalAccuracyCheck }.
import { randomUUID } from "node:crypto";

const TEMP_URL = "http://127.0.0.1:4099/mcp";
const HEALTH_URL = "http://127.0.0.1:4099/health";

// Sample-entity map keyed by lowercased arg name.
const SAMPLE = {
  symbol: "AAPL",
  symbols: ["AAPL"],
  query: "AAPL",
  ticker: "AAPL",
  tickers: ["AAPL"],
  byname: false,
  by_name: false,
  exchange: "NASDAQ",
  sector: "Technology",
  industry: "Consumer Electronics",
  country: "US",
  countrycode: "US",
  index: "sp500",
  statement: "income",
  period: "annual",
  ttm: false,
  limit: 5,
  page: 0,
  from: "2024-01-01",
  to: "2025-06-27",
  series: "light",
  indicator: "rsi",
  timeframe: "1day",
  periodlength: 14,
  period_length: 14,
  mode: "surprises",
  segment: "both",
  chamber: "both",
  direction: "gainers",
  category: "stock",
  date: "",
  filingtype: "10-K",
  filing_type: "10-K",
  type: "10-K",
  isetf: false,
  is_actively_trading: true,
  isactivelytrading: true,
  marketcapmorethan: 1_000_000_000,
  marketcaplowerthan: "",
  pricemorethan: "",
  pricelowerthan: "",
  betamorethan: "",
  betalowerthan: "",
  volumemorethan: "",
  dividendmorethan: "",
  desc: true,
  descarg: true,
};

function tryParseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractSseJson(text) {
  const dataLines = text.split(/\r?\n/u).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter((l) => l.length > 0 && l !== "[DONE]");
  if (dataLines.length === 0) return tryParseJson(text);
  // Each data line may be its own JSON-RPC payload; return the last result-bearing one.
  for (let i = dataLines.length - 1; i >= 0; i -= 1) {
    const j = tryParseJson(dataLines[i]);
    if (j) return j;
  }
  return tryParseJson(dataLines.join("\n"));
}

async function mcpCall(sessionId, method, params = {}) {
  const res = await fetch(TEMP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  const json = extractSseJson(text);
  if (!json) throw new Error(`unparseable response for ${method}: ${text.slice(0, 200)}`);
  return { status: res.status, json };
}

function fillArg(name, prop) {
  const key = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (Object.prototype.hasOwnProperty.call(SAMPLE, key)) {
    const v = SAMPLE[key];
    if (Array.isArray(prop?.enum) && prop.enum.length > 0) {
      // prefer a sample value that is in the enum, else first enum
      const hit = v && prop.enum.includes(v) ? v : prop.enum[0];
      return hit;
    }
    return v;
  }
  if (Array.isArray(prop?.enum) && prop.enum.length > 0) return prop.enum[0];
  if (prop?.type === "array") return ["AAPL"];
  if (prop?.type === "boolean") return false;
  if (prop?.type === "integer" || prop?.type === "number") return 5;
  if (prop?.type === "string") return "AAPL";
  return "AAPL";
}

function buildArgs(schema) {
  const props = schema?.properties ?? {};
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const args = {};
  for (const name of required) {
    args[name] = fillArg(name, props[name]);
  }
  return args;
}

async function main() {
  // initialize
  const initRes = await fetch(TEMP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fmp-smoke", version: "1.0.0" } } }),
    signal: AbortSignal.timeout(30_000),
  });
  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) throw new Error(`no mcp-session-id: ${initRes.status}`);
  await fetch(TEMP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
  });

  const listRes = await mcpCall(sessionId, "tools/list", {});
  const tools = Array.isArray(listRes.json?.result?.tools) ? listRes.json.result.tools : [];
  const methodRuns = [];
  for (const tool of tools) {
    const args = buildArgs(tool.inputSchema);
    const startedAt = Date.now();
    let status = "fail";
    let errorMsg = "";
    let resultKeys = [];
    let resultPreview = "";
    try {
      const callRes = await mcpCall(sessionId, "tools/call", { name: tool.name, arguments: args });
      const result = callRes.json?.result;
      const rpcErr = callRes.json?.error;
      if (rpcErr) {
        errorMsg = typeof rpcErr.message === "string" ? rpcErr.message.slice(0, 200) : "rpc error";
      } else if (!result) {
        errorMsg = "no result object";
      } else {
        const content = Array.isArray(result.content) ? result.content : [];
        const structured = result.structuredContent;
        const firstText = content.find((c) => c?.type === "text")?.text ?? "";
        resultPreview = (typeof firstText === "string" ? firstText : "").slice(0, 300);
        // pass if there's structured content or non-empty text that isn't an error marker
        const looksError = /error|failed|invalid|unauthor/i.test(resultPreview.slice(0, 120));
        if ((structured || firstText.length > 0) && !looksError) {
          status = "pass";
          resultKeys = structured && typeof structured === "object" ? Object.keys(structured).slice(0, 12) : [];
        } else {
          errorMsg = looksError ? `error marker in result: ${resultPreview.slice(0, 120)}` : "empty result";
        }
      }
    } catch (e) {
      errorMsg = e.message.slice(0, 200);
    }
    const durationMs = Date.now() - startedAt;
    methodRuns.push({ methodName: tool.name, args, status, durationMs, resultKeys, resultPreview, error: errorMsg });
    process.stderr.write(`[${status === "pass" ? "PASS" : "FAIL"}] ${tool.name} (${durationMs}ms)${errorMsg ? " :: " + errorMsg.slice(0, 80) : ""}\n`);
  }

  const executeValidation = {
    discoveredToolName: "FMP Equities Intelligence",
    discoveredMethodCount: tools.length,
    passedMethodCount: methodRuns.filter((r) => r.status === "pass").length,
    failedMethodCount: methodRuns.filter((r) => r.status !== "pass").length,
    methods: methodRuns,
  };

  // External accuracy check: get_company_profile for AAPL should return symbol AAPL + plausible sector.
  let externalAccuracyCheck = { status: "FAIL", notes: [] };
  try {
    const acc = await mcpCall(sessionId, "tools/call", { name: "get_company_profile", arguments: { symbols: ["AAPL"] } });
    const sc = acc.json?.result?.structuredContent;
    const text = (acc.json?.result?.content ?? []).find((c) => c?.type === "text")?.text ?? "";
    const blob = JSON.stringify(sc ?? text ?? "").slice(0, 800);
    const hasAapl = /AAPL/i.test(blob);
    const hasTech = /Technology|Consumer Electronics/i.test(blob);
    const hasCap = /marketCap|market_cap|\bprice\b|beta/i.test(blob);
    if (hasAapl && hasTech && hasCap) {
      externalAccuracyCheck = { status: "PASS", notes: ["get_company_profile(AAPL) returned symbol AAPL, sector Technology, and market/price fields — consistent with the real FMP profile upstream."], preview: blob.slice(0, 300) };
    } else {
      externalAccuracyCheck = { status: "FAIL", notes: [`Profile shape mismatch (aapl=${hasAapl}, tech=${hasTech}, cap=${hasCap}).`], preview: blob.slice(0, 300) };
    }
  } catch (e) {
    externalAccuracyCheck = { status: "FAIL", notes: [`accuracy call threw: ${e.message.slice(0, 120)}`] };
  }

  process.stdout.write(JSON.stringify({ executeValidation, externalAccuracyCheck }) + "\n");
}

await main().catch((e) => {
  process.stderr.write(`FATAL: ${e.message}\n`);
  process.stdout.write(JSON.stringify({ executeValidation: { discoveredMethodCount: 0, passedMethodCount: 0, failedMethodCount: 0, methods: [], fatal: e.message }, externalAccuracyCheck: { status: "FAIL", notes: [e.message.slice(0, 120)] } }) + "\n");
  process.exitCode = 0;
});
