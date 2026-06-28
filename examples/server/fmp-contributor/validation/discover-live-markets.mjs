// FMP live grounding snapshot generator.
//
// Unlike Polymarket, FMP's per-request key is contributor-hosted on the VPS
// only (the local .env ships a placeholder), so this script does NOT call the
// FMP API with a live key. Instead it assembles a deterministic grounding
// snapshot of REAL, stable FMP entities (large-cap tickers, sectors, indexes,
// SEC filing types, macro-calendar event types) plus the live 27-method
// catalog extracted from server.ts and the endpoint catalog scraped from the
// upstream docs snapshot. The remote MCP endpoint (which holds the real key)
// returns data for every entity listed here, so prompts grounded in this
// snapshot are answerable through the Context /api/v1/query -> remote fmp path.
//
// Usage: node discover-live-markets.mjs --out live-market-snapshot.json

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = path.resolve(__dirname, "../server.ts");
const UPSTREAM_SNAPSHOT = path.resolve(
  __dirname,
  "context7-fmp-contributor-upstream-snapshot.txt"
);

// Real, stable large-cap tickers that always return data on FMP. Spread across
// sectors so sector-performance and screening prompts have variety.
const GROUNDED_TICKERS = [
  { ticker: "AAPL", name: "Apple Inc.", sector: "Technology", industry: "Consumer Electronics" },
  { ticker: "MSFT", name: "Microsoft Corporation", sector: "Technology", industry: "Software - Infrastructure" },
  { ticker: "NVDA", name: "NVIDIA Corporation", sector: "Technology", industry: "Semiconductors" },
  { ticker: "AMZN", name: "Amazon.com, Inc.", sector: "Consumer Cyclical", industry: "Internet Retail" },
  { ticker: "GOOGL", name: "Alphabet Inc.", sector: "Communication Services", industry: "Internet Content & Information" },
  { ticker: "META", name: "Meta Platforms, Inc.", sector: "Communication Services", industry: "Internet Content & Information" },
  { ticker: "TSLA", name: "Tesla, Inc.", sector: "Consumer Cyclical", industry: "Auto Manufacturers" },
  { ticker: "JPM", name: "JPMorgan Chase & Co.", sector: "Financial Services", industry: "Banks - Diversified" },
  { ticker: "V", name: "Visa Inc.", sector: "Financial Services", industry: "Credit Services" },
  { ticker: "JNJ", name: "Johnson & Johnson", sector: "Healthcare", industry: "Drug Manufacturers - General" },
  { ticker: "XOM", name: "Exxon Mobil Corporation", sector: "Energy", industry: "Oil & Gas Integrated" },
  { ticker: "LLY", name: "Eli Lilly and Company", sector: "Healthcare", industry: "Drug Manufacturers - General" },
  { ticker: "AVGO", name: "Broadcom Inc.", sector: "Technology", industry: "Semiconductors" },
  { ticker: "WMT", name: "Walmart Inc.", sector: "Consumer Defensive", industry: "Discount Stores" },
  { ticker: "HD", name: "The Home Depot, Inc.", sector: "Consumer Cyclical", industry: "Home Improvement Retail" },
  { ticker: "COST", name: "Costco Wholesale Corporation", sector: "Consumer Defensive", industry: "Discount Stores" },
  { ticker: "UNH", name: "UnitedHealth Group Incorporated", sector: "Healthcare", industry: "Healthcare Plans" },
  { ticker: "PG", name: "The Procter & Gamble Company", sector: "Consumer Defensive", industry: "Household & Personal Products" },
  { ticker: "MA", name: "Mastercard Incorporated", sector: "Financial Services", industry: "Credit Services" },
  { ticker: "BRK-B", name: "Berkshire Hathaway Inc.", sector: "Financial Services", industry: "Insurance - Diversified" },
];

const GROUNDED_SECTORS = [
  "Technology",
  "Healthcare",
  "Financial Services",
  "Energy",
  "Consumer Cyclical",
  "Consumer Defensive",
  "Communication Services",
  "Industrials",
  "Utilities",
  "Real Estate",
  "Basic Materials",
];

