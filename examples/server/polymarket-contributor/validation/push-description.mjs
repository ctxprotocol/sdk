import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const LOCAL_CONTEXT_BASE_URL = "http://localhost:3000";

loadDotEnv({ path: path.resolve(__dirname, "../../../../.env.local"), override: false });
loadDotEnv({ path: path.resolve(__dirname, "../../../../../context/.env.local"), override: false });

const apiKey = (process.env.CONTEXT_API_KEY ?? process.env.API_KEY ?? "").trim();
if (!apiKey) throw new Error("Missing CONTEXT_API_KEY");

// Keep in sync with ../marketplace-listing-description.md (generated 2026-05-25)
const description = `Live Polymarket intelligence with CLOB depth, four-tier trade-flow buckets, holder-whale analysis, and composite workflows that turn raw prediction-market tape into actionable tradability and smart-money reads.

Features:
- Order book liquidity and walk-the-book slippage simulation for $1k/$5k/$10k and custom position sizes on YES/NO tokens
- Trade-flow decomposition into small (<$50), medium ($50-$500), large prints ($500-$10k), and whale-sized prints (>= $10k) with YES-directional net flow
- Dual public tape strategy: raw recent trades plus size-filtered ($500+) deep sampling so meaningful prints are not crowded out by tiny recent fills
- Explicit tradeCoverage and buyerGuidance so answers distinguish holder whales, large prints, and whale-sized prints instead of overclaiming
- Optional filtered trade pulls via minNotional, side, and wallet on get_market_trades and summarize_live_market_activity
- One-call smart-money workflows: analyze_single_market_whales, build_high_conviction_workflow, build_market_tradability_memo
- Multi-outcome event tools for outcome liquidity ranking, whale breakdown, tradability memos, and cross-outcome quote comparison
- Discovery and screening: discover_trending_markets, get_top_markets, find_arbitrage_opportunities, find_moderate_probability_bets, polymarket_crossref_kalshi
- Resolution and portfolio tools: check_market_rules, check_market_efficiency with vig-adjusted probabilities, analyze_my_positions

Try asking:
- "For the most liquid live politics market, chart top-holder skew versus 24h trade-flow by size bucket and quantify whether large prints or whale-sized prints are driving the move."
- "What Polymarket categories and tags are hottest right now, and which live markets have the biggest 24h volume spikes?"
- "Inside the 2026 FIFA World Cup winner event, compare Spain, Brazil, and France on live implied odds, spreads, and exit slippage at $5k."
- "Pull only >= $10k BUY-side trades for this conditionId in the last 24h and summarize coverage."
- "Run analyze_single_market_whales on a live single-outcome politics market and tell me holder concentration plus recent flow divergence."
- "This market looks illiquid—is it actually closed, resolved, or just orderbook-disabled? Show marketState before judging slippage."
- "Rank tradability across outcomes in the biggest multi-outcome political event, then flag where top holders disagree with recent large-print flow."

Agent tips:
- Use analyze_whale_flow or analyze_single_market_whales for size-bucket flow; do not bucket trades manually from get_market_trades
- Reserve whale-print language for >= $10k single trades; call $500-$10k trades large prints; use analyze_top_holders for position-level holder whales
- Prefer composite tools (analyze_single_market_whales, summarize_live_market_activity, build_high_conviction_workflow) over chaining discovery plus raw primitives
- Read tradeCoverage.coverageLevel and buyerGuidance before claiming complete market-wide flow; partial raw tape is common on hot markets
- Heavy tools publish rateLimit hints—run one deep workflow at a time on high-volume markets`;

async function pushDescription() {
  const urls = [
    `${LOCAL_CONTEXT_BASE_URL}/api/v1/tools/${TOOL_ID}`,
    `https://www.ctxprotocol.com/api/v1/tools/${TOOL_ID}`,
  ];

  for (const url of urls) {
    console.log(`Trying: ${url}`);
    try {
      const resp = await fetch(url, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ description }),
      });

      if (resp.ok) {
        const result = await resp.json();
        console.log("Description updated successfully!");
        console.log("Response:", JSON.stringify(result, null, 2).slice(0, 500));
        console.log("\nDescription length:", description.length, "chars");
        return;
      }
      console.log(`  => ${resp.status} ${resp.statusText}`);
    } catch (e) {
      console.log(`  => Error: ${e.message}`);
    }
  }
  console.error("All endpoints failed.");
  process.exit(1);
}

pushDescription().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
