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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
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
  - Polymarket: Same event at different prices = arbitrage opportunity (use kalshi_crossref_polymarket)
  - Odds API: Sports predictions vs sportsbook odds`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
            properties: {
                ticker: {
                    type: "string",
                    description: "Market ticker (e.g., 'PRES-2024-DT')",
                },
            },
            required: ["ticker"],
        },
        outputSchema: {
            type: "object",
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
        description: `Check if a market is efficiently priced. Calculates the "vig" (YES + NO should = 100¢), identifies pricing inefficiencies.

For multi-outcome events, checks if all outcomes sum to 100%.

INPUT: market ticker OR event ticker

RETURNS:
- Sum of outcome prices (should be ~100¢)
- Vig/overround percentage
- True implied probabilities (vig-adjusted)
- Efficiency rating`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
        name: "kalshi_crossref_polymarket",
        description: `[KALSHI SERVER] Search Polymarket for markets equivalent to a Kalshi market.

This tool belongs to the KALSHI MCP server. Use it when you have a Kalshi market 
and want to find the corresponding market on Polymarket for comparison.

⚠️ Call this tool with KALSHI's toolId, not Polymarket's.

Uses Polymarket's official /public-search API for reliable text search.

WORKFLOW:
  1. You have a Kalshi market (from get_event_by_slug or search_markets)
  2. Call: kalshi_crossref_polymarket({ keywords: "supreme court trump tariffs" })
  3. Returns matching Polymarket markets with prices and rules

PRICE COMPARISON:
  - Polymarket: decimals (0.28 = 28%)
  - Kalshi: cents (28 = 28%)

