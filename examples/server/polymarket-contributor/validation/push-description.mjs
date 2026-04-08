import { readFile } from "node:fs/promises";
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

const description = `Live prediction market intelligence for Polymarket with real-time CLOB orderbook data, whale flow tracking, and multi-tool analytical workflows.

Features:
- Order book liquidity analysis with simulated exit/entry slippage for positions up to $100K
- Whale vs retail trade flow decomposition by size tier (small, medium, whale) with directional sentiment
- Cross-market arbitrage scanning across 40+ live orderbooks with bid-ask spread analysis
- Market efficiency scoring with vig-stripped implied probabilities
- Top holder concentration analysis with smart money positioning signals
- Volume spike detection ranked by deviation from weekly average with whale/retail attribution
- Multi-outcome event-level whale breakdown comparing positioning against current odds
- Low-probability lottery ticket screening filtered by price threshold and unusual activity
- High-conviction composite workflow combining liquidity, whale flow, holder analysis, and resolution rules

Try asking:
- "What's the current liquidity depth on Polymarket's highest-volume political market? Simulate exiting a $10,000 YES position and show me the expected slippage."
- "Are there any verified arbitrage opportunities on Polymarket right now where buying both YES and NO costs less than $1?"
- "What's the whale vs retail trading flow on the most active Fed interest rate market in the last 24 hours?"
- "Find me Polymarket lottery ticket bets under 15 cents with unusual volume spikes."
- "Deep-fetch the top holders on Polymarket's biggest political market and show concentration levels."
- "Which markets have seen the biggest volume spike in the last 6 hours? For the top 3, is the move driven by whale buying or retail?"
- "Compare liquidity depth and whale positioning across all outcomes in Polymarket's biggest multi-outcome political event."
- "What's the true implied probability on Polymarket's most popular crypto market after stripping out the vig?"
- "For the biggest multi-outcome sports event, which specific outcomes are whales betting on versus current odds?"

Agent tips:
- For market discovery, use get_top_markets or search_markets before running deep analysis tools
- Whale flow analysis works best with conditionId; use search_markets to resolve market names to IDs first
- The high-conviction workflow (build_high_conviction_workflow) chains liquidity, whale flow, efficiency, and holder analysis into a single call
- Most analysis tools accept either slug, conditionId, or tokenId for market identification
- Rate limits apply to upstream Polymarket APIs; space concurrent deep-analysis calls when running multi-market workflows`;

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
          "Authorization": `Bearer ${apiKey}`,
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
