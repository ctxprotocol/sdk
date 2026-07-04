import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const CONTEXT_BASE_URL = (process.env.CONTEXT_BASE_URL ?? "").trim() || "https://www.ctxprotocol.com";
const WALL_TIMEOUT_MS = 360_000;
const OUTPUT_PATH = path.resolve(__dirname, "sdk-query-timeseries-july-2026.json");

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY (context-sdk/.env.local)");

// 3 focused prompts exercising ONLY the updated time-series functions.
// p1: 90-day single-token price history -> get_price_history deep window (3x old ~30d cap)
// p2: 30-day multi-outcome batch history -> get_batch_price_history
// p3: 7-day orderbook depth evolution -> get_orderbook_history
const PROMPTS = [
  "Pull the last 90 days of daily Yes price history for the 'Will the U.S. invade Iran before 2027?' Polymarket market and tell me the date range covered, the high/low over that span, and the biggest single-week repricing.",
  "For the 'Fed Decision in July?' Polymarket event, fetch 30-day price history for every outcome in one batch and rank the outcomes by 30-day percent change — which outcome repriced hardest and when?",
  "How has orderbook depth for the 'Will no Fed rate cuts happen in 2026?' Polymarket market evolved over the past 7 days — is liquidity thickening or thinning? Give me the per-snapshot bid and ask depth.",
];
console.log(`Production SDK Query (time-series focus): ${PROMPTS.length} prompts | target=${CONTEXT_BASE_URL} | concurrency=3`);

function tryParseJson(t){ try{ return JSON.parse(t);}catch{ return null;} }
function parseSseEvents(text){
  return text.split(/\r?\n\r?\n/u).map(c=>c.trim()).filter(c=>c.length>0)
    .map(c=>c.split(/\r?\n/u).filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("\n"))
    .filter(d=>d.length>0 && d!=="[DONE]").map(d=>tryParseJson(d)).filter(e=>e&&typeof e==="object");
}

async function runQuery(prompt){
  const res = await fetch(`${CONTEXT_BASE_URL}/api/v1/query`, {
    method:"POST",
    headers:{ accept:"text/event-stream","content-type":"application/json",authorization:`Bearer ${apiKey}`,"x-api-key":apiKey,"Idempotency-Key":randomUUID() },
    body: JSON.stringify({ query:prompt, tools:[TOOL_ID], responseShape:"answer_with_evidence", queryDepth:"deep", includeDeveloperTrace:true, clarificationPolicy:"auto", stream:true }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });
  const payload = await res.text();
  if(!res.ok) throw new Error(`Query ${res.status}: ${payload.slice(0,400)}`);
  const events = parseSseEvents(payload);
  const done = [...events].reverse().find(e=>e.type==="done"&&e.result&&typeof e.result==="object");
  if(!done) throw new Error(`No done event: ${payload.slice(-400)}`);
  return done.result;
}

function inspectTrace(trace){
  if(!trace||typeof trace!=="object") return {raw:null};
  const s = trace.summary ?? {};
  const calls = Array.isArray(trace.toolCalls) ? trace.toolCalls : [];
  const tsCalls = calls.filter(c => {
    const m = c?.method ?? c?.name ?? c?.toolName ?? "";
    return ["get_price_history","get_batch_price_history","get_orderbook_history"].includes(m);
  });
  return {
    summaryToolCalls: s.toolCalls ?? calls.length ?? 0,
    retryCount: s.retryCount ?? 0,
    loopCount: s.loopCount ?? 0,
    allMethods: [...new Set(calls.map(c=>c?.method ?? c?.name ?? c?.toolName).filter(Boolean))],
    timeSeriesCalls: tsCalls.map(c => ({
      method: c?.method ?? c?.name ?? c?.toolName,
      args: c?.args ?? c?.arguments ?? c?.input ?? null,
      hasResponse: !!(c?.response ?? c?.result ?? c?.output),
      responseKeys: c?.response ? Object.keys(c.response).slice(0,8) : (c?.result ? Object.keys(c.result).slice(0,8) : []),
    })),
    raw: trace,
  };
}

async function runOne(idx, prompt){
  const label = `[${idx+1}/${PROMPTS.length}]`;
  const t0 = Date.now();
  for(let attempt=0; attempt<=1; attempt++){
    try{
      const result = await runQuery(prompt);
      const latencyMs = Date.now()-t0;
      const insp = inspectTrace(result.developerTrace);
      const tsFired = insp.timeSeriesCalls.length;
      console.log(`${label} ${latencyMs/1000|0}s outcome=${result.outcomeType??"?"} toolCalls=${insp.summaryToolCalls} tsCalls=${tsFired} methods=[${insp.allMethods.slice(0,8).join(",")}]`);
      if(tsFired) for(const c of insp.timeSeriesCalls) console.log(`       ${c.method} args=${JSON.stringify(c.args).slice(0,160)} respKeys=[${c.responseKeys.join(",")}]`);
      console.log(`       answer[0:240]: ${(result.response??"").slice(0,240).replace(/\n/g," ")}`);
      return { idx, query:prompt, outcomeType: result.outcomeType??"unknown", latencyMs, toolsUsed: result.toolsUsed ?? [], trace: insp, response: result.response ?? "", pass: result.outcomeType==="answer" && insp.summaryToolCalls>0 };
    }catch(e){
      if(attempt<1){ await sleep(2000); continue; }
      console.log(`${label} FAIL ${(Date.now()-t0)/1000|0}s ${e.message.slice(0,140)}`);
      return { idx, query:prompt, outcomeType:"error", latencyMs: Date.now()-t0, error:e.message.slice(0,400), pass:false };
    }
  }
}

const results = await Promise.all(PROMPTS.map((p,i)=>runOne(i,p)));
await writeFile(OUTPUT_PATH, JSON.stringify(results,null,2)+"\n","utf8");
const pass = results.filter(r=>r.pass).length;
console.log(`\n${pass}/${results.length} passed. Trace evidence in ${OUTPUT_PATH}`);