⚠️ CRITICAL: Compare 'rules' and 'yesOutcomeMeans' fields!
Markets may define YES/NO differently - verify before calculating arbitrage.`,
        inputSchema: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "The Kalshi market title to search for on Polymarket",
                },
                keywords: {
                    type: "string",
                    description: "Keywords to search (e.g., 'supreme court tariffs trump'). More specific = better results.",
                },
                kalshiTicker: {
                    type: "string",
                    description: "Optional: The Kalshi ticker (for reference in results)",
                },
                limit: {
                    type: "number",
                    description: "Max results (default: 10)",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                searchedFor: {
                    type: "object",
                    properties: {
                        keywords: { type: "string" },
                        kalshiTicker: { type: "string" },
                    },
                },
                polymarketResults: {
                    type: "array",
                    description: "Matching Polymarket markets. Use 'slug' with Polymarket's get_event_by_slug for details.",
                    items: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "Polymarket market title" },
                            slug: { type: "string", description: "Use this with Polymarket's get_event_by_slug tool" },
                            question: { type: "string" },
                            yesPrice: { type: "number", description: "Current YES price (0-1 scale, e.g., 0.25 = 25%)" },
                            volume: { type: "number" },
                            liquidity: { type: "number" },
                            url: { type: "string", description: "Direct Polymarket URL" },
                            matchScore: { type: "number", description: "Keyword match score (higher = better match)" },
                            rules: { type: "string", description: "Full resolution rules text" },
                            yesOutcomeMeans: { type: "string", description: "⚠️ CRITICAL: What does buying YES mean? Compare with Kalshi!" },
                            noOutcomeMeans: { type: "string", description: "⚠️ CRITICAL: What does buying NO mean? Compare with Kalshi!" },
                        },
                    },
                },
                hint: { type: "string" },
                comparisonNote: { type: "string", description: "⚠️ MUST READ: Step-by-step guide for comparing outcomes across platforms" },
                fetchedAt: { type: "string" },
            },
            required: ["polymarketResults"],
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
            type: "object",
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
                minCloseTs: {
                    type: "number",
                    description: "Return events with at least one market closing after this Unix timestamp",
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
            type: "object",
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
            type: "object",
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
                minCloseTs: {
                    type: "number",
                    description: "Minimum close timestamp filter",
                },
                maxCloseTs: {
                    type: "number",
                    description: "Maximum close timestamp filter",
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
            type: "object",
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
  get_market({ ticker: "KXDJTVOSTARIFFS-001" })  ❌ DON'T add suffixes`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
            properties: {
                slug: {
                    type: "string",
                    description: "The slug from a Kalshi URL (e.g., 'kxdjtvostariffs' from kalshi.com/markets/kxdjtvostariffs/...)",
                },
            },
            required: ["slug"],
        },
        outputSchema: {
            type: "object",
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

This is the RECOMMENDED method when working with Kalshi URLs.`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
        description: `Get detailed information about a specific market.

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

🆕 FALLBACK: If a ticker fails, this tool will auto-attempt to fix common mistakes.`,
        inputSchema: {
            type: "object",
            properties: {
                ticker: {
                    type: "string",
                    description: "EXACT market ticker from API response. Example: 'KXDJTVOSTARIFFS' (not 'KXDJTVOSTARIFFS-001'). Copy the ticker value exactly from get_event_by_slug or search_markets results.",
                },
            },
            required: ["ticker"],
        },
        outputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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

RETURNS: Array of candlesticks with yes_bid, yes_ask, price, volume, open_interest.`,
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                ticker: { type: "string" },
                candlesticks: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            endPeriodTs: { type: "number" },
                            yesBid: {
                                type: ["object", "null"],
                                properties: {
                                    open: { type: ["number", "null"] },
                                    high: { type: ["number", "null"] },
                                    low: { type: ["number", "null"] },
                                    close: { type: ["number", "null"] },
                                    open_dollars: { type: ["string", "null"] },
                                    high_dollars: { type: ["string", "null"] },
                                    low_dollars: { type: ["string", "null"] },
                                    close_dollars: { type: ["string", "null"] },
                                },
                                additionalProperties: true,
                            },
                            yesAsk: {
                                type: ["object", "null"],
                                properties: {
                                    open: { type: ["number", "null"] },
                                    high: { type: ["number", "null"] },
                                    low: { type: ["number", "null"] },
                                    close: { type: ["number", "null"] },
                                    open_dollars: { type: ["string", "null"] },
                                    high_dollars: { type: ["string", "null"] },
                                    low_dollars: { type: ["string", "null"] },
                                    close_dollars: { type: ["string", "null"] },
                                },
                                additionalProperties: true,
                            },
                            price: {
                                type: ["object", "null"],
                                properties: {
                                    open: { type: ["number", "null"] },
                                    high: { type: ["number", "null"] },
                                    low: { type: ["number", "null"] },
                                    close: { type: ["number", "null"] },
                                    min: { type: ["number", "null"] },
                                    max: { type: ["number", "null"] },
                                    mean: { type: ["number", "null"] },
                                    previous: { type: ["number", "null"] },
                                    open_dollars: { type: ["string", "null"] },
                                    high_dollars: { type: ["string", "null"] },
                                    low_dollars: { type: ["string", "null"] },
                                    close_dollars: { type: ["string", "null"] },
                                    min_dollars: { type: ["string", "null"] },
                                    max_dollars: { type: ["string", "null"] },
                                    mean_dollars: { type: ["string", "null"] },
                                    previous_dollars: { type: ["string", "null"] },
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
            type: "object",
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
            type: "object",
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
            type: "object",
            properties: {},
            required: [],
        },
        outputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
    "browse_category",
    "browse_series",
]);
const HEAVY_QUERY_TOOLS = new Set([
    "search_markets",
    "discover_trending_markets",
    "find_arbitrage_opportunities",
    "find_trading_opportunities",
    "kalshi_crossref_polymarket",
    "browse_category",
    "browse_series",
    "get_all_series",
]);
const EXECUTE_PRICE_DEFAULT = process.env.DEFAULT_EXECUTE_USD || "0.001";
const EXECUTE_PRICE_INTELLIGENCE = process.env.INTELLIGENCE_EXECUTE_USD || "0.002";
const EXECUTE_PRICE_DISCOVERY = process.env.DISCOVERY_EXECUTE_USD || "0.0005";
function buildToolMeta(toolName) {
    const isRawDataTool = RAW_DATA_TOOLS.has(toolName);
    const isDiscoveryTool = DISCOVERY_TOOLS.has(toolName);
    const isHeavyQueryTool = HEAVY_QUERY_TOOLS.has(toolName);
    const executeUsd = isRawDataTool
        ? EXECUTE_PRICE_DEFAULT
        : isDiscoveryTool
            ? EXECUTE_PRICE_DISCOVERY
            : EXECUTE_PRICE_INTELLIGENCE;
    const latencyClass = isRawDataTool
        ? (toolName === "get_market_orderbook" || toolName === "get_market_trades" ? "instant" : "fast")
        : isHeavyQueryTool
            ? "slow"
            : "fast";
    const rateLimit = isHeavyQueryTool
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
const server = new Server({ name: "kalshi-intelligence", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS_WITH_METADATA,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
            case "kalshi_crossref_polymarket":
            case "search_on_polymarket": // Backward compatibility alias
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
            case "browse_category":
                return await handleBrowseCategory(args);
            case "browse_series":
                return await handleBrowseSeries(args);
            default:
                return errorResult(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return errorResult(error instanceof Error ? error.message : "Unknown error");
    }
});
// ============================================================================
// RESPONSE HELPERS
// ============================================================================
function errorResult(message) {
    return {
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
        isError: true,
    };
}
function successResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
    };
}
// ============================================================================
// API FETCH HELPERS
// ============================================================================
async function fetchKalshi(endpoint, timeoutMs = 15000) {
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
    }
    finally {
        clearTimeout(timeoutId);
    }
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
function getSeriesTicker(eventTicker) {
    // Remove various suffix patterns and convert to lowercase
    // Pattern 1: -S20XX... (UUID-like suffix)
    // Pattern 2: -XXMONXX... (date pattern like 26JAN09)
    // Pattern 3: -XX (numeric suffix)
    const cleaned = eventTicker
        .replace(/-S20[0-9]{2}[A-F0-9]+$/i, '') // UUID-like: -S2025000ECCE13C4
        .replace(/-\d{2}[A-Z]{3}\d{2}[A-Z]+$/i, '') // Date+teams: -26JAN09ATLDEN
        .replace(/-\d+$/, ''); // Numeric: -28
    return cleaned.toLowerCase();
}
/**
 * Detects if an input looks like a URL slug rather than an event ticker.
 * Slugs are:
 * - All lowercase
 * - Don't have a -XX numeric suffix
 * - May contain hyphens but not in ticker format
 */
function isSlug(input) {
    // Event tickers are typically uppercase and have -NUMBER suffix (e.g., KXPRESPERSON-28)
    // Slugs are lowercase (e.g., kxdjtvostariffs)
    // If it's all lowercase and doesn't have the typical ticker format, it's likely a slug
    const isLowercase = input === input.toLowerCase();
    const hasTickerSuffix = /-\d+$/.test(input);
    const looksLikeTickerFormat = /^[A-Z]+-[A-Z0-9-]+$/.test(input) || hasTickerSuffix;
    return isLowercase && !looksLikeTickerFormat;
}
/**
 * Resolves a URL slug to market/event information by searching markets.
 * Returns the best matching event ticker and associated markets.
 */