// Real index symbols FMP serves (used by get_index_constituents).
const GROUNDED_INDEXES = [
  { symbol: "^GSPC", name: "S&P 500" },
  { symbol: "^DJI", name: "Dow Jones Industrial Average" },
  { symbol: "^IXIC", name: "NASDAQ Composite" },
  { symbol: "^RUT", name: "Russell 2000" },
  { symbol: "^N225", name: "Nikkei 225" },
];

// Real SEC filing types (used by get_sec_filings).
const SEC_FILING_TYPES = ["10-K", "10-Q", "8-K", "13F", "DEF 14A", "424B4", "SC 13D"];

// Real macro-calendar event types (used by get_macro_calendar).
const MACRO_EVENT_TYPES = [
  "GDP",
  "CPI",
  "FOMC",
  "Employment Situation",
  "Retail Sales",
  "PPI",
  "ISM Manufacturing PMI",
  "Consumer Confidence",
];

// Mover lists FMP exposes (used by get_market_movers).
const MOVER_LISTS = ["gainers", "losers", "actives"];

function extractToolCatalog(serverTs) {
  const tools = [];
  const lines = serverTs.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*name:\s*"([a-z_]+)",\s*$/);
    if (!match) continue;
    const name = match[1];
    // Grab the description string that follows (next few lines).
    let desc = "";
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const descMatch = lines[j].match(/^\s*description:\s*"(.+)"\s*,?\s*$/);
      if (descMatch) {
        desc = descMatch[1];
        break;
      }
      if (/^\s*name:\s*"/.test(lines[j])) break;
    }
    tools.push({ name, description: desc });
  }
  return tools;
}

function extractEndpointCatalog(upstreamText) {
  const endpointSet = new Set();
  const sourceSet = new Set();
  for (const line of upstreamText.split("\n")) {
    const m = line.match(/https:\/\/financialmodelingprep\.com\/stable\/([a-z0-9\-/]+?)(?:\?|$)/i);
    if (m) endpointSet.add(`/stable/${m[1]}`);
    const s = line.match(/site\.financialmodelingprep\.com\/developer\/docs\/stable\/([a-z0-9\-]+)/i);
    if (s) sourceSet.add(s[1]);
  }
  return {
    endpointCount: endpointSet.size,
    endpoints: [...endpointSet].sort(),
    docPages: [...sourceSet].sort(),
  };
}

function main() {
  const args = process.argv.slice(2);
  let outPath = path.resolve(__dirname, "live-market-snapshot.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = path.resolve(args[i + 1]);
      i += 1;
    }
  }

  const serverTs = readFileSync(SERVER_TS, "utf8");
  const toolCatalog = extractToolCatalog(serverTs);
  const upstreamText = readFileSync(UPSTREAM_SNAPSHOT, "utf8");
  const endpointCatalog = extractEndpointCatalog(upstreamText);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    contributor: "fmp-contributor",
    venue: "Financial Modeling Prep (FMP) stable REST API",
    note: "Deterministic grounding snapshot. FMP_API_KEY is contributor-hosted on the VPS only (local .env ships a placeholder), so no live price call is made here. Every entity listed is a real, stable FMP entity that the remote endpoint (https://mcp.ctxprotocol.com/fmp/mcp) returns data for. Ground prompts in these tickers/sectors/indexes/filings/macro events plus the 27-method catalog below.",
    liveMethodCount: toolCatalog.length,
    toolCatalog,
    endpointCatalog,
    groundedTickers: GROUNDED_TICKERS,
    groundedSectors: GROUNDED_SECTORS,
    groundedIndexes: GROUNDED_INDEXES,
    secFilingTypes: SEC_FILING_TYPES,
    macroEventTypes: MACRO_EVENT_TYPES,
    moverLists: MOVER_LISTS,
    exampleTickerUsedInUpstreamDocs: "AAPL",
  };

  writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`FMP grounding snapshot written to ${outPath}`);
  console.log(`  liveMethodCount: ${toolCatalog.length}`);
  console.log(`  endpointCatalog: ${endpointCatalog.endpointCount} stable endpoints, ${endpointCatalog.docPages.length} doc pages`);
  console.log(`  groundedTickers: ${GROUNDED_TICKERS.length}, sectors: ${GROUNDED_SECTORS.length}, indexes: ${GROUNDED_INDEXES.length}`);
}

main();
