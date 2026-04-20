/**
 * Kalshi Prediction Markets MCP Server v1.0
 *
 * A "giga-brained" MCP server for Kalshi prediction market analysis.
 * Provides market discovery, sentiment analysis, arbitrage detection,
 * and trading opportunity identification.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import type {
  ContributorSearchJudge,
  ContributorSearchJudgeResult,
  ContributorSearchResolution,
  SearchCandidate,
} from "../../../dist/contrib/search/index.js";

type ContributorSearchModule = typeof import("../../../dist/contrib/search/index.js");

const contributorSearchModuleSpecifiers = [
  "@ctxprotocol/sdk/contrib/search",
  import.meta.url.includes("/dist/")
    ? "../../../../dist/contrib/search/index.js"
    : "../../../dist/contrib/search/index.js",
] as const;

async function loadContributorSearchModule(): Promise<
  Pick<
    ContributorSearchModule,
    "attachContributorSearchMetadata" | "createSearchIntent" | "resolveContributorSearch"
  >
> {
  let lastError: unknown = null;
  for (const specifier of contributorSearchModuleSpecifiers) {
    try {
      return (specifier.startsWith("@")
        ? await import(specifier)
        : await import(new URL(specifier, import.meta.url).href)) as Pick<
        ContributorSearchModule,
        "attachContributorSearchMetadata" | "createSearchIntent" | "resolveContributorSearch"
      >;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to load contributor search helper module.");
}

const {
  attachContributorSearchMetadata,
  createSearchIntent,
  resolveContributorSearch,
} = await loadContributorSearchModule();

// ============================================================================
// API CONFIGURATION
// ============================================================================

const KALSHI_API_BASE = process.env.KALSHI_API_BASE_URL || "https://api.elections.kalshi.com";
const API_BASE = `${KALSHI_API_BASE}/trade-api/v2`;
const CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA = {
  type: "object" as const,
  description:
    "Compact contributor search helper diagnostics, shortlist provenance, and judge metadata.",
};
const OPENROUTER_CHAT_COMPLETIONS_URL =
  "https://openrouter.ai/api/v1/chat/completions";

function getConfiguredInteger(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

const KALSHI_SEARCH_JUDGE_API_KEY =
  normalizeOptionalString(process.env.KALSHI_OPENROUTER_API_KEY) ??
  normalizeOptionalString(process.env.OPENROUTER_API_KEY);
const KALSHI_SEARCH_JUDGE_MODEL =
  normalizeOptionalString(process.env.KALSHI_SEARCH_JUDGE_MODEL) ??
  "openai/gpt-4o-mini";
const KALSHI_SEARCH_JUDGE_DISABLE =
  process.env.KALSHI_DISABLE_SEARCH_JUDGE === "true";
const KALSHI_SEARCH_JUDGE_TIMEOUT_MS = getConfiguredInteger(
  "KALSHI_SEARCH_JUDGE_TIMEOUT_MS",
  4500,
  250,
  30000
);
const KALSHI_SEARCH_JUDGE_MAX_SHORTLIST = getConfiguredInteger(
  "KALSHI_SEARCH_JUDGE_MAX_SHORTLIST",
  6,
  1,
  10
);
const KALSHI_SEARCH_JUDGE_BUDGET_USD =
  normalizeOptionalString(process.env.KALSHI_SEARCH_JUDGE_BUDGET_USD) ??
  "0.010";
const KALSHI_SEARCH_JUDGE_REFERER =
  normalizeOptionalString(process.env.KALSHI_SEARCH_JUDGE_REFERER) ??
  "https://ctxprotocol.com";
const KALSHI_SEARCH_JUDGE_TITLE =
  normalizeOptionalString(process.env.KALSHI_SEARCH_JUDGE_TITLE) ??
  "Context Kalshi Contributor Search Judge";
const KALSHI_SEARCH_JUDGE_INSTRUCTIONS =
  "Select the single Kalshi contract that best matches the user's request. Prefer exact ticker/title/category grounding and keep nearby series, broader market families, or only tariff-adjacent contracts in related or rejected buckets. Return a null primaryCandidateId when the shortlist remains genuinely ambiguous.";

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ==================== TIER 1: INTELLIGENCE TOOLS ====================

  {
    name: "discover_trending_markets",
    description: `Find the hottest markets on Kalshi right now. Shows volume spikes, price movements, and which markets are seeing the most action.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

IMPROVED CATEGORY FILTERING: When filtering by category (e.g., 'Sports'), this tool uses both API category filtering AND keyword matching to ensure accurate results. Sports keywords include: NBA, NFL, MLB, Super Bowl, championship, etc.

PLANNER GUIDANCE:
  - If the user asks for the hottest markets in a named Kalshi category, call this tool first with that exact category.
  - Prefer this ranked discovery path over raw get_markets or broad browse flows when the request is "hottest", "trending", "most active", or "right now".
  - If the user names an explicit anchor market and asks whether it is hot relative to its own peers, first call get_market to recover the anchor's canonical series/category identifiers, then compare with browse_series before using this broad category leaderboard as secondary context.
  - For climate/weather prompts, do not substitute unrelated sports, crypto, or general commodity markets unless they are explicitly returned here.

RETURNS: Markets ranked by activity with:
- url: Direct Kalshi market link (ALWAYS use this, never construct URLs)
- ticker (use with get_market_orderbook, get_market_trades)
- event_ticker (use with get_event)
- Current prices and volumes
- category: The market's category

CROSS-PLATFORM COMPOSABILITY:
  Compare Kalshi predictions with other marketplace tools for the same event at different prices.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category (e.g., 'Politics', 'Economics', 'Sports', 'Financials')",
        },
        sortBy: {
          type: "string",
          enum: ["volume", "volume_24h", "liquidity", "open_interest"],
          description: "How to rank trending markets (default: volume_24h)",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 20, max: 100)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        marketSummary: { type: "string" },
        trendingMarkets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              title: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              volume24h: { type: "number" },
              volume: { type: "number" },
              openInterest: { type: "number" },
              liquidity: { type: "number" },
              category: { type: "string" },
              closeTime: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        totalActive: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["trendingMarkets", "fetchedAt"],
    },
  },

  {
    name: "analyze_market_liquidity",
    description: `Analyze market liquidity and orderbook depth. Simulates slippage for different position sizes ($100, $500, $1000).

USE THIS WHENEVER the user asks about:
  - "bid-ask spread" / "tightest spread" / "widest spread"
  - "how much size can I buy/sell" / "size at ask" / "size at bid"
  - "orderbook depth" / "liquidity" / "slippage"
  - "can I get in/out of this position without moving the market"

CRITICAL FAN-OUT RULE: If the user asks a spread/depth/size question across multiple
candidates or sub-markets of an event (e.g. "2028 Presidential Election contracts —
which candidate has the tightest spread and how much size can I buy"), you MUST call
this tool once PER candidate/sub-market ticker (ideally in parallel) and then compare
the results. Do NOT answer from search_markets / get_event output alone — those listings
do not include bid-ask spreads or orderbook depth.

INPUT: market ticker from discover_trending_markets, search_markets, or get_event.markets[]

RETURNS:
- Spread analysis (bid-ask spread in cents and %)
- Depth at various price levels
- Slippage simulation for different order sizes
- Liquidity score and recommendation`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker (e.g., 'PRES-2024-DT')",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        ticker: { type: "string" },
        requestedTicker: {
          type: "string",
          description: "Original ticker passed by the caller.",
        },
        resolvedFrom: {
          type: "string",
          description:
            "Set when ticker was auto-resolved (for example, search:KXBITCOIN->KXBTCMAXY-26DEC31-109999.99).",
        },
        currentPrices: {
          type: "object",
          properties: {
            yesBid: { type: "number" },
            yesAsk: { type: "number" },
            noBid: { type: "number" },
            noAsk: { type: "number" },
            lastPrice: { type: "number" },
          },
        },
        spread: {
          type: "object",
          properties: {
            yesCents: { type: "number" },
            yesPercent: { type: "number" },
            noCents: { type: "number" },
            noPercent: { type: "number" },
          },
        },
        depth: {
          type: "object",
          properties: {
            bidDepthUsd: { type: "number" },
            askDepthUsd: { type: "number" },
            totalDepthUsd: { type: "number" },
          },
        },
        slippageSimulation: {
          type: "object",
          properties: {
            buy100: {
              type: "object",
              properties: {
                canFill: { type: "boolean" },
                avgPrice: { type: "string" },
                worstPrice: { type: "number" },
                filledUsd: { type: "number" },
                filledContracts: { type: "number" },
                slippagePercent: { type: "string" },
              },
            },
            buy500: {
              type: "object",
              properties: {
                canFill: { type: "boolean" },
                avgPrice: { type: "string" },
                worstPrice: { type: "number" },
                filledUsd: { type: "number" },
                filledContracts: { type: "number" },
                slippagePercent: { type: "string" },
              },
            },
            buy1000: {
              type: "object",
              properties: {
                canFill: { type: "boolean" },
                avgPrice: { type: "string" },
                worstPrice: { type: "number" },
                filledUsd: { type: "number" },
                filledContracts: { type: "number" },
                slippagePercent: { type: "string" },
              },
            },
          },
        },
        liquidityScore: {
          type: "string",
          enum: ["excellent", "good", "moderate", "poor", "illiquid"],
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "currentPrices", "spread", "liquidityScore"],
    },
  },

  {
    name: "check_market_efficiency",
    description: `Check if a market or full event is efficiently priced. Calculates the "vig" (YES + NO should = 100¢) and identifies pricing inefficiencies.

Use this for prompts like:
- "Check whether KXHIGHNY-26MAR19 is efficiently priced across all outcome buckets"
- "Is this event overround or underround?"
- "Do all YES prices add up to 100 cents?"

INPUT: market ticker OR event ticker

RETURNS:
- Sum of outcome prices (should be ~100¢)
- Vig/overround percentage
- True implied probabilities (vig-adjusted)
- Efficiency rating`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker for single market",
        },
        eventTicker: {
          type: "string",
          description: "Event ticker to analyze all markets in an event",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        outcomes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              title: { type: "string" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              impliedProbability: { type: "number" },
            },
          },
        },
        efficiency: {
          type: "object",
          properties: {
            sumOfYesPrices: { type: "number" },
            vig: { type: "number" },
            vigPercent: { type: "string" },
            isEfficient: { type: "boolean" },
            rating: { type: "string", enum: ["excellent", "good", "fair", "poor", "exploitable"] },
          },
        },
        trueProbabilities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              adjustedProbability: { type: "number" },
            },
          },
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["outcomes", "efficiency"],
    },
  },

  {
    name: "find_arbitrage_opportunities",
    description: `Scan markets for arbitrage opportunities:
1. YES + NO < 100¢ = guaranteed profit by buying both
2. Multi-outcome events where sum < 100¢
3. Wide spreads indicating inefficiency

Also identifies cross-platform arb potential with Polymarket.

RETURNS: Markets with pricing inefficiencies that could yield risk-free profit.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Category to scan (e.g., 'Politics', 'Sports')",
        },
        minEdge: {
          type: "number",
          description: "Minimum edge in cents (default: 1 = 1¢)",
        },
        limit: {
          type: "number",
          description: "Number of markets to scan (default: 50)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        scannedMarkets: { type: "number" },
        arbitrageOpportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              yesAsk: { type: "number" },
              noAsk: { type: "number" },
              totalCost: { type: "number" },
              potentialEdge: { type: "number" },
              edgePercent: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
            },
          },
        },
        wideSpreadMarkets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              ticker: { type: "string" },
              spread: { type: "number" },
              spreadPercent: { type: "string" },
              midPrice: { type: "number" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            arbitrageCount: { type: "number" },
            wideSpreadCount: { type: "number" },
            bestOpportunity: { type: "string" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["scannedMarkets", "arbitrageOpportunities", "summary"],
    },
  },

  {
    name: "find_trading_opportunities",
    description: `Find trading opportunities — ranks markets by strategy, category, OR within a specific event.

USE THIS TOOL WHEN the user asks to "find trading opportunities", "rank sub-legs", "rank sub-markets", "rank by expected value", or "rank markets in <event>". If they give you a specific event ticker or market ticker (e.g. "find trading opportunities on KXMVE...-XYZ"), pass it as \`eventTicker\` (or \`ticker\` — it will be resolved to the parent event) and this tool returns every sub-market in that event ranked by yes-price / probability. Do NOT call get_market first for ranking-style prompts — call this tool directly.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

STRATEGIES (when no eventTicker given):
- lottery_tickets: 1-15¢ (huge payoff if right, unlikely)
- moderate_conviction: 35-65¢ (balanced risk/reward)
- high_confidence: 70-90¢ (likely outcomes, safer returns)
- near_resolution: Markets closing within 24-72h
- high_volume: Most actively traded

CROSS-PLATFORM: Results include tickers for comparison with Polymarket.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        strategy: {
          type: "string",
          enum: ["lottery_tickets", "moderate_conviction", "high_confidence", "near_resolution", "high_volume", "all"],
          description: "Trading strategy to filter by",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        eventTicker: {
          type: "string",
          description: "Scope results to a single event's sub-markets (e.g. 'KXMVESPORTSMULTIGAMEEXTENDED-S2026...'). Use this when the user asks to rank sub-legs of a specific event.",
        },
        ticker: {
          type: "string",
          description: "Optional market ticker — its parent event will be resolved and all sibling sub-markets ranked. Alias for convenience when the user provides a full market ticker.",
        },
        minLiquidity: {
          type: "number",
          description: "Minimum liquidity in USD (default: 1000; set to 0 when scoping to a single eventTicker)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        summary: {
          type: "object",
          properties: {
            marketsScanned: { type: "number" },
            opportunitiesFound: { type: "number" },
            strategy: { type: "string" },
          },
        },
        opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              market: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              impliedProbability: { type: "string" },
              potentialReturn: { type: "string" },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              closeTime: { type: "string" },
              category: { type: "string" },
              whyThisOpportunity: { type: "string" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["summary", "opportunities"],
    },
  },

  {
    name: "get_markets_by_probability",
    description: `🎯 Filter open Kalshi markets by win probability with optional liquidity thresholds.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

Use this for prompts like:
- "Find open Kalshi markets between 15% and 35% probability"
- "Find open Kalshi markets between 15% and 35% probability with at least 1000 liquidity"

OPTIONS:
- very_unlikely: 1-15% (lottery tickets, 6-100x return)
- unlikely: 15-35% (longshots, 2.8-6x return)
- coinflip: 35-65% (balanced, 1.5-2.8x return)
- likely: 65-85% (favorites, 1.2-1.5x return)
- very_likely: 85-95% (near-certain, 1.05-1.2x return)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        probability: {
          type: "string",
          enum: ["very_unlikely", "unlikely", "coinflip", "likely", "very_likely"],
          description: "Probability range to filter",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        minLiquidity: {
          type: "number",
          description: "Optional minimum liquidity in USD. Use this when you need actionable markets, not thin contracts.",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
      },
      required: ["probability"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              ticker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              impliedProbability: { type: "string" },
              potentialReturn: { type: "string" },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              closeTime: { type: "string" },
              category: { type: "string" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            probabilityRange: { type: "string" },
            marketsFound: { type: "number" },
            minLiquidityApplied: { type: "number" },
            avgReturn: { type: "string" },
          },
        },
        degraded: {
          type: "boolean",
          description:
            "True when fallback sampling was used because the primary snapshot request failed.",
        },
        warning: {
          type: "string",
          description: "Optional non-fatal warning about data completeness.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["markets", "summary"],
    },
  },

  {
    name: "analyze_market_sentiment",
    description: `Analyze market sentiment using current prices, recent trades, and recent candlesticks.

Use this for prompts like:
- "Show recent trades and 1h candlesticks, then summarize sentiment"
- "Is this market trending up or down?"
- "What's the conviction behind the latest move?"

INPUT: market ticker

RETURNS:
- Price trend over the requested window
- Volume trend
- Recent tape summary from trades
- Recent candlestick closes and volume
- Sentiment classification (bullish/bearish/neutral)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker",
        },
        periodHours: {
          type: "number",
          description: "Analysis period in hours (default: 24)",
        },
        tradeLimit: {
          type: "number",
          description: "How many recent trades to include (default: 5, max: 20)",
        },
        candlestickInterval: {
          type: "number",
          enum: [1, 60, 1440],
          description: "Candlestick interval in minutes. Default: 60 (1h)",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        ticker: { type: "string" },
        currentPrice: { type: "number" },
        priceChange: {
          type: "object",
          properties: {
            change24h: { type: "number" },
            changePercent24h: { type: "string" },
            high24h: { type: "number" },
            low24h: { type: "number" },
          },
        },
        volumeTrend: {
          type: "object",
          properties: {
            volume24h: { type: "number" },
            volumeChange: { type: "string" },
            isAboveAverage: { type: "boolean" },
          },
        },
        recentTrades: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              price: { type: "number" },
              count: { type: "number" },
              takerSide: { type: "string" },
            },
          },
        },
        recentCandlesticks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              endPeriodTs: { type: "number" },
              closePrice: { type: ["number", "null"] as const },
              volume: { type: "number" },
              openInterest: { type: "number" },
            },
          },
        },
        candlestickSummary: {
          type: "object",
          properties: {
            intervalMinutes: { type: "number" },
            candlesReturned: { type: "number" },
            latestClose: { type: ["number", "null"] as const },
            highClose: { type: ["number", "null"] as const },
            lowClose: { type: ["number", "null"] as const },
            volumeTotal: { type: "number" },
          },
        },
        sentiment: {
          type: "string",
          enum: ["strongly_bullish", "bullish", "neutral", "bearish", "strongly_bearish"],
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
        recommendation: { type: "string" },
        limitations: {
          type: "array",
          items: { type: "string" },
          description: "Non-fatal warnings when secondary data like trades or candlesticks could not be loaded.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "sentiment", "confidence"],
    },
  },

  {
    name: "kalshi_crossref_polymarket",
    description: `Cross-reference one resolved Kalshi market against Polymarket search results.

Use only after resolving an exact Kalshi contract. Returns only credible Polymarket candidates and includes outcome-alignment guidance before comparing prices.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Resolved Kalshi market title or question text.",
        },
        keywords: {
          type: ["string", "array"] as const,
          description:
            "Optional supplemental keywords. Use concise differentiators such as 'fed rate cut end of year'.",
          items: { type: "string" },
        },
        kalshiTicker: {
          type: "string",
          description: "Kalshi market ticker for additional keyword extraction.",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default: 10, max: 25).",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        searchedFor: {
          type: "object",
          properties: {
            keywords: { type: "string" },
            kalshiTicker: { type: "string" },
          },
        },
        searchMethod: { type: "string" },
        polymarketResults: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              slug: { type: "string" },
              question: { type: "string" },
              yesPrice: { type: "number" },
              volume: { type: "number" },
              liquidity: { type: "number" },
              url: { type: "string" },
              matchScore: { type: "number" },
              rules: { type: "string" },
              yesOutcomeMeans: { type: "string" },
              noOutcomeMeans: { type: "string" },
            },
          },
        },
        hint: { type: "string" },
        comparisonNote: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["searchedFor", "searchMethod", "polymarketResults", "hint"],
    },
  },

  // ==================== TIER 2: RAW DATA TOOLS ====================

  {
    name: "get_events",
    description: `Get list of events from Kalshi. Events contain one or more markets.

By default returns OPEN events. Use status='settled' for resolved events.

Each event has:
- event_ticker (use with get_event for details)
- Multiple markets within it
- closeTime (ISO 8601): canonical event close timestamp (earliest sub-market close_time). Render this directly when users ask for close / settlement times — never infer from ticker names.

PLANNER GUIDANCE — CLOSE-TIME FILTERS (read carefully, this is the #1 source of mis-argued calls):
  - Use closingBeforeTs for upper bounds: "closes before <date>", "imminent settlement", "expiring soon", "closes in next N days", "settles by".
  - Use closingAfterTs for lower bounds: "closes after <date>", "settles no sooner than".
  - Both fields take Unix seconds (e.g. midnight UTC of the target day: Math.floor(Date.parse("<cutoff ISO>") / 1000)).
  - Pair both for a window (e.g. closing between now and 2026-04-25 → closingAfterTs=now, closingBeforeTs=Math.floor(Date.parse("2026-04-25T00:00:00Z")/1000)).
  - Never try to infer close times from ticker names. The upstream exposes precise filters and earliestCloseTime/latestCloseTime are returned per event so you can sort/trim further.
  - DO NOT use minCloseTs/maxCloseTs — those legacy names are easy to mis-map (min actually means "closes AFTER" and max means "closes BEFORE"). Always use the closingBeforeTs/closingAfterTs names above. The handler will reject minCloseTs/maxCloseTs arguments with a validation error.
  - WORKED EXAMPLE — "events closing before 2026-04-25": set closingBeforeTs = Math.floor(Date.parse('2026-04-25T00:00:00Z')/1000) = 1777680000. Do NOT confuse 2026 vs 2025 epochs (2025-04-25 = 1745539200, 2026-04-25 = 1777680000). Always compute from the literal ISO date in the user's ask.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "settled"],
          description: "Filter by status (default: open)",
        },
        seriesTicker: {
          type: "string",
          description: "Filter by series ticker",
        },
        withNestedMarkets: {
          type: "boolean",
          description: "Include nested markets in each event payload (default: false)",
        },
        withMilestones: {
          type: "boolean",
          description: "Include event milestones when available",
        },
        closingBeforeTs: {
          type: "number",
          description: "PREFERRED upper-bound close-time filter. Use this for 'closing before <date>', 'imminent settlements', 'expiring soon', 'closes in next N days', or any upper bound on close time. Pass Unix seconds for the cutoff (e.g. Math.floor(Date.parse('2026-04-25T00:00:00Z')/1000)).",
        },
        closingAfterTs: {
          type: "number",
          description: "PREFERRED lower-bound close-time filter. Use this for 'closes after <date>' or 'settles no sooner than'. Pass Unix seconds.",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 50, max: 200)",
        },
        cursor: {
          type: "string",
          description: "Pagination token from prior response. Pass this back to fetch the next page.",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              eventTicker: { type: "string" },
              title: { type: "string" },
              category: { type: "string" },
              status: { type: "string" },
              marketsCount: { type: "number" },
              closeTime: {
                type: "string",
                description: "Canonical close timestamp (earliest sub-market close_time, ISO 8601). Use this when the user asks for event close / settlement times.",
              },
              earliestCloseTime: { type: "string" },
              latestCloseTime: { type: "string" },
            },
          },
        },
        nextCursor: {
          type: "string",
          description: "Token for the next page. Empty string means there are no more results.",
        },
        cursor: {
          type: "string",
          description: "Backwards-compatible alias of nextCursor.",
        },
        count: { type: "number" },
        filtersApplied: {
          type: "object",
          properties: {
            status: { type: "string" },
            seriesTicker: { type: "string" },
            withNestedMarkets: { type: "boolean" },
            withMilestones: { type: "boolean" },
            minCloseTs: { type: "number" },
            maxCloseTs: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["events", "count"],
    },
  },

  {
    name: "get_markets",
    description: `Get markets directly from Kalshi with API-native filters and pagination.

Use this when you need precise, normalized market retrieval (Execute-friendly).
Supports status, event/series/category filters, timestamp filters, explicit ticker lists, and pagination.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          enum: ["open", "closed", "settled"],
          description: "Filter by market status (default: open)",
        },
        eventTicker: {
          type: "string",
          description: "Filter by event ticker",
        },
        seriesTicker: {
          type: "string",
          description: "Filter by series ticker",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        tickers: {
          type: "array",
          description: "Optional exact ticker filter list. Server joins this to API's comma format.",
          items: { type: "string" },
        },
        minUpdatedTs: {
          type: "number",
          description: "Return markets updated after this Unix timestamp",
        },
        closingBeforeTs: {
          type: "number",
          description: "PREFERRED upper-bound close-time filter (Unix seconds). Use for 'closes before <date>', 'expiring soon', 'imminent settlement'.",
        },
        closingAfterTs: {
          type: "number",
          description: "PREFERRED lower-bound close-time filter (Unix seconds). Use for 'closes after <date>'.",
        },
        minCreatedTs: {
          type: "number",
          description: "Minimum created timestamp filter",
        },
        maxCreatedTs: {
          type: "number",
          description: "Maximum created timestamp filter",
        },
        minSettledTs: {
          type: "number",
          description: "Minimum settled timestamp filter",
        },
        maxSettledTs: {
          type: "number",
          description: "Maximum settled timestamp filter",
        },
        limit: {
          type: "number",
          description: "Number of markets per page (default: 50, max: 200)",
        },
        cursor: {
          type: "string",
          description: "Pagination token from previous get_markets call",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              title: { type: "string" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              yesBid: { type: "number" },
              yesAsk: { type: "number" },
              noBid: { type: "number" },
              noAsk: { type: "number" },
              lastPrice: { type: "number" },
              volume: { type: "number" },
              volume24h: { type: "number" },
              openInterest: { type: "number" },
              liquidity: { type: "number" },
              status: { type: "string" },
              category: { type: "string" },
              openTime: { type: "string" },
              closeTime: { type: "string" },
              url: { type: "string", format: "uri" },
            },
          },
        },
        nextCursor: {
          type: "string",
          description: "Token for next page. Empty string means end of results.",
        },
        cursor: {
          type: "string",
          description: "Backwards-compatible alias of nextCursor.",
        },
        count: { type: "number" },
        filtersApplied: {
          type: "object",
          properties: {
            status: { type: "string" },
            eventTicker: { type: "string" },
            seriesTicker: { type: "string" },
            category: { type: "string" },
            tickersCount: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["markets", "count", "nextCursor"],
    },
  },

  {
    name: "get_event",
    description: `Get detailed information about a specific event including all its markets.

🆕 SLUG SUPPORT: This tool auto-detects and resolves URL slugs!

EXAMPLE INPUTS (all work):
  { "eventTicker": "KXDJTVOSTARIFFS" }       // Direct event ticker
  { "eventTicker": "kxdjtvostariffs" }       // URL slug (auto-resolved)
  { "eventTicker": "KXPRESPERSON-28" }       // Event with numeric suffix

URL HANDLING: When users share URLs like https://kalshi.com/markets/kxdjtvostariffs/tariffs-case
  → Extract 'kxdjtvostariffs' and pass as eventTicker

EXAMPLE OUTPUT:
  {
    "event": { "eventTicker": "KXDJTVOSTARIFFS", "title": "Will the Supreme Court..." },
    "markets": [
      { "ticker": "KXDJTVOSTARIFFS", "title": "...", "yesPrice": 32 }
    ]
  }

⚠️ TO GET MARKET DETAILS: Use the 'ticker' from markets[] EXACTLY as-is:
  get_market({ ticker: "KXDJTVOSTARIFFS" })  ✅
  get_market({ ticker: "KXDJTVOSTARIFFS-001" })  ❌ DON'T add suffixes

🔁 RECOVERY HINT — ALL/EVERY SUB-MARKET QUERIES:
  If the user question mentions "all", "every", "each", "full list", "universe",
  or "enumerate" the sub-markets/legs/contracts of an event, DO NOT treat the
  markets[] returned by get_event as exhaustive — it can be truncated to a
  single row. Always follow up with:
    get_markets({ eventTicker: "<same ticker>", status: "open", limit: 200 })
  and page with nextCursor until nextCursor is null. Only then answer the
  "all sub-markets" question. Prefer get_markets pagination whenever
  get_event returns markets.length <= 3 for a question about the whole event.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        eventTicker: {
          type: "string",
          description: "Event ticker (e.g., 'KXDJTVOSTARIFFS') OR URL slug (e.g., 'kxdjtvostariffs'). Slugs are auto-resolved.",
        },
        withNestedMarkets: {
          type: "boolean",
          description: "Include nested markets (default: true)",
        },
      },
      required: ["eventTicker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        event: {
          type: "object",
          description: "Event metadata",
          properties: {
            eventTicker: { type: "string", description: "Event ticker (e.g., 'KXDJTVOSTARIFFS')" },
            title: { type: "string" },
            category: { type: "string" },
            status: { type: "string" },
          },
        },
        markets: {
          type: "array",
          description: "Markets in this event. Use 'ticker' field EXACTLY for get_market calls.",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string", description: "⭐ EXACT market ticker - use this in get_market({ ticker: ... })" },
              title: { type: "string" },
              yesPrice: { type: "number", description: "YES price in cents (32 = 32%)" },
              noPrice: { type: "number", description: "NO price in cents" },
              volume: { type: "number" },
              status: { type: "string" },
            },
          },
        },
        resolvedFrom: { type: "string", description: "If a slug was resolved, shows 'slug:{original_input}'" },
        fetchedAt: { type: "string" },
      },
      required: ["event"],
    },
  },

  {
    name: "resolve_slug",
    description: `🔍 SLUG RESOLUTION: Convert a Kalshi URL slug to the proper event ticker.

USE THIS WHEN: Users share Kalshi URLs and you need to find the market.

URL STRUCTURE: https://kalshi.com/markets/{SERIES_TICKER}/{SLUG}/{EVENT_TICKER}
  - The series_ticker/slug is lowercase (e.g., 'kxdjtvostariffs')
  - The event_ticker is uppercase with suffix (e.g., 'KXDJTVOSTARIFFS-123')

HOW IT WORKS:
  1. Searches all markets for ones matching the slug
  2. Extracts the event_ticker from matching markets
  3. Returns the proper ticker(s) for use with get_event

EXAMPLE:
  Input: { slug: "kxdjtvostariffs" }
  Output: { eventTicker: "KXDJTVOSTARIFFS-123", markets: [...] }

THEN USE: get_event({ eventTicker: "KXDJTVOSTARIFFS-123" }) for full details`,
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The slug from a Kalshi URL (e.g., 'kxdjtvostariffs' from kalshi.com/markets/kxdjtvostariffs/...)",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        found: { type: "boolean" },
        slug: { type: "string" },
        eventTicker: { type: "string", description: "The proper event ticker for use with get_event" },
        seriesTicker: { type: "string" },
        title: { type: "string" },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              title: { type: "string" },
              yesPrice: { type: "number" },
              volume24h: { type: "number" },
            },
          },
        },
        url: { type: "string" },
        hint: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["found", "slug"],
    },
  },

  {
    name: "get_event_by_slug",
    description: `📍 Get event details directly from a Kalshi URL slug.

WHEN USERS SHARE URLS like: https://kalshi.com/markets/kxdjtvostariffs/tariffs-case
  1. Extract the slug: 'kxdjtvostariffs' (first segment after /markets/)
  2. Call: get_event_by_slug({ slug: "kxdjtvostariffs" })

EXAMPLE INPUT:
  { "slug": "kxdjtvostariffs" }

EXAMPLE OUTPUT:
  {
    "event": { "eventTicker": "KXDJTVOSTARIFFS", "title": "Will the Supreme Court rule..." },
    "markets": [{ "ticker": "KXDJTVOSTARIFFS", "yesPrice": 32, ... }]
  }

⚠️ IMPORTANT - HOW TO USE THE OUTPUT:
  - The 'ticker' field in markets[] is the EXACT value to pass to get_market
  - For this example: get_market({ ticker: "KXDJTVOSTARIFFS" })
  - DO NOT modify the ticker (no adding -001, -01, or any suffix)

This is the RECOMMENDED method when working with Kalshi URLs.
It returns the event plus per-market rules, detailed rules text, and direct URLs so agents can answer "fetch the full event with market rules" in one call.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The slug from a Kalshi URL. Example: 'kxdjtvostariffs' from URL kalshi.com/markets/kxdjtvostariffs/...",
        },
        withNestedMarkets: {
          type: "boolean",
          description: "Include nested markets (default: true)",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        event: {
          type: "object",
          description: "Event metadata",
          properties: {
            eventTicker: { type: "string", description: "Event ticker (e.g., 'KXDJTVOSTARIFFS')" },
            seriesTicker: { type: "string", description: "Series ticker / slug (e.g., 'kxdjtvostariffs')" },
            title: { type: "string", description: "Human-readable title" },
            category: { type: "string" },
            status: { type: "string" },
          },
        },
        markets: {
          type: "array",
          description: "Array of markets in this event. Use the 'ticker' field EXACTLY as-is for get_market calls.",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string", description: "⭐ EXACT market ticker - use this value directly in get_market({ ticker: ... })" },
              title: { type: "string" },
              yesPrice: { type: "number", description: "Current YES price in cents (32 = 32%)" },
              noPrice: { type: "number", description: "Current NO price in cents" },
              volume: { type: "number" },
              volume24h: { type: "number" },
              liquidity: { type: "number" },
              status: { type: "string" },
              url: { type: "string", description: "Direct Kalshi URL" },
              rules: { type: "string", description: "⚠️ Resolution rules - compare with other platforms before arbitrage" },
              rulesDetailed: { type: "string", description: "Full legal detail with edge cases - READ THIS for accurate comparison" },
              canCloseEarly: { type: "boolean", description: "Whether market can resolve before close_time" },
              earlyCloseCondition: { type: "string", description: "What triggers early resolution" },
            },
          },
        },
        resolvedFrom: { type: "string", description: "Shows how the slug was resolved" },
        fetchedAt: { type: "string" },
      },
      required: ["event"],
    },
  },

  {
    name: "get_market",
    description: `Get the canonical snapshot for a specific Kalshi market.

Use this for prompts like:
- "Get the exact market snapshot for KXHIGHNY-26MAR19-B47.5"
- "Show me this market's current yes/no prices, status, close time, and rules"
- "Use this market as the anchor, then compare it against its own series peers"

⚠️ CRITICAL: Use EXACT ticker values from API responses. DO NOT construct or guess tickers!

CORRECT WORKFLOW:
  1. Call get_event_by_slug({ slug: "kxdjtvostariffs" })
  2. Response includes: markets: [{ ticker: "KXDJTVOSTARIFFS", ... }]
  3. Call get_market({ ticker: "KXDJTVOSTARIFFS" })  // Use EXACT value from step 2

EXAMPLE - CORRECT:
  get_market({ "ticker": "KXDJTVOSTARIFFS" })  ✅

EXAMPLE - WRONG (DO NOT DO THIS):
  get_market({ "ticker": "KXDJTVOSTARIFFS-001" })  ❌ Adding -001 is WRONG
  get_market({ "ticker": "KXDJTVOSTARIFFS-01" })   ❌ Adding -01 is WRONG
  get_market({ "ticker": "kxdjtvostariffs" })      ❌ Wrong case

The ticker field from API responses is the EXACT string to use. Copy it exactly, don't modify it.
This method is the best single-call source for current market state, resolution rules, canonical URLs, and cohort identifiers.

PLANNER GUIDANCE:
  - If a prompt gives an explicit market ticker and asks whether that market is unusually active, liquid, near resolution, overshadowed, or hot relative to peers, call get_market first.
  - The response includes both category and seriesTicker so you can route follow-up peer comparison to browse_series (same-series cohort) or discover_trending_markets (broad category leaders).

🆕 FALLBACK: If a ticker fails, this tool will auto-attempt to fix common mistakes.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "EXACT market ticker from API response. Example: 'KXDJTVOSTARIFFS' (not 'KXDJTVOSTARIFFS-001'). Copy the ticker value exactly from get_event_by_slug or search_markets results.",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: {
          type: "object",
          properties: {
            ticker: { type: "string" },
            eventTicker: { type: "string" },
            seriesTicker: {
              type: "string",
              description:
                "Canonical series ticker derived from the market's event ticker. Use this for same-series peer comparisons with browse_series.",
            },
            title: { type: "string" },
            subtitle: { type: "string" },
            yesPrice: { type: "number" },
            noPrice: { type: "number" },
            yesBid: { type: "number" },
            yesAsk: { type: "number" },
            lastPrice: { type: "number" },
            volume: { type: "number" },
            volume24h: { type: "number" },
            openInterest: { type: "number" },
            liquidity: { type: "number" },
            status: { type: "string" },
            closeTime: { type: "string" },
            category: { type: "string" },
            rules: { type: "string", description: "Primary resolution rules" },
            rulesDetailed: { type: "string", description: "⚠️ Full legal detail with edge cases - READ THIS for accurate comparison" },
            canCloseEarly: { type: "boolean", description: "Whether market can resolve before close_time" },
            earlyCloseCondition: { type: "string", description: "What triggers early resolution" },
            url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["market"],
    },
  },

  {
    name: "search_markets",
    description: `Search for Kalshi markets by keyword.

✅ ROBUST SEARCH: This tool searches Kalshi's /series endpoint (7,800+ series with titles)
   then fetches markets for matching series. This finds markets that don't appear in
   standard listings.

EXAMPLES:
  - "trump tariffs" → finds KXDJTVOSTARIFFS (Supreme Court tariffs case)
  - "supreme court" → finds all SCOTUS-related markets
  - "bitcoin" → finds all BTC price markets
  - "highest temperature in NYC today" → prefer daily high-temp series like KXHIGHNY

PLANNER GUIDANCE:
  - Use this as the default exact-match resolver for topical searches like Supreme Court, tariffs, SCOTUS, bitcoin, or named weather contracts.
  - For highest/lowest daily temperature prompts, prefer daily HIGH/LOW series such as KXHIGHNY or KXLOWNY.
  - Only use hourly KXTEMP... markets when the user explicitly asks about a specific time of day.
  - This tool returns market titles and prices ONLY. It does NOT return bid-ask spreads, orderbook depth, or size-at-ask. If the user asks about spread, depth, size, liquidity, or slippage, use the tickers returned here as input to analyze_market_liquidity (or get_market_orderbook) — fan out across ALL relevant sub-market tickers before answering.

IF YOU HAVE A KALSHI URL, use get_event_by_slug instead:
  - URL: https://kalshi.com/markets/kxdjtvostariffs/tariffs-case
  - Use: get_event_by_slug({ slug: "kxdjtvostariffs" })

⚠️ Use EXACT ticker values from results. NEVER modify tickers!
  - Correct: get_market({ ticker: "KXDJTVOSTARIFFS" })  ✅
  - Wrong: get_market({ ticker: "KXDJTVOSTARIFFS-001" })  ❌

STATUS OPTIONS:
  - 'open' (default): Active markets currently trading
  - 'settled': Resolved markets (for historical questions)
  - 'all': Both active and historical`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query. Examples: 'trump tariffs', 'kxdjtvostariffs', 'supreme court'",
        },
        category: {
          type: "string",
          description: "Filter by category (e.g., 'Politics', 'Economics')",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "settled", "all"],
          description: "'open' = active (default), 'settled' = historical, 'all' = both",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 20)",
        },
        maxSeriesScan: {
          type: "number",
          description: "Performance guardrail: maximum series records to scan in deep search (default: 600, max: 1200)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        results: {
          type: "array",
          description: "Array of matching markets. Use 'ticker' field EXACTLY as-is for get_market calls.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Human-readable market title" },
              ticker: { type: "string", description: "⭐ EXACT market ticker - use this value in get_market({ ticker: ... }). DO NOT modify it." },
              eventTicker: { type: "string", description: "Parent event ticker" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - use this for links" },
              yesPrice: { type: "number", description: "Current YES price in cents (32 = 32%)" },
              volume24h: { type: "number", description: "24-hour trading volume" },
              category: { type: "string" },
              status: { type: "string" },
              closeTime: { type: "string" },
            },
          },
        },
        count: { type: "number", description: "Number of results returned" },
        searchBudget: {
          type: "object",
          properties: {
            maxSeriesScan: { type: "number" },
            topSeriesEvaluated: { type: "number" },
          },
        },
        searchMetadata: CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA,
        fetchedAt: { type: "string" },
      },
      required: ["results", "count"],
    },
  },

  {
    name: "get_market_orderbook",
    description: `Get the Level 2 orderbook for a specific market. Shows bid/ask prices and quantities.

USE THIS (or analyze_market_liquidity) WHENEVER the user asks about:
  - "bid-ask spread" / "tightest spread" / "widest spread"
  - "how much size can I buy/sell" / "size at ask" / "size at bid"
  - "orderbook depth" / "liquidity" / "slippage"
  - "can I get in/out of" a position

CRITICAL FAN-OUT RULE: If the user asks a spread/depth/size question across multiple
candidates or sub-markets of an event (e.g. "2028 Presidential Election contracts —
which candidate has the tightest spread"), you MUST call this tool (or
analyze_market_liquidity) once PER sub-market ticker and then compare. Do NOT answer
from search_markets / get_event output alone — those do not include orderbook data.

INPUT: market ticker (from search_markets, get_event, or discover_trending_markets)

RETURNS: Level 2 orderbook with bids, asks, spread, and midPrice.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker",
        },
        depth: {
          type: "number",
          description: "Orderbook depth (default: 10, max: 100)",
        },
        preferFixedPoint: {
          type: "boolean",
          description: "If true (default), prefer orderbook_fp quantity precision when available.",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        ticker: { type: "string" },
        bids: {
          type: "array",
          items: {
            type: "object",
            properties: {
              price: { type: "number" },
              quantity: { type: "number" },
            },
          },
        },
        asks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              price: { type: "number" },
              quantity: { type: "number" },
            },
          },
        },
        spread: { type: "number" },
        midPrice: { type: "number" },
        orderbookFpAvailable: { type: "boolean" },
        quantityPrecision: {
          type: "string",
          enum: ["fixed_point", "integer"],
        },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "bids", "asks"],
    },
  },

  {
    name: "get_market_trades",
    description: `Get recent trades for a market. Shows who's buying/selling, prices, and sizes.

INPUT: market ticker

RETURNS: Recent trades with timestamps and details.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker",
        },
        limit: {
          type: "number",
          description: "Number of trades (default: 50, max: 1000)",
        },
        minTs: {
          type: "number",
          description: "Minimum timestamp (Unix)",
        },
        maxTs: {
          type: "number",
          description: "Maximum timestamp (Unix)",
        },
        cursor: {
          type: "string",
          description: "Pagination cursor from previous response",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        ticker: { type: "string" },
        trades: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tradeId: { type: "string" },
              timestamp: { type: "string" },
              price: { type: "number" },
              count: { type: "number" },
              takerSide: { type: "string" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            totalTrades: { type: "number" },
            totalVolume: { type: "number" },
            avgPrice: { type: "number" },
          },
        },
        nextCursor: {
          type: "string",
          description: "Token for next page of trades. Empty string means end of results.",
        },
        cursor: {
          type: "string",
          description: "Backwards-compatible alias of nextCursor.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "trades"],
    },
  },

  {
    name: "get_market_candlesticks",
    description: `Get historical candlestick data for a market.

Uses Kalshi's batch candlesticks endpoint (/markets/candlesticks) for accuracy with current API shapes.
seriesTicker is optional and only used as a fallback for legacy endpoint compatibility.

INPUT: market ticker, optional time range and interval

RETURNS: Array of candlesticks with yes_bid, yes_ask, price, volume, open_interest.

🔁 RECOVERY HINT — EMPTY CANDLES ON LOW-VOLUME LEGS:
  If candlesticks returns [] (or trades/volume are 0) for a given market,
  DO NOT keep retrying different periodInterval values (1 → 60 → 1440) on
  the same ticker — that market is simply illiquid and has no history.
  Instead, pivot to liquid siblings on the same event:
    1. get_market({ ticker }) → read event_ticker (if not already known)
    2. find_trading_opportunities({ eventTicker: "<parent>" })
       or get_markets({ eventTicker: "<parent>", status: "open" })
  Then analyse the liquid legs from the parent event. Treat one empty
  candlestick response on a 0-volume leg as a terminal signal, not a
  retry opportunity.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description: "Optional series ticker for legacy fallback endpoint",
        },
        ticker: {
          type: "string",
          description: "Market ticker",
        },
        startTs: {
          type: "number",
          description: "Start timestamp (Unix)",
        },
        endTs: {
          type: "number",
          description: "End timestamp (Unix)",
        },
        periodInterval: {
          type: "number",
          enum: [1, 60, 1440],
          description: "Interval: 1 (1min), 60 (1hr), 1440 (1day)",
        },
        includeLatestBeforeStart: {
          type: "boolean",
          description: "If true, prepends synthetic continuity candlestick when available",
        },
      },
      required: ["ticker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        ticker: { type: "string" },
        candlesticks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              endPeriodTs: { type: "number" },
              yesBid: {
                type: ["object", "null"] as const,
                properties: {
                  open: { type: ["number", "null"] as const },
                  high: { type: ["number", "null"] as const },
                  low: { type: ["number", "null"] as const },
                  close: { type: ["number", "null"] as const },
                  open_dollars: { type: ["string", "null"] as const },
                  high_dollars: { type: ["string", "null"] as const },
                  low_dollars: { type: ["string", "null"] as const },
                  close_dollars: { type: ["string", "null"] as const },
                },
                additionalProperties: true,
              },
              yesAsk: {
                type: ["object", "null"] as const,
                properties: {
                  open: { type: ["number", "null"] as const },
                  high: { type: ["number", "null"] as const },
                  low: { type: ["number", "null"] as const },
                  close: { type: ["number", "null"] as const },
                  open_dollars: { type: ["string", "null"] as const },
                  high_dollars: { type: ["string", "null"] as const },
                  low_dollars: { type: ["string", "null"] as const },
                  close_dollars: { type: ["string", "null"] as const },
                },
                additionalProperties: true,
              },
              price: {
                type: ["object", "null"] as const,
                properties: {
                  open: { type: ["number", "null"] as const },
                  high: { type: ["number", "null"] as const },
                  low: { type: ["number", "null"] as const },
                  close: { type: ["number", "null"] as const },
                  min: { type: ["number", "null"] as const },
                  max: { type: ["number", "null"] as const },
                  mean: { type: ["number", "null"] as const },
                  previous: { type: ["number", "null"] as const },
                  open_dollars: { type: ["string", "null"] as const },
                  high_dollars: { type: ["string", "null"] as const },
                  low_dollars: { type: ["string", "null"] as const },
                  close_dollars: { type: ["string", "null"] as const },
                  min_dollars: { type: ["string", "null"] as const },
                  max_dollars: { type: ["string", "null"] as const },
                  mean_dollars: { type: ["string", "null"] as const },
                  previous_dollars: { type: ["string", "null"] as const },
                },
                additionalProperties: true,
              },
              volume: { type: "number" },
              openInterest: { type: "number" },
            },
          },
        },
        sourceEndpoint: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "candlesticks"],
    },
  },

  {
    name: "get_event_candlesticks",
    description: `Get aggregated candlesticks for an event across all of its markets.

Uses Kalshi's event-level candlestick endpoint and returns market_tickers + market_candlesticks arrays.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description: "Series ticker for the event",
        },
        eventTicker: {
          type: "string",
          description: "Event ticker",
        },
        startTs: {
          type: "number",
          description: "Start timestamp (Unix)",
        },
        endTs: {
          type: "number",
          description: "End timestamp (Unix)",
        },
        periodInterval: {
          type: "number",
          enum: [1, 60, 1440],
          description: "Interval minutes: 1 (1m), 60 (1h), 1440 (1d)",
        },
      },
      required: ["seriesTicker", "eventTicker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        eventTicker: { type: "string" },
        seriesTicker: { type: "string" },
        marketTickers: {
          type: "array",
          items: { type: "string" },
        },
        marketCandlesticks: {
          type: "array",
          description: "Candlestick arrays aligned by index with marketTickers.",
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
        adjustedEndTs: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["eventTicker", "seriesTicker", "marketTickers", "marketCandlesticks"],
    },
  },

  // ==================== DISCOVERY LAYER TOOLS ====================

  {
    name: "get_all_categories",
    description: `📂 DISCOVERY: List ALL available categories and their tags on Kalshi.

Returns a mapping of categories to tags that can be used to filter series and markets.

DATA FLOW:
  get_all_categories → category → get_all_series({ category }) → series_ticker → markets

CROSS-PLATFORM:
  Categories include: Politics, Economics, Sports, Financials, Climate, Entertainment
  Use to find overlapping data with Polymarket, Odds API, etc.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        categories: {
          type: "object",
          description: "Mapping of category names to arrays of tags",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
        },
        categoryList: {
          type: "array",
          items: { type: "string" },
          description: "List of all category names",
        },
        totalCategories: { type: "number" },
        totalTags: { type: "number" },
        seriesCountByCategory: {
          type: "object",
          description:
            "Snapshot count of series grouped by category. Includes categories returned by Kalshi plus any additional categories found in the series dataset.",
          additionalProperties: {
            type: "number",
          },
        },
        totalSeries: {
          type: "number",
          description: "Total number of series in the snapshot used for seriesCountByCategory.",
        },
        seriesCountSource: {
          type: "string",
          description: "How seriesCountByCategory was computed.",
        },
        seriesCountWarnings: {
          type: "array",
          items: { type: "string" },
          description:
            "Non-fatal warnings while computing seriesCountByCategory. Empty array means no issues.",
        },
        categoriesWarnings: {
          type: "array",
          items: { type: "string" },
          description:
            "Non-fatal warnings while loading category/tag taxonomy. Empty array means no issues.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["categories", "categoryList", "seriesCountByCategory"],
    },
  },

  {
    name: "get_all_series",
    description: `📊 DISCOVERY: List ALL series (market templates) on Kalshi.

A series represents a recurring event type (e.g., "Daily NYC Weather", "Monthly Jobs Report").

INPUT: Optional category/tags filter
RETURNS: Series with tickers that can be used to find events and markets.

DATA FLOW:
  get_all_series → series_ticker → get_events({ seriesTicker }) → markets`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category (e.g., 'Politics', 'Economics')",
        },
        tags: {
          type: "string",
          description: "Filter by tags (comma-separated)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 100)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        series: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              title: { type: "string" },
              category: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              frequency: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        warning: {
          type: "string",
          description: "Optional non-fatal warning when the response is degraded.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["series"],
    },
  },

  {
    name: "get_series",
    description: `📊 DISCOVERY ALIAS: Resolve one series by ticker, or list series with optional filters.

Compatibility method for planners that call "get_series" directly.
- If seriesTicker is provided: returns exactly one series record when found.
- Otherwise: behaves like get_all_series with category/tags/limit filters.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description: "Exact series ticker to resolve (e.g., 'KXBTCMAXY').",
        },
        category: {
          type: "string",
          description: "Filter by category when listing series.",
        },
        tags: {
          type: "string",
          description: "Filter by tags when listing series (comma-separated).",
        },
        limit: {
          type: "number",
          description: "Max results when listing series (default: 100).",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        series: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              title: { type: "string" },
              category: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
              frequency: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        warning: {
          type: "string",
          description: "Optional non-fatal warning when response is degraded or empty.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["series", "totalCount"],
    },
  },

  {
    name: "browse_category",
    description: `🔍 BROWSE: Get all markets within a specific category.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

INPUT: category name from get_all_categories

RETURNS: Markets with:
- url: Direct Kalshi market link (ALWAYS use this)
- ticker (use with analyze_market_liquidity, get_market_orderbook)
- event_ticker (use with get_event)
- Current prices and volumes

CROSS-PLATFORM:
  Browse "Sports" → find championship markets → compare with Odds API futures
  Browse "Crypto" → find price prediction markets → compare with spot prices`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Category name (e.g., 'Politics', 'Sports', 'Economics')",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "settled", "all"],
          description: "Filter by status (default: open)",
        },
        sortBy: {
          type: "string",
          enum: ["volume", "volume_24h", "liquidity", "close_time"],
          description: "Sort order (default: volume_24h)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
      },
      required: ["category"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string" },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              volume24h: { type: "number" },
              liquidity: { type: "number" },
              closeTime: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["category", "markets"],
    },
  },

  {
    name: "browse_series",
    description: `🔍 BROWSE: Get all events and markets within a specific series.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

INPUT: series_ticker from get_all_series, get_series, or get_market.seriesTicker

RETURNS: All events and markets in the series with direct URLs, current yes/no prices, 24h volume, liquidity, and close times. Also returns an 'aggregate' object with marketCount, activeMarketCount, uniqueEventCount (active-event count), totalVolume24h, and totalLiquidity — USE THESE DIRECTLY for "how many active events" / "total 24h volume rolled up" style rollup prompts instead of trying to re-sum the markets[] list.

Example: browse_series({ seriesTicker: "KXHIGHNY" }) → all NYC high temp events
Use this for prompts like "List open markets in the KXHIGHNY series with tickers, current yes prices, and close times."

PLANNER GUIDANCE:
  - Use this as the primary peer-comparison tool when the user gives an explicit anchor market and asks about series peers, same-family contracts, or whether the anchor is unusually active/liquid/close to resolution relative to comparable contracts.
  - If the prompt already includes a series-like prefix such as KXMVECROSSCATEGORY, or get_market returned seriesTicker, pass that exact seriesTicker here instead of asking for clarification.
  - Prefer this over discover_trending_markets when the user wants like-for-like cohort comparison rather than the broadest category leaderboard.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description:
            "Series ticker from get_all_series/get_series, or from get_market.seriesTicker. Many Kalshi market and event tickers start with this series prefix (for example KXMVECROSSCATEGORY-...).",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "settled", "all"],
          description: "Filter by status (default: open)",
        },
        sortBy: {
          type: "string",
          enum: ["volume_24h", "liquidity", "close_time"],
          description:
            "Optional ranking for peer comparison. Use volume_24h or liquidity for hottest/overshadowed prompts, or close_time for near-resolution prompts.",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
      },
      required: ["seriesTicker"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: { type: "string" },
        seriesTitle: { type: "string" },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              volume24h: { type: "number" },
              liquidity: { type: "number" },
              closeTime: { type: "string" },
              status: { type: "string" },
              category: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["seriesTicker", "markets"],
    },
  },
];

type ToolSurface = "answer" | "execute" | "both";
type ToolLatencyClass = "instant" | "fast" | "slow" | "streaming";

interface ToolRateLimitHints {
  maxRequestsPerMinute: number;
  cooldownMs: number;
  maxConcurrency: number;
  supportsBulk: boolean;
  recommendedBatchTools: string[];
  notes: string;
}

interface ToolMetadata {
  surface: ToolSurface;
  queryEligible: boolean;
  latencyClass: ToolLatencyClass;
  pricing: {
    executeUsd: string;
  };
  rateLimit: ToolRateLimitHints;
}

const RAW_DATA_TOOLS = new Set([
  "get_events",
  "get_markets",
  "get_event",
  "get_market",
  "get_market_orderbook",
  "get_market_trades",
  "get_market_candlesticks",
  "get_event_candlesticks",
  "resolve_slug",
  "get_event_by_slug",
]);

const DISCOVERY_TOOLS = new Set([
  "get_all_categories",
  "get_all_series",
  "get_series",
  "browse_category",
  "browse_series",
]);

const HEAVY_QUERY_TOOLS = new Set([
  "search_markets",
  "discover_trending_markets",
  "find_arbitrage_opportunities",
  "find_trading_opportunities",
  "analyze_market_sentiment",
  "browse_category",
  "browse_series",
  "get_all_series",
  "get_series",
]);

const EXECUTE_PRICE_DEFAULT = process.env.DEFAULT_EXECUTE_USD || "0.001";
const EXECUTE_PRICE_INTELLIGENCE = process.env.INTELLIGENCE_EXECUTE_USD || "0.002";
const EXECUTE_PRICE_DISCOVERY = process.env.DISCOVERY_EXECUTE_USD || "0.0005";

function buildToolMeta(toolName: string): ToolMetadata {
  const isRawDataTool = RAW_DATA_TOOLS.has(toolName);
  const isDiscoveryTool = DISCOVERY_TOOLS.has(toolName);
  const isHeavyQueryTool = HEAVY_QUERY_TOOLS.has(toolName);
  const isCrossrefTool = toolName === "kalshi_crossref_polymarket";

  const executeUsd = isRawDataTool
    ? EXECUTE_PRICE_DEFAULT
    : isDiscoveryTool
      ? EXECUTE_PRICE_DISCOVERY
      : EXECUTE_PRICE_INTELLIGENCE;

  const latencyClass: ToolLatencyClass = isRawDataTool
    ? (toolName === "get_market_orderbook" || toolName === "get_market_trades" ? "instant" : "fast")
    : isHeavyQueryTool
      ? "slow"
      : "fast";

  const rateLimit: ToolRateLimitHints = isCrossrefTool
    ? {
        maxRequestsPerMinute: 8,
        cooldownMs: 1500,
        maxConcurrency: 1,
        supportsBulk: false,
        recommendedBatchTools: ["search_markets", "get_events", "get_markets"],
        notes:
          "Cross-platform matcher; first resolve a direct Kalshi candidate, then use this on at most 1-2 high-confidence markets.",
      }
    : isHeavyQueryTool
    ? {
        maxRequestsPerMinute: 20,
        cooldownMs: 750,
        maxConcurrency: 1,
        supportsBulk: false,
        recommendedBatchTools: ["get_markets", "get_events"],
        notes: "Fan-out/heavy query path; prefer direct list endpoints when possible.",
      }
    : {
        maxRequestsPerMinute: 90,
        cooldownMs: 250,
        maxConcurrency: 2,
        supportsBulk: true,
        recommendedBatchTools: ["get_markets", "get_events"],
        notes: "Optimized for iterative execute-mode access with bounded pacing.",
      };

  return {
    surface: "both",
    queryEligible: true,
    latencyClass,
    pricing: {
      executeUsd,
    },
    rateLimit,
  };
}

const TOOLS_WITH_METADATA = TOOLS.map((tool) => ({
  ...tool,
  _meta: buildToolMeta(tool.name),
}));

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "kalshi-intelligence", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS_WITH_METADATA,
}));

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // Tier 1: Intelligence Tools
        case "discover_trending_markets":
          return await handleDiscoverTrendingMarkets(args);
        case "analyze_market_liquidity":
          return await handleAnalyzeMarketLiquidity(args);
        case "check_market_efficiency":
          return await handleCheckMarketEfficiency(args);
        case "find_arbitrage_opportunities":
          return await handleFindArbitrageOpportunities(args);
        case "find_trading_opportunities":
          return await handleFindTradingOpportunities(args);
        case "get_markets_by_probability":
          return await handleGetMarketsByProbability(args);
        case "analyze_market_sentiment":
          return await handleAnalyzeMarketSentiment(args);

        case "kalshi_crossref_polymarket":
          return await handleSearchOnPolymarket(args);

        // Tier 2: Raw Data Tools
        case "get_events":
          return await handleGetEvents(args);
        case "get_markets":
          return await handleGetMarkets(args);
        case "get_event":
          return await handleGetEvent(args);
        case "resolve_slug":
          return await handleResolveSlug(args);
        case "get_event_by_slug":
          return await handleGetEventBySlug(args);
        case "get_market":
          return await handleGetMarket(args);
        case "search_markets":
          return await handleSearchMarkets(args);
        case "get_market_orderbook":
          return await handleGetMarketOrderbook(args);
        case "get_market_trades":
          return await handleGetMarketTrades(args);
        case "get_market_candlesticks":
          return await handleGetMarketCandlesticks(args);
        case "get_event_candlesticks":
          return await handleGetEventCandlesticks(args);

        // Discovery Layer Tools
        case "get_all_categories":
          return await handleGetAllCategories(args);
        case "get_all_series":
          return await handleGetAllSeries(args);
        case "get_series":
          return await handleGetSeries(args);
        case "browse_category":
          return await handleBrowseCategory(args);
        case "browse_series":
          return await handleBrowseSeries(args);

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Unknown error");
    }
  }
);

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

// ----------------------------------------------------------------------------
// Recovery hints: structured pivot guidance emitted by discovery/listing tools
// when their result set is empty, weakly-matched, or obviously incomplete. The
// iterative planner reads tool responses on each step to decide the next call,
// so explicit `recoveryHints.nextTools` with concrete args drastically reduces
// premature refusals ("no markets found") and shallow pagination exits.
// ----------------------------------------------------------------------------
interface RecoveryHintTool {
  toolName: string;
  suggestedArgs?: Record<string, unknown>;
  reason: string;
}

interface RecoveryHints {
  reason: string;
  nextTools: RecoveryHintTool[];
  escalationNote: string;
  shouldSynthesizeRefusal: false;
}

function buildSearchRecoveryHints(params: {
  query: string | undefined;
  category: string | undefined;
  resultCount: number;
  lowConfidence: boolean;
  selectedTitle?: string | null;
}): RecoveryHints | null {
  const { query, category, resultCount, lowConfidence, selectedTitle } = params;
  const isEmpty = resultCount === 0;
  if (!isEmpty && !lowConfidence) {
    return null;
  }

  const q = (query || "").trim();
  const keywordGuess = q
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4)
    .slice(-1)[0];
  const slugGuess = q
    ? `kx${q.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24)}`
    : undefined;

  const nextTools: RecoveryHintTool[] = [];

  if (q) {
    nextTools.push({
      toolName: "search_markets",
      suggestedArgs: {
        query: keywordGuess || q.split(/\s+/).slice(0, 2).join(" "),
        status: "open",
        maxSeriesScan: 1500,
      },
      reason:
        "Retry with a reduced keyword (e.g. the main entity name) and NO category filter to widen the series-search scope.",
    });
  }

  if (slugGuess) {
    nextTools.push({
      toolName: "resolve_slug",
      suggestedArgs: { slug: slugGuess },
      reason:
        "Attempt slug resolution for direct event lookup. Slug format is the lowercase series ticker (e.g. 'kxmamdani', 'kxoaianth').",
    });
    nextTools.push({
      toolName: "get_event_by_slug",
      suggestedArgs: { slug: slugGuess },
      reason:
        "If you have any plausible slug guess from the user's query, call this for a one-shot event + markets snapshot.",
    });
  }

  if (category) {
    nextTools.push({
      toolName: "browse_category",
      suggestedArgs: { category, status: "open", sortBy: "volume_24h", limit: 100 },
      reason:
        "List all active markets in the category so you can scan titles for a semantic match when keyword search missed it.",
    });
    nextTools.push({
      toolName: "discover_trending_markets",
      suggestedArgs: { category, sortBy: "volume_24h", limit: 50 },
      reason:
        "Ranked view of the category's most active markets — useful when search returned irrelevant results.",
    });
  } else {
    nextTools.push({
      toolName: "get_all_series",
      suggestedArgs: { limit: 200 },
      reason:
        "If no category was provided, scan the series catalog (titles) for a plausible match, then call browse_series on the matched seriesTicker.",
    });
  }

  const reason = isEmpty
    ? `search_markets returned 0 results for query=${JSON.stringify(q)}${category ? ` category=${JSON.stringify(category)}` : ""}. Do NOT synthesize a refusal — the next step MUST be one of nextTools.`
    : `search_markets returned ${resultCount} low-confidence result(s)${selectedTitle ? ` (top hit: ${JSON.stringify(selectedTitle)})` : ""} that may not match the user's intent. Do NOT synthesize an answer yet — pivot via nextTools.`;

  return {
    reason,
    nextTools,
    escalationNote:
      "Only after ALL nextTools above have been attempted AND returned empty/irrelevant results may you tell the buyer the market does not exist on Kalshi.",
    shouldSynthesizeRefusal: false,
  };
}

function buildCategoryRecoveryHints(params: {
  category: string;
  status: string;
  resultCount: number;
}): RecoveryHints | null {
  const { category, status, resultCount } = params;
  if (resultCount > 0) {
    return null;
  }

  const nextTools: RecoveryHintTool[] = [
    {
      toolName: "get_all_series",
      suggestedArgs: { category, limit: 100 },
      reason:
        "Category browse returned zero. Enumerate series under this category and then call browse_series on the returned seriesTicker values — categories can be empty at the /markets endpoint even when series exist.",
    },
    {
      toolName: "discover_trending_markets",
      suggestedArgs: { category, sortBy: "volume_24h", limit: 50 },
      reason:
        "Ranked discovery uses a broader market pool + trades fallback, so it often surfaces active markets when category browse is empty.",
    },
    {
      toolName: "get_markets",
      suggestedArgs: { category, status: status === "open" ? "all" : "open", limit: 100 },
      reason:
        "Broaden the status filter (open → all, or vice versa) to catch markets that are pending/closed/settled but still relevant to the question.",
    },
    {
      toolName: "get_all_categories",
      reason:
        "If you are unsure whether the category name is canonical, re-fetch the taxonomy and confirm spelling/capitalization (e.g. 'Economics' vs 'Economy').",
    },
  ];

  return {
    reason: `browse_category for ${JSON.stringify(category)} status=${status} returned 0 markets. Do NOT conclude the category is empty on Kalshi — call the tools in nextTools below before synthesizing a refusal.`,
    nextTools,
    escalationNote:
      "Only after get_all_series + discover_trending_markets + get_markets(status='all') all return empty may you tell the buyer this category has no qualifying markets right now.",
    shouldSynthesizeRefusal: false,
  };
}

function buildSeriesRecoveryHints(params: {
  seriesTicker: string;
  status: string;
  resultCount: number;
}): RecoveryHints | null {
  const { seriesTicker, status, resultCount } = params;
  if (resultCount > 0) {
    return null;
  }

  const nextTools: RecoveryHintTool[] = [
    {
      toolName: "browse_series",
      suggestedArgs: { seriesTicker, status: "all", limit: 100 },
      reason:
        "Retry with status='all' — the series may have only closed/settled markets currently, which are excluded by the default 'open' filter.",
    },
    {
      toolName: "get_events",
      suggestedArgs: { seriesTicker, limit: 50 },
      reason:
        "List events under this series directly; the event-level endpoint may return records even when the market-level endpoint is empty.",
    },
    {
      toolName: "get_series",
      suggestedArgs: { seriesTicker },
      reason:
        "Confirm the series ticker itself is valid. If it returns a warning, the ticker may be malformed and you should call get_all_series to enumerate valid tickers.",
    },
  ];

  return {
    reason: `browse_series for ${JSON.stringify(seriesTicker)} status=${status} returned 0 markets. The series may be dormant, closed, or the ticker may be wrong — try nextTools before concluding.`,
    nextTools,
    escalationNote:
      "Only after all nextTools return empty may you tell the buyer this series has no qualifying markets.",
    shouldSynthesizeRefusal: false,
  };
}

function buildTrendingRecoveryHints(params: {
  category: string | undefined;
  resultCount: number;
}): RecoveryHints | null {
  const { category, resultCount } = params;
  if (resultCount > 0) {
    return null;
  }

  const nextTools: RecoveryHintTool[] = [];
  if (category) {
    nextTools.push({
      toolName: "browse_category",
      suggestedArgs: { category, status: "open", sortBy: "volume_24h", limit: 100 },
      reason:
        "Unranked list of all markets in this category — useful when the trending-ranked pool is empty.",
    });
    nextTools.push({
      toolName: "get_all_series",
      suggestedArgs: { category, limit: 100 },
      reason:
        "Enumerate series under this category and call browse_series on each seriesTicker to surface active markets.",
    });
  } else {
    nextTools.push({
      toolName: "get_all_categories",
      reason:
        "No category was provided — load the taxonomy first, then call discover_trending_markets per category.",
    });
  }

  return {
    reason: `discover_trending_markets returned 0 trendingMarkets${category ? ` for category=${JSON.stringify(category)}` : ""}. Pivot via nextTools before telling the buyer nothing is active.`,
    nextTools,
    escalationNote: "Do not refuse until browse_category + get_all_series both come back empty.",
    shouldSynthesizeRefusal: false,
  };
}

function buildMarketsListRecoveryHints(params: {
  args: Record<string, unknown> | undefined;
  resultCount: number;
  nextCursor: string;
}): RecoveryHints | null {
  const { args, resultCount, nextCursor } = params;
  const category = (args?.category as string) ?? undefined;
  const status = (args?.status as string) ?? "open";
  const seriesTicker = (args?.seriesTicker as string) ?? undefined;
  const eventTicker = (args?.eventTicker as string) ?? undefined;

  const isEmpty = resultCount === 0;
  const hasMorePages = typeof nextCursor === "string" && nextCursor.length > 0;

  if (!isEmpty && !hasMorePages) {
    return null;
  }

  const nextTools: RecoveryHintTool[] = [];

  if (isEmpty) {
    if (eventTicker) {
      nextTools.push({
        toolName: "get_event",
        suggestedArgs: { eventTicker, withNestedMarkets: true },
        reason:
          "The event may exist but have no markets at the requested status — fetch the event directly for nested markets.",
      });
    }
    if (seriesTicker) {
      nextTools.push({
        toolName: "browse_series",
        suggestedArgs: { seriesTicker, status: "all", limit: 100 },
        reason:
          "Broaden the series status filter to include closed/settled markets.",
      });
    }
    if (category) {
      nextTools.push({
        toolName: "browse_category",
        suggestedArgs: { category, status: "open", sortBy: "volume_24h", limit: 100 },
        reason: "Category browse may surface markets missed by the raw markets listing.",
      });
      nextTools.push({
        toolName: "get_all_series",
        suggestedArgs: { category, limit: 100 },
        reason:
          "Enumerate series under this category, then browse_series on each seriesTicker.",
      });
    }
    if (status === "open") {
      nextTools.push({
        toolName: "get_markets",
        suggestedArgs: { ...(args || {}), status: "all", limit: 100 },
        reason: "Retry with status='all' to catch non-open markets that still match the filter.",
      });
    }
    if (nextTools.length === 0) {
      nextTools.push({
        toolName: "discover_trending_markets",
        suggestedArgs: { sortBy: "volume_24h", limit: 50 },
        reason: "Fallback to ranked global discovery when specific filters return empty.",
      });
    }
  }

  if (hasMorePages) {
    nextTools.push({
      toolName: "get_markets",
      suggestedArgs: { ...(args || {}), cursor: nextCursor, limit: 200 },
      reason:
        "Result is paginated — call again with the provided cursor to fetch the next page before synthesizing. Alternatively, pivot to discover_trending_markets / browse_category for a pre-ranked view and stop paginating.",
    });
    nextTools.push({
      toolName: "discover_trending_markets",
      suggestedArgs: category
        ? { category, sortBy: "volume_24h", limit: 100 }
        : { sortBy: "volume_24h", limit: 100 },
      reason:
        "If you are paginating to find 'top N' by activity, a single discover_trending_markets call is a better ranked shortcut.",
    });
  }

  const reason = isEmpty
    ? `get_markets returned 0 markets for filters=${JSON.stringify({ category, status, seriesTicker, eventTicker })}. Do NOT refuse — pivot via nextTools.`
    : `get_markets returned ${resultCount} markets but nextCursor is non-empty (more pages available). Either paginate or pivot to a ranked tool to avoid premature shortlisting.`;

  return {
    reason,
    nextTools,
    escalationNote:
      "Premature refusal after one get_markets call is the #1 failure mode on Kalshi — always attempt at least one nextTools pivot before concluding.",
    shouldSynthesizeRefusal: false,
  };
}

function buildEventFanoutHint(params: {
  eventTicker: string;
  markets: Array<{ ticker: string }>;
}): {
  reason: string;
  recommendedPerMarketTools: RecoveryHintTool[];
  escalationNote: string;
} | null {
  const tickers = params.markets.map((m) => m.ticker).filter(Boolean);
  if (tickers.length < 2) {
    return null;
  }

  return {
    reason: `Event ${params.eventTicker} has ${tickers.length} sub-markets. If the user asked about arbitrage, liquidity, orderbook depth, spread, or a top-N / per-candidate comparison, you MUST fan out (preferably in parallel) across ALL sub-market tickers — partial coverage will produce a wrong answer.`,
    recommendedPerMarketTools: [
      {
        toolName: "get_market_orderbook",
        suggestedArgs: { ticker: "<each markets[].ticker>", depth: 50, preferFixedPoint: true },
        reason: "Per-candidate bid/ask for spread, arbitrage, and liquidity analyses.",
      },
      {
        toolName: "get_market",
        suggestedArgs: { ticker: "<each markets[].ticker>" },
        reason: "Per-candidate yes/no prices, volume, open interest for ranking.",
      },
      {
        toolName: "get_market_candlesticks",
        suggestedArgs: {
          ticker: "<each markets[].ticker>",
          periodInterval: 1440,
          startTs: "<now - 30d>",
          endTs: "<now>",
        },
        reason:
          "Per-candidate historical trajectories for momentum, re-pricing, or time-series comparisons.",
      },
    ],
    escalationNote: `Fan out over all ${tickers.length} tickers (use Promise.all-style parallel calls) before synthesizing. Tickers: ${tickers.slice(0, 20).join(", ")}${tickers.length > 20 ? ", ..." : ""}.`,
  };
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTextFromOpenRouterContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const fragments: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if ("text" in item && typeof item.text === "string") {
      fragments.push(item.text);
      continue;
    }

    if ("content" in item && typeof item.content === "string") {
      fragments.push(item.content);
    }
  }

  return fragments.join("\n").trim();
}

function extractJsonObjectText(rawText: string): string {
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return rawText.slice(start, end + 1).trim();
  }

  return rawText.trim();
}

function normalizeJudgeCandidateIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedIds: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = entry.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    normalizedIds.push(normalized);
  }

  return normalizedIds;
}

function normalizeJudgeConfidence(
  value: unknown
): ContributorSearchJudgeResult["confidence"] {
  if (value === "high" || value === "medium" || value === "low") {
    return value;
  }
  return "low";
}

function parseContributorSearchJudgeResult(
  rawText: string
): ContributorSearchJudgeResult {
  const parsed = JSON.parse(extractJsonObjectText(rawText)) as Record<
    string,
    unknown
  >;

  return {
    primaryCandidateId:
      typeof parsed.primaryCandidateId === "string"
        ? parsed.primaryCandidateId.trim() || null
        : null,
    relatedCandidateIds: normalizeJudgeCandidateIds(parsed.relatedCandidateIds),
    rejectedCandidateIds: normalizeJudgeCandidateIds(parsed.rejectedCandidateIds),
    confidence: normalizeJudgeConfidence(parsed.confidence),
    reason:
      typeof parsed.reason === "string" && parsed.reason.trim().length > 0
        ? parsed.reason.trim()
        : "OpenRouter judge selected a candidate.",
  };
}

function createKalshiOpenRouterJudge(): ContributorSearchJudge | null {
  if (!KALSHI_SEARCH_JUDGE_API_KEY || KALSHI_SEARCH_JUDGE_DISABLE) {
    return null;
  }

  return {
    async evaluate(input, context) {
      const shortlist = input.shortlist.candidates.map((candidate, index) => ({
        rank: index + 1,
        candidateId: candidate.candidateId,
        title: candidate.title,
        description: candidate.description ?? null,
        rawIds: candidate.rawIds ?? {},
        rankFeatures: candidate.rankFeatures ?? {},
        metadata: candidate.metadata ?? {},
        provenance: candidate.provenance.map((provenance) => ({
          source: provenance.source,
          query: provenance.query,
          rank: provenance.rank,
        })),
      }));

      const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KALSHI_SEARCH_JUDGE_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": KALSHI_SEARCH_JUDGE_REFERER,
          "X-Title": KALSHI_SEARCH_JUDGE_TITLE,
        },
        body: JSON.stringify({
          model: context.model ?? KALSHI_SEARCH_JUDGE_MODEL,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You are a contributor-side Kalshi search judge. Return exactly one JSON object with keys primaryCandidateId, relatedCandidateIds, rejectedCandidateIds, confidence, and reason. Never invent candidate ids that are not present in the shortlist.",
            },
            {
              role: "user",
              content: JSON.stringify(
                {
                  rawRequest: input.rawRequest,
                  intents: input.intents,
                  instructions:
                    input.instructions ?? KALSHI_SEARCH_JUDGE_INSTRUCTIONS,
                  traceLabel: context.traceLabel,
                  shortlist,
                },
                null,
                2
              ),
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OpenRouter judge request failed with ${response.status} ${response.statusText}`
        );
      }

      const payload = (await response.json()) as Record<string, unknown>;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice =
        choices[0] && typeof choices[0] === "object"
          ? (choices[0] as Record<string, unknown>)
          : null;
      const message =
        firstChoice &&
        typeof firstChoice.message === "object" &&
        firstChoice.message !== null
          ? (firstChoice.message as Record<string, unknown>)
          : null;
      const rawText = extractTextFromOpenRouterContent(message?.content);

      if (rawText.length === 0) {
        throw new Error("OpenRouter judge returned empty content.");
      }

      const result = parseContributorSearchJudgeResult(rawText);
      const usage =
        typeof payload.usage === "object" && payload.usage !== null
          ? (payload.usage as Record<string, unknown>)
          : null;

      if (usage) {
        result.usage = {
          promptTokens: getFiniteNumber(usage.prompt_tokens) ?? undefined,
          completionTokens: getFiniteNumber(usage.completion_tokens) ?? undefined,
          totalTokens: getFiniteNumber(usage.total_tokens) ?? undefined,
          costUsd: getNonEmptyString(usage.cost),
          latencyMs: getFiniteNumber(usage.latency_ms),
        };
      }

      return result;
    },
  };
}

async function resolveKalshiContributorSearch(params: {
  rawRequest: string;
  intentQuery: string;
  traceLabel: string;
  candidates: SearchCandidate[];
}): Promise<ContributorSearchResolution | null> {
  if (params.candidates.length === 0) {
    return null;
  }

  const judge = createKalshiOpenRouterJudge();
  return await resolveContributorSearch({
    rawRequest: params.rawRequest,
    intents: [
      createSearchIntent({
        rawRequest: params.rawRequest,
        query: params.intentQuery,
        clause: "kalshi contributor search resolution",
      }),
    ],
    candidates: params.candidates,
    ...(judge ? { judge } : {}),
    contributorConfig: {
      provider: "openrouter",
      model: KALSHI_SEARCH_JUDGE_MODEL,
      timeoutMs: KALSHI_SEARCH_JUDGE_TIMEOUT_MS,
      budgetUsd: KALSHI_SEARCH_JUDGE_BUDGET_USD,
      disableJudge: KALSHI_SEARCH_JUDGE_DISABLE,
      degradedOutcomePolicy: "allow_low_confidence_selected",
      maxShortlistSize: judge ? KALSHI_SEARCH_JUDGE_MAX_SHORTLIST : 1,
    },
    instructions: KALSHI_SEARCH_JUDGE_INSTRUCTIONS,
    traceLabel: params.traceLabel,
  });
}

function buildKalshiResultSearchCandidate(params: {
  query: string;
  rank: number;
  source: string;
  result: Record<string, unknown>;
}): SearchCandidate {
  const title = getNonEmptyString(params.result.title) ?? params.query;
  const ticker = getNonEmptyString(params.result.ticker);
  const eventTicker = getNonEmptyString(params.result.eventTicker);
  const closeTime = getNonEmptyString(params.result.closeTime);
  const yesPrice = getFiniteNumber(params.result.yesPrice);

  return {
    candidateId:
      ticker || `${params.rank}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    title,
    description: closeTime ? `Closes ${closeTime}` : null,
    rawIds: {
      ...(ticker ? { ticker } : {}),
      ...(eventTicker ? { eventTicker } : {}),
    },
    rankFeatures: {
      rank: params.rank,
      yesPrice,
      volume24h: getFiniteNumber(params.result.volume24h),
      status: getNonEmptyString(params.result.status),
      category: getNonEmptyString(params.result.category),
    },
    provenance: [
      {
        source: params.source,
        query: params.query,
        rank: params.rank,
        fetchedAt: new Date().toISOString(),
        metadata: {
          ticker,
          eventTicker,
        },
      },
    ],
    metadata: {
      category: getNonEmptyString(params.result.category),
      status: getNonEmptyString(params.result.status),
      closeTime,
    },
  };
}

// ============================================================================
// API FETCH HELPERS
// ============================================================================

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dollarsToCents(value: unknown): number | undefined {
  const dollars = parseFiniteNumber(value);
  if (dollars === undefined) {
    return undefined;
  }

  return Number((dollars * 100).toFixed(4));
}

function normalizeKalshiCandleMetric(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...record };
  const mappings: Array<[string, string]> = [
    ["open_dollars", "open"],
    ["high_dollars", "high"],
    ["low_dollars", "low"],
    ["close_dollars", "close"],
    ["min_dollars", "min"],
    ["max_dollars", "max"],
    ["mean_dollars", "mean"],
    ["previous_dollars", "previous"],
  ];

  for (const [sourceKey, targetKey] of mappings) {
    if (normalized[targetKey] !== undefined) {
      continue;
    }
    const cents = dollarsToCents(normalized[sourceKey]);
    if (cents !== undefined) {
      normalized[targetKey] = cents;
    }
  }

  return normalized;
}

function normalizeKalshiCandleRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...record };

  if (isRecord(normalized.yes_bid)) {
    normalized.yes_bid = normalizeKalshiCandleMetric(normalized.yes_bid);
  }
  if (isRecord(normalized.yes_ask)) {
    normalized.yes_ask = normalizeKalshiCandleMetric(normalized.yes_ask);
  }
  if (isRecord(normalized.price)) {
    normalized.price = normalizeKalshiCandleMetric(normalized.price);
  }

  if (normalized.volume === undefined) {
    const volume = parseFiniteNumber(normalized.volume_fp);
    if (volume !== undefined) {
      normalized.volume = volume;
    }
  }

  if (normalized.open_interest === undefined) {
    const openInterest = parseFiniteNumber(normalized.open_interest_fp);
    if (openInterest !== undefined) {
      normalized.open_interest = openInterest;
    }
  }

  return normalized;
}

function normalizeOrderbookLevels(
  rawLevels: unknown,
  priceUnit: "cents" | "dollars"
): Array<[number, number]> {
  if (!Array.isArray(rawLevels)) {
    return [];
  }

  const normalizedLevels: Array<[number, number]> = [];
  for (const level of rawLevels) {
    if (!Array.isArray(level) || level.length < 2) {
      continue;
    }

    const price =
      priceUnit === "dollars"
        ? dollarsToCents(level[0])
        : parseFiniteNumber(level[0]);
    const quantity = parseFiniteNumber(level[1]);

    if (price === undefined || quantity === undefined) {
      continue;
    }

    normalizedLevels.push([price, quantity]);
  }

  return normalizedLevels;
}

function normalizeKalshiOrderbookRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...record };
  const rawOrderbook = isRecord(normalized.orderbook) ? normalized.orderbook : {};
  const rawOrderbookFp = isRecord(normalized.orderbook_fp) ? normalized.orderbook_fp : {};

  const normalizedYes =
    rawOrderbookFp.yes_dollars !== undefined
      ? normalizeOrderbookLevels(rawOrderbookFp.yes_dollars, "dollars")
      : rawOrderbookFp.yes !== undefined
        ? normalizeOrderbookLevels(rawOrderbookFp.yes, "cents")
        : normalizeOrderbookLevels(rawOrderbook.yes, "cents");
  const normalizedNo =
    rawOrderbookFp.no_dollars !== undefined
      ? normalizeOrderbookLevels(rawOrderbookFp.no_dollars, "dollars")
      : rawOrderbookFp.no !== undefined
        ? normalizeOrderbookLevels(rawOrderbookFp.no, "cents")
        : normalizeOrderbookLevels(rawOrderbook.no, "cents");

  normalized.orderbook = {
    ...rawOrderbook,
    yes: normalizedYes,
    no: normalizedNo,
  };
  normalized.orderbook_fp = {
    ...rawOrderbookFp,
    yes: normalizedYes,
    no: normalizedNo,
  };

  return normalized;
}

function normalizeKalshiTradeRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...record };

  if (normalized.ticker === undefined && typeof normalized.market_ticker === "string") {
    normalized.ticker = normalized.market_ticker;
  }

  if (normalized.yes_price === undefined) {
    const yesPrice = dollarsToCents(normalized.yes_price_dollars);
    if (yesPrice !== undefined) {
      normalized.yes_price = yesPrice;
    }
  }

  if (normalized.no_price === undefined) {
    const noPrice = dollarsToCents(normalized.no_price_dollars);
    if (noPrice !== undefined) {
      normalized.no_price = noPrice;
    }
  }

  if (normalized.price === undefined) {
    const derivedPrice =
      dollarsToCents(normalized.price_dollars) ??
      (typeof normalized.yes_price === "number" ? normalized.yes_price : undefined);
    if (derivedPrice !== undefined) {
      normalized.price = derivedPrice;
    }
  }

  if (normalized.count === undefined) {
    const count = parseFiniteNumber(normalized.count_fp);
    if (count !== undefined) {
      normalized.count = count;
    }
  }

  if (normalized.created_ts === undefined && typeof normalized.ts === "number") {
    normalized.created_ts = normalized.ts;
  }

  return normalized;
}

function normalizeKalshiMarketRecord(record: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...record };

  const centMappings: Array<[string, string]> = [
    ["yes_bid_dollars", "yes_bid"],
    ["yes_ask_dollars", "yes_ask"],
    ["no_bid_dollars", "no_bid"],
    ["no_ask_dollars", "no_ask"],
    ["last_price_dollars", "last_price"],
    ["previous_price_dollars", "previous_price"],
  ];
  for (const [sourceKey, targetKey] of centMappings) {
    if (normalized[targetKey] !== undefined) {
      continue;
    }
    const cents = dollarsToCents(normalized[sourceKey]);
    if (cents !== undefined) {
      normalized[targetKey] = cents;
    }
  }

  const fixedPointMappings: Array<[string, string]> = [
    ["volume_fp", "volume"],
    ["volume_24h_fp", "volume_24h"],
    ["open_interest_fp", "open_interest"],
  ];
  for (const [sourceKey, targetKey] of fixedPointMappings) {
    if (normalized[targetKey] !== undefined) {
      continue;
    }
    const parsed = parseFiniteNumber(normalized[sourceKey]);
    if (parsed !== undefined) {
      normalized[targetKey] = parsed;
    }
  }

  if (normalized.liquidity === undefined) {
    const liquidity = parseFiniteNumber(normalized.liquidity_dollars);
    if (liquidity !== undefined) {
      normalized.liquidity = liquidity;
    }
  }

  return normalized;
}

function looksLikeKalshiCandleMetric(record: Record<string, unknown>): boolean {
  return [
    "open_dollars",
    "high_dollars",
    "low_dollars",
    "close_dollars",
    "mean_dollars",
    "previous_dollars",
  ].some((key) => key in record);
}

function looksLikeKalshiCandleRecord(record: Record<string, unknown>): boolean {
  return "end_period_ts" in record && (
    "volume_fp" in record ||
    "open_interest_fp" in record ||
    "yes_bid" in record ||
    "yes_ask" in record ||
    "price" in record
  );
}

function looksLikeKalshiOrderbookRecord(record: Record<string, unknown>): boolean {
  return "orderbook" in record || "orderbook_fp" in record;
}

function looksLikeKalshiTradeRecord(record: Record<string, unknown>): boolean {
  return "trade_id" in record && (
    "count_fp" in record ||
    "yes_price_dollars" in record ||
    "market_ticker" in record
  );
}

function looksLikeKalshiMarketRecord(record: Record<string, unknown>): boolean {
  return typeof record.ticker === "string" && (
    "event_ticker" in record ||
    "yes_ask_dollars" in record ||
    "yes_bid_dollars" in record ||
    "no_ask_dollars" in record ||
    "volume_fp" in record ||
    "open_interest_fp" in record
  );
}

function normalizeKalshiPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeKalshiPayload(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  let normalized: Record<string, unknown> = {};
  for (const [key, childValue] of Object.entries(value)) {
    normalized[key] = normalizeKalshiPayload(childValue);
  }

  if (looksLikeKalshiCandleMetric(normalized)) {
    normalized = normalizeKalshiCandleMetric(normalized);
  }
  if (looksLikeKalshiCandleRecord(normalized)) {
    normalized = normalizeKalshiCandleRecord(normalized);
  }
  if (looksLikeKalshiOrderbookRecord(normalized)) {
    normalized = normalizeKalshiOrderbookRecord(normalized);
  }
  if (looksLikeKalshiTradeRecord(normalized)) {
    normalized = normalizeKalshiTradeRecord(normalized);
  }
  if (looksLikeKalshiMarketRecord(normalized)) {
    normalized = normalizeKalshiMarketRecord(normalized);
  }

  return normalized;
}

async function fetchKalshi(endpoint: string, timeoutMs = 15000): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });

      if (response.ok) {
        const payload = await response.json();
        return normalizeKalshiPayload(payload);
      }

      const bodyText = await response.text();
      const retryableStatus = response.status === 429 || response.status >= 500;
      if (retryableStatus && attempt < maxRetries) {
        const retryAfterHeader = response.headers.get("retry-after");
        const retryAfterSeconds = retryAfterHeader
          ? Number.parseFloat(retryAfterHeader)
          : Number.NaN;
        const retryAfterMs = Number.isFinite(retryAfterSeconds)
          ? Math.max(retryAfterSeconds, 0) * 1000
          : Math.min(500 * (2 ** attempt), 4000);
        const jitterMs = Math.floor(Math.random() * 150);
        await sleep(retryAfterMs + jitterMs);
        continue;
      }

      throw new Error(
        `Kalshi API error (${response.status}) on ${endpoint}: ${bodyText.slice(0, 200)}`
      );
    } catch (error) {
      const isAbortError =
        error instanceof Error && error.name === "AbortError";
      if (isAbortError && attempt < maxRetries) {
        const backoffMs = Math.min(500 * (2 ** attempt), 4000);
        const jitterMs = Math.floor(Math.random() * 150);
        await sleep(backoffMs + jitterMs);
        continue;
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(`Kalshi API request failed after retries: ${endpoint}`);
}

// ============================================================================
// URL HELPER
// ============================================================================

/**
 * Extracts the series ticker from an event_ticker by removing various suffix patterns.
 * 
 * Kalshi event tickers have different formats:
 * - KXPRESPERSON-28 (numeric suffix) -> kxpresperson
 * - KXNBAPTS-26JAN09ATLDEN (date+teams) -> kxnbapts
 * - KXMVENBASINGLEGAME-S2025000ECCE13C4 (UUID suffix) -> kxmvenbasinglegame
 * 
 * The series ticker is used in URLs: https://kalshi.com/markets/{series_ticker}/{slug}
 */