async function resolveSlugToEvent(slug) {
    const slugLower = slug.toLowerCase();
    // Try multiple strategies to find the market
    // Strategy 1: Search markets with the slug as query
    try {
        const response = await fetchKalshi(`/markets?limit=500&status=open`);
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
    }
    catch (e) {
        // Continue to next strategy
    }
    // Strategy 2: Try to fetch events and check series tickers
    try {
        const response = await fetchKalshi(`/events?limit=200&status=open`);
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
            const eventDetail = await fetchKalshi(`/events/${matchingEvent.event_ticker}?with_nested_markets=true`);
            return {
                found: true,
                eventTicker: matchingEvent.event_ticker,
                seriesTicker: getSeriesTicker(matchingEvent.event_ticker),
                title: matchingEvent.title,
                markets: eventDetail.event?.markets || [],
            };
        }
    }
    catch (e) {
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
            const eventDetail = await fetchKalshi(`/events/${ticker}?with_nested_markets=true`);
            if (eventDetail.event) {
                return {
                    found: true,
                    eventTicker: eventDetail.event.event_ticker,
                    seriesTicker: getSeriesTicker(eventDetail.event.event_ticker),
                    title: eventDetail.event.title,
                    markets: eventDetail.event.markets || [],
                };
            }
        }
        catch (e) {
            // Try next ticker
        }
    }
    // Strategy 4: Try series endpoint if it exists
    try {
        const seriesResponse = await fetchKalshi(`/series/${slugLower.toUpperCase()}`);
        if (seriesResponse.series) {
            // Get events for this series
            const eventsResponse = await fetchKalshi(`/events?series_ticker=${slugLower.toUpperCase()}&limit=10`);
            const firstEvent = eventsResponse.events?.[0];
            if (firstEvent) {
                const eventDetail = await fetchKalshi(`/events/${firstEvent.event_ticker}?with_nested_markets=true`);
                return {
                    found: true,
                    eventTicker: firstEvent.event_ticker,
                    seriesTicker: slugLower,
                    title: firstEvent.title || seriesResponse.series.title,
                    markets: eventDetail.event?.markets || [],
                };
            }
        }
    }
    catch (e) {
        // Series doesn't exist
    }
    return { found: false, markets: [] };
}
// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================
async function handleDiscoverTrendingMarkets(args) {
    const category = args?.category;
    const sortBy = args?.sortBy || "volume_24h";
    const limit = Math.min(args?.limit || 20, 100);
    // Fetch more markets if filtering by category to ensure we have enough after filtering
    const fetchLimit = category ? limit * 3 : limit;
    let endpoint = `/markets?limit=${fetchLimit}&status=open`;
    if (category) {
        endpoint += `&category=${encodeURIComponent(category)}`;
    }
    const response = await fetchKalshi(endpoint);
    let markets = response.markets || [];
    // IMPROVED CATEGORY FILTERING: If category is specified, also filter by keywords
    // This handles cases where Kalshi's category filter doesn't work as expected
    if (category) {
        const categoryKeywords = {
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
async function handleAnalyzeMarketLiquidity(args) {
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    // Fetch market and orderbook
    const [marketRes, orderbookRes] = await Promise.all([
        fetchKalshi(`/markets/${ticker}`),
        fetchKalshi(`/markets/${ticker}/orderbook?depth=50`),
    ]);
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
        .map(([price, qty]) => [100 - price, qty])
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
    const simulateSlippage = (size, orders, isBuy) => {
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
    let liquidityScore;
    if (bidDepthUsd + askDepthUsd > 50000 && yesSpreadCents <= 2) {
        liquidityScore = "excellent";
    }
    else if (bidDepthUsd + askDepthUsd > 20000 && yesSpreadCents <= 4) {
        liquidityScore = "good";
    }
    else if (bidDepthUsd + askDepthUsd > 5000 && yesSpreadCents <= 6) {
        liquidityScore = "moderate";
    }
    else if (bidDepthUsd + askDepthUsd > 1000) {
        liquidityScore = "poor";
    }
    else {
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
async function handleCheckMarketEfficiency(args) {
    const ticker = args?.ticker;
    const eventTicker = args?.eventTicker;
    if (!ticker && !eventTicker) {
        return errorResult("Either ticker or eventTicker is required");
    }
    let markets = [];
    if (eventTicker) {
        const eventRes = await fetchKalshi(`/events/${eventTicker}?with_nested_markets=true`);
        markets = eventRes.event?.markets || [];
    }
    else if (ticker) {
        const marketRes = await fetchKalshi(`/markets/${ticker}`);
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
    let rating;
    if (Math.abs(vig) <= 1) {
        rating = "excellent";
    }
    else if (Math.abs(vig) <= 3) {
        rating = "good";
    }
    else if (Math.abs(vig) <= 5) {
        rating = "fair";
    }
    else if (Math.abs(vig) <= 10) {
        rating = "poor";
    }
    else {
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
async function handleFindArbitrageOpportunities(args) {
    const category = args?.category;
    const minEdge = args?.minEdge || 1;
    const limit = Math.min(args?.limit || 50, 100);
    let endpoint = `/markets?limit=${limit}&status=open`;
    if (category) {
        endpoint += `&category=${encodeURIComponent(category)}`;
    }
    const response = await fetchKalshi(endpoint);
    const markets = response.markets || [];
    const arbitrageOpportunities = [];
    const wideSpreadMarkets = [];
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
    arbitrageOpportunities.sort((a, b) => b.potentialEdge - a.potentialEdge);
    wideSpreadMarkets.sort((a, b) => b.spread - a.spread);
    return successResult({
        scannedMarkets: markets.length,
        arbitrageOpportunities: arbitrageOpportunities.slice(0, 10),
        wideSpreadMarkets: wideSpreadMarkets.slice(0, 10),
        summary: {
            arbitrageCount: arbitrageOpportunities.length,
            wideSpreadCount: wideSpreadMarkets.length,
            bestOpportunity: arbitrageOpportunities.length > 0
                ? `${arbitrageOpportunities[0].market}: ${arbitrageOpportunities[0].potentialEdge}¢ edge`
                : "No arbitrage opportunities found",
        },
        fetchedAt: new Date().toISOString(),
    });
}
async function handleFindTradingOpportunities(args) {
    const strategy = args?.strategy || "all";
    const category = args?.category;
    const minLiquidity = args?.minLiquidity || 1000;
    const limit = Math.min(args?.limit || 20, 50);
    let endpoint = `/markets?limit=100&status=open`;
    if (category) {
        endpoint += `&category=${encodeURIComponent(category)}`;
    }
    const response = await fetchKalshi(endpoint);
    let markets = response.markets || [];
    // Filter by liquidity
    markets = markets.filter(m => (m.liquidity || 0) >= minLiquidity);
    // Apply strategy filters
    const strategyFilters = {
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
            if (!m.close_time)
                return false;
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
        if (price <= 15)
            why = "Lottery ticket - high payoff if correct";
        else if (price >= 35 && price <= 65)
            why = "Balanced risk/reward - coin flip odds";
        else if (price >= 70 && price <= 90)
            why = "High confidence - likely outcome";
        else if ((m.volume_24h || 0) >= 10000)
            why = "High volume - significant activity";
        else
            why = "Active market with liquidity";
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
async function handleGetMarketsByProbability(args) {
    const probability = args?.probability;
    if (!probability) {
        return errorResult("probability is required");
    }
    const category = args?.category;
    const limit = Math.min(args?.limit || 10, 30);
    const ranges = {
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
    const response = await fetchKalshi(endpoint);
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
async function handleAnalyzeMarketSentiment(args) {
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    const marketRes = await fetchKalshi(`/markets/${ticker}`);
    const market = marketRes.market;
    const currentPrice = market.yes_ask || market.last_price || 50;
    const previousPrice = market.previous_price || currentPrice;
    const change24h = currentPrice - previousPrice;
    const changePercent = previousPrice > 0 ? ((change24h / previousPrice) * 100) : 0;
    const volume24h = market.volume_24h || 0;
    const avgVolume = (market.volume || 0) / 7; // Rough daily average
    const isAboveAverage = volume24h > avgVolume;
    // Determine sentiment
    let sentiment;
    let confidence;
    if (change24h > 10) {
        sentiment = "strongly_bullish";
        confidence = "high";
    }
    else if (change24h > 3) {
        sentiment = "bullish";
        confidence = isAboveAverage ? "high" : "medium";
    }
    else if (change24h < -10) {
        sentiment = "strongly_bearish";
        confidence = "high";
    }
    else if (change24h < -3) {
        sentiment = "bearish";
        confidence = isAboveAverage ? "high" : "medium";
    }
    else {
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
function extractKeywords(text) {
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
function extractTeams(text) {
    const teams = [];
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
function categorizeMarket(title, category) {
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
function extractOutcomeMeanings(rules, marketTitle) {
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
async function handleSearchOnPolymarket(args) {
    const title = args?.title;
    const keywords = args?.keywords;
    const kalshiTicker = args?.kalshiTicker;
    const limit = Math.min(args?.limit || 10, 25);
    // Build search query from title or keywords
    // IMPORTANT: Extract meaningful keywords - long queries fail on Polymarket's search
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'this', 'that', 'with', 'from', 'as', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'but', 'if', 'than', 'so', 'just', 'inc', 'vs', 'case']);
    let searchQuery = '';
    const sourceText = keywords || title || '';
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
        const tickerKeywords = [];
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
        const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        const allResults = [];
        // Use Polymarket's official /public-search API for server-side text search
        const searchUrl = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(searchQuery)}&limit_per_type=${limit * 2}&events_status=active`;
        const response = await fetch(searchUrl, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Kalshi-MCP-Server/1.0' },
        });
        if (response.ok) {
            const searchData = await response.json();
            for (const event of (searchData.events || [])) {
                // Calculate match score for sorting
                const searchText = (event.title + ' ' + (event.description || '')).toLowerCase();
                let matchCount = 0;
                for (const word of queryWords) {
                    if (searchText.includes(word))
                        matchCount++;
                }
                const matchScore = queryWords.length > 0 ? matchCount / queryWords.length : 1;
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
                        }
                        catch { }
                    }
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
            ? `✅ Found ${scoredResults.length} matches on Polymarket via server-side search. ⚠️ CRITICAL: Check 'yesOutcomeMeans' and 'noOutcomeMeans' fields to ensure you're comparing equivalent outcomes!`
            : `No matches found on Polymarket for "${searchQuery}". Try different keywords.`;
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
                kalshiTicker: kalshiTicker || null,
            },
            searchMethod: "public-search API",
            polymarketResults: scoredResults,
            hint,
            comparisonNote,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to search Polymarket: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
// ==================== TIER 2: RAW DATA HANDLERS ====================
async function handleGetEvents(args) {
    const status = args?.status || "open";
    const seriesTicker = args?.seriesTicker;
    const withNestedMarkets = args?.withNestedMarkets === true;
    const withMilestones = args?.withMilestones === true;
    const minCloseTs = args?.minCloseTs;
    const limit = Math.min(args?.limit || 50, 200);
    const cursor = args?.cursor;
    let endpoint = `/events?limit=${limit}&status=${status}`;
    if (seriesTicker) {
        endpoint += `&series_ticker=${encodeURIComponent(seriesTicker)}`;
    }
    if (withNestedMarkets) {
        endpoint += "&with_nested_markets=true";
    }
    if (withMilestones) {
        endpoint += "&with_milestones=true";
    }
    if (minCloseTs) {
        endpoint += `&min_close_ts=${minCloseTs}`;
    }
    if (cursor) {
        endpoint += `&cursor=${encodeURIComponent(cursor)}`;
    }
    const response = await fetchKalshi(endpoint);
    const nextCursor = response.next_cursor || response.cursor || "";
    const events = (response.events || []).map(e => ({
        eventTicker: e.event_ticker,
        title: e.title || e.event_ticker,
        category: e.category || "Unknown",
        status: e.status || "open",
        marketsCount: Array.isArray(e.markets) ? e.markets.length : 0,
    }));
    return successResult({
        events,
        nextCursor,
        cursor: nextCursor,
        count: events.length,
        filtersApplied: {
            status,
            seriesTicker,
            withNestedMarkets,
            withMilestones,
            minCloseTs,
        },
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetMarkets(args) {
    const status = args?.status || "open";
    const eventTicker = args?.eventTicker;
    const seriesTicker = args?.seriesTicker;
    const category = args?.category;
    const tickers = args?.tickers?.filter(Boolean) || [];
    const minUpdatedTs = args?.minUpdatedTs;
    const minCloseTs = args?.minCloseTs;
    const maxCloseTs = args?.maxCloseTs;
    const minCreatedTs = args?.minCreatedTs;
    const maxCreatedTs = args?.maxCreatedTs;
    const minSettledTs = args?.minSettledTs;
    const maxSettledTs = args?.maxSettledTs;
    const limit = Math.min(args?.limit || 50, 200);
    const cursor = args?.cursor;
    let endpoint = `/markets?limit=${limit}&status=${encodeURIComponent(status)}`;
    if (eventTicker)
        endpoint += `&event_ticker=${encodeURIComponent(eventTicker)}`;
    if (seriesTicker)
        endpoint += `&series_ticker=${encodeURIComponent(seriesTicker)}`;
    if (category)
        endpoint += `&category=${encodeURIComponent(category)}`;
    if (tickers.length > 0)
        endpoint += `&tickers=${encodeURIComponent(tickers.join(","))}`;
    if (minUpdatedTs)
        endpoint += `&min_updated_ts=${minUpdatedTs}`;
    if (minCloseTs)
        endpoint += `&min_close_ts=${minCloseTs}`;
    if (maxCloseTs)
        endpoint += `&max_close_ts=${maxCloseTs}`;
    if (minCreatedTs)
        endpoint += `&min_created_ts=${minCreatedTs}`;
    if (maxCreatedTs)
        endpoint += `&max_created_ts=${maxCreatedTs}`;
    if (minSettledTs)
        endpoint += `&min_settled_ts=${minSettledTs}`;
    if (maxSettledTs)
        endpoint += `&max_settled_ts=${maxSettledTs}`;
    if (cursor)
        endpoint += `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetchKalshi(endpoint);
    const nextCursor = response.next_cursor || response.cursor || "";
    const markets = (response.markets || []).map((m) => ({
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
    return successResult({
        markets,
        nextCursor,
        cursor: nextCursor,
        count: markets.length,
        filtersApplied: {
            status,
            eventTicker,
            seriesTicker,
            category,
            tickersCount: tickers.length,
        },
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetEvent(args) {
    let eventTicker = args?.eventTicker;
    if (!eventTicker) {
        return errorResult("eventTicker is required");
    }
    const withNested = args?.withNestedMarkets !== false;
    let resolvedFrom;
    // Auto-detect if this looks like a slug and resolve it
    if (isSlug(eventTicker)) {
        const resolved = await resolveSlugToEvent(eventTicker);
        if (resolved.found && resolved.eventTicker) {
            resolvedFrom = `slug:${eventTicker}`;
            eventTicker = resolved.eventTicker;
        }
        else {
            return errorResult(`Could not resolve slug '${eventTicker}' to an event. ` +
                `Try using search_markets({ query: "${eventTicker}" }) to find matching markets, ` +
                `or use resolve_slug({ slug: "${eventTicker}" }) for detailed resolution info.`);
        }
    }
    try {
        const response = await fetchKalshi(`/events/${eventTicker}?with_nested_markets=${withNested}`);
        const event = response.event;
        const markets = (event.markets || []).map(m => ({
            ticker: m.ticker,
            title: m.title || m.yes_sub_title || m.ticker,
            yesPrice: m.yes_ask || m.last_price || 0,
            noPrice: m.no_ask || (100 - (m.yes_ask || m.last_price || 50)),
            volume: m.volume || 0,
            status: m.status || "open",
        }));
        const result = {
            event: {
                eventTicker: event.event_ticker,
                title: event.title || event.event_ticker,
                category: event.category || "Unknown",
                status: event.status || "open",
            },
            markets,
            fetchedAt: new Date().toISOString(),
        };
        if (resolvedFrom) {
            result.resolvedFrom = resolvedFrom;
        }
        return successResult(result);
    }
    catch (error) {
        // If direct fetch fails and we haven't tried slug resolution, try it now
        if (!resolvedFrom && error instanceof Error && error.message.includes('404')) {
            const resolved = await resolveSlugToEvent(eventTicker);
            if (resolved.found && resolved.eventTicker && resolved.eventTicker !== eventTicker) {
                // Retry with resolved ticker
                const response = await fetchKalshi(`/events/${resolved.eventTicker}?with_nested_markets=${withNested}`);
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
                    resolvedFrom: `fallback:${eventTicker}`,
                    fetchedAt: new Date().toISOString(),
                });
            }
        }
        throw error;
    }
}
async function handleResolveSlug(args) {
    const slug = args?.slug;
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
async function handleGetEventBySlug(args) {
    const slug = args?.slug;
    if (!slug) {
        return errorResult("slug is required");
    }
    const withNested = args?.withNestedMarkets !== false;
    const resolved = await resolveSlugToEvent(slug);
    if (!resolved.found || !resolved.eventTicker) {
        return errorResult(`Could not resolve slug '${slug}' to an event. ` +
            `Try using search_markets({ query: "${slug}" }) to find matching markets.`);
    }
    // Fetch the full event details
    const response = await fetchKalshi(`/events/${resolved.eventTicker}?with_nested_markets=${withNested}`);
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
    return successResult({
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
    });
}
async function handleGetMarket(args) {
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    // Helper to format market result
    const formatMarketResult = (m, resolvedFrom) => {
        const result = {
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
        return result;
    };
    // Strategy 1: Try exact ticker
    try {
        const response = await fetchKalshi(`/markets/${ticker}`);
        return successResult(formatMarketResult(response.market));
    }
    catch (error) {
        if (!(error instanceof Error && error.message.includes('404'))) {
            throw error;
        }
    }
    // Strategy 2: Try removing common suffixes AI might have added (like -001, -01, etc.)
    const tickerWithoutSuffix = ticker.replace(/-0+\d*$/, '');
    if (tickerWithoutSuffix !== ticker) {
        try {
            const response = await fetchKalshi(`/markets/${tickerWithoutSuffix}`);
            return successResult(formatMarketResult(response.market, `corrected:${ticker}->${tickerWithoutSuffix}`));
        }
        catch (e) {
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
                const response = await fetchKalshi(`/markets/${firstMarket.ticker}`);
                return successResult(formatMarketResult(response.market, `slug:${slugVersion}->${firstMarket.ticker}`));
            }
            catch (e) {
                // Return basic info from resolved markets
                return successResult(formatMarketResult(firstMarket, `slug:${slugVersion}`));
            }
        }
    }
    // Strategy 4: Search for similar tickers
    try {
        const searchResponse = await fetchKalshi(`/markets?limit=100&status=open`);
        const markets = searchResponse.markets || [];
        const tickerBase = ticker.replace(/-\d+$/, '').toLowerCase();
        const matching = markets.filter(m => m.ticker.toLowerCase() === ticker.toLowerCase() ||
            m.ticker.toLowerCase().startsWith(tickerBase) ||
            getSeriesTicker(m.event_ticker) === tickerBase);
        if (matching.length > 0) {
            const bestMatch = matching[0];
            const response = await fetchKalshi(`/markets/${bestMatch.ticker}`);
            return successResult(formatMarketResult(response.market, `search:${ticker}->${bestMatch.ticker}`));
        }
    }
    catch (e) {
        // Fall through to error
    }
    // All strategies failed
    return errorResult(`Market '${ticker}' not found. ` +
        `Possible issues:\n` +
        `1. The ticker may have been incorrectly constructed (don't add suffixes like -001)\n` +
        `2. Use the exact 'ticker' value from get_event_by_slug or search_markets results\n` +
        `3. Try get_event_by_slug({ slug: "${ticker.toLowerCase()}" }) first to get the correct ticker`);
}
async function handleSearchMarkets(args) {
    const query = args?.query;
    const category = args?.category;
    const status = args?.status || "open";
    const limit = Math.min(args?.limit || 20, 50);
    const maxSeriesScan = Math.min(args?.maxSeriesScan || 600, 1200);
    let markets = [];
    let matchedSeries = [];
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'rule', 'market', 'markets']);
    // Parse query words
    let queryWords = query ? query.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.has(word)) : [];
    // STRATEGY 1: INTELLIGENT HIERARCHICAL SEARCH WITH DYNAMIC TAG MATCHING
    // Fetch Kalshi's actual categories/tags and match query words dynamically
    if (query && queryWords.length > 0) {
        try {
            // Step 1: Dynamically fetch Kalshi's categories and tags (cached in production)
            let tagsByCategory = {};
            try {
                const tagsResponse = await fetchKalshi('/search/tags_by_categories');
                tagsByCategory = tagsResponse.tags_by_categories || {};
            }
            catch {
                console.warn('[Kalshi Search] Could not fetch tags, using fallback');
            }
            // Step 2: Build reverse index: word fragments → { category, tag }
            // e.g., "scotus" → { category: "Politics", tag: "SCOTUS & courts" }
            const wordToTagMap = new Map();
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
                    if (!tag || typeof tag !== 'string')
                        continue;
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
            // Step 3: Also add common abbreviation mappings (these ARE robust - they're standard abbreviations)
            const abbreviations = {
                'trump': ['trump', 'djt', 'donald'],
                'bitcoin': ['btc'],
                'ethereum': ['eth'],
                'scotus': ['supreme', 'court'],
            };
            // Expand query words with abbreviations
            const expandedQueryWords = [...queryWords];
            for (const word of queryWords) {
                // Check if this word is an abbreviation that maps to a tag word
                for (const [tagWord, abbrevs] of Object.entries(abbreviations)) {
                    if (abbrevs.includes(word) && !expandedQueryWords.includes(tagWord)) {
                        expandedQueryWords.push(tagWord);
                    }
                    if (word === tagWord) {
                        expandedQueryWords.push(...abbrevs.filter(a => !expandedQueryWords.includes(a)));
                    }
                }
            }
            queryWords = [...new Set(expandedQueryWords)];
            // Step 4: Match query words to categories/tags and count matches per tag
            let detectedCategory = null;
            const tagMatchCounts = new Map();
            for (const word of queryWords) {
                const match = wordToTagMap.get(word);
                if (match) {
                    if (!detectedCategory)
                        detectedCategory = match.category;
                    const existing = tagMatchCounts.get(match.tag);
                    if (existing) {
                        existing.count++;
                    }
                    else {
                        tagMatchCounts.set(match.tag, { category: match.category, count: 1 });
                    }
                }
            }
            // Get ALL matched tags, sorted by count (most specific first)
            const sortedTags = [...tagMatchCounts.entries()]
                .sort((a, b) => b[1].count - a[1].count)
                .slice(0, 3); // Take up to 3 most relevant tags
            console.log(`[Kalshi Search] Matched tags: ${sortedTags.map(([t, { count }]) => `${t}(${count})`).join(', ')}`);
            console.log(`[Kalshi Search] Detected category: ${detectedCategory}`);
            // Step 5: Fetch series from MULTIPLE tags to maximize coverage
            // Some markets may be tagged with different tags (e.g., SCOTUS vs Trump Agenda)
            const allSeriesMap = new Map();
            // Fetch from each matched tag
            for (const [tag] of sortedTags) {
                let seriesEndpoint = `/series?limit=300`;
                if (detectedCategory) {
                    seriesEndpoint += `&category=${encodeURIComponent(detectedCategory)}`;
                }
                seriesEndpoint += `&tags=${encodeURIComponent(tag)}`;
                console.log(`[Kalshi Search] Fetching series with tag: ${tag}`);
                const seriesResponse = await fetchKalshi(seriesEndpoint);
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
                const seriesResponse = await fetchKalshi(seriesEndpoint);
                for (const s of (seriesResponse.series || [])) {
                    allSeriesMap.set(s.ticker, s);
                }
            }
            let allSeries = [...allSeriesMap.values()];
            console.log(`[Kalshi Search] Total unique series from tag searches: ${allSeries.length}`);
            // If still no results, fall back to broader search
            if (allSeries.length === 0) {
                console.log('[Kalshi Search] No results with filters, falling back to broader search');
                const fallbackResponse = await fetchKalshi(`/series?limit=${maxSeriesScan}`);
                allSeries = fallbackResponse.series || [];
            }
            // Initial filter - any query word matches series title/ticker/tags
            // Also pre-score for better initial ranking
            const initialMatches = [];
            for (const s of allSeries) {
                const tagsText = Array.isArray(s.tags) ? s.tags.join(' ') : '';
                const searchText = ((s.title || '') + ' ' + s.ticker + ' ' + tagsText).toLowerCase();
                const matchCount = queryWords.filter(word => searchText.includes(word)).length;
                if (matchCount > 0) {
                    initialMatches.push({ series: s, score: matchCount });
                }
            }
            // Sort by initial score
            initialMatches.sort((a, b) => b.score - a.score);
            // Take top candidates (limit to avoid too many event fetches)
            const topCandidates = initialMatches.slice(0, 20).map(m => m.series);
            const enrichedResults = [];
            // Fetch markets for each series, then get event details for better titles
            // Series ticker often != event ticker, so we need to go: series -> markets -> event
            for (let i = 0; i < topCandidates.length; i += 5) {
                const batch = topCandidates.slice(i, i + 5);
                const eventPromises = batch.map(async (s) => {
                    try {
                        // First, fetch markets for this series to get event_ticker
                        const marketsResponse = await fetchKalshi(`/markets?series_ticker=${s.ticker}&status=${status}&limit=1`);
                        const firstMarket = marketsResponse.markets?.[0];
                        let eventTitle = s.title || '';
                        if (firstMarket?.event_ticker) {
                            // Now fetch the event using the correct event_ticker
                            try {
                                const eventResponse = await fetchKalshi(`/events/${firstMarket.event_ticker}`);
                                eventTitle = eventResponse.event?.title || firstMarket.title || s.title || '';
                            }
                            catch {
                                // Use market title as fallback
                                eventTitle = firstMarket.title || s.title || '';
                            }
                        }
                        // Score based on ALL text: series title + event title + ticker
                        const fullText = ((s.title || '') + ' ' + eventTitle + ' ' + s.ticker).toLowerCase();
                        const score = queryWords.filter(w => fullText.includes(w)).length;
                        // Bonus for exact phrase matches
                        const bonusScore = queryWords.length > 1 && fullText.includes(queryWords.join(' ')) ? 3 : 0;
                        return { series: s, eventTitle, score: score + bonusScore, hasMarkets: !!firstMarket };
                    }
                    catch {
                        // If all fetches fail, use series data only
                        const fullText = ((s.title || '') + ' ' + s.ticker).toLowerCase();
                        return { series: s, eventTitle: s.title || '', score: queryWords.filter(w => fullText.includes(w)).length, hasMarkets: false };
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
                    const response = await fetchKalshi(`/markets?series_ticker=${result.series.ticker}&status=${status}`);
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
                }
                catch {
                    // Continue with other series
                }
            }
        }
        catch (e) {
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
            const response = await fetchKalshi(endpoint);
            const listingMarkets = response.markets || [];
            for (const m of listingMarkets) {
                if (!markets.find(existing => existing.ticker === m.ticker)) {
                    markets.push(m);
                }
            }
        }
        catch {
            // Continue with what we have
        }
    }
    // Filter by query if provided (for markets from fallback that may not match)
    if (query) {
        const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by']);
        const queryWords = query.toLowerCase()
            .split(/\s+/)
            .filter(word => word.length > 2 && !stopWords.has(word));
        markets = markets.filter(m => {
            const searchText = ((m.title || '') + ' ' + (m.yes_sub_title || '') + ' ' + m.ticker + ' ' + m.event_ticker).toLowerCase();
            return queryWords.some(word => {
                const regex = new RegExp(`\\b${word}\\b`, 'i');
                return regex.test(searchText);
            });
        });
    }
    const results = markets.slice(0, limit).map(m => ({
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
    // Build helpful hint
    const hint = results.length === 0 && query
        ? `⚠️ No Kalshi markets found for "${query}". Try: (1) Different keywords, (2) Check kalshi.com for the exact URL, (3) Use get_event_by_slug with the slug from the URL.`
        : matchedSeries.length > 0
            ? `✅ Found ${results.length} markets via series search. Matched series: ${matchedSeries.slice(0, 5).join(', ')}`
            : `Found ${results.length} markets matching "${query || 'all'}".`;
    return successResult({
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
    });
}
async function handleGetMarketOrderbook(args) {
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    const depth = Math.min(args?.depth || 10, 100);
    const preferFixedPoint = args?.preferFixedPoint !== false;
    const response = await fetchKalshi(`/markets/${ticker}/orderbook?depth=${depth}`);
    const hasOrderbookFp = !!response.orderbook_fp;
    const normalizeQty = (qty) => {
        if (typeof qty === "number") {
            return qty;
        }
        const parsed = Number.parseFloat(qty);
        return Number.isFinite(parsed) ? parsed : 0;
    };
    const selectedOrderbook = preferFixedPoint && response.orderbook_fp
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
async function handleGetMarketTrades(args) {
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    const limit = Math.min(args?.limit || 50, 1000);
    const minTs = args?.minTs;
    const maxTs = args?.maxTs;
    const cursor = args?.cursor;
    let endpoint = `/markets/trades?ticker=${encodeURIComponent(ticker)}&limit=${limit}`;
    if (minTs)
        endpoint += `&min_ts=${minTs}`;
    if (maxTs)
        endpoint += `&max_ts=${maxTs}`;
    if (cursor)
        endpoint += `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetchKalshi(endpoint);
    const trades = (response.trades || []).map(t => ({
        tradeId: t.trade_id || "",
        timestamp: t.created_time ||
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
async function handleGetMarketCandlesticks(args) {
    const seriesTicker = args?.seriesTicker;
    const ticker = args?.ticker;
    if (!ticker) {
        return errorResult("ticker is required");
    }
    const startTs = args?.startTs || Math.floor(Date.now() / 1000) - 86400 * 7;
    const endTs = args?.endTs || Math.floor(Date.now() / 1000);
    const periodInterval = args?.periodInterval || 60;
    const includeLatestBeforeStart = args?.includeLatestBeforeStart === true;
    const baseBatchEndpoint = `/markets/candlesticks?market_tickers=${encodeURIComponent(ticker)}&start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;
    const batchEndpoint = includeLatestBeforeStart
        ? `${baseBatchEndpoint}&include_latest_before_start=true`
        : baseBatchEndpoint;
    const normalizeCandleMetric = (value) => {
        if (value === null || value === undefined) {
            return null;
        }
        if (typeof value === "number") {
            return { close: value };
        }
        if (typeof value !== "object") {
            return null;
        }
        const raw = value;
        const pick = (key) => raw[key] ?? null;
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
        const response = await fetchKalshi(batchEndpoint);
        const marketData = response.markets?.find((m) => m.market_ticker === ticker) || response.markets?.[0];
        const candlesticks = (marketData?.candlesticks || []).map((c) => ({
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
            sourceEndpoint: "/markets/candlesticks",
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (batchError) {
        if (!seriesTicker) {
            throw batchError;
        }
        // Legacy fallback for older environments where series-based endpoint is available.
        const legacyEndpoint = `/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}${includeLatestBeforeStart ? "&include_latest_before_start=true" : ""}`;
        const legacyResponse = await fetchKalshi(legacyEndpoint);
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
async function handleGetEventCandlesticks(args) {
    const seriesTicker = args?.seriesTicker;
    const eventTicker = args?.eventTicker;
    if (!seriesTicker || !eventTicker) {
        return errorResult("seriesTicker and eventTicker are required");
    }
    const startTs = args?.startTs || Math.floor(Date.now() / 1000) - 86400 * 7;
    const endTs = args?.endTs || Math.floor(Date.now() / 1000);
    const periodInterval = args?.periodInterval || 60;
    const endpoint = `/series/${encodeURIComponent(seriesTicker)}/events/${encodeURIComponent(eventTicker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=${periodInterval}`;
    const response = await fetchKalshi(endpoint);
    return successResult({
        eventTicker,
        seriesTicker,
        marketTickers: response.market_tickers || [],
        marketCandlesticks: response.market_candlesticks || [],
        adjustedEndTs: response.adjusted_end_ts || endTs,
        fetchedAt: new Date().toISOString(),
    });
}
// ==================== DISCOVERY LAYER HANDLERS ====================
async function handleGetAllCategories(_args) {
    const response = await fetchKalshi("/search/tags_by_categories");
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
async function handleGetAllSeries(args) {
    const category = args?.category;
    const tags = args?.tags;
    const limit = Math.min(args?.limit || 100, 200);
    let endpoint = `/series?limit=${limit}`;
    if (category) {
        endpoint += `&category=${encodeURIComponent(category)}`;
    }
    if (tags) {
        endpoint += `&tags=${encodeURIComponent(tags)}`;
    }
    const response = await fetchKalshi(endpoint);
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
async function handleBrowseCategory(args) {
    const category = args?.category;
    if (!category) {
        return errorResult("category is required");
    }
    const status = args?.status || "open";
    const sortBy = args?.sortBy || "volume_24h";
    const limit = Math.min(args?.limit || 50, 100);
    let endpoint = `/markets?limit=${limit}&category=${encodeURIComponent(category)}`;
    if (status !== "all") {
        endpoint += `&status=${status}`;
    }
    const response = await fetchKalshi(endpoint);
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
async function handleBrowseSeries(args) {
    const seriesTicker = args?.seriesTicker;
    if (!seriesTicker) {
        return errorResult("seriesTicker is required");
    }
    const status = args?.status || "open";
    const limit = Math.min(args?.limit || 50, 100);
    // Get series info
    const seriesRes = await fetchKalshi(`/series/${encodeURIComponent(seriesTicker)}`);
    const series = seriesRes.series;
    // Get markets in this series
    let endpoint = `/markets?limit=${limit}&series_ticker=${encodeURIComponent(seriesTicker)}`;
    if (status !== "all") {
        endpoint += `&status=${status}`;
    }
    const response = await fetchKalshi(endpoint);
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
const disableContextAuth = process.env.DISABLE_CONTEXT_AUTH === "true";
// Testing-only toggle: set DISABLE_CONTEXT_AUTH=true on isolated test environments.
const mcpMiddlewares = disableContextAuth ? [] : [verifyContextAuth];
// Health check
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        server: "kalshi-intelligence",
        version: "1.0.0",
        tools: TOOLS.length,
    });
});
// Session management
const transports = new Map();
// MCP endpoint with security middleware
app.post("/mcp", ...mcpMiddlewares, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        await server.connect(transport);
    }
    else {
        res.status(400).json({ error: "Bad Request: No valid session" });
        return;
    }
    await transport.handleRequest(req, res, req.body);
});
// Handle SSE for streaming
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
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
    console.log("   Discovery Layer: 4 tools");
});
