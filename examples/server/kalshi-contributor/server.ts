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

// ============================================================================
// API CONFIGURATION
// ============================================================================

const KALSHI_API_BASE = process.env.KALSHI_API_BASE_URL || "https://api.elections.kalshi.com";
const API_BASE = `${KALSHI_API_BASE}/trade-api/v2`;

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

RETURNS: Markets ranked by activity with:
- url: Direct Kalshi market link (ALWAYS use this, never construct URLs)
- ticker (use with get_market_orderbook, get_market_trades)
- event_ticker (use with get_event)
- Current prices and volumes
- category: The market's category

CROSS-PLATFORM COMPOSABILITY:
  Compare Kalshi predictions with:
  - Polymarket: Same event at different prices = arbitrage opportunity
  - Odds API: Sports predictions vs sportsbook odds
  - Use get_comparable_markets for standardized cross-platform format`,
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

Answers: "Can I get in/out of this position without moving the market?"

INPUT: market ticker from discover_trending_markets or search_markets

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
            buy100: { type: "object" },
            buy500: { type: "object" },
            buy1000: { type: "object" },
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
    description: `Check if a market is efficiently priced. Calculates the "vig" (YES + NO should = 100¢), identifies pricing inefficiencies.

For multi-outcome events, checks if all outcomes sum to 100%.

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
    description: `Find trading opportunities based on probability/strategy:

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

STRATEGIES:
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
        minLiquidity: {
          type: "number",
          description: "Minimum liquidity in USD (default: 1000)",
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
    description: `🎯 Simple tool to filter markets by win probability.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

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
              volume24h: { type: "number" },
              category: { type: "string" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            probabilityRange: { type: "string" },
            marketsFound: { type: "number" },
            avgReturn: { type: "string" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["markets", "summary"],
    },
  },

  {
    name: "analyze_market_sentiment",
    description: `Analyze market sentiment by looking at price history and volume trends.

Answers: "Is this market trending up or down? What's the conviction?"

INPUT: market ticker

RETURNS:
- Price trend (24h, 7d)
- Volume trend
- Momentum indicators
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
        sentiment: {
          type: "string",
          enum: ["strongly_bullish", "bullish", "neutral", "bearish", "strongly_bearish"],
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "sentiment", "confidence"],
    },
  },

  // ==================== CROSS-PLATFORM INTEROPERABILITY ====================

  {
    name: "get_comparable_markets",
    description: `📊 CROSS-PLATFORM: Get Kalshi markets in a STANDARDIZED format for comparing with other platforms (Polymarket, Odds API).

Returns markets with normalized probabilities (0-1 scale) and standardized fields that can be 
directly compared across prediction markets and sportsbooks.

🕐 LIVE vs HISTORICAL DATA:
  - DEFAULT (includeResolved: false): Returns only ACTIVE markets currently trading
    → Use for: Current arbitrage, live comparisons, real-time analysis, trading decisions
  - HISTORICAL (includeResolved: true): Returns SETTLED/RESOLVED markets  
    → Use for: Past event analysis, accuracy studies, "what were the odds on X?", backtesting

WHEN TO USE includeResolved: true:
  - "What were Kalshi's odds on Trump winning in 2024?"
  - "How accurate were Kalshi predictions for Fed rate decisions?"
  - "Compare historical probability gaps between platforms"
  - Any question about PAST events that have already resolved

⚠️ IMPORTANT: Kalshi currently has NO active sports markets. For sports comparisons, use Polymarket + Odds API instead.

USE THIS TOOL when you need to:
- Find arbitrage opportunities between Kalshi and Polymarket (POLITICS, ECONOMICS, ENTERTAINMENT)
- Compare probability assessments across markets
- Build cross-platform market analysis
- Analyze historical prediction accuracy (with includeResolved: true)

⚠️ CROSS-PLATFORM MATCHING GUIDE:
Markets on different platforms have DIFFERENT titles for the SAME event:
  - Kalshi: "Will Trump win 2028 election?"
  - Polymarket: "Trump wins 2028 Presidential Election"

DO NOT use exact title matching! Instead, use FUZZY MATCHING with these fields:
  1. keywords: Check if 50%+ of keywords overlap between platforms
  2. teams: For sports, check if the same teams appear (N/A for Kalshi - no sports)
  3. eventCategory: Filter to same category first (politics, economics, etc.)
  4. normalizedProbability: Once matched, compare these directly (all 0-1 scale)

MATCHING EXAMPLE:
  Kalshi keywords: ["trump", "win", "2028", "election"]
  Polymarket keywords: ["trump", "wins", "2028", "presidential", "election"]
  → Overlap: ["trump", "2028", "election"] = 60% match → SAME MARKET!
  → Compare: Kalshi 0.38 vs Polymarket 0.42 = 4% gap

PLATFORM COMPATIBILITY:
  - Politics/Economics: Use Kalshi + Polymarket
  - Sports: ❌ Kalshi has NO sports - use Polymarket + Odds API instead`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category: Sports, Politics, Economics, Financials, Entertainment, Science",
        },
        keywords: {
          type: "string",
          description: "Keywords to search for (uses OR matching for multi-word queries)",
        },
        minVolume: {
          type: "number",
          description: "Minimum 24h volume in USD (default: 100)",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 30, max: 100)",
        },
        includeResolved: {
          type: "boolean",
          description: "Include resolved/closed markets (default: false). Set to true to see historical markets that have already concluded.",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        platform: { type: "string", const: "kalshi" },
        markets: {
          type: "array",
          description: "Markets in standardized format. Use keywords for FUZZY MATCHING with Polymarket - NOT title matching! Note: Kalshi has no sports markets.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Human-readable title. DO NOT use for cross-platform matching (titles differ by platform)" },
              description: { type: "string" },
              eventCategory: { type: "string", description: "Standardized category (politics, economics, etc). Filter by this FIRST when matching. Note: 'sports' will be empty." },
              keywords: { 
                type: "array", 
                items: { type: "string" }, 
                description: "🔑 USE FOR MATCHING: Check if 50%+ keywords overlap with Polymarket's keywords array" 
              },
              teams: { 
                type: "array", 
                items: { type: "string" }, 
                description: "Team names (always empty - Kalshi has no sports markets)" 
              },
              outcomes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    normalizedProbability: { type: "number", description: "🎯 COMPARE THIS: 0-1 scale, directly comparable with Polymarket" },
                    rawPrice: { type: "number", description: "Original Kalshi price (cents 0-100)" },
                  },
                },
              },
              volume24h: { type: "number" },
              liquidity: { type: "number" },
              closeTime: { type: "string", description: "Resolution date - can help confirm same event across platforms" },
              url: { type: "string" },
              platformMarketId: { type: "string", description: "ticker for Kalshi" },
            },
          },
        },
        totalCount: { type: "number" },
        hint: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["platform", "markets", "fetchedAt"],
    },
  },

  // ==================== TIER 2: RAW DATA TOOLS ====================

  {
    name: "get_events",
    description: `Get list of events from Kalshi. Events contain one or more markets.

By default returns OPEN events. Use status='settled' for resolved events.

Each event has:
- event_ticker (use with get_event for details)
- Multiple markets within it`,
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
        limit: {
          type: "number",
          description: "Number of results (default: 50, max: 200)",
        },
        cursor: {
          type: "string",
          description: "Pagination cursor",
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
            },
          },
        },
        cursor: { type: "string" },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["events", "count"],
    },
  },

  {
    name: "get_event",
    description: `Get detailed information about a specific event including all its markets.

INPUT: event_ticker from get_events or discover_trending_markets

RETURNS: Event metadata and array of markets with tickers for further analysis.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        eventTicker: {
          type: "string",
          description: "Event ticker (e.g., 'PRES-2024')",
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
          properties: {
            eventTicker: { type: "string" },
            title: { type: "string" },
            category: { type: "string" },
            status: { type: "string" },
          },
        },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ticker: { type: "string" },
              title: { type: "string" },
              yesPrice: { type: "number" },
              noPrice: { type: "number" },
              volume: { type: "number" },
              status: { type: "string" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["event"],
    },
  },

  {
    name: "get_market",
    description: `Get detailed information about a specific market.

INPUT: market ticker from discover_trending_markets or search_markets

RETURNS: Full market details including prices, volumes, rules.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        ticker: {
          type: "string",
          description: "Market ticker",
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
            rules: { type: "string" },
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
    description: `Search for Kalshi markets by keyword or filters.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. Each result includes a real 'url' field - use ONLY those URLs.

🕐 LIVE vs HISTORICAL MARKETS:
  - status: 'open' (default) → Active markets currently trading. Use for current analysis.
  - status: 'settled' → Resolved/concluded markets. Use for historical questions like:
    → "What were Kalshi's odds on the 2024 election?"
    → "How accurate were Kalshi predictions for past Fed decisions?"
  - status: 'all' → Both active and historical markets.

RETURNS: Matching markets with tickers and direct URLs for further analysis.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (searches titles)",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "settled", "all"],
          description: "Filter by status: 'open' (default) = active/trading, 'settled' = resolved/historical, 'all' = both. Use 'settled' for past event questions.",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 20)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              ticker: { type: "string" },
              eventTicker: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Kalshi URL - always use this, never construct URLs" },
              yesPrice: { type: "number" },
              volume24h: { type: "number" },
              category: { type: "string" },
              status: { type: "string" },
              closeTime: { type: "string" },
            },
          },
        },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["results", "count"],
    },
  },

  {
    name: "get_market_orderbook",
    description: `Get the orderbook for a specific market. Shows bid/ask prices and quantities.

INPUT: market ticker

RETURNS: Level 2 orderbook with bids and asks.`,
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
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "trades"],
    },
  },

  {
    name: "get_market_candlesticks",
    description: `Get historical OHLC candlestick data for a market.

INPUT: market ticker, series ticker

RETURNS: Array of candlesticks with open, high, low, close, volume.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description: "Series ticker containing the market",
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
      },
      required: ["seriesTicker", "ticker"],
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
              timestamp: { type: "number" },
              open: { type: "number" },
              high: { type: "number" },
              low: { type: "number" },
              close: { type: "number" },
              volume: { type: "number" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["ticker", "candlesticks"],
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
        fetchedAt: { type: "string" },
      },
      required: ["categories", "categoryList"],
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
        fetchedAt: { type: "string" },
      },
      required: ["series"],
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

INPUT: series_ticker from get_all_series

RETURNS: All events and markets in the series with direct URLs.

Example: browse_series({ seriesTicker: "KXHIGHNY" }) → all NYC high temp events`,
    inputSchema: {
      type: "object" as const,
      properties: {
        seriesTicker: {
          type: "string",
          description: "Series ticker from get_all_series",
        },
        status: {
          type: "string",
          enum: ["open", "closed", "settled", "all"],
          description: "Filter by status (default: open)",
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
              volume24h: { type: "number" },
              closeTime: { type: "string" },
              status: { type: "string" },
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

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "kalshi-intelligence", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
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

        // Cross-Platform Interoperability
        case "get_comparable_markets":
          return await handleGetComparableMarkets(args);

        // Tier 2: Raw Data Tools
        case "get_events":
          return await handleGetEvents(args);
        case "get_event":
          return await handleGetEvent(args);
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

        // Discovery Layer Tools
        case "get_all_categories":
          return await handleGetAllCategories(args);
        case "get_all_series":
          return await handleGetAllSeries(args);
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

// ============================================================================
// API FETCH HELPERS
// ============================================================================

async function fetchKalshi(endpoint: string, timeoutMs = 15000): Promise<unknown> {
  const url = `${API_BASE}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kalshi API error (${response.status}): ${text.slice(0, 200)}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================================================
// URL HELPER
// ============================================================================

/**
 * Extracts the series ticker from an event_ticker by removing the numeric suffix.
 * Example: KXNEWPOPE-70 -> kxnewpope
 * This is needed because Kalshi URLs use the series ticker format:
 * https://kalshi.com/markets/{series_ticker}/{slug}
 */
function getSeriesTicker(eventTicker: string): string {
  // Remove -XX numeric suffix and convert to lowercase
  return eventTicker.replace(/-\d+$/, '').toLowerCase();
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
}

interface KalshiTrade {
  trade_id?: string;
  ticker?: string;
  yes_price?: number;
  no_price?: number;
  count?: number;
  taker_side?: string;
  created_time?: string;
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

  // Fetch more markets if filtering by category to ensure we have enough after filtering
  const fetchLimit = category ? limit * 3 : limit;
  let endpoint = `/markets?limit=${fetchLimit}&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = response.markets || [];

  // IMPROVED CATEGORY FILTERING: If category is specified, also filter by keywords
  // This handles cases where Kalshi's category filter doesn't work as expected
  if (category) {
    const categoryKeywords: Record<string, string[]> = {
      'Sports': ['nba', 'nfl', 'mlb', 'nhl', 'super bowl', 'championship', 'playoffs', 'football', 'basketball', 'baseball', 'hockey', 'soccer', 'tennis', 'golf', 'ufc', 'boxing', 'f1', 'nascar', 'olympics', 'world cup', 'finals', 'mvp', 'rookie', 'draft'],
      'Politics': ['election', 'president', 'senate', 'congress', 'vote', 'trump', 'biden', 'democrat', 'republican', 'governor', 'primary', 'nominee'],
      'Economics': ['gdp', 'inflation', 'fed', 'interest rate', 'recession', 'jobs', 'unemployment', 'cpi', 'economic'],
      'Financials': ['stock', 's&p', 'nasdaq', 'bitcoin', 'crypto', 'price', 'market'],
    };

    const keywords = categoryKeywords[category] || [];
    if (keywords.length > 0) {
      // Filter to only markets that match category keywords in title
      markets = markets.filter(m => {
        const title = ((m.title || '') + ' ' + (m.subtitle || '') + ' ' + (m.yes_sub_title || '')).toLowerCase();
        const matchesCategory = m.category?.toLowerCase() === category.toLowerCase();
        const matchesKeywords = keywords.some(kw => title.includes(kw));
        return matchesCategory || matchesKeywords;
      });
    }
  }

  // Sort by the requested metric
  const sorted = markets.sort((a, b) => {
    switch (sortBy) {
      case "volume":
        return (b.volume || 0) - (a.volume || 0);
      case "volume_24h":
        return (b.volume_24h || 0) - (a.volume_24h || 0);
      case "liquidity":
        return (b.liquidity || 0) - (a.liquidity || 0);
      case "open_interest":
        return (b.open_interest || 0) - (a.open_interest || 0);
      default:
        return (b.volume_24h || 0) - (a.volume_24h || 0);
    }
  });

  const trendingMarkets = sorted.map((m, idx) => ({
    rank: idx + 1,
    title: m.title || m.yes_sub_title || m.ticker,
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
    yesPrice: (m.yes_ask || m.last_price || 0),
    noPrice: (m.no_ask || (100 - (m.yes_ask || m.last_price || 50))),
    volume24h: m.volume_24h || 0,
    volume: m.volume || 0,
    openInterest: m.open_interest || 0,
    liquidity: m.liquidity || 0,
    category: m.category || "Unknown",
    closeTime: m.close_time || "",
    status: m.status || "open",
  }));

  const totalVolume = trendingMarkets.reduce((sum, m) => sum + m.volume24h, 0);
  const marketSummary = `Found ${trendingMarkets.length} active markets${category ? ` in ${category}` : ""}. Total 24h volume: $${totalVolume.toLocaleString()}`;

  return successResult({
    marketSummary,
    trendingMarkets,
    totalActive: markets.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeMarketLiquidity(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  // Fetch market and orderbook
  const [marketRes, orderbookRes] = await Promise.all([
    fetchKalshi(`/markets/${ticker}`) as Promise<{ market: KalshiMarket }>,
    fetchKalshi(`/markets/${ticker}/orderbook?depth=50`) as Promise<KalshiOrderbook>,
  ]);

  const market = marketRes.market;
  const orderbook = orderbookRes.orderbook || {};

  const yesBid = market.yes_bid || 0;
  const yesAsk = market.yes_ask || 0;
  const noBid = market.no_bid || 0;
  const noAsk = market.no_ask || 0;

  const yesBids = orderbook.yes || [];
  const yesAsks = orderbook.no || []; // In Kalshi, no side is the ask for yes

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
    let remaining = size;
    let totalCost = 0;
    let worstPrice = 0;

    for (const [price, qty] of orders) {
      const available = (price / 100) * qty;
      const fill = Math.min(remaining, available);
      totalCost += fill;
      remaining -= fill;
      worstPrice = price;
      if (remaining <= 0) break;
    }

    const avgPrice = size > 0 ? (totalCost / size) * 100 : 0;
    const slippage = isBuy ? avgPrice - yesAsk : yesBid - avgPrice;

    return {
      canFill: remaining <= 0,
      avgPrice: avgPrice.toFixed(1),
      worstPrice,
      slippagePercent: ((slippage / yesAsk) * 100).toFixed(2),
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

  const sumOfYesPrices = outcomes.reduce((sum, o) => sum + o.yesPrice, 0);
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
    ? `OPPORTUNITY: Sum of prices is ${sumOfYesPrices}¢ < 100¢. Buying all outcomes guarantees ${Math.abs(vig).toFixed(0)}¢ profit.`
    : vig > 5
    ? `HIGH VIG: Market has ${vig.toFixed(0)}¢ overround. Consider this when sizing positions.`
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
  const minLiquidity = (args?.minLiquidity as number) || 1000;
  const limit = Math.min((args?.limit as number) || 20, 50);

  let endpoint = `/markets?limit=100&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = response.markets || [];

  // Filter by liquidity
  markets = markets.filter(m => (m.liquidity || 0) >= minLiquidity);

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

  // Sort by volume and take top results
  markets.sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0));
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
      marketsScanned: response.markets?.length || 0,
      opportunitiesFound: opportunities.length,
      strategy,
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
  const limit = Math.min((args?.limit as number) || 10, 30);

  const ranges: Record<string, [number, number]> = {
    very_unlikely: [1, 15],
    unlikely: [15, 35],
    coinflip: [35, 65],
    likely: [65, 85],
    very_likely: [85, 95],
  };

  const [minPrice, maxPrice] = ranges[probability] || [0, 100];

  let endpoint = `/markets?limit=100&status=open`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = response.markets || [];

  // Filter by probability range
  markets = markets.filter(m => {
    const price = m.yes_ask || m.last_price || 50;
    return price >= minPrice && price <= maxPrice;
  });

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
      volume24h: m.volume_24h || 0,
      category: m.category || "Unknown",
    };
  });

  return successResult({
    markets: marketsResult,
    summary: {
      probabilityRange: `${minPrice}-${maxPrice}%`,
      marketsFound: markets.length,
      avgReturn: `${avgReturn.toFixed(0)}%`,
    },
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

  const marketRes = await fetchKalshi(`/markets/${ticker}`) as { market: KalshiMarket };
  const market = marketRes.market;

  const currentPrice = market.yes_ask || market.last_price || 50;
  const previousPrice = market.previous_price || currentPrice;
  const change24h = currentPrice - previousPrice;
  const changePercent = previousPrice > 0 ? ((change24h / previousPrice) * 100) : 0;

  const volume24h = market.volume_24h || 0;
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
    ? "Positive momentum - price is trending up"
    : sentiment.includes("bearish")
    ? "Negative momentum - price is trending down"
    : "Sideways movement - wait for clearer signal";

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
    sentiment,
    confidence,
    recommendation,
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

async function handleGetComparableMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string | undefined;
  const keywords = args?.keywords as string | undefined;
  const minVolume = (args?.minVolume as number) || 0; // Lower default to catch more markets
  const limit = Math.min((args?.limit as number) || 30, 100);
  const includeResolved = args?.includeResolved === true;

  // By default, only fetch active markets. Set includeResolved=true for historical data.
  const statusParam = includeResolved ? "settled" : "open";

  // Kalshi API category mapping (Kalshi uses different category names)
  const kalshiCategoryMap: Record<string, string> = {
    'sports': 'Sports',
    'politics': 'Politics',
    'business': 'Financials',
    'economics': 'Economics',
    'crypto': 'Crypto',
    'entertainment': 'Entertainment',
  };

  let markets: KalshiMarket[] = [];

  // If category is specified, use the events endpoint which has proper category filtering
  if (category) {
    const kalshiCategory = kalshiCategoryMap[category.toLowerCase()];
    if (kalshiCategory) {
      // Fetch events with the specified category
      const eventsResponse = await fetchKalshi(`/events?status=${statusParam}&limit=50`) as { events: KalshiEvent[] };
      const events = (eventsResponse.events || []).filter(e => 
        e.category?.toLowerCase() === kalshiCategory.toLowerCase()
      );
      
      // Get markets from each matching event
      for (const event of events.slice(0, 20)) { // Limit events to prevent too many API calls
        try {
          const eventDetail = await fetchKalshi(`/events/${event.event_ticker}`) as { event: KalshiEvent };
          if (eventDetail.event?.markets) {
            markets.push(...eventDetail.event.markets);
          }
        } catch (e) {
          // Skip events that fail to load
        }
      }
    }
  }
  
  // If no category or no markets found via events, fall back to markets endpoint
  // IMPORTANT: Fetch more markets to ensure we capture relevant ones (API doesn't filter well)
  if (markets.length === 0) {
    const fetchLimit = category ? 500 : limit * 5; // Fetch more when filtering
    const response = await fetchKalshi(`/markets?limit=${fetchLimit}&status=${statusParam}`) as { markets: KalshiMarket[] };
    markets = response.markets || [];
  }

  // Category keywords for additional filtering and categorization
  const categoryKeywords: Record<string, string[]> = {
    'sports': ['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'ufc', 'mma', 'boxing', 'f1', 'nascar', 'olympics', 'world cup', 'super bowl', 'championship', 'playoffs', 'finals', 'lebron', 'stanley cup', 'mvp', 'draft', 'sonics'],
    'politics': ['election', 'president', 'senate', 'congress', 'vote', 'trump', 'biden', 'democrat', 'republican', 'governor', 'political', 'poll', 'speaker', 'vp', 'vice president', 'impeach'],
    'crypto': ['bitcoin', 'ethereum', 'crypto', 'btc', 'eth', 'solana', 'token', 'defi', 'nft', 'blockchain'],
    'business': ['stock', 'market', 'fed', 'interest rate', 'recession', 'inflation', 'gdp', 'economic', 'ipo', 'company', 'trillionaire', 'unemployment'],
  };

  // Additional keyword-based filtering if category was specified but events didn't yield results
  if (category && markets.length > 0) {
    const catKeywords = categoryKeywords[category.toLowerCase()] || [];
    if (catKeywords.length > 0) {
      const keywordFiltered = markets.filter(m => {
        const searchText = ((m.title || '') + ' ' + (m.subtitle || '') + ' ' + (m.yes_sub_title || '')).toLowerCase();
        return catKeywords.some(kw => searchText.includes(kw));
      });
      // Only use keyword filtering if it finds results
      if (keywordFiltered.length > 0) {
        markets = keywordFiltered;
      }
    }
  }

  // Filter by keywords if provided (using OR matching)
  if (keywords) {
    const queryWords = keywords.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2);
    
    markets = markets.filter(m => {
      const searchText = ((m.title || '') + ' ' + (m.subtitle || '') + ' ' + (m.yes_sub_title || '')).toLowerCase();
      return queryWords.some(word => searchText.includes(word));
    });
  }

  // Filter by minimum volume
  if (minVolume > 0) {
    markets = markets.filter(m => (m.volume_24h || 0) >= minVolume);
  }

  // Transform to standardized format
  const comparableMarkets = markets.slice(0, limit).map(m => {
    const title = m.title || m.yes_sub_title || m.ticker;
    const yesPrice = m.yes_ask || m.last_price || 50;
    const noPrice = m.no_ask || (100 - yesPrice);
    
    return {
      title,
      description: m.subtitle || '',
      eventCategory: categorizeMarket(title, m.category),
      keywords: extractKeywords(title + ' ' + (m.subtitle || '')),
      teams: extractTeams(title + ' ' + (m.subtitle || '')),
      outcomes: [
        { name: 'Yes', normalizedProbability: yesPrice / 100, rawPrice: yesPrice },
        { name: 'No', normalizedProbability: noPrice / 100, rawPrice: noPrice },
      ],
      volume24h: m.volume_24h || 0,
      liquidity: m.liquidity || 0,
      closeTime: m.close_time || null,
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
      platformMarketId: m.ticker,
    };
  });

  const sportsCount = comparableMarkets.filter(m => m.eventCategory === 'sports').length;
  const politicsCount = comparableMarkets.filter(m => m.eventCategory === 'politics').length;

  return successResult({
    platform: 'kalshi',
    markets: comparableMarkets,
    totalCount: comparableMarkets.length,
    categoryBreakdown: {
      sports: sportsCount,
      politics: politicsCount,
      business: comparableMarkets.filter(m => m.eventCategory === 'business').length,
      other: comparableMarkets.filter(m => !['sports', 'politics', 'business'].includes(m.eventCategory)).length,
    },
    hint: `Returned ${comparableMarkets.length} markets. Probabilities are normalized 0-1 (original Kalshi prices are in cents 0-100). Compare with Polymarket or Odds API.`,
    fetchedAt: new Date().toISOString(),
  });
}

// ==================== TIER 2: RAW DATA HANDLERS ====================

async function handleGetEvents(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const status = (args?.status as string) || "open";
  const seriesTicker = args?.seriesTicker as string | undefined;
  const limit = Math.min((args?.limit as number) || 50, 200);
  const cursor = args?.cursor as string | undefined;

  let endpoint = `/events?limit=${limit}&status=${status}`;
  if (seriesTicker) {
    endpoint += `&series_ticker=${encodeURIComponent(seriesTicker)}`;
  }
  if (cursor) {
    endpoint += `&cursor=${encodeURIComponent(cursor)}`;
  }

  const response = await fetchKalshi(endpoint) as { events: KalshiEvent[]; cursor?: string };
  const events = (response.events || []).map(e => ({
    eventTicker: e.event_ticker,
    title: e.title || e.event_ticker,
    category: e.category || "Unknown",
    status: e.status || "open",
    marketsCount: e.markets?.length || 0,
  }));

  return successResult({
    events,
    cursor: response.cursor || "",
    count: events.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetEvent(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const eventTicker = args?.eventTicker as string;
  if (!eventTicker) {
    return errorResult("eventTicker is required");
  }

  const withNested = args?.withNestedMarkets !== false;
  const response = await fetchKalshi(
    `/events/${eventTicker}?with_nested_markets=${withNested}`
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

  return successResult({
    event: {
      eventTicker: event.event_ticker,
      title: event.title || event.event_ticker,
      category: event.category || "Unknown",
      status: event.status || "open",
    },
    markets,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarket(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  const response = await fetchKalshi(`/markets/${ticker}`) as { market: KalshiMarket };
  const m = response.market;

  return successResult({
    market: {
      ticker: m.ticker,
      eventTicker: m.event_ticker,
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
      url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleSearchMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const query = args?.query as string | undefined;
  const category = args?.category as string | undefined;
  const status = (args?.status as string) || "open";
  const limit = Math.min((args?.limit as number) || 20, 50);

  // IMPORTANT: Kalshi API doesn't do server-side text search, so fetch more and filter client-side
  const fetchLimit = query ? 500 : limit * 3;
  
  let endpoint = `/markets?limit=${fetchLimit}`;
  if (status !== "all") {
    endpoint += `&status=${status}`;
  }
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = response.markets || [];

  // Filter by query if provided - using WORD-BY-WORD matching (any word matches)
  // This is critical for queries like "Senate control" to find "Senate" OR "control"
  if (query) {
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by']);
    const queryWords = query.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));
    
    markets = markets.filter(m => {
      const searchText = ((m.title || '') + ' ' + (m.yes_sub_title || '') + ' ' + m.ticker).toLowerCase();
      // ANY query word matches (OR matching for better cross-platform compatibility)
      return queryWords.some(word => searchText.includes(word));
    });
  }

  const results = markets.map(m => ({
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

  return successResult({
    results,
    count: results.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketOrderbook(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const ticker = args?.ticker as string;
  if (!ticker) {
    return errorResult("ticker is required");
  }

  const depth = Math.min((args?.depth as number) || 10, 100);
  const response = await fetchKalshi(`/markets/${ticker}/orderbook?depth=${depth}`) as KalshiOrderbook;
  const orderbook = response.orderbook || {};

  const yesBids = (orderbook.yes || []).map(([price, qty]) => ({ price, quantity: qty }));
  const yesAsks = (orderbook.no || []).map(([price, qty]) => ({ price: 100 - price, quantity: qty }));

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

  let endpoint = `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;
  if (minTs) endpoint += `&min_ts=${minTs}`;
  if (maxTs) endpoint += `&max_ts=${maxTs}`;

  const response = await fetchKalshi(endpoint) as { trades: KalshiTrade[] };
  const trades = (response.trades || []).map(t => ({
    tradeId: t.trade_id || "",
    timestamp: t.created_time || "",
    price: t.yes_price || 0,
    count: t.count || 0,
    takerSide: t.taker_side || "unknown",
  }));

  const totalVolume = trades.reduce((sum, t) => sum + t.count, 0);
  const avgPrice = trades.length > 0
    ? trades.reduce((sum, t) => sum + t.price, 0) / trades.length
    : 0;

  return successResult({
    ticker,
    trades,
    summary: {
      totalTrades: trades.length,
      totalVolume,
      avgPrice: Number(avgPrice.toFixed(2)),
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketCandlesticks(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTicker = args?.seriesTicker as string;
  const ticker = args?.ticker as string;

  if (!seriesTicker || !ticker) {
    return errorResult("seriesTicker and ticker are required");
  }

  const startTs = (args?.startTs as number) || Math.floor(Date.now() / 1000) - 86400 * 7;
  const endTs = (args?.endTs as number) || Math.floor(Date.now() / 1000);
  const periodInterval = (args?.periodInterval as number) || 60;

  const endpoint = `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;
  
  const response = await fetchKalshi(endpoint) as { 
    ticker: string;
    candlesticks: Array<{
      end_period_ts: number;
      price?: { open?: number; high?: number; low?: number; close?: number };
      volume?: number;
    }>;
  };

  const candlesticks = (response.candlesticks || []).map(c => ({
    timestamp: c.end_period_ts,
    open: c.price?.open || 0,
    high: c.price?.high || 0,
    low: c.price?.low || 0,
    close: c.price?.close || 0,
    volume: c.volume || 0,
  }));

  return successResult({
    ticker,
    candlesticks,
    fetchedAt: new Date().toISOString(),
  });
}

// ==================== DISCOVERY LAYER HANDLERS ====================

async function handleGetAllCategories(
  _args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const response = await fetchKalshi("/search/tags_by_categories") as {
    tags_by_categories: Record<string, string[]>;
  };

  const categories = response.tags_by_categories || {};
  const categoryList = Object.keys(categories);
  const totalTags = Object.values(categories).reduce((sum, tags) => sum + tags.length, 0);

  return successResult({
    categories,
    categoryList,
    totalCategories: categoryList.length,
    totalTags,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetAllSeries(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string | undefined;
  const tags = args?.tags as string | undefined;
  const limit = Math.min((args?.limit as number) || 100, 200);

  let endpoint = `/series?limit=${limit}`;
  if (category) {
    endpoint += `&category=${encodeURIComponent(category)}`;
  }
  if (tags) {
    endpoint += `&tags=${encodeURIComponent(tags)}`;
  }

  const response = await fetchKalshi(endpoint) as { series: KalshiSeries[] };
  const series = (response.series || []).map(s => ({
    ticker: s.ticker,
    title: s.title || s.ticker,
    category: s.category || "Unknown",
    tags: s.tags || [],
    frequency: s.frequency || "unknown",
  }));

  return successResult({
    series,
    totalCount: series.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleBrowseCategory(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string;
  if (!category) {
    return errorResult("category is required");
  }

  const status = (args?.status as string) || "open";
  const sortBy = (args?.sortBy as string) || "volume_24h";
  const limit = Math.min((args?.limit as number) || 50, 100);

  let endpoint = `/markets?limit=${limit}&category=${encodeURIComponent(category)}`;
  if (status !== "all") {
    endpoint += `&status=${status}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  let markets = response.markets || [];

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

  return successResult({
    category,
    markets: marketsResult,
    totalCount: marketsResult.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleBrowseSeries(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const seriesTicker = args?.seriesTicker as string;
  if (!seriesTicker) {
    return errorResult("seriesTicker is required");
  }

  const status = (args?.status as string) || "open";
  const limit = Math.min((args?.limit as number) || 50, 100);

  // Get series info
  const seriesRes = await fetchKalshi(`/series/${encodeURIComponent(seriesTicker)}`) as { series: KalshiSeries };
  const series = seriesRes.series;

  // Get markets in this series
  let endpoint = `/markets?limit=${limit}&series_ticker=${encodeURIComponent(seriesTicker)}`;
  if (status !== "all") {
    endpoint += `&status=${status}`;
  }

  const response = await fetchKalshi(endpoint) as { markets: KalshiMarket[] };
  const markets = (response.markets || []).map(m => ({
    title: m.title || m.yes_sub_title || m.ticker,
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    url: `https://kalshi.com/markets/${getSeriesTicker(m.event_ticker)}`,
    yesPrice: m.yes_ask || m.last_price || 0,
    volume24h: m.volume_24h || 0,
    closeTime: m.close_time || "",
    status: m.status || "open",
  }));

  return successResult({
    seriesTicker,
    seriesTitle: series?.title || seriesTicker,
    markets,
    totalCount: markets.length,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// EXPRESS SERVER WITH SECURITY MIDDLEWARE
// ============================================================================

const app = express();
app.use(express.json());

// Create security middleware
const verifyContextAuth = createContextMiddleware();

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
app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
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
  console.log(`\n📝 ${TOOLS.length} tools available:`);
  console.log("   Tier 1 (Intelligence): 7 tools");
  console.log("   Tier 2 (Raw Data): 7 tools");
  console.log("   Discovery Layer: 4 tools");
});