function getSeriesTicker(eventTicker: string): string {
  // Remove various suffix patterns and convert to lowercase
  // Pattern 1: -S20XX... (UUID-like suffix)
  // Pattern 2: -XXMONXX... (date pattern like 26JAN09)
  // Pattern 3: -XX (numeric suffix)
  const cleaned = eventTicker
    .replace(/-S20[0-9]{2}[A-F0-9]+$/i, '')  // UUID-like: -S2025000ECCE13C4
    .replace(/-\d{2}[A-Z]{3}\d{2}[A-Z]+$/i, '')  // Date+teams: -26JAN09ATLDEN
    .replace(/-\d+$/, '');  // Numeric: -28
  
  return cleaned.toLowerCase();
}

const KALSHI_CATEGORY_ALIASES: Record<string, string> = {
  climate: "climate and weather",
  weather: "climate and weather",
  "climate & weather": "climate and weather",
  economy: "economics",
  economic: "economics",
  finance: "financials",
};

const KALSHI_CATEGORY_KEYWORDS: Record<string, string[]> = {
  sports: [
    "nba",
    "nfl",
    "mlb",
    "nhl",
    "super bowl",
    "championship",
    "playoffs",
    "football",
    "basketball",
    "baseball",
    "hockey",
    "soccer",
    "tennis",
    "golf",
    "ufc",
    "boxing",
    "f1",
    "nascar",
    "olympics",
    "world cup",
    "finals",
    "mvp",
    "rookie",
    "draft",
  ],
  politics: [
    "election",
    "president",
    "senate",
    "congress",
    "vote",
    "trump",
    "biden",
    "democrat",
    "republican",
    "governor",
    "primary",
    "nominee",
  ],
  economics: [
    "gdp",
    "inflation",
    "fed",
    "interest rate",
    "rates",
    "recession",
    "jobs",
    "payrolls",
    "employment",
    "unemployment",
    "cpi",
    "pce",
    "economic",
    "tariff",
    "tariffs",
  ],
  financials: [
    "stock",
    "s&p",
    "nasdaq",
    "bitcoin",
    "crypto",
    "price",
    "market",
  ],
  "climate and weather": [
    "weather",
    "climate",
    "temp",
    "temperature",
    "rain",
    "snow",
    "storm",
    "hurricane",
    "wind",
    "heat",
    "cold",
    "precipitation",
    "forecast",
    "landfall",
  ],
};

const LOW_SIGNAL_SEARCH_WORDS = new Set([
  "current",
  "exact",
  "find",
  "identify",
  "latest",
  "live",
  "main",
  "market",
  "markets",
  "next",
  "open",
  "price",
  "prices",
  "release",
  "resolve",
  "return",
  "rule",
  "rules",
  "show",
  "trading",
  "whether",
  "will",
]);

function normalizeKalshiCategoryName(value: string | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (!normalizedValue) {
    return null;
  }

  return KALSHI_CATEGORY_ALIASES[normalizedValue] ?? normalizedValue;
}

function getKalshiCategoryKeywords(category: string | undefined): string[] {
  const normalizedCategory = normalizeKalshiCategoryName(category);
  if (!normalizedCategory) {
    return [];
  }

  return KALSHI_CATEGORY_KEYWORDS[normalizedCategory] || [];
}

function textLooksLikeSportsMarket(text: string): boolean {
  return /(winner\?|\bvs\b|points?|goals?|assists?|rebounds?|touchdowns?|innings?|pitcher|strikeouts?|world series|playoffs?|championship|finals)/i.test(
    text
  );
}

function matchesRequestedKalshiCategory(params: {
  requestedCategory: string | undefined;
  recordCategory: string | undefined;
  text: string;
}): boolean {
  const normalizedRequested = normalizeKalshiCategoryName(params.requestedCategory);
  if (!normalizedRequested) {
    return true;
  }

  const normalizedRecord = normalizeKalshiCategoryName(params.recordCategory);
  if (normalizedRecord === normalizedRequested) {
    return true;
  }

  if (normalizedRequested !== "sports" && textLooksLikeSportsMarket(params.text)) {
    return false;
  }

  const keywords = getKalshiCategoryKeywords(normalizedRequested);
  return keywords.length === 0
    ? false
    : keywords.some((keyword) => params.text.includes(keyword));
}

function filterMarketsByRequestedCategory(
  markets: KalshiMarket[],
  requestedCategory: string | undefined
): KalshiMarket[] {
  if (!requestedCategory) {
    return markets;
  }

  return markets.filter((market) => {
    const searchText = [
      market.title || "",
      market.subtitle || "",
      market.yes_sub_title || "",
      market.event_ticker || "",
      market.ticker || "",
    ]
      .join(" ")
      .toLowerCase();
    return matchesRequestedKalshiCategory({
      requestedCategory,
      recordCategory: market.category,
      text: searchText,
    });
  });
}

function filterSeriesByRequestedCategory(
  series: KalshiSeries[],
  requestedCategory: string | undefined
): KalshiSeries[] {
  if (!requestedCategory) {
    return series;
  }

  return series.filter((entry) => {
    const searchText = [
      entry.title || "",
      entry.ticker || "",
      Array.isArray(entry.tags) ? entry.tags.join(" ") : "",
    ]
      .join(" ")
      .toLowerCase();
    return matchesRequestedKalshiCategory({
      requestedCategory,
      recordCategory: entry.category,
      text: searchText,
    });
  });
}

function normalizeRequestedKalshiStatus(value: string | undefined): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (!normalizedValue) {
    return "open";
  }
  if (normalizedValue === "active") {
    return "open";
  }
  return normalizedValue;
}

function matchesRequestedKalshiStatus(
  requestedStatus: string | undefined,
  recordStatus: string | undefined
): boolean {
  const normalizedRequested = normalizeRequestedKalshiStatus(requestedStatus);
  if (normalizedRequested === "all") {
    return true;
  }

  const normalizedRecord = recordStatus?.trim().toLowerCase() || "";
  if (normalizedRequested === "open") {
    return (
      normalizedRecord === "open" ||
      normalizedRecord === "active" ||
      normalizedRecord === "initialized"
    );
  }
  if (normalizedRequested === "settled") {
    return normalizedRecord === "settled" || normalizedRecord === "resolved";
  }
  return normalizedRecord === normalizedRequested;
}

function textMatchesSearchWord(searchText: string, word: string): boolean {
  const variants = new Set([word]);
  if (word.length > 4 && word.endsWith("s") && !word.endsWith("ss")) {
    variants.add(word.slice(0, -1));
  } else if (word.length > 3 && !word.endsWith("s")) {
    variants.add(`${word}s`);
  }

  for (const variant of variants) {
    if (searchText.includes(variant)) {
      return true;
    }
  }

  return false;
}

function computeIntentMatchScore(searchText: string, words: string[]): number {
  return words.reduce((total, word) => {
    if (!textMatchesSearchWord(searchText, word)) {
      return total;
    }

    return total + (word.length >= 6 ? 2 : 1);
  }, 0);
}

function hasCredibleIntentMatch(searchText: string, words: string[]): boolean {
  if (words.length === 0) {
    return true;
  }

  let matchCount = 0;
  let anchorMatchCount = 0;
  for (const word of words) {
    if (!textMatchesSearchWord(searchText, word)) {
      continue;
    }

    matchCount += 1;
    if (word.length >= 6) {
      anchorMatchCount += 1;
    }
  }

  const minimumSignalMatches = Math.max(1, Math.ceil(words.length / 2));
  return (
    anchorMatchCount > 0 ||
    (matchCount >= minimumSignalMatches && matchCount / words.length >= 0.5)
  );
}

/**
 * Detects if an input looks like a URL slug rather than an event ticker.
 * Slugs are:
 * - All lowercase
 * - Don't have a -XX numeric suffix
 * - May contain hyphens but not in ticker format
 */
function isSlug(input: string): boolean {
  // Event tickers are typically uppercase and have -NUMBER suffix (e.g., KXPRESPERSON-28)
  // Slugs are lowercase (e.g., kxdjtvostariffs)
  
  // If it's all lowercase and doesn't have the typical ticker format, it's likely a slug
  const isLowercase = input === input.toLowerCase();
  const hasTickerSuffix = /-\d+$/.test(input);
  const looksLikeTickerFormat = /^[A-Z]+-[A-Z0-9-]+$/.test(input) || hasTickerSuffix;
  
  return isLowercase && !looksLikeTickerFormat;
}

// Event-level ticker shape: `KX<SERIES>-<N>` with NO trailing letter child suffix.
// Examples: "KXOAIANTH-40", "KXRAMPBREX-40", "KXNEXTUKPM-30", "KXTRILLIONAIRE-30".
// These are NOT market tickers — they identify an event whose sub-markets have the
// form "KX<SERIES>-<N>-<CHILD>" (e.g. "KXOAIANTH-40-OAI"). Agents that pass event
// tickers to get_market or get_market_candlesticks waste 2-4 calls before recovery.
function isEventLevelTicker(input: string): boolean {
  return /^KX[A-Z0-9]+-\d+$/.test(input);
}

// Fetch an event by its UPPERCASE event ticker (e.g. "KXOAIANTH-40") and return the
// normalized child-market list plus a structured recovery-hint payload the iterative
// planner can read to auto-pivot to the correct per-child tool call.
async function resolveEventTickerToChildren(
  eventTicker: string,
): Promise<{
  found: boolean;
  eventTitle: string | null;
  seriesTicker: string;
  childMarkets: Array<{
    ticker: string;
    title: string;
    yesPrice: number;
    noPrice: number;
    volume24h: number;
    status: string;
  }>;
} | null> {
  try {
    const response = await fetchKalshi(
      `/events/${encodeURIComponent(eventTicker)}?with_nested_markets=true`,
    ) as { event?: KalshiEvent };
    const event = response.event;
    if (!event) {
      return null;
    }

    const childMarkets = (event.markets || []).map((m) => ({
      ticker: m.ticker,
      title: m.title || m.yes_sub_title || m.ticker,
      yesPrice: m.yes_ask || m.last_price || 0,
      noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
      volume24h: m.volume_24h || 0,
      status: m.status || "open",
    }));

    return {
      found: true,
      eventTitle: event.title || null,
      seriesTicker: getSeriesTicker(event.event_ticker),
      childMarkets,
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Resolves a URL slug to market/event information by searching markets.
 * Returns the best matching event ticker and associated markets.
 */
async function resolveSlugToEvent(slug: string): Promise<{
  found: boolean;
  eventTicker?: string;
  seriesTicker?: string;
  title?: string;
  markets: KalshiMarket[];
}> {
  const slugLower = slug.toLowerCase();
  
  // Try multiple strategies to find the market
  
  // Strategy 1: Search markets with the slug as query
  try {
    const response = await fetchKalshi(`/markets?limit=500&status=open`) as { markets: KalshiMarket[] };
    const markets = response.markets || [];
    
    // Find markets where the series ticker matches the slug
    // Use multiple matching strategies:
    // 1. Exact series ticker match
    // 2. Event ticker starts with slug (case-insensitive)
    // 3. Ticker contains slug (case-insensitive)
    const matchingMarkets = markets.filter(m => {
      const seriesTicker = getSeriesTicker(m.event_ticker);
      const eventTickerLower = m.event_ticker.toLowerCase();
      const tickerLower = m.ticker.toLowerCase();
      
      return seriesTicker === slugLower || 
             eventTickerLower.startsWith(slugLower) ||
             eventTickerLower.startsWith(slugLower + '-') ||
             tickerLower.includes(slugLower);
    });
    
    if (matchingMarkets.length > 0) {
      const firstMatch = matchingMarkets[0];
      return {
        found: true,
        eventTicker: firstMatch.event_ticker,
        seriesTicker: getSeriesTicker(firstMatch.event_ticker),
        title: firstMatch.title || firstMatch.yes_sub_title,
        markets: matchingMarkets,
      };
    }
  } catch (e) {
    // Continue to next strategy
  }
  
  // Strategy 2: Try to fetch events and check series tickers
  try {
    const response = await fetchKalshi(`/events?limit=200&status=open`) as { events: KalshiEvent[] };
    const events = response.events || [];
    
    // Find event where the ticker matches the slug pattern
    const matchingEvent = events.find(e => {
      const eventSeriesTicker = getSeriesTicker(e.event_ticker);
      const eventTickerLower = e.event_ticker.toLowerCase();
      return eventSeriesTicker === slugLower || 
             eventTickerLower.startsWith(slugLower) ||
             eventTickerLower.startsWith(slugLower + '-');
    });
    
    if (matchingEvent) {
      // Fetch the full event with markets
      const eventDetail = await fetchKalshi(`/events/${matchingEvent.event_ticker}?with_nested_markets=true`) as { event: KalshiEvent };
      return {
        found: true,
        eventTicker: matchingEvent.event_ticker,
        seriesTicker: getSeriesTicker(matchingEvent.event_ticker),
        title: matchingEvent.title,
        markets: eventDetail.event?.markets || [],
      };
    }
  } catch (e) {
    // Continue to next strategy
  }
  
  // Strategy 3: Try direct event fetch with uppercase slug
  const possibleTickers = [
    slugLower.toUpperCase(),
    `${slugLower.toUpperCase()}-1`,
    `${slugLower.toUpperCase()}-24`,
    `${slugLower.toUpperCase()}-25`,
    `${slugLower.toUpperCase()}-26`,
    `${slugLower.toUpperCase()}-28`,
  ];
  
  for (const ticker of possibleTickers) {
    try {
      const eventDetail = await fetchKalshi(`/events/${ticker}?with_nested_markets=true`) as { event: KalshiEvent };
      if (eventDetail.event) {
        return {
          found: true,
          eventTicker: eventDetail.event.event_ticker,
          seriesTicker: getSeriesTicker(eventDetail.event.event_ticker),
          title: eventDetail.event.title,
          markets: eventDetail.event.markets || [],
        };
      }
    } catch (e) {
      // Try next ticker
    }
  }
  
  // Strategy 4: Try series endpoint if it exists
  try {
    const seriesResponse = await fetchKalshi(`/series/${slugLower.toUpperCase()}`) as { series: KalshiSeries };
    if (seriesResponse.series) {
      // Get events for this series
      const eventsResponse = await fetchKalshi(`/events?series_ticker=${slugLower.toUpperCase()}&limit=10`) as { events: KalshiEvent[] };
      const firstEvent = eventsResponse.events?.[0];
      if (firstEvent) {
        const eventDetail = await fetchKalshi(`/events/${firstEvent.event_ticker}?with_nested_markets=true`) as { event: KalshiEvent };
        return {
          found: true,
          eventTicker: firstEvent.event_ticker,
          seriesTicker: slugLower,
          title: firstEvent.title || seriesResponse.series.title,
          markets: eventDetail.event?.markets || [],
        };
      }
    }
  } catch (e) {
    // Series doesn't exist
  }
  
  return { found: false, markets: [] };
}

// ============================================================================
// TYPES
// ============================================================================

interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  subtitle?: string;
  yes_sub_title?: string;
  no_sub_title?: string;
  market_type?: string;
  status?: string;
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  previous_price?: number;
  volume?: number;
  volume_24h?: number;
  open_interest?: number;
  liquidity?: number;
  close_time?: string;
  open_time?: string;
  category?: string;
  rules_primary?: string;
  rules_secondary?: string;
  can_close_early?: boolean;
  early_close_condition?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title?: string;
  category?: string;
  status?: string;
  markets?: KalshiMarket[];
}

interface KalshiSeries {
  ticker: string;
  title?: string;
  category?: string;
  tags?: string[];
  frequency?: string;
}

interface KalshiOrderbook {
  orderbook?: {
    yes?: Array<[number, number]>;
    no?: Array<[number, number]>;
  };
  orderbook_fp?: {
    yes?: Array<[number, number | string]>;
    no?: Array<[number, number | string]>;
  };
}

interface KalshiTrade {
  trade_id?: string;
  ticker?: string;
  yes_price?: number;
  no_price?: number;
  price?: number;
  count?: number;
  taker_side?: string;
  created_time?: string;
  created_ts?: number;
  timestamp?: string | number;
}

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

async function handleDiscoverTrendingMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string | undefined;
  const sortBy = (args?.sortBy as string) || "volume_24h";
  const limit = Math.min((args?.limit as number) || 20, 100);

  // Fetch a broad pool so ranking/filtering has enough candidates before fallback enrichment.
  const fetchLimit = Math.min(Math.max(limit * 5, 200), 1000);
  let endpoint = `/markets?limit=${fetchLimit}&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = filterMarketsByRequestedCategory(response.markets || [], category);

  // In Kalshi's public elections endpoint, market volume fields can be zeroed even when
  // there is meaningful live trade flow. When detected, derive "recent activity" from
  // the global trades feed so "most actively traded right now" stays relevant.
  type ActivitySnapshot = {
    contractsTraded: number;
    notionalUsd: number;
    lastTradeTime: string;
  };
  const activityByTicker = new Map<string, ActivitySnapshot>();
  const allVolume24hZero = markets.every(
    (marketItem) => Number(marketItem.volume_24h || 0) <= 0
  );
  const allVolumeZero = markets.every(
    (marketItem) => Number(marketItem.volume || 0) <= 0
  );
  const needsTradeFallback =
    (sortBy === "volume_24h" && allVolume24hZero) ||
    (sortBy === "volume" && allVolumeZero) ||
    (sortBy !== "volume_24h" && sortBy !== "volume" && allVolume24hZero && allVolumeZero);

  if (needsTradeFallback) {
    let cursor: string | undefined;
    const maxTradePages = 3;
    const tradePageSize = 500;

    for (let page = 0; page < maxTradePages; page += 1) {
      let tradesEndpoint = `/markets/trades?status=open&limit=${tradePageSize}`;
      if (cursor) {
        tradesEndpoint += `&cursor=${encodeURIComponent(cursor)}`;
      }

      const tradeResponse = (await fetchKalshi(tradesEndpoint)) as {
        trades?: KalshiTrade[];
        cursor?: string;
        next_cursor?: string;
      };
      const trades = Array.isArray(tradeResponse.trades) ? tradeResponse.trades : [];
      if (trades.length === 0) {
        break;
      }

      for (const trade of trades) {
        if (!trade.ticker) {
          continue;
        }

        const contracts = Number(trade.count || 0);
        const price = Number(
          trade.price ||
            trade.yes_price ||
            trade.no_price ||
            0
        );
        const notionalUsd = contracts > 0 && price > 0 ? (contracts * price) / 100 : 0;
        const existing = activityByTicker.get(trade.ticker);
        if (!existing) {
          activityByTicker.set(trade.ticker, {
            contractsTraded: contracts,
            notionalUsd,
            lastTradeTime: trade.created_time || trade.timestamp?.toString() || "",
          });
          continue;
        }

        existing.contractsTraded += contracts;
        existing.notionalUsd += notionalUsd;
        if ((trade.created_time || "") > existing.lastTradeTime) {
          existing.lastTradeTime = trade.created_time || existing.lastTradeTime;
        }
      }

      const nextCursor = tradeResponse.cursor || tradeResponse.next_cursor;
      if (!nextCursor || nextCursor === cursor) {
        break;
      }
      cursor = nextCursor;
    }

    if (activityByTicker.size > 0) {
      const maxTickerHydration = Math.min(Math.max(limit * 6, 60), 240);
      const topActivityTickers = [...activityByTicker.entries()]
        .sort(
          (left, right) =>
            right[1].notionalUsd - left[1].notionalUsd ||
            right[1].contractsTraded - left[1].contractsTraded
        )
        .slice(0, maxTickerHydration)
        .map(([ticker]) => ticker);

      const hydratedMarkets: KalshiMarket[] = [];
      const chunkSize = 25;
      for (let index = 0; index < topActivityTickers.length; index += chunkSize) {
        const chunk = topActivityTickers.slice(index, index + chunkSize);
        if (chunk.length === 0) {
          continue;
        }

        try {
          const byTickersResponse = (await fetchKalshi(
            `/markets?status=open&limit=${chunk.length}&tickers=${encodeURIComponent(chunk.join(","))}`
          )) as { markets?: KalshiMarket[] };
          if (Array.isArray(byTickersResponse.markets)) {
            hydratedMarkets.push(...byTickersResponse.markets);
            continue;
          }
        } catch {
          // Fallback below fetches ticker-by-ticker when bulk tickers filter is unavailable.
        }

        const settled = await Promise.allSettled(
          chunk.map(async (ticker) => {
            const marketResponse = (await fetchKalshi(`/markets/${ticker}`)) as {
              market?: KalshiMarket;
            };
            return marketResponse.market;
          })
        );
        for (const item of settled) {
          if (item.status === "fulfilled" && item.value) {
            hydratedMarkets.push(item.value);
          }
        }
      }

      if (hydratedMarkets.length > 0) {
        const mergedByTicker = new Map<string, KalshiMarket>();
        for (const market of hydratedMarkets) {
          mergedByTicker.set(market.ticker, market);
        }
        for (const market of markets) {
          if (!mergedByTicker.has(market.ticker)) {
            mergedByTicker.set(market.ticker, market);
          }
        }
        markets = [...mergedByTicker.values()];
      }
    }
  }

  markets = filterMarketsByRequestedCategory(markets, category);

  // Sort by the requested metric
  const sorted = markets.sort((a, b) => {
    const tradeActivityA = activityByTicker.get(a.ticker);
    const tradeActivityB = activityByTicker.get(b.ticker);
    const fallbackVolumeA = tradeActivityA?.notionalUsd || 0;
    const fallbackVolumeB = tradeActivityB?.notionalUsd || 0;
    const fallbackContractsA = tradeActivityA?.contractsTraded || 0;
    const fallbackContractsB = tradeActivityB?.contractsTraded || 0;
    const effectiveVolumeA =
      Number(a.volume || 0) > 0 ? Number(a.volume || 0) : fallbackVolumeA;
    const effectiveVolumeB =
      Number(b.volume || 0) > 0 ? Number(b.volume || 0) : fallbackVolumeB;
    const effectiveVolume24hA =
      Number(a.volume_24h || 0) > 0 ? Number(a.volume_24h || 0) : fallbackVolumeA;
    const effectiveVolume24hB =
      Number(b.volume_24h || 0) > 0 ? Number(b.volume_24h || 0) : fallbackVolumeB;

    switch (sortBy) {
      case "volume":
        return effectiveVolumeB - effectiveVolumeA;
      case "volume_24h":
        return (
          effectiveVolume24hB - effectiveVolume24hA ||
          fallbackContractsB - fallbackContractsA
        );
      case "liquidity":
        return (b.liquidity || 0) - (a.liquidity || 0);
      case "open_interest":
        return (b.open_interest || 0) - (a.open_interest || 0);
      default:
        return (
          effectiveVolume24hB - effectiveVolume24hA ||
          fallbackContractsB - fallbackContractsA
        );
    }
  });

  const trendingMarkets = sorted.slice(0, limit).map((m, idx) => {
    const tradeActivity = activityByTicker.get(m.ticker);
    const derivedVolume24h =
      Number(m.volume_24h || 0) > 0
        ? Number(m.volume_24h || 0)
        : Number(tradeActivity?.notionalUsd || 0);
    const derivedVolume =
      Number(m.volume || 0) > 0
        ? Number(m.volume || 0)
        : Number(tradeActivity?.contractsTraded || 0);

    return {
      rank: idx + 1,
      title: m.title || m.yes_sub_title || m.ticker,
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      yesPrice: (m.yes_ask || m.last_price || 0),
      noPrice: (m.no_ask || (100 - (m.yes_ask || m.last_price || 50))),
      volume24h: derivedVolume24h,
      volume: derivedVolume,
      openInterest: m.open_interest || 0,
      liquidity: m.liquidity || 0,
      category: m.category || "Unknown",
      closeTime: m.close_time || "",
      status: m.status || "open",
    };
  });

  const totalVolume = trendingMarkets.reduce((sum, m) => sum + m.volume24h, 0);
  const formattedVolume = Number(totalVolume.toFixed(2)).toLocaleString();
  const marketSummary = `Showing ${trendingMarkets.length} of ${markets.length} active markets${
    category ? ` in ${category}` : ""
  }. Combined 24h contract volume: ${formattedVolume}`;

  const trendingRecoveryHints = buildTrendingRecoveryHints({
    category,
    resultCount: trendingMarkets.length,
  });

  const trendingResponse: Record<string, unknown> = {
    marketSummary,
    trendingMarkets,
    totalActive: markets.length,
    activitySource:
      needsTradeFallback && activityByTicker.size > 0
        ? "derived_from_recent_trades"
        : "market_snapshot_fields",
    tradeSnapshot: {
      tickersWithRecentTrades: activityByTicker.size,
      allVolume24hZero,
      allVolumeZero,
      usedTradeFallback: needsTradeFallback,
    },
    fetchedAt: new Date().toISOString(),
  };

  if (trendingRecoveryHints) {
    trendingResponse.hint = `⚠️ discover_trending_markets returned 0 markets${category ? ` for category=${JSON.stringify(category)}` : ""}. Follow recoveryHints.nextTools before concluding nothing is active.`;
    trendingResponse.recoveryHints = trendingRecoveryHints;
  }

  return successResult(trendingResponse);
}

async function handleAnalyzeMarketLiquidity(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const requestedTicker = args?.ticker as string;
  if (!requestedTicker) {
    return errorResult("ticker is required");
  }

  let ticker = requestedTicker;
  let resolvedFrom: string | undefined;

  // Fetch market and orderbook
  let marketRes: { market: KalshiMarket };
  let orderbookRes: KalshiOrderbook;
  try {
    [marketRes, orderbookRes] = await Promise.all([
      fetchKalshi(`/markets/${ticker}`) as Promise<{ market: KalshiMarket }>,
      fetchKalshi(`/markets/${ticker}/orderbook?depth=50`) as Promise<KalshiOrderbook>,
    ]);
  } catch (error) {
    const isNotFound =
      error instanceof Error && error.message.includes("Kalshi API error (404)");
    if (!isNotFound) {
      throw error;
    }

    const normalizedTicker = requestedTicker.toLowerCase();
    const tickerWithoutSymbols = normalizedTicker.replace(/[^a-z0-9]/g, "");
    const looksLikeBitcoinAlias =
      normalizedTicker.includes("bitcoin") || normalizedTicker.includes("btc");

    const scoreMarketCandidate = (marketCandidate: KalshiMarket): number => {
      const candidateTicker = marketCandidate.ticker.toLowerCase();
      const candidateSeries = getSeriesTicker(marketCandidate.event_ticker);
      const candidateEvent = marketCandidate.event_ticker.toLowerCase();
      const candidateTitle = `${marketCandidate.title || ""} ${
        marketCandidate.subtitle || ""
      } ${marketCandidate.yes_sub_title || ""}`.toLowerCase();
      const candidateTickerCompact = candidateTicker.replace(/[^a-z0-9]/g, "");
      const candidateSeriesCompact = candidateSeries.replace(/[^a-z0-9]/g, "");
      const candidateEventCompact = candidateEvent.replace(/[^a-z0-9]/g, "");

      let score = 0;
      if (candidateTicker === normalizedTicker) {
        score += 1000;
      }
      if (candidateTickerCompact === tickerWithoutSymbols) {
        score += 850;
      }
      if (candidateTickerCompact.startsWith(tickerWithoutSymbols)) {
        score += 450;
      }
      if (candidateTickerCompact.includes(tickerWithoutSymbols)) {
        score += 350;
      }
      if (candidateSeriesCompact.includes(tickerWithoutSymbols)) {
        score += 300;
      }
      if (candidateEventCompact.includes(tickerWithoutSymbols)) {
        score += 250;
      }
      if (
        tickerWithoutSymbols.length >= 4 &&
        tickerWithoutSymbols.includes(candidateSeriesCompact)
      ) {
        score += 120;
      }

      if (looksLikeBitcoinAlias) {
        if (candidateTicker.includes("btc")) {
          score += 260;
        }
        if (candidateTitle.includes("bitcoin") || candidateTitle.includes("btc")) {
          score += 200;
        }
      }

      return score;
    };

    const matching: Array<{ market: KalshiMarket; score: number }> = [];
    const maxPages = 25;
    const pageSize = 200;
    let foundHighConfidence = false;
    const statusFilters = ["open", ""] as const;

    for (const statusFilter of statusFilters) {
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page += 1) {
        let endpoint = `/markets?limit=${pageSize}`;
        if (statusFilter.length > 0) {
          endpoint += `&status=${statusFilter}`;
        }
        if (cursor) {
          endpoint += `&cursor=${encodeURIComponent(cursor)}`;
        }
        const searchResponse = (await fetchKalshi(endpoint)) as {
          markets?: KalshiMarket[];
          cursor?: string;
          next_cursor?: string;
        };
        const candidates = Array.isArray(searchResponse.markets)
          ? searchResponse.markets
          : [];

        for (const candidate of candidates) {
          const score = scoreMarketCandidate(candidate);
          if (score <= 0) {
            continue;
          }
          matching.push({ market: candidate, score });
          if (score >= 850) {
            foundHighConfidence = true;
          }
        }

        const nextCursor = searchResponse.next_cursor || searchResponse.cursor;
        if (!nextCursor || nextCursor === cursor) {
          break;
        }
        cursor = nextCursor;

        if (foundHighConfidence && page >= 2) {
          break;
        }
      }

      if (foundHighConfidence) {
        break;
      }
    }

    matching.sort(
      (left, right) =>
        right.score - left.score ||
        (right.market.volume_24h || 0) - (left.market.volume_24h || 0) ||
        (right.market.liquidity || 0) - (left.market.liquidity || 0)
    );

    let resolvedTicker = matching.at(0)?.market.ticker;
    if (!resolvedTicker) {
      try {
        const normalizedRequestedTicker = requestedTicker.toLowerCase();
        const strippedTickerWord = normalizedRequestedTicker
          .replace(/^kx/, "")
          .replace(/[^a-z]/g, "");
        const queryCandidates = new Set<string>([requestedTicker]);
        if (strippedTickerWord.length >= 3) {
          queryCandidates.add(strippedTickerWord);
        }
        if (
          normalizedRequestedTicker.includes("btc") ||
          normalizedRequestedTicker.includes("bitcoin")
        ) {
          queryCandidates.add("bitcoin");
        }
        if (
          normalizedRequestedTicker.includes("eth") ||
          normalizedRequestedTicker.includes("ethereum")
        ) {
          queryCandidates.add("ethereum");
        }

        for (const candidateQuery of queryCandidates) {
          const searchResult = await handleSearchMarkets({
            query: candidateQuery,
            status: "open",
            limit: 20,
          });
          if (searchResult.isError) {
            continue;
          }
          const firstTextBlock = searchResult.content.find(
            (item): item is { type: "text"; text: string } =>
              item.type === "text"
          );
          if (!firstTextBlock?.text) {
            continue;
          }
          const parsed = JSON.parse(firstTextBlock.text) as {
            results?: Array<{ ticker?: unknown }>;
          };
          const candidateTicker = parsed.results?.at(0)?.ticker;
          if (typeof candidateTicker === "string" && candidateTicker.length > 0) {
            resolvedTicker = candidateTicker;
            break;
          }
        }
      } catch {
        // Keep the original not-found error if search fallback also fails.
      }
    }

    if (!resolvedTicker) {
      return errorResult(
        `Market '${requestedTicker}' not found. Use discover_trending_markets or search_markets first, then pass an exact ticker to analyze_market_liquidity.`
      );
    }

    ticker = resolvedTicker;
    resolvedFrom = `search:${requestedTicker}->${ticker}`;
    [marketRes, orderbookRes] = await Promise.all([
      fetchKalshi(`/markets/${ticker}`) as Promise<{ market: KalshiMarket }>,
      fetchKalshi(`/markets/${ticker}/orderbook?depth=50`) as Promise<KalshiOrderbook>,
    ]);
  }

  const market = marketRes.market;
  const orderbook = orderbookRes.orderbook || {};

  const yesBid = market.yes_bid || 0;
  const yesAsk = market.yes_ask || 0;
  const noBid = market.no_bid || 0;
  const noAsk = market.no_ask || 0;

  // In Kalshi orderbooks, NO bids imply YES asks at (100 - noPrice).
  // Normalize both sides into YES-price space for correct slippage/depth math.
  const yesBids = [...(orderbook.yes || [])].sort((a, b) => b[0] - a[0]);
  const yesAsks = (orderbook.no || [])
    .map(([price, qty]) => [100 - price, qty] as [number, number])
    .sort((a, b) => a[0] - b[0]);

  // Calculate depth
  let bidDepthUsd = 0;
  let askDepthUsd = 0;
  
  for (const [price, qty] of yesBids) {
    bidDepthUsd += (price / 100) * qty;
  }
  for (const [price, qty] of yesAsks) {
    askDepthUsd += (price / 100) * qty;
  }

  // Simulate slippage for different order sizes
  const simulateSlippage = (size: number, orders: Array<[number, number]>, isBuy: boolean) => {
    let remainingUsd = size;
    let filledUsd = 0;
    let filledContracts = 0;
    let worstPrice = 0;

    for (const [price, qty] of orders) {
      if (price <= 0 || qty <= 0) {
        continue;
      }
      const levelNotionalUsd = (price / 100) * qty;
      const usdFilledAtLevel = Math.min(remainingUsd, levelNotionalUsd);
      const contractsFilledAtLevel = usdFilledAtLevel / (price / 100);

      filledUsd += usdFilledAtLevel;
      filledContracts += contractsFilledAtLevel;
      remainingUsd -= usdFilledAtLevel;
      worstPrice = price;
      if (remainingUsd <= 0) {
        break;
      }
    }

    const avgPrice = filledContracts > 0 ? (filledUsd / filledContracts) * 100 : 0;
    const referencePrice = isBuy ? yesAsk : yesBid;
    const slippage = isBuy ? avgPrice - referencePrice : referencePrice - avgPrice;
    const slippagePercent = referencePrice > 0 ? (slippage / referencePrice) * 100 : 0;

    return {
      canFill: remainingUsd <= 0,
      avgPrice: avgPrice.toFixed(1),
      worstPrice,
      filledUsd: Number(filledUsd.toFixed(2)),
      filledContracts: Number(filledContracts.toFixed(2)),
      slippagePercent: slippagePercent.toFixed(2),
    };
  };

  const yesSpreadCents = yesAsk - yesBid;
  const yesSpreadPercent = yesBid > 0 ? ((yesSpreadCents / yesBid) * 100) : 0;
  const noSpreadCents = noAsk - noBid;
  const noSpreadPercent = noBid > 0 ? ((noSpreadCents / noBid) * 100) : 0;

  // Liquidity score
  let liquidityScore: string;
  if (bidDepthUsd + askDepthUsd > 50000 && yesSpreadCents <= 2) {
    liquidityScore = "excellent";
  } else if (bidDepthUsd + askDepthUsd > 20000 && yesSpreadCents <= 4) {
    liquidityScore = "good";
  } else if (bidDepthUsd + askDepthUsd > 5000 && yesSpreadCents <= 6) {
    liquidityScore = "moderate";
  } else if (bidDepthUsd + askDepthUsd > 1000) {
    liquidityScore = "poor";
  } else {
    liquidityScore = "illiquid";
  }

  const recommendation = liquidityScore === "excellent" || liquidityScore === "good"
    ? "Good liquidity - can enter/exit positions with minimal slippage"
    : liquidityScore === "moderate"
    ? "Moderate liquidity - use limit orders to avoid slippage"
    : "Low liquidity - be cautious with position sizing, may be difficult to exit";

  return successResult({
    market: market.title || ticker,
    ticker,
    requestedTicker,
    resolvedFrom,
    currentPrices: {
      yesBid,
      yesAsk,
      noBid,
      noAsk,
      lastPrice: market.last_price || 0,
    },
    spread: {
      yesCents: yesSpreadCents,
      yesPercent: Number(yesSpreadPercent.toFixed(2)),
      noCents: noSpreadCents,
      noPercent: Number(noSpreadPercent.toFixed(2)),
    },
    depth: {
      bidDepthUsd: Math.round(bidDepthUsd),
      askDepthUsd: Math.round(askDepthUsd),
      totalDepthUsd: Math.round(bidDepthUsd + askDepthUsd),
    },
    slippageSimulation: {
      buy100: simulateSlippage(100, yesAsks, true),
      buy500: simulateSlippage(500, yesAsks, true),
      buy1000: simulateSlippage(1000, yesAsks, true),
    },
    liquidityScore,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleCheckMarketEfficiency(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string | undefined;
  const eventTicker = args?.eventTicker as string | undefined;

  if (!ticker && !eventTicker) {
    return errorResult("Either ticker or eventTicker is required");
  }

  let markets: KalshiMarket[] = [];

  if (eventTicker) {
    const eventRes = await fetchKalshi(`/events/${eventTicker}?with_nested_markets=true`) as { event: KalshiEvent };
    markets = eventRes.event?.markets || [];
  } else if (ticker) {
    const marketRes = await fetchKalshi(`/markets/${ticker}`) as { market: KalshiMarket };
    markets = [marketRes.market];
  }

  const outcomes = markets.map(m => ({
    ticker: m.ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesPrice: m.yes_ask || m.last_price || 50,
    noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
    impliedProbability: (m.yes_ask || m.last_price || 50) / 100,
  }));

  const sumOfYesPrices =
    outcomes.length === 1
      ? outcomes[0].yesPrice + outcomes[0].noPrice
      : outcomes.reduce((sum, o) => sum + o.yesPrice, 0);
  const vig = sumOfYesPrices - 100;
  const vigPercent = ((vig / 100) * 100).toFixed(2);

  let rating: string;
  if (Math.abs(vig) <= 1) {
    rating = "excellent";
  } else if (Math.abs(vig) <= 3) {
    rating = "good";
  } else if (Math.abs(vig) <= 5) {
    rating = "fair";
  } else if (Math.abs(vig) <= 10) {
    rating = "poor";
  } else {
    rating = "exploitable";
  }

  // Calculate true probabilities (vig-adjusted)
  const trueProbabilities = outcomes.map(o => ({
    ticker: o.ticker,
    adjustedProbability: Number(((o.yesPrice / sumOfYesPrices) * 100).toFixed(2)),
  }));

  const isEfficient = Math.abs(vig) <= 3;
  const recommendation = vig < -2
    ? outcomes.length === 1
      ? `OPPORTUNITY: YES + NO ask totals ${sumOfYesPrices}¢ < 100¢. Buying both sides guarantees ${Math.abs(vig).toFixed(0)}¢ profit.`
      : `OPPORTUNITY: Sum of prices is ${sumOfYesPrices}¢ < 100¢. Buying all outcomes guarantees ${Math.abs(vig).toFixed(0)}¢ profit.`
    : vig > 5
    ? outcomes.length === 1
      ? `HIGH VIG: YES + NO ask totals ${sumOfYesPrices}¢, implying ${vig.toFixed(0)}¢ of overround on the binary book.`
      : `HIGH VIG: Market has ${vig.toFixed(0)}¢ overround. Consider this when sizing positions.`
    : "Market is efficiently priced.";

  return successResult({
    market: eventTicker || ticker || "",
    outcomes,
    efficiency: {
      sumOfYesPrices,
      vig,
      vigPercent: `${vigPercent}%`,
      isEfficient,
      rating,
    },
    trueProbabilities,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleFindArbitrageOpportunities(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string | undefined;
  const minEdge = (args?.minEdge as number) || 1;
  const limit = Math.min((args?.limit as number) || 50, 100);

  let endpoint = `/markets?limit=${limit}&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  const markets = response.markets || [];

  const arbitrageOpportunities: Array<Record<string, unknown>> = [];
  const wideSpreadMarkets: Array<Record<string, unknown>> = [];

  for (const m of markets) {
    const yesAsk = m.yes_ask || 0;
    const noAsk = m.no_ask || 0;
    const totalCost = yesAsk + noAsk;

    // Check for YES+NO < 100 arbitrage
    if (totalCost > 0 && totalCost < 100 - minEdge) {
      const edge = 100 - totalCost;
      arbitrageOpportunities.push({
        market: m.title || m.ticker,
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        yesAsk,
        noAsk,
        totalCost,
        potentialEdge: edge,
        edgePercent: `${((edge / totalCost) * 100).toFixed(2)}%`,
        url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      });
    }

    // Check for wide spreads
    const yesBid = m.yes_bid || 0;
    const spread = yesAsk - yesBid;
    if (spread >= 5) {
      wideSpreadMarkets.push({
        market: m.title || m.ticker,
        ticker: m.ticker,
        spread,
        spreadPercent: `${((spread / ((yesAsk + yesBid) / 2)) * 100).toFixed(2)}%`,
        midPrice: (yesAsk + yesBid) / 2,
      });
    }
  }

  // Sort by edge
  arbitrageOpportunities.sort((a, b) => (b.potentialEdge as number) - (a.potentialEdge as number));
  wideSpreadMarkets.sort((a, b) => (b.spread as number) - (a.spread as number));

  return successResult({
    scannedMarkets: markets.length,
    arbitrageOpportunities: arbitrageOpportunities.slice(0, 10),
    wideSpreadMarkets: wideSpreadMarkets.slice(0, 10),
    summary: {
      arbitrageCount: arbitrageOpportunities.length,
      wideSpreadCount: wideSpreadMarkets.length,
      bestOpportunity: arbitrageOpportunities.length > 0
        ? `${(arbitrageOpportunities[0] as Record<string, unknown>).market}: ${(arbitrageOpportunities[0] as Record<string, unknown>).potentialEdge}¢ edge`
        : "No arbitrage opportunities found",
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleFindTradingOpportunities(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const strategy = (args?.strategy as string) || "all";
  const category = args?.category as string | undefined;
  const rawEventTicker = (args?.eventTicker as string | undefined)?.trim();
  const rawTicker = (args?.ticker as string | undefined)?.trim();
  const limit = Math.min((args?.limit as number) || 20, 50);

  // Resolve event scope. If the caller passed a market ticker, derive its parent event.
  let scopedEventTicker: string | undefined = rawEventTicker || undefined;
  if (!scopedEventTicker && rawTicker) {
    try {
      const mkt = (await fetchKalshi(`/markets/${rawTicker}`)) as { market?: KalshiMarket };
      if (mkt?.market?.event_ticker) scopedEventTicker = mkt.market.event_ticker;
    } catch {
      // fall through to treating rawTicker as an eventTicker
      scopedEventTicker = rawTicker;
    }
  }

  let markets: KalshiMarket[] = [];
  let marketsScanned = 0;
  const minLiquidity =
    scopedEventTicker !== undefined
      ? (args?.minLiquidity as number) ?? 0
      : (args?.minLiquidity as number) || 1000;

  if (scopedEventTicker) {
    const eventRes = (await fetchKalshi(
      `/events/${scopedEventTicker}?with_nested_markets=true`
    )) as { event?: KalshiEvent & { markets?: KalshiMarket[] } };
    const eventMarkets = eventRes?.event?.markets || [];
    marketsScanned = eventMarkets.length;
    markets = eventMarkets.filter(m => (m.liquidity || 0) >= minLiquidity);
  } else {
    let endpoint = `/markets?limit=100&status=open`;
    if (category) {
      endpoint += `&category=${encodeURIComponent(category)}`;
    }
    const response = (await fetchKalshi(endpoint)) as { markets: KalshiMarket[] };
    marketsScanned = response.markets?.length || 0;
    markets = filterMarketsByRequestedCategory(response.markets || [], category);
    markets = markets.filter(m => (m.liquidity || 0) >= minLiquidity);
  }

  // Apply strategy filters
  const strategyFilters: Record<string, (m: KalshiMarket) => boolean> = {
    lottery_tickets: m => {
      const price = m.yes_ask || m.last_price || 50;
      return price >= 1 && price <= 15;
    },
    moderate_conviction: m => {
      const price = m.yes_ask || m.last_price || 50;
      return price >= 35 && price <= 65;
    },
    high_confidence: m => {
      const price = m.yes_ask || m.last_price || 50;
      return price >= 70 && price <= 90;
    },
    near_resolution: m => {
      if (!m.close_time) return false;
      const closeDate = new Date(m.close_time);
      const hoursUntilClose = (closeDate.getTime() - Date.now()) / (1000 * 60 * 60);
      return hoursUntilClose > 0 && hoursUntilClose <= 72;
    },
    high_volume: m => (m.volume_24h || 0) >= 10000,
  };

  if (strategy !== "all" && strategyFilters[strategy]) {
    markets = markets.filter(strategyFilters[strategy]);
  }

  if (scopedEventTicker) {
    markets.sort((a, b) => (b.yes_ask || b.last_price || 0) - (a.yes_ask || a.last_price || 0));
  } else {
    markets.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));
  }
  markets = markets.slice(0, limit);

  const opportunities = markets.map((m, idx) => {
    const price = m.yes_ask || m.last_price || 50;
    const potentialReturn = price > 0 ? ((100 / price) - 1) * 100 : 0;
    
    let why = "";
    if (price <= 15) why = "Lottery ticket - high payoff if correct";
    else if (price >= 35 && price <= 65) why = "Balanced risk/reward - coin flip odds";
    else if (price >= 70 && price <= 90) why = "High confidence - likely outcome";
    else if ((m.volume_24h || 0) >= 10000) why = "High volume - significant activity";
    else why = "Active market with liquidity";

    return {
      rank: idx + 1,
      market: m.title || m.yes_sub_title || m.ticker,
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      yesPrice: price,
      impliedProbability: `${price}%`,
      potentialReturn: `${potentialReturn.toFixed(0)}%`,
      liquidity: m.liquidity || 0,
      volume24h: m.volume_24h || 0,
      closeTime: m.close_time || "",
      category: m.category || "Unknown",
      whyThisOpportunity: why,
    };
  });

  return successResult({
    summary: {
      marketsScanned,
      opportunitiesFound: opportunities.length,
      strategy: scopedEventTicker ? `event_scope:${scopedEventTicker}` : strategy,
    },
    opportunities,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketsByProbability(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const probability = args?.probability as string;
  if (!probability) {
    return errorResult("probability is required");
  }

  const category = args?.category as string | undefined;
  const rawMinLiquidity = args?.minLiquidity as number | undefined;
  const limit = Math.min((args?.limit as number) || 10, 30);
  const minLiquidityApplied =
    typeof rawMinLiquidity === "number" &&
    Number.isFinite(rawMinLiquidity) &&
    rawMinLiquidity > 0
      ? rawMinLiquidity
      : 0;

  const ranges: Record<string, [number, number]> = {
    very_unlikely: [1, 15],
    unlikely: [15, 35],
    coinflip: [35, 65],
    likely: [65, 85],
    very_likely: [85, 95],
  };

  const [minPrice, maxPrice] = ranges[probability] || [0, 100];
  const estimateLiquidityFromOrderbook = async (
    marketTicker: string
  ): Promise<number> => {
    const orderbookResponse = (await fetchKalshi(
      `/markets/${marketTicker}/orderbook?depth=25`
    )) as KalshiOrderbook;

    const selectedOrderbook =
      orderbookResponse.orderbook_fp ||
      orderbookResponse.orderbook || {
        yes: [],
        no: [],
      };

    const yesBids = Array.isArray(selectedOrderbook.yes)
      ? selectedOrderbook.yes
      : [];
    const rawYesAsks = Array.isArray(selectedOrderbook.no)
      ? selectedOrderbook.no
      : [];

    const bidDepthUsd = yesBids.reduce((sum, level) => {
      if (!Array.isArray(level) || level.length < 2) {
        return sum;
      }

      const price = parseFiniteNumber(level[0]) || 0;
      const quantity = parseFiniteNumber(level[1]) || 0;
      return sum + (price * quantity) / 100;
    }, 0);

    const askDepthUsd = rawYesAsks.reduce((sum, level) => {
      if (!Array.isArray(level) || level.length < 2) {
        return sum;
      }

      const noPrice = parseFiniteNumber(level[0]) || 0;
      const quantity = parseFiniteNumber(level[1]) || 0;
      const yesAskPrice = 100 - noPrice;
      return sum + (yesAskPrice * quantity) / 100;
    }, 0);

    return Math.round(bidDepthUsd + askDepthUsd);
  };

  let endpoint = `/markets?limit=100&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  let degraded = false;
  let warning: string | undefined;
  let response: { markets?: KalshiMarket[] };
  try {
    response = (await fetchKalshi(endpoint)) as { markets?: KalshiMarket[] };
  } catch (primaryError) {
    degraded = true;
    warning = `Primary market snapshot failed (${endpoint}). Using reduced fallback sample.`;
    try {
      let fallbackEndpoint = `/markets?limit=30&status=open`;
      if (category) {
        fallbackEndpoint += `&category=${encodeURIComponent(category)}`;
      }
      response = (await fetchKalshi(fallbackEndpoint)) as {
        markets?: KalshiMarket[];
      };
    } catch (fallbackError) {
      const fallbackMessage =
        fallbackError instanceof Error ? fallbackError.message : "unknown error";
      return successResult({
        markets: [],
        summary: {
          probabilityRange: `${minPrice}-${maxPrice}%`,
          marketsFound: 0,
          minLiquidityApplied,
          avgReturn: "0%",
        },
        degraded: true,
        warning: `Market snapshot unavailable after fallback: ${fallbackMessage}`,
        fetchedAt: new Date().toISOString(),
      });
    }

    if (primaryError instanceof Error) {
      warning = `${warning} Primary error: ${primaryError.message.slice(0, 160)}`;
    }
  }

  let markets = response.markets || [];

  // Filter by probability range
  markets = markets.filter(m => {
    const price = m.yes_ask || m.last_price || 50;
    return price >= minPrice && price <= maxPrice;
  });

  if (minLiquidityApplied > 0) {
    const liquidityCandidates = markets
      .slice()
      .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
      .slice(0, Math.max(limit * 5, 20));
    const liquidityQualified: KalshiMarket[] = [];

    for (const market of liquidityCandidates) {
      let effectiveLiquidity = market.liquidity || 0;

      if (effectiveLiquidity <= 0) {
        try {
          effectiveLiquidity = await estimateLiquidityFromOrderbook(market.ticker);
        } catch {
          effectiveLiquidity = 0;
        }
      }

      if (effectiveLiquidity >= minLiquidityApplied) {
        liquidityQualified.push({
          ...market,
          liquidity: effectiveLiquidity,
        });
      }
    }

    markets = liquidityQualified;
  }

  // Sort by volume and take top results
  markets.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));
  markets = markets.slice(0, limit);

  const avgPrice = markets.length > 0
    ? markets.reduce((sum, m) => sum + (m.yes_ask || m.last_price || 50), 0) / markets.length
    : 0;
  const avgReturn = avgPrice > 0 ? ((100 / avgPrice) - 1) * 100 : 0;

  const marketsResult = markets.map(m => {
    const price = m.yes_ask || m.last_price || 50;
    const potentialReturn = price > 0 ? ((100 / price) - 1) * 100 : 0;

    return {
      title: m.title || m.yes_sub_title || m.ticker,
      ticker: m.ticker,
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      yesPrice: price,
      impliedProbability: `${price}%`,
      potentialReturn: `${potentialReturn.toFixed(0)}%`,
      liquidity: m.liquidity || 0,
      volume24h: m.volume_24h || 0,
      closeTime: m.close_time || "",
      category: m.category || "Unknown",
    };
  });

  return successResult({
    markets: marketsResult,
    summary: {
      probabilityRange: `${minPrice}-${maxPrice}%`,
      marketsFound: markets.length,
      minLiquidityApplied,
      avgReturn: `${avgReturn.toFixed(0)}%`,
    },
    degraded,
    warning:
      warning ||
      (minLiquidityApplied > 0 && markets.length === 0
        ? "No markets met the requested probability range plus liquidity threshold based on current orderbook depth."
        : undefined),
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeMarketSentiment(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  const periodHours = Math.min(
    Math.max((args?.periodHours as number) || 24, 1),
    24 * 14
  );
  const tradeLimit = Math.min(
    Math.max((args?.tradeLimit as number) || 5, 1),
    20
  );
  const rawCandlestickInterval = args?.candlestickInterval as number | undefined;
  const candlestickInterval =
    rawCandlestickInterval === 1 ||
    rawCandlestickInterval === 60 ||
    rawCandlestickInterval === 1440
      ? rawCandlestickInterval
      : 60;

  const marketRes = await fetchKalshi(`/markets/${ticker}`) as { market: KalshiMarket };
  const market = marketRes.market;

  const limitations: string[] = [];
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - periodHours * 60 * 60;

  const extractClosePrice = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (!isRecord(value)) {
      return null;
    }
    const close = parseFiniteNumber(value.close);
    return close === undefined ? null : close;
  };

  let recentTrades: Array<{
    timestamp: string;
    price: number;
    count: number;
    takerSide: string;
  }> = [];
  try {
    const tradesResponse = (await fetchKalshi(
      `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${tradeLimit}`
    )) as {
      trades?: KalshiTrade[];
    };
    recentTrades = (tradesResponse.trades || []).map((trade) => ({
      timestamp:
        trade.created_time ||
        (typeof trade.timestamp === "string"
          ? trade.timestamp
          : typeof trade.timestamp === "number"
            ? new Date(trade.timestamp * 1000).toISOString()
            : typeof trade.created_ts === "number"
              ? new Date(trade.created_ts * 1000).toISOString()
              : ""),
      price: trade.yes_price ?? trade.price ?? 0,
      count: trade.count || 0,
      takerSide: trade.taker_side || "unknown",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    limitations.push(`Recent trades unavailable: ${message}`);
  }

  let recentCandlesticks: Array<{
    endPeriodTs: number;
    closePrice: number | null;
    volume: number;
    openInterest: number;
  }> = [];
  let candlestickSummary: {
    intervalMinutes: number;
    candlesReturned: number;
    latestClose: number | null;
    highClose: number | null;
    lowClose: number | null;
    volumeTotal: number;
  } = {
    intervalMinutes: candlestickInterval,
    candlesReturned: 0,
    latestClose: null,
    highClose: null,
    lowClose: null,
    volumeTotal: 0,
  };

  try {
    const candlestickResponse = (await fetchKalshi(
      `/markets/candlesticks?market_tickers=${encodeURIComponent(
        ticker
      )}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${candlestickInterval}`
    )) as {
      markets?: Array<{
        market_ticker: string;
        candlesticks?: Array<{
          end_period_ts: number;
          price?: unknown;
          volume?: number;
          open_interest?: number;
        }>;
      }>;
    };

    const marketCandles =
      candlestickResponse.markets?.find((entry) => entry.market_ticker === ticker)
        ?.candlesticks || candlestickResponse.markets?.at(0)?.candlesticks || [];

    recentCandlesticks = marketCandles.slice(-8).map((candle) => ({
      endPeriodTs: candle.end_period_ts,
      closePrice: extractClosePrice(candle.price),
      volume: candle.volume ?? 0,
      openInterest: candle.open_interest ?? 0,
    }));

    const closePrices = recentCandlesticks
      .map((candle) => candle.closePrice)
      .filter((price): price is number => price !== null);

    candlestickSummary = {
      intervalMinutes: candlestickInterval,
      candlesReturned: marketCandles.length,
      latestClose:
        recentCandlesticks.length > 0
          ? recentCandlesticks.at(-1)?.closePrice ?? null
          : null,
      highClose:
        closePrices.length > 0 ? Math.max(...closePrices) : null,
      lowClose:
        closePrices.length > 0 ? Math.min(...closePrices) : null,
      volumeTotal: recentCandlesticks.reduce(
        (sum, candle) => sum + candle.volume,
        0
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    limitations.push(`Candlesticks unavailable: ${message}`);
  }

  const currentPrice =
    candlestickSummary.latestClose ?? market.yes_ask ?? market.last_price ?? 50;
  const previousPrice =
    recentCandlesticks.find((candle) => candle.closePrice !== null)?.closePrice ??
    market.previous_price ??
    currentPrice;
  const change24h = currentPrice - previousPrice;
  const changePercent =
    previousPrice > 0 ? ((change24h / previousPrice) * 100) : 0;

  const volume24h =
    candlestickSummary.volumeTotal > 0
      ? candlestickSummary.volumeTotal
      : market.volume_24h || 0;
  const avgVolume = (market.volume || 0) / 7; // Rough daily average
  const isAboveAverage = volume24h > avgVolume;

  // Determine sentiment
  let sentiment: string;
  let confidence: string;

  if (change24h > 10) {
    sentiment = "strongly_bullish";
    confidence = "high";
  } else if (change24h > 3) {
    sentiment = "bullish";
    confidence = isAboveAverage ? "high" : "medium";
  } else if (change24h < -10) {
    sentiment = "strongly_bearish";
    confidence = "high";
  } else if (change24h < -3) {
    sentiment = "bearish";
    confidence = isAboveAverage ? "high" : "medium";
  } else {
    sentiment = "neutral";
    confidence = "low";
  }

  const recommendation = sentiment.includes("bullish")
    ? "Positive momentum - recent tape and pricing are leaning upward"
    : sentiment.includes("bearish")
    ? "Negative momentum - recent tape and pricing are leaning downward"
    : "Sideways movement - tape is mixed, wait for clearer signal";

  return successResult({
    market: market.title || ticker,
    ticker,
    currentPrice,
    priceChange: {
      change24h,
      changePercent24h: `${changePercent.toFixed(2)}%`,
      high24h: currentPrice + Math.abs(change24h),
      low24h: currentPrice - Math.abs(change24h),
    },
    volumeTrend: {
      volume24h,
      volumeChange: isAboveAverage ? "Above average" : "Below average",
      isAboveAverage,
    },
    recentTrades,
    recentCandlesticks,
    candlestickSummary,
    sentiment,
    confidence,
    recommendation,
    limitations,
    fetchedAt: new Date().toISOString(),
  });
}

// ==================== CROSS-PLATFORM INTEROPERABILITY HANDLER ====================

/**
 * Extract keywords from market title/description for cross-platform matching
 */
function extractKeywords(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 
    'will', 'be', 'by', 'this', 'that', 'it', 'with', 'from', 'as', 'are',
    'was', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'but',
    'if', 'than', 'so', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
    'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
  ]);
  
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 15);
}

/**
 * Extract team names from sports-related text
 */
function extractTeams(text: string): string[] {
  const teams: string[] = [];
  const textLower = text.toLowerCase();
  
  const nbaTeams = ['lakers', 'celtics', 'warriors', 'heat', 'bucks', 'nuggets', 'suns', 'nets', 'sixers', '76ers', 'knicks', 'bulls', 'clippers', 'mavericks', 'cavaliers'];
  const nflTeams = ['chiefs', 'eagles', 'cowboys', '49ers', 'bills', 'ravens', 'lions', 'dolphins', 'jets', 'packers', 'vikings', 'bengals', 'jaguars', 'texans', 'chargers', 'broncos', 'patriots', 'saints', 'falcons', 'bears'];
  const mlbTeams = ['yankees', 'dodgers', 'braves', 'astros', 'mets', 'phillies', 'padres', 'mariners', 'orioles', 'rangers', 'twins', 'rays', 'guardians', 'cubs', 'red sox'];
  
  const allTeams = [...nbaTeams, ...nflTeams, ...mlbTeams];
  
  for (const team of allTeams) {
    if (textLower.includes(team)) {
      teams.push(team.charAt(0).toUpperCase() + team.slice(1));
    }
  }
  
  return teams;
}

/**
 * Categorize a market into standardized categories
 */
function categorizeMarket(title: string, category: string | undefined): string {
  const textLower = (title + ' ' + (category || '')).toLowerCase();
  
  if (['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'ufc', 'mma', 'boxing', 'f1', 'nascar', 'olympics', 'world cup', 'super bowl', 'championship', 'sports'].some(s => textLower.includes(s))) {
    return 'sports';
  }
  if (['election', 'president', 'senate', 'congress', 'vote', 'trump', 'biden', 'democrat', 'republican', 'governor', 'political', 'poll', 'politics'].some(s => textLower.includes(s))) {
    return 'politics';
  }
  if (['bitcoin', 'ethereum', 'crypto', 'btc', 'eth', 'solana', 'token', 'defi', 'nft', 'blockchain'].some(s => textLower.includes(s))) {
    return 'crypto';
  }
  if (['stock', 'market', 'fed', 'interest rate', 'recession', 'inflation', 'gdp', 'economic', 'financials', 'economics'].some(s => textLower.includes(s))) {
    return 'business';
  }
  
  return category?.toLowerCase() || 'other';
}

// Cross-platform search on Polymarket
// Helper function to extract YES/NO outcome meanings from resolution rules
function extractOutcomeMeanings(rules: string, marketTitle: string): { yesOutcomeMeans: string; noOutcomeMeans: string } {
  const rulesLower = rules.toLowerCase();
  const titleLower = marketTitle.toLowerCase();
  
  // Default fallback based on title
  let yesOutcomeMeans = `The event described in "${marketTitle}" occurs`;
  let noOutcomeMeans = `The event described in "${marketTitle}" does NOT occur`;
  
  // Pattern 1: "resolve to Yes if..." / "resolve to No if..."
  const yesIfMatch = rules.match(/resolves?\s+to\s+["']?yes["']?\s+if\s+([^.]+)/i);
  const noIfMatch = rules.match(/resolves?\s+to\s+["']?no["']?\s+if\s+([^.]+)/i);
  
  if (yesIfMatch) {
    yesOutcomeMeans = yesIfMatch[1].trim().replace(/[,;]$/, '');
    // Capitalize first letter
    yesOutcomeMeans = yesOutcomeMeans.charAt(0).toUpperCase() + yesOutcomeMeans.slice(1);
  }
  if (noIfMatch) {
    noOutcomeMeans = noIfMatch[1].trim().replace(/[,;]$/, '');
    noOutcomeMeans = noOutcomeMeans.charAt(0).toUpperCase() + noOutcomeMeans.slice(1);
  }
  
  // Pattern 2: "This market will resolve to 'Yes' if..."
  const willResolveYes = rules.match(/will\s+resolve\s+to\s+["']?yes["']?\s+if\s+([^.]+)/i);
  if (willResolveYes && !yesIfMatch) {
    yesOutcomeMeans = willResolveYes[1].trim().replace(/[,;]$/, '');
    yesOutcomeMeans = yesOutcomeMeans.charAt(0).toUpperCase() + yesOutcomeMeans.slice(1);
  }
  
  // Pattern 3: Look for "in favor of" patterns
  if (rulesLower.includes('in favor of') || titleLower.includes('in favor of')) {
    const favorMatch = rules.match(/in\s+favor\s+of\s+([^,.']+)/i);
    if (favorMatch) {
      const subject = favorMatch[1].trim();
      yesOutcomeMeans = `Ruling/decision is IN FAVOR OF ${subject}`;
      noOutcomeMeans = `Ruling/decision is AGAINST ${subject}`;
    }
  }
  
  // Pattern 4: "reverses, vacates, or otherwise overturns" - legal patterns
  if (rulesLower.includes('reverses') || rulesLower.includes('overturns') || rulesLower.includes('vacates')) {
    yesOutcomeMeans = 'Court reverses/overturns the lower court decision (ruling FAVORS the appellant)';
    noOutcomeMeans = 'Court upholds/affirms the lower court decision (ruling AGAINST the appellant)';
  }
  
  // Truncate if too long
  if (yesOutcomeMeans.length > 150) {
    yesOutcomeMeans = yesOutcomeMeans.substring(0, 147) + '...';
  }
  if (noOutcomeMeans.length > 150) {
    noOutcomeMeans = noOutcomeMeans.substring(0, 147) + '...';
  }
  
  return { yesOutcomeMeans, noOutcomeMeans };
}

async function handleSearchOnPolymarket(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const title = args?.title as string | undefined;
  const rawKeywords = args?.keywords;
  const keywords =
    typeof rawKeywords === "string"
      ? rawKeywords
      : Array.isArray(rawKeywords)
        ? rawKeywords
            .filter((value): value is string => typeof value === "string")
            .join(" ")
        : undefined;
  const kalshiTicker = args?.kalshiTicker as string | undefined;
  const limit = Math.min((args?.limit as number) || 10, 25);

  // Build search query from title or keywords
  // IMPORTANT: Extract meaningful keywords - long queries fail on Polymarket's search
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'this', 'that', 'with', 'from', 'as', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'but', 'if', 'than', 'so', 'just', 'inc', 'vs', 'case']);
  const lowSignalWords = new Set(['above', 'after', 'before', 'below', 'between', 'buy', 'current', 'day', 'end', 'event', 'events', 'exact', 'explain', 'high', 'hit', 'market', 'markets', 'match', 'matches', 'mean', 'means', 'month', 'next', 'no', 'price', 'prices', 'question', 'really', 'said', 'show', 'side', 'specific', 'temp', 'temperature', 'then', 'under', 'up', 'view', 'weather', 'yes', 'york']);
  
  let searchQuery = '';
  const sourceText = keywords || title || '';
  const tickerKeywords: string[] = [];
  
  if (sourceText) {
    // Extract meaningful keywords - Polymarket search works best with 3-6 short keywords
    // Long queries like "Will the Supreme Court rule in favor of Trump in V.O.S. Selections, Inc. v. Trump"
    // fail, but "supreme court trump tariffs" works perfectly
    const extractedWords = sourceText.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
    
    // Also extract keywords from Kalshi ticker if provided (e.g., KXDJTVOSTARIFFS contains "tariffs")
    // These are HIGH PRIORITY - often contain the key differentiating term
    if (kalshiTicker) {
      // Extract meaningful words from ticker
      // Ticker format: KXDJTVOSTARIFFS -> contains "tariffs" which is crucial
      const tickerLower = kalshiTicker.toLowerCase().replace(/^kx/, '');
      
      // Look for embedded keywords in ticker - these are CRITICAL for matching
      const keywordPatterns = [
        { pattern: /tariffs?/i, keyword: 'tariffs' },
        { pattern: /scotus/i, keyword: 'scotus' },
        { pattern: /bitcoin|btc/i, keyword: 'bitcoin' },
        { pattern: /ethereum|eth/i, keyword: 'ethereum' },
        { pattern: /election/i, keyword: 'election' },
        { pattern: /president/i, keyword: 'president' },
      ];
      
      for (const { pattern, keyword } of keywordPatterns) {
        if (pattern.test(tickerLower) && !extractedWords.includes(keyword)) {
          tickerKeywords.push(keyword);
        }
      }
    }
    
    // Prioritize keywords that are most likely to be useful for matching:
    // 1. High-value keywords (names, specific terms) from title
    // 2. Ticker-derived keywords (often contain the key differentiating term)
    // 3. Skip common verbs like "rule", "favor" which are less distinctive
    const lowValueWords = new Set(['rule', 'ruling', 'favor', 'decide', 'decision', 'vote', 'pass', 'approve']);
    
    const highValueWords = extractedWords.filter(w => !lowValueWords.has(w));
    const normalWords = extractedWords.filter(w => lowValueWords.has(w));
    
    // Combine: high-value words first, then ticker keywords, then normal words
    const priorityWords = [...highValueWords, ...tickerKeywords, ...normalWords];
    // Remove duplicates while preserving order
    const uniqueWords = [...new Set(priorityWords)];
    searchQuery = uniqueWords.slice(0, 5).join(' ');
  }

  if (!searchQuery) {
    return errorResult("Either 'title' or 'keywords' is required to search Polymarket.");
  }

  try {
    const allQueryWords = searchQuery
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w));
    const signalQueryWords = allQueryWords.filter(w => !lowSignalWords.has(w));
    const matchWords = signalQueryWords.length > 0 ? signalQueryWords : allQueryWords;
    const strongTickerAnchors = tickerKeywords.filter(
      word => !new Set(['election', 'president']).has(word) && word.length >= 6
    );
    const strongKeywordAnchors = [...new Set([
      ...strongTickerAnchors,
      ...matchWords.filter(word => word.length >= 6),
    ])];
    const allResults: Array<{
      title: string;
      slug: string;
      question: string;
      yesPrice: number;
      volume: number;
      liquidity: number;
      url: string;
      matchScore: number;
      rules: string;
      yesOutcomeMeans: string;
      noOutcomeMeans: string;
    }> = [];
    let rejectedWeakMatches = 0;

    // Use Polymarket's official /public-search API for server-side text search
    const searchUrl = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(searchQuery)}&limit_per_type=${limit * 2}&events_status=active`;
    const response = await fetch(searchUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Kalshi-MCP-Server/1.0' },
    });

    if (response.ok) {
      const searchData = await response.json() as { 
        events?: Array<{
          id: string; 
          slug: string; 
          title: string; 
          description?: string;
          volume?: number;
          liquidity?: number;
          markets?: Array<{ 
            question?: string; 
            description?: string; 
            outcomePrices?: string; 
            volume?: number; 
            liquidity?: number; 
          }>;
        }>; 
      };

      for (const event of (searchData.events || [])) {
        let yesPrice = 0;
        let volume = event.volume || 0;
        let liquidity = event.liquidity || 0;
        let question = event.title;
        let rules = event.description || '';
        
        if (event.markets && event.markets.length > 0) {
          const firstMarket = event.markets[0];
          question = firstMarket.question || event.title;
          volume = firstMarket.volume || volume;
          liquidity = firstMarket.liquidity || liquidity;
          rules = firstMarket.description || event.description || '';
          if (firstMarket.outcomePrices) {
            try {
              const prices = JSON.parse(firstMarket.outcomePrices);
              yesPrice = parseFloat(prices[0]) || 0;
            } catch {}
          }
        }

        const searchText = [
          event.title,
          question,
          event.description || '',
          rules,
        ].join(' ').toLowerCase();
        let matchCount = 0;
        for (const word of matchWords) {
          if (textMatchesSearchWord(searchText, word)) {
            matchCount++;
          }
        }
        const anchorMatchCount = strongKeywordAnchors.filter(word =>
          textMatchesSearchWord(searchText, word)
        ).length;
        const matchScore = matchWords.length > 0 ? matchCount / matchWords.length : 1;
        const minimumSignalMatches =
          matchWords.length === 0
            ? 0
            : Math.max(1, Math.ceil(matchWords.length / 2));
        const hasCredibleSemanticMatch =
          matchWords.length === 0 ||
          (anchorMatchCount > 0 && matchScore >= 0.25) ||
          (matchCount >= minimumSignalMatches && matchScore >= 0.5);
        if (!hasCredibleSemanticMatch) {
          rejectedWeakMatches++;
          continue;
        }
        
        const { yesOutcomeMeans, noOutcomeMeans } = extractOutcomeMeanings(rules, event.title);
        allResults.push({
          title: event.title,
          slug: event.slug,
          question,
          yesPrice: Math.round(yesPrice * 100) / 100,
          volume,
          liquidity,
          url: `https://polymarket.com/event/${event.slug}`,
          matchScore: Math.round(matchScore * 100) / 100,
          rules,
          yesOutcomeMeans,
          noOutcomeMeans,
        });
      }
    }

    // Sort by match score and volume
    const scoredResults = allResults
      .sort((a, b) => b.matchScore - a.matchScore || b.volume - a.volume)
      .slice(0, limit);

    const hint = scoredResults.length > 0
      ? `✅ Found ${scoredResults.length} credible matches on Polymarket via server-side search.${rejectedWeakMatches > 0 ? ` Filtered out ${rejectedWeakMatches} weak semantic matches.` : ''} ⚠️ CRITICAL: Check 'yesOutcomeMeans' and 'noOutcomeMeans' fields to ensure you're comparing equivalent outcomes!`
      : `No credible Polymarket matches found for "${searchQuery}". The public search results did not produce a close semantic equivalent.`;

    // Build comparison guidance
    const comparisonNote = scoredResults.length > 0 
      ? `⚠️ CROSS-PLATFORM COMPARISON GUIDE:
1. Polymarket prices are decimals (0.25 = 25%), Kalshi prices are cents (25 = 25%)
2. READ 'yesOutcomeMeans' for each market - they may be INVERTED!
3. Example: If Polymarket YES means "Court rules AGAINST" and Kalshi YES means "Court rules IN FAVOR", then Polymarket NO ≈ Kalshi YES
4. Only compare prices AFTER confirming outcomes align!`
      : null;

    return successResult({
      searchedFor: {
        keywords: searchQuery,
        kalshiTicker: kalshiTicker || "",
      },
      searchMethod: "public-search API",
      polymarketResults: scoredResults,
      hint,
      comparisonNote: comparisonNote || "",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to search Polymarket: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ==================== TIER 2: RAW DATA HANDLERS ====================

async function handleGetEvents(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const status = normalizeRequestedKalshiStatus(args?.status as string | undefined);
  const seriesTicker = args?.seriesTicker as string | undefined;
  const withNestedMarkets = args?.withNestedMarkets === true;
  const withMilestones = args?.withMilestones === true;
  if (args?.minCloseTs !== undefined || args?.maxCloseTs !== undefined) {
    return errorResult(
      "Arguments minCloseTs/maxCloseTs are not supported (their semantics are commonly mis-mapped). Use closingBeforeTs for 'closes before <date>' / 'imminent settlement' / 'expiring soon' (upper bound on close time) and closingAfterTs for 'closes after <date>' (lower bound). Both take Unix seconds, e.g. Math.floor(Date.parse('2026-04-25T00:00:00Z')/1000) === 1777680000."
    );
  }
  const minCloseTs = args?.closingAfterTs as number | undefined;
  const maxCloseTs = args?.closingBeforeTs as number | undefined;
  const limit = Math.min((args?.limit as number) || 50, 200);
  const cursor = args?.cursor as string | undefined;

  let endpoint = `/events?limit=${limit}&status=${status}`;
  if (seriesTicker) {
    endpoint += `&series_ticker=${encodeURIComponent(seriesTicker)}`;
  }
  // Always fetch with_nested_markets so each event can surface a canonical
  // closeTime (earliest sub-market close). Without this, buyers asking for
  // close times / imminent settlements get no per-event timestamps.
  endpoint += "&with_nested_markets=true";
  void withNestedMarkets;
  if (withMilestones) {
    endpoint += "&with_milestones=true";
  }
  if (minCloseTs) {
    endpoint += `&min_close_ts=${minCloseTs}`;
  }
  if (maxCloseTs) {
    // Best-effort: pass to upstream even though it may be ignored; we still
    // enforce the cap client-side below.
    endpoint += `&max_close_ts=${maxCloseTs}`;
  }
  if (cursor) {
    endpoint += `&cursor=${encodeURIComponent(cursor)}`;
  }

  const response = await fetchKalshi(endpoint) as { events: KalshiEvent[]; cursor?: string; next_cursor?: string };
  const nextCursor = response.next_cursor || response.cursor || "";
  const rawEvents = response.events || [];

  const computeEventCloseBounds = (event: KalshiEvent): { earliest?: number; latest?: number; earliestIso?: string; latestIso?: string } => {
    const tsList: number[] = [];
    const markets = Array.isArray(event.markets) ? event.markets : [];
    for (const m of markets) {
      const t = Date.parse(m.close_time || "");
      if (Number.isFinite(t)) tsList.push(Math.floor(t / 1000));
      const nt = (m as unknown as { close_ts?: number }).close_ts;
      if (typeof nt === "number" && Number.isFinite(nt)) tsList.push(nt);
    }
    if (tsList.length === 0) return {};
    const earliest = Math.min(...tsList);
    const latest = Math.max(...tsList);
    return {
      earliest,
      latest,
      earliestIso: new Date(earliest * 1000).toISOString(),
      latestIso: new Date(latest * 1000).toISOString(),
    };
  };

  const filteredEvents = maxCloseTs || minCloseTs
    ? rawEvents.filter((e) => {
        const bounds = computeEventCloseBounds(e);
        if (bounds.earliest === undefined) {
          // Keep events we can't evaluate rather than silently drop them.
          return true;
        }
        if (maxCloseTs && bounds.earliest > maxCloseTs) return false;
        if (minCloseTs && bounds.latest !== undefined && bounds.latest < minCloseTs) return false;
        return true;
      })
    : rawEvents;

  const events = filteredEvents.map((event) => {
    const bounds = computeEventCloseBounds(event);
    const result: Record<string, unknown> = {
      eventTicker: event.event_ticker,
      title: event.title || event.event_ticker,
      category: event.category || "Unknown",
      status: event.status || "open",
      marketsCount: Array.isArray(event.markets) ? event.markets.length : 0,
      ...(bounds.earliestIso
        ? { closeTime: bounds.earliestIso, earliestCloseTime: bounds.earliestIso }
        : {}),
      ...(bounds.latestIso ? { latestCloseTime: bounds.latestIso } : {}),
    };

    if (withNestedMarkets && Array.isArray(event.markets)) {
      result.markets = event.markets.map((market) => ({
        ticker: market.ticker,
        title: market.title || market.yes_sub_title || market.ticker,
        yesPrice: market.yes_ask || market.last_price || 0,
        noPrice: market.no_ask || (100 - (market.yes_ask || market.last_price || 50)),
        yesBid: market.yes_bid || 0,
        yesAsk: market.yes_ask || 0,
        noBid: market.no_bid || 0,
        noAsk: market.no_ask || 0,
        volume: market.volume || 0,
        volume24h: market.volume_24h || 0,
        liquidity: market.liquidity || 0,
        closeTime: market.close_time || "",
        status: market.status || "open",
        url: `https://kalshi.com/markets/${getSeriesTicker(market.event_ticker)}`,
      }));
    }

    return result;
  });

  return successResult({
    events,
    nextCursor,
    cursor: nextCursor,
    count: events.length,
    filtersApplied: {
      status,
      seriesTicker,
      withNestedMarkets: withNestedMarkets || Boolean(maxCloseTs),
      withMilestones,
      minCloseTs,
      maxCloseTs,
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const status = (args?.status as string) || "open";
  const eventTicker = args?.eventTicker as string | undefined;
  const seriesTicker = args?.seriesTicker as string | undefined;
  const category = args?.category as string | undefined;
  const tickers = (args?.tickers as string[] | undefined)?.filter(Boolean) || [];
  const minUpdatedTs = args?.minUpdatedTs as number | undefined;
  if (args?.minCloseTs !== undefined || args?.maxCloseTs !== undefined) {
    return errorResult(
      "Arguments minCloseTs/maxCloseTs are not supported (their semantics are commonly mis-mapped). Use closingBeforeTs for 'closes before <date>' (upper bound on close time) and closingAfterTs for 'closes after <date>' (lower bound). Both take Unix seconds."
    );
  }
  const minCloseTs = args?.closingAfterTs as number | undefined;
  const maxCloseTs = args?.closingBeforeTs as number | undefined;
  const minCreatedTs = args?.minCreatedTs as number | undefined;
  const maxCreatedTs = args?.maxCreatedTs as number | undefined;
  const minSettledTs = args?.minSettledTs as number | undefined;
  const maxSettledTs = args?.maxSettledTs as number | undefined;
  const limit = Math.min((args?.limit as number) || 50, 200);
  const cursor = args?.cursor as string | undefined;

  let endpoint = `/markets?limit=${limit}&status=${encodeURIComponent(status)}`;
  if (eventTicker) endpoint += `&event_ticker=${encodeURIComponent(eventTicker)}`;
  if (seriesTicker) endpoint += `&series_ticker=${encodeURIComponent(seriesTicker)}`;
  if (category) endpoint += `&category=${encodeURIComponent(category)}`;
  if (tickers.length > 0) endpoint += `&tickers=${encodeURIComponent(tickers.join(","))}`;
  if (minUpdatedTs) endpoint += `&min_updated_ts=${minUpdatedTs}`;
  if (minCloseTs) endpoint += `&min_close_ts=${minCloseTs}`;
  if (maxCloseTs) endpoint += `&max_close_ts=${maxCloseTs}`;
  if (minCreatedTs) endpoint += `&min_created_ts=${minCreatedTs}`;
  if (maxCreatedTs) endpoint += `&max_created_ts=${maxCreatedTs}`;
  if (minSettledTs) endpoint += `&min_settled_ts=${minSettledTs}`;
  if (maxSettledTs) endpoint += `&max_settled_ts=${maxSettledTs}`;
  if (cursor) endpoint += `&cursor=${encodeURIComponent(cursor)}`;

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[]; cursor?: string; next_cursor?: string };
  let nextCursor = response.next_cursor || response.cursor || "";
  let rawMarkets: KalshiMarket[] = response.markets || [];

  // When a caller requests a series-level rollup (seriesTicker provided and
  // they didn't pass an explicit cursor) auto-paginate up to a safe ceiling so
  // we can return a real aggregate.totalVolume24h. Otherwise callers stop at
  // the first page and synthesize misleading "0 volume across the series"
  // answers.
  let autoPaginated = false;
  if (seriesTicker && !cursor && nextCursor) {
    const MAX_AUTO_PAGES = 9;
    const MAX_AUTO_ROWS = 2000;
    let page = 0;
    while (nextCursor && page < MAX_AUTO_PAGES && rawMarkets.length < MAX_AUTO_ROWS) {
      const nextUrl = `${endpoint.split("&cursor=")[0]}&cursor=${encodeURIComponent(nextCursor)}`;
      const pageResp = (await fetchKalshi(nextUrl)) as {
        markets: KalshiMarket[];
        cursor?: string;
        next_cursor?: string;
      };
      rawMarkets = rawMarkets.concat(pageResp.markets || []);
      nextCursor = pageResp.next_cursor || pageResp.cursor || "";
      page += 1;
      autoPaginated = true;
    }
  }

  const markets = filterMarketsByRequestedCategory(rawMarkets, category).map((m) => ({
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesPrice: m.yes_ask || m.last_price || 0,
    noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
    yesBid: m.yes_bid || 0,
    yesAsk: m.yes_ask || 0,
    noBid: m.no_bid || 0,
    noAsk: m.no_ask || 0,
    lastPrice: m.last_price || 0,
    volume: m.volume || 0,
    volume24h: m.volume_24h || 0,
    openInterest: m.open_interest || 0,
    liquidity: m.liquidity || 0,
    status: m.status || "open",
    category: m.category || "Unknown",
    openTime: m.open_time || "",
    closeTime: m.close_time || "",
    url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
  }));

  const marketsRecoveryHints = buildMarketsListRecoveryHints({
    args,
    resultCount: markets.length,
    nextCursor,
  });

  const totalVolume24h = markets.reduce((acc, m) => acc + (Number(m.volume24h) || 0), 0);
  const totalVolume = markets.reduce((acc, m) => acc + (Number(m.volume) || 0), 0);
  const totalLiquidity = markets.reduce((acc, m) => acc + (Number(m.liquidity) || 0), 0);
  const totalOpenInterest = markets.reduce((acc, m) => acc + (Number(m.openInterest) || 0), 0);
  const uniqueEventTickers = new Set(markets.map((m) => m.eventTicker).filter(Boolean));

  const marketsResponse: Record<string, unknown> = {
    markets,
    nextCursor,
    cursor: nextCursor,
    count: markets.length,
    autoPaginated,
    aggregate: {
      marketCount: markets.length,
      uniqueEventCount: uniqueEventTickers.size,
      totalVolume24h,
      totalVolume,
      totalLiquidity,
      totalOpenInterest,
    },
    filtersApplied: {
      status,
      eventTicker,
      seriesTicker,
      category,
      tickersCount: tickers.length,
    },
    fetchedAt: new Date().toISOString(),
  };

  if (marketsRecoveryHints) {
    marketsResponse.hint =
      markets.length === 0
        ? `⚠️ get_markets returned 0 markets for the given filters. DO NOT refuse — follow recoveryHints.nextTools (broaden status, pivot to browse_category / discover_trending_markets, or fetch get_event directly).`
        : `ℹ️ More pages available (nextCursor='${nextCursor.slice(0, 24)}...'). Paginate with cursor OR pivot to a ranked tool (recoveryHints.nextTools) before shortlisting a 'top N'.`;
    marketsResponse.recoveryHints = marketsRecoveryHints;
  }

  return successResult(marketsResponse);
}

async function handleGetEvent(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  let eventTicker = args?.eventTicker as string;
  if (!eventTicker) {
    return errorResult("eventTicker is required");
  }

  const withNested = args?.withNestedMarkets !== false;
  let resolvedFrom: string | undefined;
  
  // Auto-detect if this looks like a slug and resolve it
  if (isSlug(eventTicker)) {
    const resolved = await resolveSlugToEvent(eventTicker);
    if (resolved.found && resolved.eventTicker) {
      resolvedFrom = `slug:${eventTicker}`;
      eventTicker = resolved.eventTicker;
    } else {
      return errorResult(
        `Could not resolve slug '${eventTicker}' to an event. ` +
        `Try using search_markets({ query: "${eventTicker}" }) to find matching markets, ` +
        `or use resolve_slug({ slug: "${eventTicker}" }) for detailed resolution info.`
      );
    }
  }
  
  try {
    const response = await fetchKalshi(
      `/events/${eventTicker}?with_nested_markets=${withNested}`
    ) as { event: KalshiEvent };
    const event = response.event;

    const projectMarket = (m: KalshiMarket) => ({
      ticker: m.ticker,
      title: m.title || m.yes_sub_title || m.ticker,
      yesPrice: m.yes_ask || m.last_price || 0,
      noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
      yesBid: m.yes_bid || 0,
      yesAsk: m.yes_ask || 0,
      noBid: m.no_bid || 0,
      noAsk: m.no_ask || 0,
      lastPrice: m.last_price || 0,
      volume: m.volume || 0,
      volume24h: m.volume_24h || 0,
      liquidity: m.liquidity || 0,
      openInterest: m.open_interest || 0,
      closeTime: m.close_time || "",
      status: m.status || "open",
    });

    let markets = (event.markets || []).map(projectMarket);
    let marketsSource: "event.markets" | "event.markets+fallback" = "event.markets";

    // Some events return a sparse markets array from /events/{ticker}
    // (e.g. pagination-like truncation). When that happens, fan out to
    // /markets?event_ticker=... and merge — this recovers sub-markets
    // that the event endpoint silently drops, so pairwise arb / spread
    // checks have real data to work with.
    if (withNested && markets.length < 2) {
      try {
        const marketsResp = (await fetchKalshi(
          `/markets?event_ticker=${encodeURIComponent(eventTicker)}&limit=200`
        )) as { markets?: KalshiMarket[]; cursor?: string; next_cursor?: string };
        const extraRaw = marketsResp.markets || [];
        if (extraRaw.length > markets.length) {
          const byTicker = new Map(markets.map((m) => [m.ticker, m]));
          for (const raw of extraRaw) {
            if (!byTicker.has(raw.ticker)) {
              byTicker.set(raw.ticker, projectMarket(raw));
            }
          }
          markets = Array.from(byTicker.values());
          marketsSource = "event.markets+fallback";
        }
      } catch {
        // Best effort; keep the original sparse list if the fallback fails.
      }
    }

    const result: Record<string, unknown> = {
      event: {
        eventTicker: event.event_ticker,
        title: event.title || event.event_ticker,
        category: event.category || "Unknown",
        status: event.status || "open",
      },
      markets,
      marketsSource,
      fetchedAt: new Date().toISOString(),
    };
    
    if (resolvedFrom) {
      result.resolvedFrom = resolvedFrom;
    }

    const fanoutHint = buildEventFanoutHint({
      eventTicker: event.event_ticker,
      markets,
    });
    if (fanoutHint) {
      result.fanoutHint = fanoutHint;
    }

    // Single-leg guidance: pairwise arb / overround / spread / rank-by-EV
    // prompts require ≥2 sibling legs. When an event truly has only one
    // sub-market (after the /markets fallback above), the planner should NOT
    // flag "structural arb" on the single leg and should NOT keep retrying
    // get_event / get_markets. Tell it explicitly how to answer arb-shaped
    // prompts in the single-leg case and offer a pivot to related events.
    if (markets.length <= 1) {
      const seriesTicker =
        typeof event.event_ticker === "string" && event.event_ticker.includes("-")
          ? event.event_ticker.split("-")[0]
          : null;
      const nextTools: RecoveryHintTool[] = [];
      if (seriesTicker) {
        nextTools.push({
          toolName: "get_events",
          suggestedArgs: { seriesTicker, status: "open", limit: 50 },
          reason: `Find sibling events in series ${seriesTicker} if the buyer wants a cross-event comparison — single-event pairwise arb is not possible with only ${markets.length} sub-market.`,
        });
      }
      if (markets[0]?.ticker) {
        nextTools.push({
          toolName: "get_market_orderbook",
          suggestedArgs: { ticker: markets[0].ticker, depth: 50, preferFixedPoint: true },
          reason: "For single-leg prompts, orderbook depth/spread is a better substitute for pairwise arb analysis.",
        });
      }
      result.singleLegGuidance = {
        legCount: markets.length,
        reason: `Event ${event.event_ticker} has ${markets.length} sub-market${markets.length === 1 ? "" : "s"} after the /markets fallback. Pairwise arbitrage, implied-probability sums (<100 / >110), and cross-leg spread flags are NOT applicable — they require at least two sibling legs. Do not flag "structural arb" on a single-leg event; answer honestly that the event does not support the requested pairwise analysis.`,
        doNotFlag: ["structuralArb", "venueOverround", "pairwiseSpread"],
        nextTools,
        shouldSynthesizeRefusal: false as const,
      };
    }

    return successResult(result);
  } catch (error) {
    // If direct fetch fails and we haven't tried slug resolution, try it now
    if (!resolvedFrom && error instanceof Error && error.message.includes('404')) {
      const resolved = await resolveSlugToEvent(eventTicker);
      if (resolved.found && resolved.eventTicker && resolved.eventTicker !== eventTicker) {
        // Retry with resolved ticker
        const response = await fetchKalshi(
          `/events/${resolved.eventTicker}?with_nested_markets=${withNested}`
        ) as { event: KalshiEvent };
        const event = response.event;

        const markets = (event.markets || []).map(m => ({
          ticker: m.ticker,
          title: m.title || m.yes_sub_title || m.ticker,
          yesPrice: m.yes_ask || m.last_price || 0,
          noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
          volume: m.volume || 0,
          status: m.status || "open",
        }));

        const fallbackResult: Record<string, unknown> = {
          event: {
            eventTicker: event.event_ticker,
            title: event.title || event.event_ticker,
            category: event.category || "Unknown",
            status: event.status || "open",
          },
          markets,
          resolvedFrom: `fallback:${eventTicker}`,
          fetchedAt: new Date().toISOString(),
        };
        const fallbackFanoutHint = buildEventFanoutHint({
          eventTicker: event.event_ticker,
          markets,
        });
        if (fallbackFanoutHint) {
          fallbackResult.fanoutHint = fallbackFanoutHint;
        }
        return successResult(fallbackResult);
      }
    }
    throw error;
  }
}

async function handleResolveSlug(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  if (!slug) {
    return errorResult("slug is required");
  }

  const resolved = await resolveSlugToEvent(slug);

  if (!resolved.found) {
    return successResult({
      found: false,
      slug,
      hint: `Could not find any markets matching slug '${slug}'. The market may be closed/settled, or the slug may be incorrect. Try search_markets({ query: "${slug}" }) for a broader search.`,
      fetchedAt: new Date().toISOString(),
    });
  }

  const markets = resolved.markets.slice(0, 10).map(m => ({
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesPrice: m.yes_ask || m.last_price || 0,
    volume24h: m.volume_24h || 0,
  }));

  return successResult({
    found: true,
    slug,
    eventTicker: resolved.eventTicker,
    seriesTicker: resolved.seriesTicker,
    title: resolved.title,
    markets,
    url: `https://kalshi.com/markets/${resolved.seriesTicker}`,
    hint: `Found! Use get_event({ eventTicker: "${resolved.eventTicker}" }) for full details.`,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetEventBySlug(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  if (!slug) {
    return errorResult("slug is required");
  }

  const withNested = args?.withNestedMarkets !== false;
  const resolved = await resolveSlugToEvent(slug);

  if (!resolved.found || !resolved.eventTicker) {
    return errorResult(
      `Could not resolve slug '${slug}' to an event. ` +
      `Try using search_markets({ query: "${slug}" }) to find matching markets.`
    );
  }

  // Fetch the full event details
  const response = await fetchKalshi(
    `/events/${resolved.eventTicker}?with_nested_markets=${withNested}`
  ) as { event: KalshiEvent };
  const event = response.event;

  const markets = (event.markets || []).map(m => ({
    ticker: m.ticker,
    title: m.title || m.yes_sub_title || m.ticker,
    yesPrice: m.yes_ask || m.last_price || 0,
    noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
    volume: m.volume || 0,
    volume24h: m.volume_24h || 0,
    liquidity: m.liquidity || 0,
    status: m.status || "open",
    url: `https://kalshi.com/markets/${resolved.seriesTicker}`,
    rules: m.rules_primary || "", // Resolution rules for cross-platform comparison
    rulesDetailed: m.rules_secondary || "", // Detailed rules with edge cases
    canCloseEarly: m.can_close_early || false,
    earlyCloseCondition: m.early_close_condition || ""
  }));

  const slugResult: Record<string, unknown> = {
    event: {
      eventTicker: event.event_ticker,
      seriesTicker: resolved.seriesTicker,
      title: event.title || event.event_ticker,
      category: event.category || "Unknown",
      status: event.status || "open",
    },
    markets,
    resolvedFrom: `slug:${slug}`,
    fetchedAt: new Date().toISOString(),
  };
  const slugFanoutHint = buildEventFanoutHint({
    eventTicker: event.event_ticker,
    markets,
  });
  if (slugFanoutHint) {
    slugResult.fanoutHint = slugFanoutHint;
  }
  return successResult(slugResult);
}

async function handleGetMarket(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  // Helper to format market result
  const formatMarketResult = (m: KalshiMarket, resolvedFrom?: string) => {
    const result: Record<string, unknown> = {
      market: {
        ticker: m.ticker,
        eventTicker: m.event_ticker,
        seriesTicker: getSeriesTicker(m.event_ticker),
        title: m.title || m.yes_sub_title || m.ticker,
        subtitle: m.subtitle || m.no_sub_title || "",
        yesPrice: m.yes_ask || m.last_price || 0,
        noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
        yesBid: m.yes_bid || 0,
        yesAsk: m.yes_ask || 0,
        lastPrice: m.last_price || 0,
        volume: m.volume || 0,
        volume24h: m.volume_24h || 0,
        openInterest: m.open_interest || 0,
        liquidity: m.liquidity || 0,
        status: m.status || "open",
        closeTime: m.close_time || "",
        category: m.category || "Unknown",
        rules: m.rules_primary || "",
        rulesDetailed: m.rules_secondary || "", // Full legal detail with edge cases
        canCloseEarly: m.can_close_early || false,
        earlyCloseCondition: m.early_close_condition || "",
        url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      },
      fetchedAt: new Date().toISOString(),
    };
    if (resolvedFrom) {
      result.resolvedFrom = resolvedFrom;
    }
    // Ranking / sibling-discovery hint: when a buyer asks to "find trading
    // opportunities" or "rank sub-legs" on a single market ticker that belongs
    // to a multi-leg event, or when the returned market is already
    // resolved/finalized (no further EV on it), point the planner at
    // find_trading_opportunities(eventTicker=...) so it can enumerate and
    // rank peer sub-legs instead of synthesising a one-market refusal.
    const status = String(m.status || "open").toLowerCase();
    const isResolved = status === "finalized" || status === "settled" || status === "closed";
    const parentEvent = m.event_ticker;
    if (parentEvent) {
      result.rankingGuidance = {
        parentEventTicker: parentEvent,
        note: isResolved
          ? `This market is ${status}. To rank peer sub-legs in the parent event, call find_trading_opportunities with eventTicker="${parentEvent}" (or get_event with withNestedMarkets:true).`
          : `For "find trading opportunities", "rank sub-legs", "rank by EV", or peer-comparison prompts across this event, call find_trading_opportunities with eventTicker="${parentEvent}" to get all sibling sub-markets ranked. Do NOT stop at this single market.`,
        suggestedNextCall: {
          toolName: "find_trading_opportunities",
          suggestedArgs: { eventTicker: parentEvent },
        },
      };
    }
    return result;
  };

  // Strategy 1: Try exact ticker
  try {
    const response = await fetchKalshi(`/markets/${ticker}`) as { market: KalshiMarket };
    return successResult(formatMarketResult(response.market));
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('404'))) {
      throw error;
    }
  }

  // Strategy 1.5: Auto-resolve event-level tickers (e.g. "KXOAIANTH-40") that buyers/
  // agents sometimes pass to get_market. Without this, calls fall through to Strategy
  // 2's regex (which only strips -0-prefixed suffixes) and waste 2-4 follow-up calls
  // before eventually hitting resolve_slug. Returning the child market list + a
  // recoveryHints payload lets the iterative planner pick the correct per-candidate
  // ticker on its next step.
  if (isEventLevelTicker(ticker)) {
    const eventResolution = await resolveEventTickerToChildren(ticker);
    if (eventResolution?.found && eventResolution.childMarkets.length > 0) {
      const childMarkets = eventResolution.childMarkets;
      const topChildren = [...childMarkets]
        .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
        .slice(0, 10);

      const payload = {
        kind: "event_ticker_not_market" as const,
        eventTicker: ticker,
        eventTitle: eventResolution.eventTitle,
        seriesTicker: eventResolution.seriesTicker,
        resolvedFrom: `event:${ticker}`,
        childMarketCount: childMarkets.length,
        childMarkets,
        recoveryHints: {
          reason: `"${ticker}" is an EVENT ticker, not a MARKET ticker. Events have multiple sub-markets (one per candidate/outcome) and do not have their own yes/no price. Use one of the child tickers listed in childMarkets for get_market, get_market_orderbook, or get_market_candlesticks.`,
          nextTools: [
            {
              toolName: "get_market",
              suggestedArgs: { ticker: topChildren[0]?.ticker ?? childMarkets[0].ticker },
              reason: `Call get_market per child ticker (highest 24h volume first: ${topChildren.slice(0, 3).map((c) => c.ticker).join(", ")}) to get yes/no prices and liquidity.`,
            },
            {
              toolName: "get_market_candlesticks",
              suggestedArgs: {
                ticker: topChildren[0]?.ticker ?? childMarkets[0].ticker,
                periodInterval: 1440,
                startTs: Math.floor(Date.now() / 1000) - 86400 * 30,
                endTs: Math.floor(Date.now() / 1000),
              },
              reason: "For 30-day trajectories / re-pricing / moving averages, call get_market_candlesticks per child ticker with periodInterval=1440 (daily).",
            },
            {
              toolName: "get_event",
              suggestedArgs: { eventTicker: ticker, withNestedMarkets: true },
              reason: "Call get_event for the full event view (all child markets with prices and volume in one response).",
            },
          ],
          escalationNote: `Fan out the per-child call over ALL ${childMarkets.length} childMarkets if the query asks for a ranking, comparison, arbitrage, or 'tightest spread / strongest aggression / highest volume' across the event.`,
          shouldSynthesizeRefusal: false as const,
        },
        fetchedAt: new Date().toISOString(),
      };

      return successResult(payload);
    }
  }

  // Strategy 2: Try removing common suffixes AI might have added (like -001, -01, etc.)
  const tickerWithoutSuffix = ticker.replace(/-0+\d*$/, '');
  if (tickerWithoutSuffix !== ticker) {
    try {
      const response = await fetchKalshi(`/markets/${tickerWithoutSuffix}`) as { market: KalshiMarket };
      return successResult(formatMarketResult(response.market, `corrected:${ticker}->${tickerWithoutSuffix}`));
    } catch (e) {
      // Continue to next strategy
    }
  }

  // Strategy 3: Try as a slug (lowercase version)
  const slugVersion = ticker.toLowerCase();
  if (isSlug(slugVersion)) {
    const resolved = await resolveSlugToEvent(slugVersion);
    if (resolved.found && resolved.markets.length > 0) {
      const firstMarket = resolved.markets[0];
      try {
        const response = await fetchKalshi(`/markets/${firstMarket.ticker}`) as { market: KalshiMarket };
        return successResult(formatMarketResult(response.market, `slug:${slugVersion}->${firstMarket.ticker}`));
      } catch (e) {
        // Return basic info from resolved markets
        return successResult(formatMarketResult(firstMarket, `slug:${slugVersion}`));
      }
    }
  }

  // Strategy 4: Search for similar tickers
  try {
    const searchResponse = await fetchKalshi(`/markets?limit=100&status=open`) as { markets: KalshiMarket[] };
    const markets = searchResponse.markets || [];
    const tickerBase = ticker.replace(/-\d+$/, '').toLowerCase();
    
    const matching = markets.filter(m => 
      m.ticker.toLowerCase() === ticker.toLowerCase() ||
      m.ticker.toLowerCase().startsWith(tickerBase) ||
      getSeriesTicker(m.event_ticker) === tickerBase
    );

    if (matching.length > 0) {
      const bestMatch = matching[0];
      const response = await fetchKalshi(`/markets/${bestMatch.ticker}`) as { market: KalshiMarket };
      return successResult(formatMarketResult(response.market, `search:${ticker}->${bestMatch.ticker}`));
    }
  } catch (e) {
    // Fall through to error
  }

  // All strategies failed
  return errorResult(
    `Market '${ticker}' not found. ` +
    `Possible issues:\n` +
    `1. The ticker may have been incorrectly constructed (don't add suffixes like -001)\n` +
    `2. Use the exact 'ticker' value from get_event_by_slug or search_markets results\n` +
    `3. Try get_event_by_slug({ slug: "${ticker.toLowerCase()}" }) first to get the correct ticker`
  );
}

async function handleSearchMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const query = args?.query as string | undefined;
  const requestedCategory = args?.category as string | undefined;
  const category = normalizeKalshiCategoryName(requestedCategory) ?? requestedCategory;
  const status = normalizeRequestedKalshiStatus(args?.status as string | undefined);
  const limit = Math.min((args?.limit as number) || 20, 50);
  const maxSeriesScan = Math.min((args?.maxSeriesScan as number) || 600, 1200);

  let markets: KalshiMarket[] = [];
  let matchedSeries: string[] = [];

  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'rule', 'market', 'markets']);
  const lexicalAliases: Record<string, string[]> = {
    'trump': ['djt', 'donald'],
    'bitcoin': ['btc'],
    'ethereum': ['eth'],
    'scotus': ['supreme', 'court'],
    'supreme': ['scotus'],
    'court': ['scotus'],
    'temperature': ['temp'],
    'temperatures': ['temp', 'temperature'],
    'temp': ['temperature'],
    'highest': ['high'],
    'weather': ['climate'],
    'climate': ['weather'],
    'tariff': ['tariffs'],
    'tariffs': ['tariff'],
    'jobs': ['payrolls', 'employment'],
    'payrolls': ['jobs', 'employment'],
    'fomc': ['fed', 'federal', 'reserve'],
    'nyc': ['new', 'york'],
  };
  const tokenizeQueryWords = (value: string): string[] =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word =>
        word.length > 2 &&
        !stopWords.has(word) &&
        !LOW_SIGNAL_SEARCH_WORDS.has(word)
      );
  const expandQueryWords = (words: string[]): string[] => {
    const expandedWords = new Set(words);
    for (const word of words) {
      const aliases = lexicalAliases[word];
      if (!aliases) {
        continue;
      }
      for (const alias of aliases) {
        if (alias.length > 2 && !stopWords.has(alias)) {
          expandedWords.add(alias);
        }
      }
    }
    return [...expandedWords];
  };

  const queryLower = query?.toLowerCase() || '';

  // Parse query words
  let queryWords = query ? expandQueryWords(tokenizeQueryWords(query)) : [];
  if (queryLower.includes('new york city') || queryLower.includes('new york')) {
    queryWords = [...queryWords, 'nyc'];
  }
  if (/\b\d{2,3}f\b/.test(queryLower)) {
    queryWords = [...queryWords, 'temperature', 'temp', 'high'];
  }
  if (queryLower.includes('jobs report')) {
    queryWords = [...queryWords, 'payrolls', 'employment'];
  }
  // Preserve US jurisdiction signal. Tokenizer drops "U.S." / "US" (length <=2 after
  // punctuation stripping) which lets non-US elections (e.g. Turkish, UK) win ranking
  // on queries like "2028 U.S. Presidential Election". Re-inject strong US tokens.
  const intentRequiresUSJurisdiction =
    /\bu\.s\.|\busa\b|\bunited states\b|\bamericans?\b/.test(queryLower) ||
    (/\bpresident(?:ial)?\b/.test(queryLower) && /\bu\.?\s?s\.?\b/.test(queryLower));
  if (intentRequiresUSJurisdiction) {
    queryWords = [...queryWords, 'usa', 'america', 'american', 'united', 'states'];
  }
  queryWords = [...new Set(queryWords)];
  const intentRequiresWeather =
    category === "climate and weather" ||
    /\b(weather|climate|temperature|temp|hurricane|rain|snow|storm|heat)\b/.test(queryLower) ||
    /\b\d{2,3}f\b/.test(queryLower);
  const intentRequiresTariffs =
    /\b(tariff|tariffs|trade war|customs|import|china)\b/.test(queryLower);
  const intentRequiresJobs =
    /\b(jobs?|payrolls?|employment|unemployment|nfp)\b/.test(queryLower);
  const intentRequiresInflation =
    /\b(cpi|inflation|consumer price index|core cpi|pce)\b/.test(queryLower);
  const intentRequiresFedRates =
    /\b(fed|fomc|federal reserve)\b/.test(queryLower) &&
    /\b(rate|rates|cut|cuts|hike|hikes|funds|basis|bps|decision)\b/.test(queryLower);
  const matchesStrictIntent = (searchText: string): boolean => {
    if (
      intentRequiresWeather &&
      !/kxhigh|temperature|temp|weather|climate|hurricane|rain|snow|storm|heat|degree/.test(
        searchText
      )
    ) {
      return false;
    }
    if (
      intentRequiresTariffs &&
      !/\btariff|tariffs|china|trade|customs|import/.test(searchText)
    ) {
      return false;
    }
    if (
      intentRequiresJobs &&
      !/\bjob|jobs|payroll|payrolls|employment|unemployment|labor/.test(searchText) &&
      !searchText.includes("kxpayroll")
    ) {
      return false;
    }
    if (
      intentRequiresInflation &&
      !/\bcpi|inflation|consumer price index|core cpi|pce/.test(searchText) &&
      !searchText.includes("kxcpi")
    ) {
      return false;
    }
    if (intentRequiresUSJurisdiction) {
      const nonUSCountryPattern =
        /\b(turkey|turkish|uk|united kingdom|british|france|french|germany|german|japan|japanese|india|indian|mexico|mexican|brazil|brazilian|korea|korean|russia|russian|china|chinese|canada|canadian|argentina|argentine|pakistan|pakistani|taiwan|taiwanese|philippines|filipino|iran|iranian|israel|israeli|spain|spanish|italy|italian|poland|polish|venezuela|venezuelan|nigeria|nigerian|egypt|egyptian|saudi|australia|australian|south korea|north korea|indonesia|indonesian|thailand|thai|vietnam|vietnamese)\b/;
      const hasUSSignal =
        /\b(us|u\.s\.|usa|united states|america|american)\b/.test(searchText) ||
        /kx(pres|potus|djt|trump|gop|dem|senate|house|congress|biden|harris|vance|election)/.test(
          searchText
        );
      if (nonUSCountryPattern.test(searchText) && !hasUSSignal) {
        return false;
      }
    }
    if (intentRequiresFedRates) {
      if (!/\bfed|fomc|federal reserve/.test(searchText)) {
        return false;
      }
      if (
        !/\brate|rates|cut|cuts|hike|hikes|funds|basis|bps|decision/.test(searchText) &&
        !/kxfed|kxratecut|kxfomc|kxlargecut/.test(searchText)
      ) {
        return false;
      }
      if (
        /\bdissent|emergency meeting/.test(searchText) &&
        !/\brate|cut|hike|funds|decision/.test(searchText)
      ) {
        return false;
      }
    }
    return true;
  };
  const scoreQueryMatches = (searchText: string): number =>
    computeIntentMatchScore(searchText, queryWords);
  const explicitIdentifierTokens = query
    ? [...new Set((query.match(/\bkx[a-z0-9-]{5,}\b/gi) || []).map((token) => token.toUpperCase()))]
    : [];

  if (explicitIdentifierTokens.length > 0) {
    const exactMarkets = new Map<string, KalshiMarket>();
    const exactMatchLabels: string[] = [];
    const addExactMarket = (market: KalshiMarket | undefined, matchLabel: string) => {
      if (!market?.ticker) {
        return;
      }
      const explicitMatch =
        explicitIdentifierTokens.includes(market.ticker.toUpperCase()) ||
        explicitIdentifierTokens.includes((market.event_ticker || '').toUpperCase());
      const matchesStatus = matchesRequestedKalshiStatus(status, market.status) || explicitMatch;
      if (!matchesStatus) {
        return;
      }
      exactMarkets.set(market.ticker, market);
      exactMatchLabels.push(matchLabel);
    };

    for (const identifier of explicitIdentifierTokens.slice(0, 5)) {
      try {
        const directMarketResponse = (await fetchKalshi(
          `/markets/${identifier}`
        )) as { market?: KalshiMarket } | KalshiMarket;
        const directMarketRecord = directMarketResponse as { market?: KalshiMarket };
        const directMarket =
          directMarketRecord.market ?? (directMarketResponse as KalshiMarket);
        addExactMarket(directMarket, `${identifier} (exact_market)`);
        if (directMarket?.ticker) {
          continue;
        }
      } catch {
        // Fall through to event/series hydration.
      }

      try {
        const eventMarketsResponse = (await fetchKalshi(
          `/markets?event_ticker=${encodeURIComponent(identifier)}`
        )) as { markets?: KalshiMarket[] };
        if (Array.isArray(eventMarketsResponse.markets)) {
          for (const market of eventMarketsResponse.markets) {
            addExactMarket(market, `${identifier} (exact_event)`);
          }
          if (eventMarketsResponse.markets.length > 0) {
            continue;
          }
        }
      } catch {
        // Fall through to series hydration.
      }

      try {
        const seriesMarketsResponse = (await fetchKalshi(
          `/markets?series_ticker=${encodeURIComponent(identifier)}`
        )) as { markets?: KalshiMarket[] };
        if (Array.isArray(seriesMarketsResponse.markets)) {
          for (const market of seriesMarketsResponse.markets) {
            addExactMarket(market, `${identifier} (exact_series)`);
          }
        }
      } catch {
        // Ignore exact-series misses.
      }
    }

    if (exactMarkets.size > 0) {
      markets.push(...exactMarkets.values());
      matchedSeries = [...new Set([...matchedSeries, ...exactMatchLabels])];
    }
  }

  // STRATEGY 1: INTELLIGENT HIERARCHICAL SEARCH WITH DYNAMIC TAG MATCHING
  // Fetch Kalshi's actual categories/tags and match query words dynamically
  if (query && queryWords.length > 0) {
    try {
      // Step 1: Dynamically fetch Kalshi's categories and tags (cached in production)
      let tagsByCategory: Record<string, string[]> = {};
      try {
        const tagsResponse = await fetchKalshi('/search/tags_by_categories') as { tags_by_categories: Record<string, string[]> };
        tagsByCategory = tagsResponse.tags_by_categories || {};
      } catch {
        console.warn('[Kalshi Search] Could not fetch tags, using fallback');
      }
      
      // Step 2: Build reverse index: word fragments → { category, tag }
      // e.g., "scotus" → { category: "Politics", tag: "SCOTUS & courts" }
      const wordToTagMap: Map<string, { category: string; tag: string }> = new Map();
      
      // Safely iterate - Kalshi API sometimes returns null for some category tag lists
      const entries = Object.entries(tagsByCategory || {});
      for (let i = 0; i < entries.length; i++) {
        const [category, tags] = entries[i];
        // Guard against null/undefined/non-array tags
        if (tags === null || tags === undefined || !Array.isArray(tags)) {
          continue;
        }
        
        for (let j = 0; j < tags.length; j++) {
          const tag = tags[j];
          if (!tag || typeof tag !== 'string') continue;
          
          // Extract words from tag for matching
          const tagWords = tag.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
          for (const word of tagWords) {
            wordToTagMap.set(word, { category, tag });
          }
          // Also map the full tag (lowercased, cleaned)
          const cleanTag = tag.toLowerCase().replace(/[^a-z0-9]/g, '');
          wordToTagMap.set(cleanTag, { category, tag });
        }
      }
      
      // Step 4: Match query words to categories/tags and count matches per tag
      let detectedCategory = normalizeKalshiCategoryName(category);
      const tagMatchCounts: Map<string, { category: string; count: number }> = new Map();
      
      for (const word of queryWords) {
        const match = wordToTagMap.get(word);
        if (match) {
          if (!detectedCategory) {
            detectedCategory = normalizeKalshiCategoryName(match.category);
          }
          const existing = tagMatchCounts.get(match.tag);
          if (existing) {
            existing.count++;
          } else {
            tagMatchCounts.set(match.tag, { category: match.category, count: 1 });
          }
        }
      }
      
      // Get ALL matched tags, sorted by count (most specific first)
      const sortedTags = [...tagMatchCounts.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 3); // Take up to 3 most relevant tags
      
      console.log(`[Kalshi Search] Matched tags: ${sortedTags.map(([t, {count}]) => `${t}(${count})`).join(', ')}`);
      console.log(`[Kalshi Search] Detected category: ${detectedCategory}`);
      
      // Step 5: Fetch series from MULTIPLE tags to maximize coverage
      // Some markets may be tagged with different tags (e.g., SCOTUS vs Trump Agenda)
      const allSeriesMap = new Map<string, KalshiSeries>();
      
      // Fetch from each matched tag
      for (const [tag] of sortedTags) {
        let seriesEndpoint = `/series?limit=300`;
        if (detectedCategory) {
          seriesEndpoint += `&category=${encodeURIComponent(detectedCategory)}`;
        }
        seriesEndpoint += `&tags=${encodeURIComponent(tag)}`;
        
        console.log(`[Kalshi Search] Fetching series with tag: ${tag}`);
        const seriesResponse = await fetchKalshi(seriesEndpoint) as { series: KalshiSeries[] };
        for (const s of (seriesResponse.series || [])) {
          allSeriesMap.set(s.ticker, s);
        }
      }
      
      // If no tags matched, fall back to category-only or broad search
      if (sortedTags.length === 0) {
        let seriesEndpoint = `/series?limit=${maxSeriesScan}`;
        if (detectedCategory) {
          seriesEndpoint += `&category=${encodeURIComponent(detectedCategory)}`;
        }
        console.log(`[Kalshi Search] No tag matches, using endpoint: ${seriesEndpoint}`);
        const seriesResponse = await fetchKalshi(seriesEndpoint) as { series: KalshiSeries[] };
        for (const s of (seriesResponse.series || [])) {
          allSeriesMap.set(s.ticker, s);
        }
      }

      if (sortedTags.length > 0 && !category && allSeriesMap.size < maxSeriesScan) {
        // Kalshi's tags/categories are not fully consistent across related series
        // (for example, daily-high temperature markets can miss the same category/tag
        // metadata as intraday temperature markets). When the user did not explicitly
        // constrain category, supplement tag hits with a broader pool before scoring.
        try {
          const broadResponse = await fetchKalshi(`/series?limit=${maxSeriesScan}`) as { series: KalshiSeries[] };
          for (const s of (broadResponse.series || [])) {
            allSeriesMap.set(s.ticker, s);
          }
        } catch {
          // Keep the narrower tag-derived pool if the broad supplement fails.
        }
      }
      
      let allSeries = filterSeriesByRequestedCategory([...allSeriesMap.values()], category);
      console.log(`[Kalshi Search] Total unique series from tag searches: ${allSeries.length}`);
      
      // If still no results, fall back to broader search
      if (allSeries.length === 0) {
        console.log('[Kalshi Search] No results with filters, falling back to broader search');
        const fallbackResponse = await fetchKalshi(`/series?limit=${maxSeriesScan}`) as { series: KalshiSeries[] };
        allSeries = filterSeriesByRequestedCategory(fallbackResponse.series || [], category);
      }
      
      // Initial filter - any query word matches series title/ticker/tags
      // Also pre-score for better initial ranking
      const initialMatches: Array<{series: KalshiSeries; score: number}> = [];
      for (const s of allSeries) {
        const tagsText = Array.isArray(s.tags) ? s.tags.join(' ') : '';
        const searchText = ((s.title || '') + ' ' + s.ticker + ' ' + tagsText).toLowerCase();
        const matchScore = scoreQueryMatches(searchText);
        if (matchScore > 0 && hasCredibleIntentMatch(searchText, queryWords)) {
          initialMatches.push({ series: s, score: matchScore });
        }
      }
      
      // Sort by initial score
      initialMatches.sort((a, b) => b.score - a.score);
      
      // Take a broader top slice before event-title reranking so series with weak
      // ticker text but strong event titles still get a chance to surface.
      const topCandidateLimit = Math.min(Math.max(limit * 6, 30), 60);
      const topCandidates = initialMatches
        .slice(0, topCandidateLimit)
        .map(m => m.series);
      
      // Fetch event details for better titles and re-rank
      interface EnrichedSeries {
        series: KalshiSeries;
        eventTitle: string;
        score: number;
        hasMarkets: boolean;
      }
      
      const enrichedResults: EnrichedSeries[] = [];
      
      // Fetch markets for each series, then get event details for better titles
      // Series ticker often != event ticker, so we need to go: series -> markets -> event
      for (let i = 0; i < topCandidates.length; i += 5) {
        const batch = topCandidates.slice(i, i + 5);
        const eventPromises = batch.map(async (s) => {
          try {
            // First, fetch markets for this series to get event_ticker
            const marketsResponse = await fetchKalshi(`/markets?series_ticker=${s.ticker}&status=${status}&limit=1`) as { markets: KalshiMarket[] };
            const firstMarket = marketsResponse.markets?.[0];
            
            let eventTitle = s.title || '';
            
            if (firstMarket?.event_ticker) {
              // Now fetch the event using the correct event_ticker
              try {
                const eventResponse = await fetchKalshi(`/events/${firstMarket.event_ticker}`) as { event: KalshiEvent };
                eventTitle = eventResponse.event?.title || firstMarket.title || s.title || '';
              } catch {
                // Use market title as fallback
                eventTitle = firstMarket.title || s.title || '';
              }
            }
            
            // Score based on ALL text: series title + event title + ticker
            const fullText = ((s.title || '') + ' ' + eventTitle + ' ' + s.ticker).toLowerCase();
            const score = hasCredibleIntentMatch(fullText, queryWords)
              ? scoreQueryMatches(fullText)
              : 0;
            
            // Bonus for exact phrase matches
            const bonusScore = queryWords.length > 1 && fullText.includes(queryWords.join(' ')) ? 3 : 0;
            
            return { series: s, eventTitle, score: score + bonusScore, hasMarkets: !!firstMarket };
          } catch {
            // If all fetches fail, use series data only
            const fullText = ((s.title || '') + ' ' + s.ticker).toLowerCase();
            return {
              series: s,
              eventTitle: s.title || '',
              score: hasCredibleIntentMatch(fullText, queryWords)
                ? scoreQueryMatches(fullText)
                : 0,
              hasMarkets: false,
            };
          }
        });
        
        const results = await Promise.all(eventPromises);
        enrichedResults.push(...results);
      }
      
      // Filter to only series with active markets, then sort by score
      const withMarkets = enrichedResults.filter(r => r.hasMarkets);
      withMarkets.sort((a, b) => b.score - a.score);
      
      // Take top results
      const topResults = withMarkets.slice(0, 10);
      matchedSeries = topResults.map(r => `${r.series.ticker} (score:${r.score})`);
      
      for (const result of topResults) {
        try {
          const response = await fetchKalshi(`/markets?series_ticker=${result.series.ticker}&status=${status}`) as { markets: KalshiMarket[] };
          if (response.markets && response.markets.length > 0) {
            for (const m of response.markets) {
              if (!markets.find(existing => existing.ticker === m.ticker)) {
                // Enrich market with event title for better display
                if (!m.title || m.title.length < result.eventTitle.length) {
                  m.title = result.eventTitle;
                }
                markets.push(m);
              }
            }
          }
        } catch {
          // Continue with other series
        }
      }
    } catch (e) {
      console.warn("Series search failed:", e);
    }
  }

  // STRATEGY 2: Fallback - fetch from standard markets listing (for non-query or additional results)
  if (markets.length < limit) {
    const fetchLimit = query ? 200 : limit * 3;
    
    let endpoint = `/markets?limit=${fetchLimit}`;
    if (status !== "all") {
      endpoint += `&status=${status}`;
    }
    if (category) {
      endpoint += `&category=${encodeURIComponent(category)}`;
    }

    try {
      const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
      const listingMarkets = response.markets || [];
      
      for (const m of listingMarkets) {
        if (!markets.find(existing => existing.ticker === m.ticker)) {
          markets.push(m);
        }
      }
    } catch {
      // Continue with what we have
    }
  }

  // Filter by query if provided (for markets from fallback that may not match)
  if (query) {
    markets = markets.filter(m => {
      const searchText = ((m.title || '') + ' ' + (m.yes_sub_title || '') + ' ' + m.ticker + ' ' + m.event_ticker).toLowerCase();
      return hasCredibleIntentMatch(searchText, queryWords) && matchesStrictIntent(searchText);
    });
  }

  markets = filterMarketsByRequestedCategory(markets, requestedCategory);

  const timeSensitiveQuery =
    queryLower.includes('next') ||
    queryLower.includes('soon') ||
    queryLower.includes('this week');
  const scoreMarketResult = (market: KalshiMarket): number => {
    const searchText = [
      market.title || '',
      market.subtitle || '',
      market.yes_sub_title || '',
      market.ticker,
      market.event_ticker,
    ]
      .join(' ')
      .toLowerCase();
    let score = scoreQueryMatches(searchText);
    if (matchesRequestedKalshiCategory({
      requestedCategory: requestedCategory,
      recordCategory: market.category,
      text: searchText,
    })) {
      score += 2;
    }
    if (timeSensitiveQuery && market.close_time) {
      const closeTs = Date.parse(market.close_time);
      if (!Number.isNaN(closeTs) && closeTs > Date.now()) {
        const hoursUntilClose = (closeTs - Date.now()) / (1000 * 60 * 60);
        score += Math.max(0, 8 - hoursUntilClose / 48);
      }
    }
    score += Math.min((market.volume_24h || 0) / 5000, 2);
    return score;
  };
  markets.sort(
    (left, right) =>
      scoreMarketResult(right) - scoreMarketResult(left) ||
      (right.volume_24h || 0) - (left.volume_24h || 0) ||
      (right.liquidity || 0) - (left.liquidity || 0)
  );

  let results = markets.slice(0, limit).map(m => ({
    title: m.title || m.yes_sub_title || m.ticker,
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
    yesPrice: m.yes_ask || m.last_price || 0,
    volume24h: m.volume_24h || 0,
    category: m.category || "Unknown",
    status: m.status || "open",
    closeTime: m.close_time || "",
  }));

  const searchResolution =
    query && results.length > 0
      ? await resolveKalshiContributorSearch({
          rawRequest: query,
          intentQuery: query,
          traceLabel: "kalshi:search_markets",
          candidates: results.map((result, index) =>
            buildKalshiResultSearchCandidate({
              query,
              rank: index + 1,
              source: matchedSeries.length > 0 ? "series_search" : "market_listing",
              result,
            })
          ),
        })
      : null;

  if (searchResolution?.selectedCandidate?.rawIds?.ticker) {
    const selectedTicker = searchResolution.selectedCandidate.rawIds.ticker;
    results = [
      ...results.filter((result) => result.ticker === selectedTicker),
      ...results.filter((result) => result.ticker !== selectedTicker),
    ];
  }

  const selectedResult =
    searchResolution?.selectedCandidate?.rawIds?.ticker
      ? results.find(
          (result) =>
            result.ticker === searchResolution.selectedCandidate?.rawIds?.ticker
        ) || null
      : null;

  const selectedHint = selectedResult
    ? ` Best match: ${selectedResult.title} (${selectedResult.ticker}, status: ${selectedResult.status}).`
    : "";

  const selectedConfidence =
    (searchResolution as unknown as { confidence?: string } | null)?.confidence ?? null;
  const lowConfidence =
    selectedConfidence === "low" ||
    (results.length > 0 && !selectedResult && !!query);

  const recoveryHints = buildSearchRecoveryHints({
    query,
    category: requestedCategory,
    resultCount: results.length,
    lowConfidence,
    selectedTitle: selectedResult?.title ?? null,
  });

  // Build helpful hint
  const hint = results.length === 0 && query
    ? `⚠️ No Kalshi markets found for "${query}". DO NOT synthesize a refusal. Next: call one of recoveryHints.nextTools — e.g. resolve_slug / get_event_by_slug for a slug guess, or search_markets again with a single-keyword query and NO category filter.`
    : lowConfidence
      ? `⚠️ Low-confidence match${selectedHint ? ` (${selectedHint.trim()})` : ""}. Results may be semantically irrelevant — call recoveryHints.nextTools before answering.`
      : matchedSeries.length > 0
        ? `✅ Found ${results.length} markets via series search. Matched series: ${matchedSeries.slice(0, 5).join(', ')}.${selectedHint}`
        : `Found ${results.length} markets matching "${query || 'all'}".${selectedHint}`;

  const responseData: Record<string, unknown> = {
    results,
    count: results.length,
    matchedSeries: matchedSeries.slice(0, 10),
    searchMethod: matchedSeries.length > 0 ? "series_search" : "market_listing",
    searchBudget: {
      maxSeriesScan,
      topSeriesEvaluated: matchedSeries.length,
    },
    hint,
    fetchedAt: new Date().toISOString(),
  };

  if (recoveryHints) {
    responseData.recoveryHints = recoveryHints;
  }

  return successResult(
    searchResolution
      ? attachContributorSearchMetadata(responseData, searchResolution)
      : responseData
  );
}

async function handleGetMarketOrderbook(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  const depth = Math.min((args?.depth as number) || 10, 100);
  const preferFixedPoint = args?.preferFixedPoint !== false;
  const response = await fetchKalshi(`/markets/${ticker}/orderbook?depth=${depth}`) as KalshiOrderbook;
  const hasOrderbookFp = !!response.orderbook_fp;

  const normalizeQty = (qty: number | string): number => {
    if (typeof qty === "number") {
      return qty;
    }
    const parsed = Number.parseFloat(qty);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const selectedOrderbook =
    preferFixedPoint && response.orderbook_fp
      ? response.orderbook_fp
      : (response.orderbook || response.orderbook_fp || {});

  const yesBids = (selectedOrderbook.yes || [])
    .map(([price, qty]) => ({ price, quantity: normalizeQty(qty) }))
    .sort((a, b) => b.price - a.price);
  const yesAsks = (selectedOrderbook.no || [])
    .map(([price, qty]) => ({ price: 100 - price, quantity: normalizeQty(qty) }))
    .sort((a, b) => a.price - b.price);

  const bestBid = yesBids.length > 0 ? yesBids[0].price : 0;
  const bestAsk = yesAsks.length > 0 ? yesAsks[0].price : 100;
  const spread = bestAsk - bestBid;
  const midPrice = (bestBid + bestAsk) / 2;

  return successResult({
    ticker,
    bids: yesBids,
    asks: yesAsks,
    spread,
    midPrice,
    orderbookFpAvailable: hasOrderbookFp,
    quantityPrecision: preferFixedPoint && hasOrderbookFp ? "fixed_point" : "integer",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketTrades(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  const limit = Math.min((args?.limit as number) || 50, 1000);
  const minTs = args?.minTs as number | undefined;
  const maxTs = args?.maxTs as number | undefined;
  const cursor = args?.cursor as string | undefined;

  let endpoint = `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;
  if (minTs) endpoint += `&min_ts=${minTs}`;
  if (maxTs) endpoint += `&max_ts=${maxTs}`;
  if (cursor) endpoint += `&cursor=${encodeURIComponent(cursor)}`;

  const response = await fetchKalshi(endpoint) as { trades: KalshiTrade[]; cursor?: string; next_cursor?: string };
  const trades = (response.trades || []).map(t => ({
    tradeId: t.trade_id || "",
    timestamp:
      t.created_time ||
      (typeof t.timestamp === "string" ? t.timestamp : "") ||
      (typeof t.timestamp === "number" ? new Date(t.timestamp * 1000).toISOString() : "") ||
      (typeof t.created_ts === "number" ? new Date(t.created_ts * 1000).toISOString() : ""),
    price: t.yes_price ?? t.price ?? 0,
    count: t.count || 0,
    takerSide: t.taker_side || "unknown",
  }));

  const totalVolume = trades.reduce((sum, t) => sum + t.count, 0);
  const avgPrice = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.price, 0) / trades.length
    : 0;
  const nextCursor = response.next_cursor || response.cursor || "";

  return successResult({
    ticker,
    trades,
    summary: {
      totalTrades: trades.length,
      totalVolume,
      avgPrice: Number(avgPrice.toFixed(2)),
    },
    nextCursor,
    cursor: nextCursor,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketCandlesticks(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTicker = args?.seriesTicker as string;
  const ticker = args?.ticker as string;

  if (!ticker) {
    return errorResult("ticker is required");
  }

  const rawStartTs = (args?.startTs as number) || Math.floor(Date.now() / 1000) - 86400 * 7;
  const endTs = (args?.endTs as number) || Math.floor(Date.now() / 1000);
  const periodInterval = (args?.periodInterval as number) || 60;
  const includeLatestBeforeStart = args?.includeLatestBeforeStart === true;

  // Kalshi enforces a hard cap of 5000 candlesticks per request. periodInterval
  // is measured in minutes, so max window seconds = 5000 * periodInterval * 60.
  // When callers request periodInterval:1 over a multi-day window, the upstream
  // returns repeated 400 "max candlesticks: 5000" errors with no usable data.
  // Auto-clamp startTs forward so the window stays within the cap and add a
  // note on the response so the planner can retry with coarser periodInterval
  // if longer history is required.
  const MAX_CANDLES_PER_REQUEST = 5000;
  const maxWindowSeconds = MAX_CANDLES_PER_REQUEST * Math.max(periodInterval, 1) * 60;
  let startTs = rawStartTs;
  let windowAdjustedNote: string | undefined;
  if (endTs - startTs > maxWindowSeconds) {
    const originalStartTs = startTs;
    startTs = endTs - maxWindowSeconds;
    windowAdjustedNote =
      `Requested window of ${endTs - originalStartTs}s exceeded Kalshi's 5000-candle cap for periodInterval=${periodInterval}min. ` +
      `Auto-clamped startTs from ${originalStartTs} to ${startTs} (${maxWindowSeconds}s window). ` +
      `For longer history, re-call with a larger periodInterval (60 or 1440 minutes).`;
  }

  // Detect event-level tickers (e.g. "KXOAIANTH-40", "KXRAMPBREX-40") before issuing
  // the batch call. The upstream /markets/candlesticks endpoint silently returns an
  // empty markets array for event-level tickers (no error, ~124 bytes) which wastes a
  // tool call without giving the iterative planner anything to pivot on. Auto-resolve
  // to child markets here so the planner can fan out per-child on the next step.
  if (isEventLevelTicker(ticker)) {
    const eventResolution = await resolveEventTickerToChildren(ticker);
    if (eventResolution?.found && eventResolution.childMarkets.length > 0) {
      const childMarkets = eventResolution.childMarkets;
      const topChildren = [...childMarkets]
        .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
        .slice(0, 10);
      const primaryChild = topChildren[0]?.ticker ?? childMarkets[0].ticker;

      return successResult({
        kind: "event_ticker_not_market",
        requestedTicker: ticker,
        eventTitle: eventResolution.eventTitle,
        seriesTicker: eventResolution.seriesTicker,
        resolvedFrom: `event:${ticker}`,
        childMarketCount: childMarkets.length,
        childMarkets,
        candlesticks: [],
        recoveryHints: {
          reason: `"${ticker}" is an EVENT ticker, not a MARKET ticker. get_market_candlesticks returns one time-series per child market, not per event. Call this tool again with a child ticker from childMarkets.`,
          nextTools: [
            {
              toolName: "get_market_candlesticks",
              suggestedArgs: {
                ticker: primaryChild,
                periodInterval,
                startTs,
                endTs,
              },
              reason: `Retry with the highest-24h-volume child ticker first (${topChildren.slice(0, 3).map((c) => c.ticker).join(", ")}). Fan out over additional children if the query needs per-candidate comparison.`,
            },
            {
              toolName: "get_event",
              suggestedArgs: { eventTicker: ticker, withNestedMarkets: true },
              reason: "Full event snapshot with all child markets (yes/no prices, volume) in a single call.",
            },
          ],
          escalationNote: `Fan out per-child candlesticks over ALL ${childMarkets.length} childMarkets for event-level trajectory / re-pricing / moving-average analyses.`,
          shouldSynthesizeRefusal: false as const,
        },
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  const baseBatchEndpoint = `/markets/candlesticks?market_tickers=${encodeURIComponent(
    ticker
  )}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;
  const batchEndpoint = includeLatestBeforeStart
    ? `${baseBatchEndpoint}&include_latest_before_start=true`
    : baseBatchEndpoint;

  const normalizeCandleMetric = (value: unknown): Record<string, unknown> | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "number") {
      return { close: value };
    }
    if (typeof value !== "object") {
      return null;
    }
    const raw = value as Record<string, unknown>;
    const pick = (key: string) => raw[key] ?? null;
    return {
      open: pick("open"),
      high: pick("high"),
      low: pick("low"),
      close: pick("close"),
      min: pick("min"),
      max: pick("max"),
      mean: pick("mean"),
      previous: pick("previous"),
      open_dollars: pick("open_dollars"),
      high_dollars: pick("high_dollars"),
      low_dollars: pick("low_dollars"),
      close_dollars: pick("close_dollars"),
      min_dollars: pick("min_dollars"),
      max_dollars: pick("max_dollars"),
      mean_dollars: pick("mean_dollars"),
      previous_dollars: pick("previous_dollars"),
    };
  };

  try {
    const response = await fetchKalshi(batchEndpoint) as {
      markets?: Array<{
        market_ticker: string;
        candlesticks?: Array<{
          end_period_ts: number;
          yes_bid?: unknown;
          yes_ask?: unknown;
          price?: unknown;
          volume?: number;
          open_interest?: number;
        }>;
      }>;
    };

    const marketData =
      response.markets?.find((m) => m.market_ticker === ticker) || response.markets?.[0];
    const candlesticks = (marketData?.candlesticks || []).map((c) => ({
      endPeriodTs: c.end_period_ts,
      yesBid: normalizeCandleMetric(c.yes_bid),
      yesAsk: normalizeCandleMetric(c.yes_ask),
      price: normalizeCandleMetric(c.price),
      volume: c.volume ?? 0,
      openInterest: c.open_interest ?? 0,
    }));

    const baseResult: Record<string, unknown> = {
      ticker,
      candlesticks,
      sourceEndpoint: "/markets/candlesticks",
      startTs,
      endTs,
      periodInterval,
      windowAdjusted: Boolean(windowAdjustedNote),
      ...(windowAdjustedNote ? { windowAdjustedNote } : {}),
      fetchedAt: new Date().toISOString(),
    };

    // Empty-candlestick recovery: when a market returns no candles, the planner
    // tends to retry 2-3 alternate periodInterval values (1m / 60m / 1d) before
    // giving up — each retry is wasted budget because the upstream data source
    // is empty for the market, not the interval. Fetch the market snapshot once
    // so we can tell the planner WHY it's empty and steer to a pivot instead of
    // an interval retry.
    if (candlesticks.length === 0) {
      try {
        const mktResp = (await fetchKalshi(`/markets/${ticker}`)) as {
          market?: KalshiMarket;
        };
        const m = mktResp?.market;
        if (m) {
          const parentEvent =
            typeof m.event_ticker === "string" && m.event_ticker.length > 0
              ? m.event_ticker
              : null;
          const volume24h = m.volume_24h ?? 0;
          const volumeTotal = m.volume ?? 0;
          const status = m.status || "open";
          const zeroVolume = volume24h === 0 && volumeTotal === 0;
          const finalized = status === "finalized" || status === "settled";
          const likelyIlliquidOrDead = zeroVolume || finalized;

          const nextTools: RecoveryHintTool[] = [];
          if (parentEvent) {
            nextTools.push({
              toolName: "find_trading_opportunities",
              suggestedArgs: { eventTicker: parentEvent, limit: 10 },
              reason: `Pivot from this quiet/${finalized ? "finalized" : "illiquid"} leg to ranked siblings in event ${parentEvent} — find_trading_opportunities surfaces liquid sub-legs with EV ranking instead of another empty candle call.`,
            });
            nextTools.push({
              toolName: "get_event",
              suggestedArgs: { eventTicker: parentEvent, withNestedMarkets: true },
              reason: `Inspect sibling sub-markets in ${parentEvent} with volume / yes_ask / open_interest so a different leg can be picked for the time-series question.`,
            });
          }

          baseResult.recoveryHints = {
            reason: likelyIlliquidOrDead
              ? `candlesticks is empty because this market has ${zeroVolume ? "0 volume" : `status=${status}`} over the requested window, NOT because the periodInterval is wrong. Do NOT retry with a different periodInterval (1m/60m/1d) — every interval will return empty.`
              : `candlesticks is empty for the requested window. Retrying with a different periodInterval is unlikely to help; widen the window via startTs, or pivot to the parent event.`,
            snapshot: {
              status,
              volume24h,
              volumeTotal,
              openInterest: m.open_interest ?? 0,
              eventTicker: parentEvent,
              liquidity: m.liquidity ?? 0,
            },
            nextTools,
            pivotGuidance: parentEvent
              ? `For "give me the price/volume/candles for <ticker>" prompts where the leg is empty, the buyer-useful answer is: (1) honestly report the 0-volume/finalized snapshot, then (2) call find_trading_opportunities(eventTicker="${parentEvent}") to surface tradable siblings in the same event. Do that in ONE follow-up tool call — do not loop over periodInterval values.`
              : `No parent event_ticker available on this market; widen startTs (older history) once, then stop.`,
            doNotRetry: [
              { toolName: "get_market_candlesticks", reason: "alternate periodInterval values will return the same empty result for a 0-volume leg" },
            ],
            shouldSynthesizeRefusal: false as const,
          };
        }
      } catch {
        // Best effort; if the market snapshot fetch fails, fall through with the
        // bare empty-candles response (planner still gets candlesticks:[] signal).
      }
    }

    return successResult(baseResult);
  } catch (batchError) {
    if (!seriesTicker) {
      throw batchError;
    }

    // Legacy fallback for older environments where series-based endpoint is available.
    const legacyEndpoint = `/series/${encodeURIComponent(
      seriesTicker
    )}/markets/${encodeURIComponent(
      ticker
    )}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}${
      includeLatestBeforeStart ? "&include_latest_before_start=true" : ""
    }`;

    const legacyResponse = await fetchKalshi(legacyEndpoint) as {
      candlesticks?: Array<{
        end_period_ts: number;
        yes_bid?: unknown;
        yes_ask?: unknown;
        price?: unknown;
        volume?: number;
        open_interest?: number;
      }>;
    };

    const candlesticks = (legacyResponse.candlesticks || []).map((c) => ({
      endPeriodTs: c.end_period_ts,
      yesBid: normalizeCandleMetric(c.yes_bid),
      yesAsk: normalizeCandleMetric(c.yes_ask),
      price: normalizeCandleMetric(c.price),
      volume: c.volume ?? 0,
      openInterest: c.open_interest ?? 0,
    }));

    return successResult({
      ticker,
      candlesticks,
      sourceEndpoint: "/series/{series_ticker}/markets/{ticker}/candlesticks",
      fetchedAt: new Date().toISOString(),
    });
  }
}

async function handleGetEventCandlesticks(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTicker = args?.seriesTicker as string;
  const eventTicker = args?.eventTicker as string;
  if (!seriesTicker || !eventTicker) {
    return errorResult("seriesTicker and eventTicker are required");
  }

  const startTs = (args?.startTs as number) || Math.floor(Date.now() / 1000) - 86400 * 7;
  const endTs = (args?.endTs as number) || Math.floor(Date.now() / 1000);
  const periodInterval = (args?.periodInterval as number) || 60;

  const endpoint = `/series/${encodeURIComponent(
    seriesTicker
  )}/events/${encodeURIComponent(
    eventTicker
  )}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;

  const response = await fetchKalshi(endpoint) as {
    market_tickers?: string[];
    market_candlesticks?: unknown[][];
    adjusted_end_ts?: number;
  };

  const marketTickers = response.market_tickers || [];
  const marketCandlesticks = response.market_candlesticks || [];

  const baseResult: Record<string, unknown> = {
    eventTicker,
    seriesTicker,
    marketTickers,
    marketCandlesticks,
    adjustedEndTs: response.adjusted_end_ts || endTs,
    fetchedAt: new Date().toISOString(),
  };

  // Event-level recovery: the upstream /events/.../candlesticks endpoint frequently
  // returns empty rows even for events with 50+ active sub-markets (the aggregate
  // series isn't tracked for sports/combo events until at least one leg trades).
  // Rather than returning a bare empty response (which forces the planner to guess
  // at a sub-market pivot or synthesize a thin "no data" answer), materialize the
  // fallback in-band: fetch the top-volume child market and inline its candles, so
  // the buyer still gets a real price history to work with.
  const hasAnyCandles = marketCandlesticks.some((row) =>
    Array.isArray(row) && row.length > 0
  );
  if (!hasAnyCandles) {
    try {
      const children = await resolveEventTickerToChildren(eventTicker);
      if (children?.found && children.childMarkets.length > 0) {
        const ranked = [...children.childMarkets].sort(
          (a, b) => (b.volume24h || 0) - (a.volume24h || 0),
        );
        const top = ranked.slice(0, 3);
        const primary = top[0];
        let fallbackCandles: Array<Record<string, unknown>> = [];
        if (primary) {
          try {
            const childBatch = (await fetchKalshi(
              `/markets/candlesticks?market_tickers=${encodeURIComponent(
                primary.ticker,
              )}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`,
            )) as {
              markets?: Array<{
                market_ticker: string;
                candlesticks?: Array<{
                  end_period_ts: number;
                  yes_bid?: unknown;
                  yes_ask?: unknown;
                  price?: unknown;
                  volume?: number;
                  open_interest?: number;
                }>;
              }>;
            };
            const primaryMarket =
              childBatch.markets?.find((m) => m.market_ticker === primary.ticker) ||
              childBatch.markets?.[0];
            fallbackCandles = (primaryMarket?.candlesticks || []).map((c) => ({
              endPeriodTs: c.end_period_ts,
              yesBidClose: typeof c.yes_bid === "object" && c.yes_bid
                ? (c.yes_bid as Record<string, unknown>).close ?? null
                : c.yes_bid ?? null,
              yesAskClose: typeof c.yes_ask === "object" && c.yes_ask
                ? (c.yes_ask as Record<string, unknown>).close ?? null
                : c.yes_ask ?? null,
              priceClose: typeof c.price === "object" && c.price
                ? (c.price as Record<string, unknown>).close ?? null
                : c.price ?? null,
              volume: c.volume ?? 0,
              openInterest: c.open_interest ?? 0,
            }));
          } catch {
            // best-effort
          }
        }

        baseResult.fallbackSubMarketCandles = primary
          ? {
              representativeTicker: primary.ticker,
              representativeTitle: primary.title,
              volume24h: primary.volume24h,
              yesPrice: primary.yesPrice,
              candlesticks: fallbackCandles,
              candlestickCount: fallbackCandles.length,
            }
          : null;
        baseResult.topSubMarketsByVolume = top.map((c) => ({
          ticker: c.ticker,
          title: c.title,
          volume24h: c.volume24h,
          yesPrice: c.yesPrice,
          status: c.status,
        }));
        baseResult.recoveryHints = {
          reason:
            `Event-level candlesticks for ${eventTicker} returned empty for the requested window (${periodInterval}-min bars). ` +
            `This is common for sports/combo events — Kalshi only maintains the aggregate series once legs start trading. ` +
            `To still answer the user, the contributor auto-fell-back to the highest-24h-volume sub-market ` +
            `(${primary ? primary.ticker : "none available"}), whose candlesticks are inlined in fallbackSubMarketCandles. ` +
            `Use those as a representative price trajectory, or fan out per-leg via get_market_candlesticks for the tickers in topSubMarketsByVolume.`,
          nextTools: top.map((c) => ({
            toolName: "get_market_candlesticks",
            suggestedArgs: {
              ticker: c.ticker,
              periodInterval,
              startTs,
              endTs,
            },
            reason: `Sub-market ${c.ticker} has volume_24h=${c.volume24h}; pull its candles for a real time-series.`,
          })),
          doNotRetry: [
            {
              toolName: "get_event_candlesticks",
              reason:
                "alternate periodInterval values on the event-level endpoint will return the same empty rows; the aggregate series isn't tracked",
            },
          ],
          shouldSynthesizeRefusal: false as const,
        };
      }
    } catch {
      // Best effort; fall through with bare empty response if resolution fails.
    }
  }

  return successResult(baseResult);
}

// ==================== DISCOVERY LAYER HANDLERS ====================

async function handleGetAllCategories(
  _args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const categoriesWarnings: string[] = [];
  const categories: Record<string, string[]> = {};
  try {
    const response = (await fetchKalshi("/search/tags_by_categories")) as {
      tags_by_categories?: Record<string, unknown>;
    };
    const sourceCategories = response.tags_by_categories || {};
    for (const [category, rawTags] of Object.entries(sourceCategories)) {
      const normalizedTags = Array.isArray(rawTags)
        ? rawTags.filter(
            (tag): tag is string =>
              typeof tag === "string" && tag.trim().length > 0
          )
        : [];
      categories[category] = normalizedTags;
    }
  } catch (error) {
    categoriesWarnings.push(
      `category tag taxonomy unavailable: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  const categoryList = Object.keys(categories);
  const totalTags = Object.values(categories).reduce(
    (sum, tags) => sum + tags.length,
    0
  );

  const seriesCountByCategory: Record<string, number> = Object.fromEntries(
    categoryList.map((category) => [category, 0])
  );
  const seriesCountWarnings: string[] = [];
  let totalSeries = 0;

  try {
    const seriesResponse = (await fetchKalshi("/series?limit=10000")) as {
      series?: KalshiSeries[];
    };
    const seriesSnapshot = Array.isArray(seriesResponse.series)
      ? seriesResponse.series
      : [];

    totalSeries = seriesSnapshot.length;
    for (const series of seriesSnapshot) {
      const normalizedCategory =
        typeof series.category === "string" && series.category.trim().length > 0
          ? series.category.trim()
          : "Unknown";
      if (!(normalizedCategory in categories)) {
        categories[normalizedCategory] = [];
      }
      if (!(normalizedCategory in seriesCountByCategory)) {
        seriesCountByCategory[normalizedCategory] = 0;
      }
      seriesCountByCategory[normalizedCategory] += 1;
    }
  } catch (error) {
    seriesCountWarnings.push(
      `series count snapshot unavailable: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  }

  return successResult({
    categories,
    categoryList,
    totalCategories: categoryList.length,
    totalTags,
    seriesCountByCategory,
    totalSeries,
    seriesCountSource: "series_snapshot:/series?limit=10000",
    seriesCountWarnings,
    categoriesWarnings,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetAllSeries(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const requestedCategory = args?.category as string | undefined;
  const category = normalizeKalshiCategoryName(requestedCategory) ?? requestedCategory;
  const tags = args?.tags as string | undefined;
  const limit = Math.min((args?.limit as number) || 100, 200);

  const shouldHydrateLocally = Boolean(category || tags);
  let endpoint = shouldHydrateLocally
    ? `/series?limit=10000`
    : `/series?limit=${limit}`;
  if (!shouldHydrateLocally && category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }
  if (!shouldHydrateLocally && tags) {
    endpoint += `&tags=${encodeURIComponent(tags)}`;
  }

  let response: { series?: KalshiSeries[] };
  let warning: string | undefined;
  try {
    response = (await fetchKalshi(endpoint)) as { series?: KalshiSeries[] };
  } catch (error) {
    warning = `series list unavailable for endpoint ${endpoint}: ${
      error instanceof Error ? error.message : "unknown error"
    }`;
    response = { series: [] };
  }

  let seriesSnapshot = response.series || [];
  if (requestedCategory) {
    seriesSnapshot = filterSeriesByRequestedCategory(seriesSnapshot, requestedCategory);
  }
  if (tags) {
    const wantedTags = tags
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0);
    if (wantedTags.length > 0) {
      seriesSnapshot = seriesSnapshot.filter((seriesEntry) => {
        const searchText = [
          seriesEntry.title || "",
          seriesEntry.ticker || "",
          Array.isArray(seriesEntry.tags) ? seriesEntry.tags.join(" ") : "",
        ]
          .join(" ")
          .toLowerCase();
        return wantedTags.every((tag) => searchText.includes(tag));
      });
    }
  }

  const series = seriesSnapshot.slice(0, limit).map((s) => ({
    ticker: s.ticker,
    title: s.title || s.ticker,
    category: s.category || "Unknown",
    tags: s.tags || [],
    frequency: s.frequency || "unknown",
  }));

  return successResult({
    series,
    totalCount: series.length,
    warning,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetSeries(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTickerRaw = args?.seriesTicker ?? args?.series_ticker;
  const seriesTicker =
    typeof seriesTickerRaw === "string" ? seriesTickerRaw.trim() : "";

  if (seriesTicker.length > 0) {
    try {
      const response = (await fetchKalshi(
        `/series/${encodeURIComponent(seriesTicker)}`
      )) as { series?: KalshiSeries };
      const seriesRecord = response.series;
      if (!seriesRecord) {
        return successResult({
          series: [],
          totalCount: 0,
          warning: `Series '${seriesTicker}' was not found.`,
          fetchedAt: new Date().toISOString(),
        });
      }

      return successResult({
        series: [
          {
            ticker: seriesRecord.ticker,
            title: seriesRecord.title || seriesRecord.ticker,
            category: seriesRecord.category || "Unknown",
            tags: seriesRecord.tags || [],
            frequency: seriesRecord.frequency || "unknown",
          },
        ],
        totalCount: 1,
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      return successResult({
        series: [],
        totalCount: 0,
        warning: `Series lookup failed for '${seriesTicker}': ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        fetchedAt: new Date().toISOString(),
      });
    }
  }

  return handleGetAllSeries(args);
}

async function handleBrowseCategory(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const requestedCategory = args?.category as string;
  if (!requestedCategory) {
    return errorResult("category is required");
  }

  const category =
    normalizeKalshiCategoryName(requestedCategory) ?? requestedCategory;
  const status = normalizeRequestedKalshiStatus(args?.status as string | undefined);
  const sortBy = (args?.sortBy as string) || "volume_24h";
  const limit = Math.min((args?.limit as number) || 50, 100);

  let endpoint = `/markets?limit=${limit}&category=${encodeURIComponent(category)}`;
  if (status !== "all") {
    endpoint += `&status=${status}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = filterMarketsByRequestedCategory(response.markets || [], requestedCategory).filter(
    (market) => matchesRequestedKalshiStatus(status, market.status)
  );

  // Sort
  markets.sort((a, b) => {
    switch (sortBy) {
      case "volume":
        return (b.volume || 0) - (a.volume || 0);
      case "liquidity":
        return (b.liquidity || 0) - (a.liquidity || 0);
      case "close_time":
        return new Date(a.close_time || "").getTime() - new Date(b.close_time || "").getTime();
      default:
        return (b.volume_24h || 0) - (a.volume_24h || 0);
    }
  });

  const marketsResult = markets.map(m => ({
    title: m.title || m.yes_sub_title || m.ticker,
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
    yesPrice: m.yes_ask || m.last_price || 0,
    noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
    volume24h: m.volume_24h || 0,
    liquidity: m.liquidity || 0,
    closeTime: m.close_time || "",
    status: m.status || "open",
  }));

  const recoveryHints = buildCategoryRecoveryHints({
    category: requestedCategory,
    status,
    resultCount: marketsResult.length,
  });

  const browseCategoryResponse: Record<string, unknown> = {
    category: requestedCategory,
    markets: marketsResult,
    totalCount: marketsResult.length,
    fetchedAt: new Date().toISOString(),
  };

  if (recoveryHints) {
    browseCategoryResponse.hint = `⚠️ browse_category returned 0 markets for ${JSON.stringify(requestedCategory)} (status=${status}). DO NOT conclude the category is empty — follow recoveryHints.nextTools (get_all_series + discover_trending_markets + get_markets with broader status).`;
    browseCategoryResponse.recoveryHints = recoveryHints;
  }

  return successResult(browseCategoryResponse);
}

async function handleBrowseSeries(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTicker = args?.seriesTicker as string;
  if (!seriesTicker) {
    return errorResult("seriesTicker is required");
  }

  const status = normalizeRequestedKalshiStatus(args?.status as string | undefined);
  const sortBy = args?.sortBy as string | undefined;
  const limit = Math.min((args?.limit as number) || 50, 100);

  // Get series info
  const seriesRes = await fetchKalshi(`/series/${encodeURIComponent(seriesTicker)}`) as { series: KalshiSeries };
  const series = seriesRes.series;

  // Get markets in this series. Auto-paginate so callers asking for a
  // series-level rollup ("how many active events" / "total 24h volume") get a
  // real aggregate instead of a single-page slice. Caller's `limit` becomes
  // per-page size; we cap absolute row count to stay safe.
  const perPageLimit = Math.min(limit, 100);
  const baseEndpoint = `/markets?limit=${perPageLimit}&series_ticker=${encodeURIComponent(seriesTicker)}${status !== "all" ? `&status=${status}` : ""}`;

  const MAX_AUTO_PAGES = 9;
  const MAX_AUTO_ROWS = 2000;
  let rawMarkets: KalshiMarket[] = [];
  let pageCursor = "";
  let pageCount = 0;
  let autoPaginated = false;
  while (true) {
    const url = pageCursor ? `${baseEndpoint}&cursor=${encodeURIComponent(pageCursor)}` : baseEndpoint;
    const resp = (await fetchKalshi(url)) as { markets: KalshiMarket[]; cursor?: string; next_cursor?: string };
    rawMarkets = rawMarkets.concat(resp.markets || []);
    pageCursor = resp.next_cursor || resp.cursor || "";
    pageCount += 1;
    if (pageCount > 1) autoPaginated = true;
    if (!pageCursor || pageCount >= MAX_AUTO_PAGES || rawMarkets.length >= MAX_AUTO_ROWS) break;
  }

  const response = { markets: rawMarkets };
  const markets = (response.markets || [])
    .filter((market) => matchesRequestedKalshiStatus(status, market.status))
    .map((m) => ({
      title: m.title || m.yes_sub_title || m.ticker,
      ticker: m.ticker,
      eventTicker: m.event_ticker,
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      yesPrice: m.yes_ask || m.last_price || 0,
      noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
      volume24h: m.volume_24h || 0,
      liquidity: m.liquidity || 0,
      closeTime: m.close_time || "",
      status: m.status || "open",
      category: m.category || "Unknown",
    }));

  if (sortBy === "volume_24h") {
    markets.sort((a, b) => b.volume24h - a.volume24h);
  } else if (sortBy === "liquidity") {
    markets.sort((a, b) => b.liquidity - a.liquidity);
  } else if (sortBy === "close_time") {
    markets.sort((a, b) => {
      const aTime = Date.parse(a.closeTime);
      const bTime = Date.parse(b.closeTime);
      if (!Number.isFinite(aTime) && !Number.isFinite(bTime)) {
        return 0;
      }
      if (!Number.isFinite(aTime)) {
        return 1;
      }
      if (!Number.isFinite(bTime)) {
        return -1;
      }
      return aTime - bTime;
    });
  }

  const seriesRecoveryHints = buildSeriesRecoveryHints({
    seriesTicker,
    status,
    resultCount: markets.length,
  });

  const totalVolume24h = markets.reduce((acc, m) => acc + (Number(m.volume24h) || 0), 0);
  const totalLiquidity = markets.reduce((acc, m) => acc + (Number(m.liquidity) || 0), 0);
  const uniqueEventTickers = new Set(markets.map((m) => m.eventTicker).filter(Boolean));
  const activeMarketCount = markets.filter((m) => m.status === "open" || m.status === "active").length;

  const browseSeriesResponse: Record<string, unknown> = {
    seriesTicker,
    seriesTitle: series?.title || seriesTicker,
    markets,
    totalCount: markets.length,
    autoPaginated,
    aggregate: {
      marketCount: markets.length,
      activeMarketCount,
      uniqueEventCount: uniqueEventTickers.size,
      totalVolume24h,
      totalLiquidity,
    },
    fetchedAt: new Date().toISOString(),
  };

  if (seriesRecoveryHints) {
    browseSeriesResponse.hint = `⚠️ browse_series returned 0 markets for ${JSON.stringify(seriesTicker)} (status=${status}). Follow recoveryHints.nextTools before concluding.`;
    browseSeriesResponse.recoveryHints = seriesRecoveryHints;
  }

  return successResult(browseSeriesResponse);
}

// ============================================================================
// EXPRESS SERVER WITH SECURITY MIDDLEWARE
// ============================================================================

const app = express();
app.use(express.json());

// Create security middleware
const verifyContextAuth = createContextMiddleware();
const disableContextAuth = process.env.DISABLE_CONTEXT_AUTH === "true";
// Testing-only toggle: set DISABLE_CONTEXT_AUTH=true on isolated test environments.
const mcpMiddlewares = disableContextAuth ? [] : [verifyContextAuth];

// Health check
app.get("/health", (_req: Request, res: Response) => {
  res.json({ 
    status: "ok", 
    server: "kalshi-intelligence", 
    version: "1.0.0",
    tools: TOOLS.length,
  });
});

// Session management
const transports: Map<string, StreamableHTTPServerTransport> = new Map();

// MCP endpoint with security middleware
app.post("/mcp", ...mcpMiddlewares, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId)!;
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => { transports.set(id, transport); },
    });
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Bad Request: No valid session" });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// Handle SSE for streaming
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "No transport found for session" });
    return;
  }
  await transport.handleRequest(req, res);
});

// Start server
const PORT = Number(process.env.PORT || 4007);
app.listen(PORT, () => {
  console.log(`🎯 Kalshi MCP server running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`🔌 MCP endpoint: http://localhost:${PORT}/mcp`);
  if (disableContextAuth) {
    console.log("⚠️  Context auth middleware is DISABLED (testing only). Re-enable for production.");
  }
  console.log(`\n📝 ${TOOLS.length} tools available:`);
  console.log("   Tier 1 (Intelligence): 7 tools");
  console.log("   Cross-platform: 1 tool");
  console.log("   Tier 2 (Raw Data): 11 tools (includes get_markets + event candlesticks)");
  console.log("   Discovery Layer: 5 tools");
});

