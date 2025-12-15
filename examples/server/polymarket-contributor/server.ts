/**
 * Polymarket Intelligence MCP Server v1.0
 *
 * A "giga-brained" MCP server for prediction market analysis.
 * Provides whale cost analysis, market efficiency checks, smart money tracking,
 * and arbitrage detection.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
import type { PolymarketContext, PolymarketPosition } from "@ctxprotocol/sdk";

// ============================================================================
// API ENDPOINTS
// ============================================================================

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (required by Context)
// - requirements.context: Context types needed for portfolio tools (Context Protocol extension)
//
// NOTE: ToolRequirements type is imported from @ctxprotocol/sdk
// ============================================================================

const TOOLS = [
  // ==================== TIER 1: INTELLIGENCE TOOLS ====================

  {
    name: "analyze_market_liquidity",
    description:
      'Analyze market liquidity and calculate "Whale Cost" - simulates the slippage for selling $1k, $5k, and $10k positions. Answers: "Can I exit this position if I put $X in?"',
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: {
          type: "string",
          description: "The token ID (YES or NO outcome token) to analyze",
        },
        conditionId: {
          type: "string",
          description: "The market condition ID (alternative to tokenId)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        tokenId: { type: "string" },
        currentPrice: { type: "number" },
        spread: {
          type: "object",
          properties: {
            absolute: { type: "number" },
            percentage: { type: "number" },
            bps: { type: "number" },
          },
        },
        depthWithin2Percent: {
          type: "object",
          properties: {
            bidDepthUsd: { type: "number" },
            askDepthUsd: { type: "number" },
          },
        },
        whaleCost: {
          type: "object",
          description: "Slippage simulation for different position sizes",
          properties: {
            sell1k: { type: "object" },
            sell5k: { type: "object" },
            sell10k: { type: "object" },
          },
        },
        liquidityScore: {
          type: "string",
          enum: ["excellent", "good", "moderate", "poor", "illiquid"],
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["tokenId", "currentPrice", "spread", "whaleCost", "liquidityScore"],
    },
  },

  {
    name: "check_market_efficiency",
    description:
      'Check if a market is efficiently priced. Calculates the "vig" (sum of YES + NO prices), identifies if fees/spread are eating potential edge, and reports true implied probabilities.',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
        slug: {
          type: "string",
          description: "The event slug (alternative to conditionId)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        conditionId: { type: "string" },
        outcomes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              tokenId: { type: "string" },
              price: { type: "number" },
              impliedProbability: { type: "number" },
            },
          },
        },
        marketEfficiency: {
          type: "object",
          properties: {
            sumOfOutcomes: {
              type: "number",
              description: "Sum of all outcome prices. Should be ~1.0 for efficient market",
            },
            vig: {
              type: "number",
              description: "The overround/vig as percentage (sumOfOutcomes - 1)",
            },
            vigBps: { type: "number" },
            isEfficient: { type: "boolean" },
            efficiency: {
              type: "string",
              enum: ["excellent", "good", "fair", "poor", "exploitable"],
            },
          },
        },
        trueProbabilities: {
          type: "object",
          description: "Vig-adjusted true probabilities",
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["conditionId", "outcomes", "marketEfficiency"],
    },
  },

  {
    name: "analyze_whale_flow",
    description:
      'Track "Smart Money" by analyzing trade sizes. Buckets trades into Small (<$50), Medium ($50-$500), and Whale (>$1000), then calculates net directional flow for each bucket.',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
        tokenId: {
          type: "string",
          description: "Specific token ID to analyze",
        },
        hoursBack: {
          type: "number",
          description: "Hours of trade history to analyze (default: 24)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        period: { type: "string" },
        totalTrades: { type: "number" },
        totalVolume: { type: "number" },
        flowBySize: {
          type: "object",
          properties: {
            small: {
              type: "object",
              description: "Trades < $50",
              properties: {
                count: { type: "number" },
                buyVolume: { type: "number" },
                sellVolume: { type: "number" },
                netFlow: { type: "number" },
                sentiment: { type: "string" },
              },
            },
            medium: {
              type: "object",
              description: "Trades $50-$500",
            },
            whale: {
              type: "object",
              description: "Trades > $1000",
            },
          },
        },
        whaleActivity: {
          type: "object",
          properties: {
            netWhaleVolume: { type: "number" },
            sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
            largestTrade: { type: "object" },
          },
        },
        divergence: {
          type: "string",
          description: "Is whale flow diverging from retail? e.g., 'Retail selling, whales buying YES'",
        },
        fetchedAt: { type: "string" },
      },
      required: ["totalTrades", "flowBySize", "whaleActivity"],
    },
  },

  {
    name: "find_correlated_markets",
    description:
      'Find markets that might be correlated for hedging purposes. If betting on "Bitcoin > $100k", shows related crypto markets.',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID to find correlations for",
        },
        slug: {
          type: "string",
          description: "The event slug (alternative to conditionId)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        sourceMarket: {
          type: "object",
          properties: {
            title: { type: "string" },
            category: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
        correlatedMarkets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              conditionId: { type: "string" },
              correlationType: {
                type: "string",
                enum: ["same_category", "same_tags", "title_similarity", "same_event"],
              },
              correlationScore: { type: "number" },
              currentPrice: { type: "number" },
              hedgeNote: { type: "string" },
            },
          },
        },
        hedgingStrategy: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["sourceMarket", "correlatedMarkets"],
    },
  },

  {
    name: "check_market_rules",
    description:
      'Parse market resolution rules and highlight potential "gotchas". Extracts the description, resolution source, and edge cases that could cause unexpected resolution.',
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The event slug",
        },
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        description: { type: "string" },
        resolutionSource: { type: "string" },
        endDate: { type: "string" },
        rulesSummary: {
          type: "object",
          properties: {
            primaryCondition: { type: "string" },
            resolvesYesIf: { type: "string" },
            resolvesNoIf: { type: "string" },
            potentialGotchas: {
              type: "array",
              items: { type: "string" },
              description: "Edge cases that could cause unexpected resolution",
            },
            ambiguities: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        riskFactors: {
          type: "array",
          items: { type: "string" },
        },
        fetchedAt: { type: "string" },
      },
      required: ["market", "description", "rulesSummary"],
    },
  },

  {
    name: "find_arbitrage_opportunities",
    description:
      "Scan markets for REAL arbitrage by fetching actual CLOB orderbooks. Checks if buying both YES and NO costs less than $1 (guaranteed profit). Also identifies wide-spread markets. Limited to ~20 markets to avoid timeout.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: 'Category to scan (e.g., "politics", "crypto", "sports")',
        },
        limit: {
          type: "number",
          description: "Number of markets to scan (default: 20, max: 30 due to orderbook fetching)",
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
              conditionId: { type: "string" },
              buyYesAt: { type: "number", description: "Best ask price for YES" },
              buyNoAt: { type: "number", description: "Best ask price for NO" },
              totalCost: { type: "number", description: "Total cost to buy both (should be < 1 for arbitrage)" },
              potentialEdge: { type: "number" },
              edgePercent: { type: "string" },
              liquidity: { type: "number" },
              note: { type: "string" },
            },
          },
        },
        wideSpreadMarkets: {
          type: "array",
          description: "Markets with wide bid-ask spreads (potential for limit order profits)",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
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
            averageSpreadCents: { type: "number" },
            summaryNote: { type: "string" },
          },
        },
        methodology: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["scannedMarkets", "arbitrageOpportunities", "summary", "methodology"],
    },
  },

  {
    name: "find_trading_opportunities",
    description:
      "🎯 THE GO-TO TOOL for finding genuine Polymarket trading opportunities. Scans for: (1) Asymmetric upside - cheap YES/NO positions with huge potential payoff, (2) Volume momentum - markets with surging activity, (3) Value plays - potential mispricings based on market characteristics, (4) Near resolution - markets about to resolve where conviction pays. Returns ACTIONABLE opportunities ranked by quality. If no good opportunities exist, says so honestly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        strategy: {
          type: "string",
          enum: ["all", "asymmetric_upside", "momentum", "value", "near_resolution"],
          description: "Which strategy to focus on. Default: 'all' scans everything",
        },
        category: {
          type: "string",
          description: "Filter by category (politics, crypto, sports, etc.)",
        },
        minLiquidity: {
          type: "number",
          description: "Minimum liquidity in USD (default: 1000). Higher = more reliable exits",
        },
        riskTolerance: {
          type: "string",
          enum: ["conservative", "moderate", "aggressive"],
          description: "Risk tolerance affects which opportunities are shown. Default: moderate",
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
            bestOpportunityType: { type: "string" },
            marketConditions: { type: "string" },
          },
        },
        opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              market: { type: "string" },
              conditionId: { type: "string" },
              slug: { type: "string" },
              opportunityType: {
                type: "string",
                enum: ["asymmetric_upside", "momentum", "value", "near_resolution", "contrarian"],
              },
              signal: { type: "string" },
              currentPrice: { type: "number" },
              suggestedSide: { type: "string", enum: ["YES", "NO", "EITHER"] },
              potentialReturn: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              riskFactors: { type: "array", items: { type: "string" } },
              whyThisOpportunity: { type: "string" },
            },
          },
        },
        noOpportunitiesReason: {
          type: "string",
          description: "If no good opportunities, explains why and what to do instead",
        },
        fetchedAt: { type: "string" },
      },
      required: ["summary", "opportunities"],
    },
  },

  {
    name: "discover_trending_markets",
    description:
      "Find the hottest markets on Polymarket right now. Shows volume spikes, unusual activity, and which markets are seeing the most action. Great for finding what's happening NOW and where the smart money is looking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category (politics, crypto, sports, etc.)",
        },
        sortBy: {
          type: "string",
          enum: ["volume", "liquidity", "price_change"],
          description: "How to rank trending markets",
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
        marketSummary: { type: "string", description: "Overall market conditions summary" },
        trendingMarkets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              title: { type: "string" },
              slug: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number" },
              priceDirection: { type: "string" },
              volume24h: { type: "number" },
              volumeVsAverage: { type: "string" },
              liquidity: { type: "number" },
              trendScore: { type: "number" },
              category: { type: "string" },
              signal: { type: "string" },
              whyTrending: { type: "string" },
            },
          },
        },
        categories: {
          type: "object",
          description: "Breakdown by category",
        },
        totalActive: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["marketSummary", "trendingMarkets"],
    },
  },

  {
    name: "analyze_my_positions",
    description:
      "Analyze your Polymarket positions with exit liquidity simulation, P&L calculation, " +
      "and personalized recommendations. Requires portfolio context to be injected by the app.",

    inputSchema: {
      type: "object" as const,
      // ⭐ Context requirements embedded in inputSchema (JSON Schema extension)
      // The MCP protocol strips custom top-level fields, but inputSchema is preserved.
      // The Context platform reads this to inject user's Polymarket portfolio data.
      "x-context-requirements": ["polymarket"] as const,
      properties: {
        portfolio: {
          type: "object",
          description: "Your Polymarket portfolio context (injected by the Context app)",
          properties: {
            walletAddress: { type: "string" },
            positions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  conditionId: { type: "string" },
                  tokenId: { type: "string" },
                  outcome: { type: "string", enum: ["YES", "NO"] },
                  shares: { type: "number" },
                  avgEntryPrice: { type: "number" },
                  marketTitle: { type: "string" },
                },
              },
            },
            openOrders: { type: "array" },
            totalValue: { type: "number" },
            fetchedAt: { type: "string" },
          },
          required: ["walletAddress", "positions"],
        },
        focus_market: {
          type: "string",
          description: "Optional: specific conditionId to focus analysis on",
        },
      },
      required: ["portfolio"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string" },
        totalPositions: { type: "number" },
        portfolioSummary: {
          type: "object",
          properties: {
            totalValue: { type: "number" },
            totalUnrealizedPnL: { type: "number" },
            totalUnrealizedPnLPercent: { type: "number" },
            riskyPositions: { type: "number", description: "Positions with poor exit liquidity" },
          },
        },
        positionAnalyses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              conditionId: { type: "string" },
              marketTitle: { type: "string" },
              outcome: { type: "string" },
              shares: { type: "number" },
              avgEntryPrice: { type: "number" },
              currentPrice: { type: "number" },
              unrealizedPnL: { type: "number" },
              unrealizedPnLPercent: { type: "number" },
              positionValue: { type: "number" },
              exitLiquidity: {
                type: "object",
                properties: {
                  estimatedSlippage: { type: "number" },
                  canExitCleanly: { type: "boolean" },
                  liquidityScore: { type: "string" },
                },
              },
              recommendation: { type: "string" },
            },
          },
        },
        overallRecommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "totalPositions", "portfolioSummary", "positionAnalyses"],
    },
  },

  // ==================== TIER 2: RAW DATA TOOLS ====================

  {
    name: "get_events",
    description: "Get list of events (markets) from Polymarket with optional filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        active: {
          type: "boolean",
          description: "Filter to active events only (default: true)",
        },
        closed: {
          type: "boolean",
          description: "Include closed events (default: false)",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 50, max: 100)",
        },
        offset: {
          type: "number",
          description: "Pagination offset",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        events: { type: "array" },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["events", "count"],
    },
  },

  {
    name: "get_event_by_slug",
    description: "Get detailed information about a specific event by its slug. Returns event metadata and all associated markets with their token IDs for trading.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The event slug from the Polymarket URL (e.g., 'maduro-out-in-2025')",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        event: {
          type: "object",
          description: "The event (parent container for markets)",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            category: { type: "string" },
            resolutionSource: { type: "string" },
            startDate: { type: "string" },
            endDate: { type: "string" },
            volume: { type: "number" },
            liquidity: { type: "number" },
            active: { type: "boolean" },
            closed: { type: "boolean" },
          },
        },
        markets: {
          type: "array",
          description: "Array of markets (betting questions) within this event",
          items: {
            type: "object",
            properties: {
              conditionId: { type: "string", description: "Unique market identifier" },
              question: { type: "string", description: "The market question" },
              outcomePrices: {
                type: "array",
                items: { type: "string" },
                description: "Current prices as strings [yesPrice, noPrice]",
              },
              volume: { type: "number" },
              liquidity: { type: "number" },
              tokens: {
                type: "array",
                description: "Outcome tokens for this market (YES and NO)",
                items: {
                  type: "object",
                  properties: {
                    token_id: { type: "string", description: "Token ID for trading and price lookups. Use this to look up prices via get_prices." },
                    outcome: { type: "string", description: "YES or NO" },
                  },
                },
              },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["event", "markets"],
    },
  },

  {
    name: "get_orderbook",
    description: "Get the Level 2 orderbook for a specific token. Use merged=true to see the full orderbook including synthetic liquidity (matches Polymarket UI). Raw orderbook only shows direct orders and may appear to have very wide spreads.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: {
          type: "string",
          description: "The token ID to get orderbook for",
        },
        merged: {
          type: "boolean",
          description: "If true, returns merged orderbook combining direct + synthetic liquidity from complement token. This matches what Polymarket UI shows. Default: false (raw orderbook)",
        },
      },
      required: ["tokenId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        assetId: { type: "string" },
        view: { type: "string", description: "'raw' or 'merged'" },
        bids: { type: "array", description: "Bid orders sorted by price descending" },
        asks: { type: "array", description: "Ask orders sorted by price ascending" },
        bestBid: { type: "number" },
        bestAsk: { type: "number" },
        midPrice: { type: "number" },
        spread: { type: "number" },
        spreadCents: { type: "number", description: "Spread in cents (only for merged view)" },
        fetchedAt: { type: "string" },
      },
      required: ["assetId", "bids", "asks"],
    },
  },

  {
    name: "get_prices",
    description: "Get current prices for one or more tokens.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of token IDs to get prices for",
        },
      },
      required: ["tokenIds"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        prices: {
          type: "object",
          description: "Map of token_id (string) to price info. Keys are the token_id strings from get_event_by_slug.",
          additionalProperties: {
            type: "object",
            properties: {
              buy: { type: "number", description: "Best buy price (what you pay to buy YES/NO)" },
              sell: { type: "number", description: "Best sell price (what you receive when selling)" },
              mid: { type: "number", description: "Mid price between buy and sell" },
              spread: { type: "number", description: "Spread between buy and sell" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["prices"],
    },
  },

  {
    name: "get_price_history",
    description: "Get historical price data for a market.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: {
          type: "string",
          description: "The token ID (CLOB market ID)",
        },
        interval: {
          type: "string",
          enum: ["1m", "1h", "6h", "1d", "1w", "max"],
          description: "Time interval",
        },
        fidelity: {
          type: "number",
          description: "Resolution in minutes",
        },
      },
      required: ["tokenId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string" },
        history: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              price: { type: "number" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            high: { type: "number" },
            low: { type: "number" },
            change: { type: "number" },
            changePercent: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["tokenId", "history"],
    },
  },

  {
    name: "search_markets",
    description: "Search for markets by keyword or category.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        category: {
          type: "string",
          description: "Filter by category",
        },
        active: {
          type: "boolean",
          description: "Filter to active markets only",
        },
        limit: {
          type: "number",
          description: "Number of results",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        results: { type: "array" },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["results", "count"],
    },
  },
];

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "polymarket-intelligence", version: "1.0.0" },
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
        case "analyze_market_liquidity":
          return await handleAnalyzeMarketLiquidity(args);
        case "check_market_efficiency":
          return await handleCheckMarketEfficiency(args);
        case "analyze_whale_flow":
          return await handleAnalyzeWhaleFlow(args);
        case "find_correlated_markets":
          return await handleFindCorrelatedMarkets(args);
        case "check_market_rules":
          return await handleCheckMarketRules(args);
        case "find_arbitrage_opportunities":
          return await handleFindArbitrageOpportunities(args);
        case "find_trading_opportunities":
          return await handleFindTradingOpportunities(args);
        case "discover_trending_markets":
          return await handleDiscoverTrendingMarkets(args);
        case "analyze_my_positions":
          return await handleAnalyzeMyPositions(args);

        // Tier 2: Raw Data Tools
        case "get_events":
          return await handleGetEvents(args);
        case "get_event_by_slug":
          return await handleGetEventBySlug(args);
        case "get_orderbook":
          return await handleGetOrderbook(args);
        case "get_prices":
          return await handleGetPrices(args);
        case "get_price_history":
          return await handleGetPriceHistory(args);
        case "search_markets":
          return await handleSearchMarkets(args);

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

/**
 * Parse JSON string or return array as-is
 * Polymarket API returns some fields as JSON strings (e.g., clobTokenIds, outcomePrices)
 */
function parseJsonArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function fetchGamma(endpoint: string): Promise<unknown> {
  const url = `${GAMMA_API_URL}${endpoint}`;
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gamma API error (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function fetchClob(endpoint: string, options?: RequestInit): Promise<unknown> {
  const url = `${CLOB_API_URL}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CLOB API error (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function fetchClobPost(endpoint: string, body: unknown): Promise<unknown> {
  return fetchClob(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ============================================================================
// TIER 1: INTELLIGENCE TOOL HANDLERS
// ============================================================================

async function handleAnalyzeMarketLiquidity(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenId = args?.tokenId as string;
  const conditionId = args?.conditionId as string;

  if (!tokenId && !conditionId) {
    return errorResult("Either tokenId or conditionId is required");
  }

  let yesTokenId = tokenId;
  let noTokenId = "";

  // Get both token IDs - we need both to calculate synthetic liquidity
  if (conditionId) {
    const market = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
    yesTokenId = market.tokens?.[0]?.token_id || tokenId;
    noTokenId = market.tokens?.[1]?.token_id || "";
  }

  if (!yesTokenId) {
    return errorResult("Could not resolve token ID");
  }

  // Fetch orderbook for this token first
  const yesOrderbook = (await fetchClob(`/book?token_id=${yesTokenId}`)) as OrderbookResponse;
  
  // If we don't have the complement token yet, try to get it from the market
  if (!noTokenId && yesOrderbook.market) {
    try {
      const market = (await fetchClob(`/markets/${yesOrderbook.market}`)) as ClobMarket;
      if (market?.tokens) {
        const otherToken = market.tokens.find((t: { token_id: string }) => t.token_id !== yesTokenId);
        if (otherToken) {
          noTokenId = otherToken.token_id;
        }
      }
    } catch {
      // Continue without complement token
    }
  }
  let noOrderbook: OrderbookResponse | null = null;
  
  if (noTokenId) {
    try {
      noOrderbook = (await fetchClob(`/book?token_id=${noTokenId}`)) as OrderbookResponse;
    } catch {
      // Continue without NO orderbook
    }
  }

  // Build MERGED orderbook combining direct + synthetic liquidity
  // Polymarket UI shows this merged view
  const mergedBids: Array<{ price: number; size: number; source: string }> = [];
  const mergedAsks: Array<{ price: number; size: number; source: string }> = [];

  // Direct YES bids
  for (const bid of yesOrderbook.bids || []) {
    mergedBids.push({ price: Number(bid.price), size: Number(bid.size), source: "direct" });
  }

  // Direct YES asks
  for (const ask of yesOrderbook.asks || []) {
    mergedAsks.push({ price: Number(ask.price), size: Number(ask.size), source: "direct" });
  }

  // Synthetic liquidity from NO orderbook
  if (noOrderbook) {
    // NO asks create synthetic YES bids: sell NO at X% → buy YES at (1-X)%
    // e.g., NO ask at 93¢ → YES bid at 7¢
    for (const ask of noOrderbook.asks || []) {
      const syntheticYesBid = 1 - Number(ask.price);
      if (syntheticYesBid > 0 && syntheticYesBid < 1) {
        mergedBids.push({ price: syntheticYesBid, size: Number(ask.size), source: "synthetic" });
      }
    }

    // NO bids create synthetic YES asks: buy NO at X% → sell YES at (1-X)%
    // e.g., NO bid at 92¢ → YES ask at 8¢
    for (const bid of noOrderbook.bids || []) {
      const syntheticYesAsk = 1 - Number(bid.price);
      if (syntheticYesAsk > 0 && syntheticYesAsk < 1) {
        mergedAsks.push({ price: syntheticYesAsk, size: Number(bid.size), source: "synthetic" });
      }
    }
  }

  // Sort merged orderbooks: bids high-to-low, asks low-to-high
  mergedBids.sort((a, b) => b.price - a.price);
  mergedAsks.sort((a, b) => a.price - b.price);

  // Get current price from /prices endpoint
  let currentPrice = 0.5;
  try {
    const pricesResp = (await fetchClobPost("/prices", [
      { token_id: yesTokenId, side: "BUY" },
    ])) as Record<string, { BUY?: string } | string>;
    
    const priceData = pricesResp[yesTokenId];
    if (priceData) {
      currentPrice = typeof priceData === "object" && priceData.BUY 
        ? Number(priceData.BUY) 
        : Number(priceData);
    }
  } catch {
    // Fall back to merged orderbook mid
    const bestBid = mergedBids.length > 0 ? mergedBids[0].price : 0;
    const bestAsk = mergedAsks.length > 0 ? mergedAsks[0].price : 1;
    currentPrice = (bestBid + bestAsk) / 2;
  }

  // Calculate spread from MERGED orderbook (this is what users see)
  const bestBid = mergedBids.length > 0 ? mergedBids[0].price : 0;
  const bestAsk = mergedAsks.length > 0 ? mergedAsks[0].price : 1;
  const spread = bestAsk - bestBid;
  const spreadBps = currentPrice > 0 ? (spread / currentPrice) * 10000 : 0;

  // Calculate depth from merged orderbook
  let totalBidDepthUsd = 0;
  let totalAskDepthUsd = 0;

  for (const bid of mergedBids) {
    totalBidDepthUsd += bid.size * bid.price;
  }

  for (const ask of mergedAsks) {
    totalAskDepthUsd += ask.size * ask.price;
  }

  // Whale cost simulation using MERGED bids
  const whaleCost = {
    sell1k: simulateSellMerged(mergedBids, 1000, currentPrice),
    sell5k: simulateSellMerged(mergedBids, 5000, currentPrice),
    sell10k: simulateSellMerged(mergedBids, 10000, currentPrice),
  };

  // Determine liquidity score
  let liquidityScore: string;
  const totalDepth = totalBidDepthUsd + totalAskDepthUsd;
  const slippage5k = whaleCost.sell5k.slippagePercent;
  const slippage1k = whaleCost.sell1k.slippagePercent;

  if (slippage5k < 2 && spread < 0.02) {
    liquidityScore = "excellent";
  } else if (slippage5k < 5 && spread < 0.03) {
    liquidityScore = "good";
  } else if (slippage5k < 10 && spread < 0.05) {
    liquidityScore = "moderate";
  } else if (slippage1k < 20) {
    liquidityScore = "poor";
  } else {
    liquidityScore = "illiquid";
  }

  // Generate recommendation
  let recommendation: string;
  if (liquidityScore === "excellent") {
    recommendation = `Excellent liquidity. Spread: ${(spread * 100).toFixed(0)}¢. Exit $5k with ~${slippage5k.toFixed(1)}% slippage.`;
  } else if (liquidityScore === "good") {
    recommendation = `Good liquidity. Spread: ${(spread * 100).toFixed(0)}¢. Exit $1k: ~${slippage1k.toFixed(1)}% slippage, $5k: ~${slippage5k.toFixed(1)}%.`;
  } else if (liquidityScore === "moderate") {
    recommendation = `Moderate liquidity. Consider limit orders. $1k exit: ~${slippage1k.toFixed(1)}% slippage.`;
  } else {
    recommendation = `Low liquidity. Exit $1k would cost ~${slippage1k.toFixed(1)}% in slippage. Use limit orders.`;
  }

  return successResult({
    market: yesOrderbook.market || conditionId,
    tokenId: yesTokenId,
    currentPrice: Number(currentPrice.toFixed(4)),
    spread: {
      bestBid: Number(bestBid.toFixed(4)),
      bestAsk: Number(bestAsk.toFixed(4)),
      spreadCents: Number((spread * 100).toFixed(1)),
      spreadBps: Number(spreadBps.toFixed(1)),
    },
    depth: {
      bidDepthUsd: Number(totalBidDepthUsd.toFixed(2)),
      askDepthUsd: Number(totalAskDepthUsd.toFixed(2)),
      totalDepthUsd: Number((totalBidDepthUsd + totalAskDepthUsd).toFixed(2)),
      note: "Includes synthetic liquidity from complement token",
    },
    whaleCost,
    liquidityScore,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Simulate selling on the MERGED orderbook (direct + synthetic liquidity)
 */
function simulateSellMerged(
  mergedBids: Array<{ price: number; size: number; source: string }>,
  usdAmount: number,
  currentPrice: number
): { amountFilled: number; avgPrice: number; worstPrice: number; slippagePercent: number; canFill: boolean } {
  if (mergedBids.length === 0 || currentPrice <= 0) {
    return {
      amountFilled: 0,
      avgPrice: 0,
      worstPrice: 0,
      slippagePercent: 100,
      canFill: false,
    };
  }

  let remainingUsd = usdAmount;
  let totalShares = 0;
  let worstPrice = currentPrice;

  for (const bid of mergedBids) {
    if (remainingUsd <= 0) break;

    const levelValueUsd = bid.size * bid.price;
    const fillValueUsd = Math.min(remainingUsd, levelValueUsd);
    const fillShares = fillValueUsd / bid.price;

    totalShares += fillShares;
    remainingUsd -= fillValueUsd;
    worstPrice = bid.price;
  }

  const filledAmount = usdAmount - remainingUsd;
  const avgPrice = totalShares > 0 ? filledAmount / totalShares : 0;
  
  // Slippage from current price (what you expect to get)
  const slippagePercent = currentPrice > 0 ? ((currentPrice - avgPrice) / currentPrice) * 100 : 0;

  return {
    amountFilled: Number(filledAmount.toFixed(2)),
    avgPrice: Number(avgPrice.toFixed(4)),
    worstPrice: Number(worstPrice.toFixed(4)),
    slippagePercent: Number(Math.max(0, slippagePercent).toFixed(1)),
    canFill: remainingUsd <= 0,
  };
}

async function handleCheckMarketEfficiency(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const slug = args?.slug as string;

  if (!conditionId && !slug) {
    return errorResult("Either conditionId or slug is required");
  }

  // Get market data
  let market: GammaMarket | undefined;

  if (slug) {
    const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
    if (!event || !event.markets || event.markets.length === 0) {
      return errorResult(`Event not found: ${slug}`);
    }
    market = event.markets[0];
  } else {
    // Query by conditionId - need to search through events since direct query is unreliable
    // First try to find the market in active events
    const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
    for (const event of events) {
      const found = event.markets?.find(m => m.conditionId === conditionId);
      if (found) {
        market = found;
        break;
      }
    }
    
    // If not found in active events, try closed events
    if (!market) {
      const closedEvents = (await fetchGamma(`/events?closed=true&limit=50`)) as GammaEvent[];
      for (const event of closedEvents) {
        const found = event.markets?.find(m => m.conditionId === conditionId);
        if (found) {
          market = found;
          break;
        }
      }
    }
    
    if (!market) {
      return errorResult(`Market not found for conditionId: ${conditionId}. Try using 'slug' parameter instead.`);
    }
  }

  // Get prices for all outcome tokens
  const outcomes: Array<{
    name: string;
    tokenId: string;
    price: number;
    impliedProbability: number;
  }> = [];

  // For binary markets - parse clobTokenIds and outcomePrices (may be JSON strings)
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const gammaPrices = parseJsonArray(market.outcomePrices);
  const yesToken = tokenIds[0];
  const noToken = tokenIds[1];

  if (yesToken && noToken) {
    let yesPrice = 0;
    let noPrice = 0;
    let usedClobPrices = false;

    // Try to get live prices from CLOB API (correct format: array of objects)
    try {
      const pricesResp = (await fetchClobPost("/prices", [
        { token_id: yesToken, side: "BUY" },
        { token_id: noToken, side: "BUY" },
      ])) as Record<string, { BUY?: string } | string>;

      // CLOB API response format: { "tokenId": { "BUY": "0.95" } } or { "tokenId": "0.95" }
      const yesData = pricesResp[yesToken];
      const noData = pricesResp[noToken];
      
      if (yesData) {
        yesPrice = typeof yesData === "object" && yesData.BUY 
          ? Number(yesData.BUY) 
          : Number(yesData);
        usedClobPrices = !isNaN(yesPrice) && yesPrice > 0;
      }
      if (noData) {
        noPrice = typeof noData === "object" && noData.BUY 
          ? Number(noData.BUY) 
          : Number(noData);
      }
    } catch {
      // CLOB API error - will fall back to Gamma prices
    }

    // Fall back to Gamma API prices if CLOB failed or returned invalid data
    if (!usedClobPrices || isNaN(yesPrice) || isNaN(noPrice) || (yesPrice === 0 && noPrice === 0)) {
      if (gammaPrices.length >= 2) {
        yesPrice = parseFloat(gammaPrices[0]) || 0;
        noPrice = parseFloat(gammaPrices[1]) || 0;
      }
    }

    // Final fallback to 0.5 if still no valid prices
    if (isNaN(yesPrice) || yesPrice === 0) yesPrice = 0.5;
    if (isNaN(noPrice) || noPrice === 0) noPrice = 0.5;

    outcomes.push(
      { name: "YES", tokenId: yesToken, price: yesPrice, impliedProbability: yesPrice * 100 },
      { name: "NO", tokenId: noToken, price: noPrice, impliedProbability: noPrice * 100 }
    );
  }

  // Calculate market efficiency
  const sumOfOutcomes = outcomes.reduce((sum, o) => sum + o.price, 0);
  const vig = sumOfOutcomes - 1;
  const vigBps = vig * 10000;

  let efficiency: string;
  if (Math.abs(vig) < 0.005) {
    efficiency = "excellent";
  } else if (Math.abs(vig) < 0.02) {
    efficiency = "good";
  } else if (Math.abs(vig) < 0.05) {
    efficiency = "fair";
  } else if (vig > 0) {
    efficiency = "poor";
  } else {
    efficiency = "exploitable";
  }

  // Calculate true probabilities (vig-adjusted)
  const trueProbabilities: Record<string, number> = {};
  for (const outcome of outcomes) {
    trueProbabilities[outcome.name] = Number(
      ((outcome.price / sumOfOutcomes) * 100).toFixed(2)
    );
  }

  // Generate recommendation
  let recommendation: string;
  if (vig < -0.01) {
    recommendation = `🚨 Arbitrage opportunity! Sum of prices is ${sumOfOutcomes.toFixed(4)}. Buy all outcomes for guaranteed profit.`;
  } else if (vig > 0.05) {
    recommendation = `⚠️ High vig (${(vig * 100).toFixed(1)}%). Spread is eating potential edge. Consider waiting for better prices.`;
  } else if (vig > 0.02) {
    recommendation = `Moderate vig (${(vig * 100).toFixed(1)}%). Account for this when sizing positions.`;
  } else {
    recommendation = "Market is efficiently priced. Edge must come from superior information.";
  }

  // Try to get spread info from merged orderbook
  let spreadInfo: { bidAskSpread: number; spreadCents: number } | null = null;
  try {
    const tokenIds = parseJsonArray(market.clobTokenIds);
    if (tokenIds[0] && tokenIds[1]) {
      const yesBook = (await fetchClob(`/book?token_id=${tokenIds[0]}`)) as OrderbookResponse;
      const noBook = (await fetchClob(`/book?token_id=${tokenIds[1]}`)) as OrderbookResponse;
      
      // Build merged orderbook for YES token
      const mergedBids: number[] = [];
      const mergedAsks: number[] = [];
      
      // Synthetic YES bids from NO asks
      for (const ask of noBook.asks || []) {
        const synthetic = 1 - Number(ask.price);
        if (synthetic > 0 && synthetic < 1) mergedBids.push(synthetic);
      }
      // Synthetic YES asks from NO bids  
      for (const bid of noBook.bids || []) {
        const synthetic = 1 - Number(bid.price);
        if (synthetic > 0 && synthetic < 1) mergedAsks.push(synthetic);
      }
      
      mergedBids.sort((a, b) => b - a);
      mergedAsks.sort((a, b) => a - b);
      
      if (mergedBids.length > 0 && mergedAsks.length > 0) {
        const spread = mergedAsks[0] - mergedBids[0];
        spreadInfo = {
          bidAskSpread: Number(spread.toFixed(4)),
          spreadCents: Number((spread * 100).toFixed(1)),
        };
      }
    }
  } catch {
    // Spread info unavailable
  }

  return successResult({
    market: market.question || market.title || "Unknown",
    conditionId: market.conditionId || conditionId,
    outcomes,
    marketEfficiency: {
      sumOfOutcomes: Number(sumOfOutcomes.toFixed(4)),
      vig: Number(vig.toFixed(4)),
      vigBps: Number(vigBps.toFixed(1)),
      isEfficient: Math.abs(vig) < 0.02,
      efficiency,
    },
    spreadInfo,
    trueProbabilities,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeWhaleFlow(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const tokenId = args?.tokenId as string;
  const hoursBack = (args?.hoursBack as number) || 24;

  if (!conditionId && !tokenId) {
    return errorResult("Either conditionId or tokenId is required");
  }

  // Fetch trades - note: this endpoint may require authentication
  // For now, we'll use the public endpoint with limited data
  const tradeParams: Record<string, string> = {};
  if (conditionId) tradeParams.market = conditionId;
  if (tokenId) tradeParams.asset_id = tokenId;

  let trades: TradeResponse[] = [];
  try {
    const queryString = new URLSearchParams(tradeParams).toString();
    const tradesResp = (await fetchClob(`/trades?${queryString}`)) as TradeResponse[];
    trades = tradesResp || [];
  } catch {
    // If trades endpoint fails, return limited analysis
    return successResult({
      market: conditionId || tokenId,
      period: `Last ${hoursBack} hours`,
      totalTrades: 0,
      totalVolume: 0,
      flowBySize: {
        small: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
        medium: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
        whale: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
      },
      whaleActivity: {
        netWhaleVolume: 0,
        sentiment: "neutral",
        largestTrade: null,
      },
      divergence: "Insufficient data - trades endpoint may require authentication",
      fetchedAt: new Date().toISOString(),
    });
  }

  // Filter by time
  const cutoffTime = Date.now() - hoursBack * 60 * 60 * 1000;
  const recentTrades = trades.filter((t) => {
    const tradeTime = Number(t.match_time || t.timestamp || 0) * 1000;
    return tradeTime > cutoffTime;
  });

  // Bucket trades by size
  const buckets = {
    small: { count: 0, buyVolume: 0, sellVolume: 0 },
    medium: { count: 0, buyVolume: 0, sellVolume: 0 },
    whale: { count: 0, buyVolume: 0, sellVolume: 0 },
  };

  let largestTrade: { size: number; side: string; price: number } | null = null;

  for (const trade of recentTrades) {
    const size = Number(trade.size || 0);
    const price = Number(trade.price || 0);
    const notional = size * price;
    const side = trade.side?.toLowerCase() || "buy";

    let bucket: keyof typeof buckets;
    if (notional < 50) {
      bucket = "small";
    } else if (notional < 500) {
      bucket = "medium";
    } else {
      bucket = "whale";
    }

    buckets[bucket].count++;
    if (side === "buy" || side === "b") {
      buckets[bucket].buyVolume += notional;
    } else {
      buckets[bucket].sellVolume += notional;
    }

    if (!largestTrade || notional > largestTrade.size) {
      largestTrade = { size: notional, side, price };
    }
  }

  // Calculate net flows and sentiments
  const flowBySize: Record<string, unknown> = {};
  for (const [bucket, data] of Object.entries(buckets)) {
    const netFlow = data.buyVolume - data.sellVolume;
    let sentiment: string;
    if (Math.abs(netFlow) < 100) {
      sentiment = "neutral";
    } else if (netFlow > 0) {
      sentiment = "bullish";
    } else {
      sentiment = "bearish";
    }

    flowBySize[bucket] = {
      count: data.count,
      buyVolume: Number(data.buyVolume.toFixed(2)),
      sellVolume: Number(data.sellVolume.toFixed(2)),
      netFlow: Number(netFlow.toFixed(2)),
      sentiment,
    };
  }

  // Whale activity summary
  const whaleNetFlow = buckets.whale.buyVolume - buckets.whale.sellVolume;
  let whaleSentiment: "bullish" | "bearish" | "neutral";
  if (Math.abs(whaleNetFlow) < 500) {
    whaleSentiment = "neutral";
  } else if (whaleNetFlow > 0) {
    whaleSentiment = "bullish";
  } else {
    whaleSentiment = "bearish";
  }

  // Check for divergence
  const retailNetFlow = buckets.small.buyVolume - buckets.small.sellVolume;
  const retailSentiment = retailNetFlow > 100 ? "buying" : retailNetFlow < -100 ? "selling" : "neutral";
  const whaleBehavior = whaleNetFlow > 500 ? "buying" : whaleNetFlow < -500 ? "selling" : "neutral";

  let divergence: string;
  if (retailSentiment === "selling" && whaleBehavior === "buying") {
    divergence = "🐋 Divergence detected: Retail is selling, but whales are buying YES";
  } else if (retailSentiment === "buying" && whaleBehavior === "selling") {
    divergence = "🐋 Divergence detected: Retail is buying, but whales are selling";
  } else if (whaleBehavior !== "neutral") {
    divergence = `Whale flow is ${whaleBehavior}, aligned with retail`;
  } else {
    divergence = "No significant whale activity detected";
  }

  const totalVolume = Object.values(buckets).reduce(
    (sum, b) => sum + b.buyVolume + b.sellVolume,
    0
  );

  return successResult({
    market: conditionId || tokenId,
    period: `Last ${hoursBack} hours`,
    totalTrades: recentTrades.length,
    totalVolume: Number(totalVolume.toFixed(2)),
    flowBySize,
    whaleActivity: {
      netWhaleVolume: Number(whaleNetFlow.toFixed(2)),
      sentiment: whaleSentiment,
      largestTrade,
    },
    divergence,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleFindCorrelatedMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const slug = args?.slug as string;

  if (!conditionId && !slug) {
    return errorResult("Either conditionId or slug is required");
  }

  // Get the source market
  let sourceEvent: GammaEvent;

  if (slug) {
    sourceEvent = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
  } else {
    // Query market by conditionId first, then get its event
    const markets = (await fetchGamma(`/markets?condition_id=${conditionId}`)) as Array<GammaMarket & { eventSlug?: string }>;
    if (markets?.[0]?.eventSlug) {
      sourceEvent = (await fetchGamma(`/events/slug/${markets[0].eventSlug}`)) as GammaEvent;
    } else {
      // Fallback: search in active events for a market with this conditionId
      const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
      sourceEvent = events.find(e => 
        e.markets?.some(m => m.conditionId === conditionId)
      ) as GammaEvent;
    }
  }

  if (!sourceEvent) {
    return errorResult("Source market not found");
  }

  const sourceTags = sourceEvent.tags?.map((t) => t.slug || t.label) || [];
  const sourceCategory = sourceEvent.category || "";
  const sourceTitle = sourceEvent.title || "";

  // Fetch markets in same category
  const relatedEvents = (await fetchGamma(
    `/events?closed=false&limit=50${sourceCategory ? `&category=${sourceCategory}` : ""}`
  )) as GammaEvent[];

  const correlatedMarkets: Array<{
    title: string;
    conditionId: string;
    correlationType: string;
    correlationScore: number;
    currentPrice: number | null;
    hedgeNote: string;
  }> = [];

  for (const event of relatedEvents) {
    if (event.id === sourceEvent.id) continue;

    const eventTags = event.tags?.map((t) => t.slug || t.label) || [];
    const eventTitle = event.title || "";

    // Calculate correlation score
    let correlationScore = 0;
    let correlationType = "none";

    // Same category bonus
    if (event.category === sourceCategory) {
      correlationScore += 30;
      correlationType = "same_category";
    }

    // Shared tags
    const sharedTags = sourceTags.filter((t) => eventTags.includes(t));
    if (sharedTags.length > 0) {
      correlationScore += sharedTags.length * 20;
      correlationType = "same_tags";
    }

    // Title similarity (simple word overlap)
    const sourceWords = new Set(sourceTitle.toLowerCase().split(/\s+/));
    const eventWords = eventTitle.toLowerCase().split(/\s+/);
    const sharedWords = eventWords.filter((w) => sourceWords.has(w) && w.length > 3);
    if (sharedWords.length > 0) {
      correlationScore += sharedWords.length * 15;
      if (correlationType === "none") correlationType = "title_similarity";
    }

    // Same parent event
    if (event.parentEvent === sourceEvent.id || sourceEvent.parentEvent === event.id) {
      correlationScore = 100;
      correlationType = "same_event";
    }

    if (correlationScore > 20) {
      // Generate hedge note
      let hedgeNote = "";
      if (correlationScore > 80) {
        hedgeNote = "Strongly correlated - consider for hedging";
      } else if (correlationScore > 50) {
        hedgeNote = "Moderately correlated - may move together";
      } else {
        hedgeNote = "Weakly correlated - limited hedging value";
      }

      correlatedMarkets.push({
        title: eventTitle,
        conditionId: event.conditionId || event.id || "",
        correlationType,
        correlationScore,
        currentPrice: null, // Would need additional API call
        hedgeNote,
      });
    }
  }

  // Sort by correlation score
  correlatedMarkets.sort((a, b) => b.correlationScore - a.correlationScore);

  // Generate hedging strategy
  let hedgingStrategy: string;
  if (correlatedMarkets.length === 0) {
    hedgingStrategy = "No correlated markets found for hedging";
  } else if (correlatedMarkets[0].correlationScore > 80) {
    hedgingStrategy = `Consider "${correlatedMarkets[0].title}" as a hedge - strongly correlated`;
  } else {
    hedgingStrategy = `${correlatedMarkets.length} related markets found. Review for hedging opportunities.`;
  }

  return successResult({
    sourceMarket: {
      title: sourceTitle,
      category: sourceCategory,
      tags: sourceTags,
    },
    correlatedMarkets: correlatedMarkets.slice(0, 10),
    hedgingStrategy,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleCheckMarketRules(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  const conditionId = args?.conditionId as string;

  if (!slug && !conditionId) {
    return errorResult("Either slug or conditionId is required");
  }

  // Get the event
  let event: GammaEvent;

  if (slug) {
    event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
  } else {
    // Query market by conditionId first, then get its event
    const markets = (await fetchGamma(`/markets?condition_id=${conditionId}`)) as Array<GammaMarket & { eventSlug?: string }>;
    if (markets?.[0]?.eventSlug) {
      event = (await fetchGamma(`/events/slug/${markets[0].eventSlug}`)) as GammaEvent;
    } else {
      // Fallback: search in active events
      const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
      event = events.find(e => 
        e.markets?.some(m => m.conditionId === conditionId)
      ) as GammaEvent;
    }
  }

  if (!event) {
    return errorResult("Event not found");
  }

  const title = event.title || "";
  const description = event.description || "";
  const resolutionSource = event.resolutionSource || "Not specified";
  const endDate = event.endDate || event.endDateIso || "";

  // Parse rules from description
  const descLower = description.toLowerCase();

  // Extract potential gotchas
  const potentialGotchas: string[] = [];
  const ambiguities: string[] = [];

  // Check for time-sensitive language
  if (descLower.includes("by") || descLower.includes("before") || descLower.includes("deadline")) {
    potentialGotchas.push("Time-sensitive resolution - check exact deadline in description");
  }

  // Check for conditional language
  if (descLower.includes("if and only if") || descLower.includes("must")) {
    potentialGotchas.push("Strict conditions required for YES resolution");
  }

  // Check for partial satisfaction
  if (descLower.includes("partial") || descLower.includes("some")) {
    ambiguities.push("Partial fulfillment may not count - verify resolution criteria");
  }

  // Check for source dependency
  if (descLower.includes("official") || descLower.includes("announced")) {
    potentialGotchas.push("Requires official source/announcement - unofficial reports may not count");
  }

  // Check for edge cases
  if (descLower.includes("tie") || descLower.includes("draw")) {
    potentialGotchas.push("Check how ties/draws are resolved");
  }

  if (descLower.includes("cancel") || descLower.includes("postpone")) {
    potentialGotchas.push("Check resolution if event is cancelled/postponed");
  }

  // Generate summary
  let primaryCondition = title;
  let resolvesYesIf = "Condition in title is met";
  let resolvesNoIf = "Condition in title is not met by end date";

  // Try to extract more specific conditions from description
  const yesMatch = description.match(/resolves?\s+(?:to\s+)?yes\s+if\s+([^.]+)/i);
  const noMatch = description.match(/resolves?\s+(?:to\s+)?no\s+if\s+([^.]+)/i);

  if (yesMatch) resolvesYesIf = yesMatch[1].trim();
  if (noMatch) resolvesNoIf = noMatch[1].trim();

  // Risk factors
  const riskFactors: string[] = [];

  if (potentialGotchas.length > 0) {
    riskFactors.push("Multiple gotchas identified - read rules carefully");
  }

  if (!resolutionSource || resolutionSource === "Not specified") {
    riskFactors.push("Resolution source not clearly specified");
  }

  if (ambiguities.length > 0) {
    riskFactors.push("Ambiguous language in resolution criteria");
  }

  if (endDate) {
    const end = new Date(endDate);
    const now = new Date();
    const daysRemaining = Math.ceil((end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    if (daysRemaining < 0) {
      riskFactors.push("Market has passed end date - resolution pending");
    } else if (daysRemaining < 7) {
      riskFactors.push(`Only ${daysRemaining} days remaining until resolution`);
    }
  }

  return successResult({
    market: title,
    description: description.slice(0, 1000) + (description.length > 1000 ? "..." : ""),
    resolutionSource,
    endDate: endDate || "Not specified",
    rulesSummary: {
      primaryCondition,
      resolvesYesIf,
      resolvesNoIf,
      potentialGotchas,
      ambiguities,
    },
    riskFactors,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleFindArbitrageOpportunities(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string;
  // Limit to 20 markets to avoid timeout - we need to fetch orderbooks
  const limit = Math.min((args?.limit as number) || 20, 30);

  // Step 1: Get top markets by liquidity from Gamma (fast)
  let endpoint = `/events?closed=false&limit=${limit}&order=liquidity&ascending=false`;
  if (category) {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  const arbitrageOpportunities: Array<{
    market: string;
    conditionId: string;
    buyYesAt: number;
    buyNoAt: number;
    totalCost: number;
    potentialEdge: number;
    edgePercent: string;
    liquidity: number;
    note: string;
  }> = [];

  const wideSpreadMarkets: Array<{
    market: string;
    conditionId: string;
    spread: number;
    spreadPercent: string;
    midPrice: number;
  }> = [];

  let marketsAnalyzed = 0;
  let totalSpread = 0;

  // Step 2: For each market, fetch orderbooks and compute MERGED book
  // Polymarket shows synthetic liquidity from complement token
  const marketsToCheck: Array<{
    event: GammaEvent;
    market: GammaMarket;
    yesTokenId: string;
    noTokenId: string;
  }> = [];

  for (const event of events) {
    if (!event.markets || event.markets.length === 0) continue;

    for (const market of event.markets) {
      const tokenIds = parseJsonArray(market.clobTokenIds);
      const gammaPrices = parseJsonArray(market.outcomePrices);
      
      if (tokenIds.length < 2 || gammaPrices.length < 2) continue;
      
      const yesPrice = parseFloat(gammaPrices[0]) || 0;
      // Skip settled markets
      if (yesPrice <= 0 || yesPrice >= 1) continue;

      marketsToCheck.push({
        event,
        market,
        yesTokenId: tokenIds[0],
        noTokenId: tokenIds[1],
      });
    }
  }

  // Fetch orderbooks in parallel (batches of 5 to respect rate limits)
  const batchSize = 5;
  for (let i = 0; i < marketsToCheck.length && i < limit * 2; i += batchSize) {
    const batch = marketsToCheck.slice(i, i + batchSize);
    
    const results = await Promise.all(
      batch.map(async ({ event, market, yesTokenId, noTokenId }) => {
        try {
          // Fetch both orderbooks in parallel
          const [yesBook, noBook] = await Promise.all([
            fetchClob(`/book?token_id=${yesTokenId}`) as Promise<OrderbookResponse>,
            fetchClob(`/book?token_id=${noTokenId}`) as Promise<OrderbookResponse>,
          ]);

          // Build MERGED orderbook for YES token
          // This is what Polymarket UI shows - includes synthetic liquidity
          const mergedYesAsks: number[] = [];
          const mergedYesBids: number[] = [];
          const mergedNoAsks: number[] = [];

          // Direct YES asks
          for (const ask of yesBook.asks || []) {
            mergedYesAsks.push(Number(ask.price));
          }
          // Synthetic YES asks from NO bids: NO bid at X creates YES ask at (1-X)
          for (const bid of noBook.bids || []) {
            const syntheticAsk = 1 - Number(bid.price);
            if (syntheticAsk > 0 && syntheticAsk < 1) {
              mergedYesAsks.push(syntheticAsk);
            }
          }

          // Direct YES bids
          for (const bid of yesBook.bids || []) {
            mergedYesBids.push(Number(bid.price));
          }
          // Synthetic YES bids from NO asks: NO ask at X creates YES bid at (1-X)
          for (const ask of noBook.asks || []) {
            const syntheticBid = 1 - Number(ask.price);
            if (syntheticBid > 0 && syntheticBid < 1) {
              mergedYesBids.push(syntheticBid);
            }
          }

          // Direct NO asks
          for (const ask of noBook.asks || []) {
            mergedNoAsks.push(Number(ask.price));
          }
          // Synthetic NO asks from YES bids
          for (const bid of yesBook.bids || []) {
            const syntheticAsk = 1 - Number(bid.price);
            if (syntheticAsk > 0 && syntheticAsk < 1) {
              mergedNoAsks.push(syntheticAsk);
            }
          }

          // Sort: asks low-to-high, bids high-to-low
          mergedYesAsks.sort((a, b) => a - b);
          mergedYesBids.sort((a, b) => b - a);
          mergedNoAsks.sort((a, b) => a - b);

          const bestYesAsk = mergedYesAsks.length > 0 ? mergedYesAsks[0] : null;
          const bestYesBid = mergedYesBids.length > 0 ? mergedYesBids[0] : null;
          const bestNoAsk = mergedNoAsks.length > 0 ? mergedNoAsks[0] : null;

          return {
            event,
            market,
            bestYesAsk,
            bestYesBid,
            bestNoAsk,
            liquidity: Number(market.liquidity || event.liquidity || 0),
          };
        } catch {
          return null;
        }
      })
    );

    for (const result of results) {
      if (!result || result.bestYesAsk === null || result.bestNoAsk === null) continue;

      marketsAnalyzed++;
      const { event, market, bestYesAsk, bestYesBid, bestNoAsk, liquidity } = result;

      // REAL arbitrage check using MERGED orderbook
      // Can we buy BOTH sides for less than $1?
      const totalCost = bestYesAsk + bestNoAsk;
      
      if (totalCost < 0.995) {
        // Found actual arbitrage!
        const edge = 1 - totalCost;
        arbitrageOpportunities.push({
          market: market.question || event.title || "Unknown",
          conditionId: market.conditionId || "",
          buyYesAt: Number(bestYesAsk.toFixed(4)),
          buyNoAt: Number(bestNoAsk.toFixed(4)),
          totalCost: Number(totalCost.toFixed(4)),
          potentialEdge: Number(edge.toFixed(4)),
          edgePercent: (edge * 100).toFixed(2) + "%",
          liquidity,
          note: `BUY YES @ ${(bestYesAsk * 100).toFixed(1)}¢ + BUY NO @ ${(bestNoAsk * 100).toFixed(1)}¢ = ${(totalCost * 100).toFixed(1)}¢. Guaranteed ${(edge * 100).toFixed(1)}¢ profit per $1.`,
        });
      }

      // Track spread using MERGED orderbook
      if (bestYesBid !== null) {
        const spread = bestYesAsk - bestYesBid;
        totalSpread += spread;
        
        // Wide spread = potential opportunity for limit orders
        if (spread > 0.02) {
          wideSpreadMarkets.push({
            market: market.question || event.title || "Unknown",
            conditionId: market.conditionId || "",
            spread: Number(spread.toFixed(4)),
            spreadPercent: (spread * 100).toFixed(1) + "¢",
            midPrice: Number(((bestYesAsk + bestYesBid) / 2).toFixed(4)),
          });
        }
      }
    }
  }

  // Sort by edge
  arbitrageOpportunities.sort((a, b) => b.potentialEdge - a.potentialEdge);
  wideSpreadMarkets.sort((a, b) => b.spread - a.spread);

  const avgSpread = marketsAnalyzed > 0 ? (totalSpread / marketsAnalyzed) * 100 : 0;

  // Generate summary
  let summaryNote: string;
  if (arbitrageOpportunities.length > 0) {
    summaryNote = `🚨 Found ${arbitrageOpportunities.length} REAL arbitrage opportunities! Buy both YES and NO for guaranteed profit.`;
  } else if (marketsAnalyzed === 0) {
    summaryNote = "⚠️ Could not fetch orderbook data. Try again or reduce limit.";
  } else {
    summaryNote = `✅ No arbitrage found in ${marketsAnalyzed} markets. Polymarket is efficiently priced. Average spread: ${avgSpread.toFixed(1)}¢.`;
  }

  return successResult({
    scannedMarkets: marketsAnalyzed,
    arbitrageOpportunities: arbitrageOpportunities.slice(0, 10),
    wideSpreadMarkets: wideSpreadMarkets.slice(0, 5),
    summary: {
      arbitrageCount: arbitrageOpportunities.length,
      wideSpreadCount: wideSpreadMarkets.length,
      averageSpreadCents: Number(avgSpread.toFixed(2)),
      summaryNote,
    },
    methodology: "Fetched real CLOB orderbooks and checked if BUY YES + BUY NO < $1.00. This is true arbitrage detection using executable prices, not midpoints.",
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Find genuine trading opportunities across multiple strategies
 */
async function handleFindTradingOpportunities(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const strategy = (args?.strategy as string) || "all";
  const category = args?.category as string;
  const minLiquidity = (args?.minLiquidity as number) || 1000;
  const riskTolerance = (args?.riskTolerance as string) || "moderate";

  // Fetch active markets sorted by different criteria
  const [volumeEvents, liquidityEvents, newEvents] = await Promise.all([
    fetchGamma(`/events?closed=false&limit=100&order=volume24hr&ascending=false${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
    fetchGamma(`/events?closed=false&limit=100&order=liquidity&ascending=false${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
    fetchGamma(`/events?closed=false&limit=50&order=startDate&ascending=false${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
  ]);

  // Combine and dedupe events
  const eventMap = new Map<string, GammaEvent>();
  [...volumeEvents, ...liquidityEvents, ...newEvents].forEach(e => {
    if (e.id && !eventMap.has(e.id)) {
      eventMap.set(e.id, e);
    }
  });
  const allEvents = Array.from(eventMap.values());

  const opportunities: Array<{
    rank: number;
    market: string;
    conditionId: string;
    slug: string;
    opportunityType: string;
    signal: string;
    currentPrice: number;
    suggestedSide: string;
    potentialReturn: string;
    confidence: string;
    liquidity: number;
    volume24h: number;
    riskFactors: string[];
    whyThisOpportunity: string;
    score: number; // internal scoring
  }> = [];

  let marketsScanned = 0;

  for (const event of allEvents) {
    if (!event.markets || event.markets.length === 0) continue;

    const eventLiquidity = Number(event.liquidity || 0);
    const eventVolume24h = Number(event.volume24hr || 0);
    const eventSlug = event.slug || "";
    
    for (const market of event.markets) {
      const gammaPrices = parseJsonArray(market.outcomePrices);
      if (gammaPrices.length < 2) continue;

      const yesPrice = parseFloat(gammaPrices[0]) || 0;
      const noPrice = parseFloat(gammaPrices[1]) || 0;
      const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
      const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
      const marketTitle = market.question || event.title || "Unknown";

      if (marketLiquidity < minLiquidity) continue;
      if (yesPrice <= 0 || noPrice <= 0) continue;

      marketsScanned++;

      // ============ STRATEGY 1: ASYMMETRIC UPSIDE ============
      // Look for cheap positions (< 15¢) with potential 6x+ returns
      if (strategy === "all" || strategy === "asymmetric_upside") {
        const cheapThreshold = riskTolerance === "conservative" ? 0.10 : riskTolerance === "aggressive" ? 0.20 : 0.15;
        
        if (yesPrice < cheapThreshold && yesPrice > 0.01) {
          const potentialMultiple = (1 / yesPrice).toFixed(1);
          const riskFactors: string[] = [];
          
          if (marketLiquidity < 5000) riskFactors.push("Low liquidity - hard to exit");
          if (yesPrice < 0.05) riskFactors.push("Very low probability - likely to lose");
          
          let confidence: "high" | "medium" | "low" = "medium";
          if (marketLiquidity > 20000 && marketVolume24h > 5000) confidence = "high";
          if (marketLiquidity < 5000 || yesPrice < 0.05) confidence = "low";

          const score = (marketLiquidity / 1000) + (marketVolume24h / 500) + (yesPrice * 100);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "asymmetric_upside",
            signal: `YES at ${(yesPrice * 100).toFixed(1)}¢ - potential ${potentialMultiple}x return`,
            currentPrice: yesPrice,
            suggestedSide: "YES",
            potentialReturn: `${potentialMultiple}x if YES wins`,
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `Cheap YES position offers asymmetric payoff. Risk ${(yesPrice * 100).toFixed(0)}¢ to potentially win $1. Good for small speculative bets if you have an edge on this outcome.`,
            score,
          });
        }

        // Also check cheap NO positions
        if (noPrice < cheapThreshold && noPrice > 0.01) {
          const potentialMultiple = (1 / noPrice).toFixed(1);
          const riskFactors: string[] = [];
          
          if (marketLiquidity < 5000) riskFactors.push("Low liquidity - hard to exit");
          if (noPrice < 0.05) riskFactors.push("Very low probability - likely to lose");
          
          let confidence: "high" | "medium" | "low" = "medium";
          if (marketLiquidity > 20000 && marketVolume24h > 5000) confidence = "high";
          if (marketLiquidity < 5000 || noPrice < 0.05) confidence = "low";

          const score = (marketLiquidity / 1000) + (marketVolume24h / 500) + (noPrice * 100);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "asymmetric_upside",
            signal: `NO at ${(noPrice * 100).toFixed(1)}¢ - potential ${potentialMultiple}x return`,
            currentPrice: noPrice,
            suggestedSide: "NO",
            potentialReturn: `${potentialMultiple}x if NO wins`,
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `Cheap NO position offers asymmetric payoff. Most people bet YES - this is a contrarian opportunity if you think the market is wrong.`,
            score,
          });
        }
      }

      // ============ STRATEGY 2: MOMENTUM ============
      // High volume relative to liquidity = active market with price discovery
      if (strategy === "all" || strategy === "momentum") {
        const volumeToLiquidityRatio = marketLiquidity > 0 ? marketVolume24h / marketLiquidity : 0;
        
        // High activity threshold
        if (volumeToLiquidityRatio > 0.3 && marketVolume24h > 10000) {
          const riskFactors: string[] = [];
          if (volumeToLiquidityRatio > 1) riskFactors.push("Extremely high volume - news event likely");
          
          let confidence: "high" | "medium" | "low" = "medium";
          if (marketLiquidity > 50000) confidence = "high";

          const score = volumeToLiquidityRatio * 50 + (marketVolume24h / 1000);
          
          // Determine momentum direction based on price
          const suggestedSide = yesPrice > 0.6 ? "YES" : yesPrice < 0.4 ? "NO" : "EITHER";
          
          opportunities.push({
            rank: 0,
            market: marketTitle,
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "momentum",
            signal: `Volume ${(volumeToLiquidityRatio * 100).toFixed(0)}% of liquidity in 24h`,
            currentPrice: yesPrice,
            suggestedSide,
            potentialReturn: suggestedSide === "YES" ? `${((1 - yesPrice) / yesPrice * 100).toFixed(0)}% if YES wins` : suggestedSide === "NO" ? `${((1 - noPrice) / noPrice * 100).toFixed(0)}% if NO wins` : "Depends on direction",
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `High trading activity suggests active price discovery. This market is "hot" - prices may be moving. Good for traders who can source news/information faster than the market.`,
            score,
          });
        }
      }

      // ============ STRATEGY 3: VALUE (Wide spread / inefficient) ============
      // Look for markets where YES + NO doesn't sum to ~1
      if (strategy === "all" || strategy === "value") {
        const sumOfPrices = yesPrice + noPrice;
        const inefficiency = Math.abs(sumOfPrices - 1);
        
        // Market is inefficient if prices don't sum close to 1
        if (inefficiency > 0.03 && marketLiquidity > 5000) {
          const riskFactors: string[] = [];
          
          let signal: string;
          let suggestedSide: string;
          let confidence: "high" | "medium" | "low" = "medium";
          
          if (sumOfPrices < 0.97) {
            // Arbitrage-like opportunity
            signal = `Prices sum to ${(sumOfPrices * 100).toFixed(1)}¢ - under 100¢`;
            suggestedSide = "EITHER";
            confidence = "high";
            riskFactors.push("May be temporary - act quickly");
          } else if (sumOfPrices > 1.05) {
            // Wide spread - one side is probably mispriced
            signal = `Wide spread - prices sum to ${(sumOfPrices * 100).toFixed(1)}¢`;
            suggestedSide = yesPrice > noPrice ? "NO" : "YES"; // Bet on the cheaper side
            confidence = "low";
            riskFactors.push("Wide spread may indicate low liquidity on one side");
          } else {
            continue; // Not interesting enough
          }

          const score = inefficiency * 200 + (marketLiquidity / 1000);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "value",
            signal,
            currentPrice: yesPrice,
            suggestedSide,
            potentialReturn: sumOfPrices < 0.97 ? `${((1 - sumOfPrices) * 100).toFixed(1)}% guaranteed edge` : "Depends on resolution",
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: sumOfPrices < 0.97 
              ? `Market is underpriced! Buy both YES and NO for guaranteed profit when market resolves.`
              : `Market has pricing inefficiency. One side may be overpriced due to sentiment.`,
            score,
          });
        }
      }

      // ============ STRATEGY 4: NEAR RESOLUTION ============
      // Markets ending soon with clear direction
      if (strategy === "all" || strategy === "near_resolution") {
        const endDate = event.endDate || event.endDateIso;
        if (endDate) {
          const end = new Date(endDate);
          const now = new Date();
          const daysRemaining = (end.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
          
          // Markets within 7 days of resolution with strong conviction (< 20% or > 80%)
          if (daysRemaining > 0 && daysRemaining < 7) {
            const strongConviction = yesPrice > 0.80 || yesPrice < 0.20;
            
            if (strongConviction && marketLiquidity > 5000) {
              const riskFactors: string[] = [];
              riskFactors.push(`Resolves in ${daysRemaining.toFixed(1)} days`);
              
              const isYesFavored = yesPrice > 0.5;
              const favoredPrice = isYesFavored ? yesPrice : noPrice;
              const underdogPrice = isYesFavored ? noPrice : yesPrice;
              
              let confidence: "high" | "medium" | "low" = "medium";
              if (favoredPrice > 0.90) confidence = "high";
              if (marketLiquidity < 10000) confidence = "low";

              const score = (1 / daysRemaining) * 10 + (favoredPrice * 50) + (marketLiquidity / 1000);

              // Opportunity: either lock in small profit on favorite, or take contrarian underdog bet
              opportunities.push({
                rank: 0,
                market: marketTitle,
                conditionId: market.conditionId || "",
                slug: eventSlug,
                opportunityType: "near_resolution",
                signal: `Resolves in ${daysRemaining.toFixed(1)} days - ${isYesFavored ? "YES" : "NO"} at ${(favoredPrice * 100).toFixed(0)}%`,
                currentPrice: yesPrice,
                suggestedSide: isYesFavored ? "YES" : "NO",
                potentialReturn: `${((1 - favoredPrice) / favoredPrice * 100).toFixed(0)}% in ${daysRemaining.toFixed(0)} days if market is right`,
                confidence,
                liquidity: marketLiquidity,
                volume24h: marketVolume24h,
                riskFactors,
                whyThisOpportunity: `Market resolves soon with strong conviction. If you agree with the market, lock in ${((1 - favoredPrice) * 100).toFixed(0)}% return. If you think market is wrong, underdog pays ${((1 / underdogPrice) - 1).toFixed(1)}x.`,
                score,
              });
            }
          }
        }
      }
    }
  }

  // Sort by score and assign ranks
  opportunities.sort((a, b) => b.score - a.score);
  opportunities.forEach((opp, idx) => {
    opp.rank = idx + 1;
  });

  // Remove internal score from output and limit results
  const finalOpportunities = opportunities.slice(0, 15).map(({ score, ...rest }) => rest);

  // Generate summary
  const opportunityTypes = opportunities.map(o => o.opportunityType);
  const typeCounts = opportunityTypes.reduce((acc, t) => {
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const bestType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";

  let marketConditions: string;
  if (opportunities.length === 0) {
    marketConditions = "Markets are efficiently priced with no clear edges. Consider waiting for news events or checking less popular markets.";
  } else if (opportunities.length < 3) {
    marketConditions = "Few opportunities available. Markets are relatively efficient.";
  } else if (opportunities.filter(o => o.confidence === "high").length > 3) {
    marketConditions = "Active market with multiple high-confidence opportunities. Good time to trade.";
  } else {
    marketConditions = "Normal market conditions with some speculative opportunities.";
  }

  let noOpportunitiesReason: string | undefined;
  if (opportunities.length === 0) {
    noOpportunitiesReason = 
      "No strong opportunities found. This means: (1) Markets are efficiently priced - prices reflect available information, " +
      "(2) Spreads are tight - no easy arbitrage, (3) Most markets are priced between 20-80% - no cheap asymmetric bets. " +
      "Suggestions: Wait for news events that create mispricings, look at niche/local markets, or focus on markets where you have genuine information edge.";
  }

  return successResult({
    summary: {
      marketsScanned,
      opportunitiesFound: opportunities.length,
      bestOpportunityType: bestType,
      marketConditions,
    },
    opportunities: finalOpportunities,
    ...(noOpportunitiesReason && { noOpportunitiesReason }),
    fetchedAt: new Date().toISOString(),
  });
}

async function handleDiscoverTrendingMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string;
  const sortBy = (args?.sortBy as string) || "volume";
  const limit = Math.min((args?.limit as number) || 20, 50);

  // Fetch active events with volume sorting
  let endpoint = `/events?closed=false&limit=${Math.max(limit * 2, 50)}&order=volume24hr&ascending=false`;
  if (category) {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  const trendingMarkets: Array<{
    rank: number;
    title: string;
    slug: string;
    conditionId: string;
    currentPrice: number;
    priceDirection: string;
    volume24h: number;
    volumeVsAverage: string;
    liquidity: number;
    trendScore: number;
    category: string;
    signal: string;
    whyTrending: string;
  }> = [];

  const categoryBreakdown: Record<string, number> = {};

  for (const event of events) {
    const market = event.markets?.[0];
    if (!market) continue;

    const volume = Number(event.volume || market.volume || 0);
    const volume24h = Number(event.volume24hr || market.volume24hr || 0);
    const liquidity = Number(event.liquidity || market.liquidity || 0);
    
    // Skip low activity markets
    if (volume24h < 1000 || liquidity < 1000) continue;
    
    const gammaPrices = parseJsonArray(market.outcomePrices);
    const yesPrice = parseFloat(gammaPrices[0]) || 0.5;

    // Calculate trend score (weighted)
    let trendScore = 0;
    
    // Volume weight
    if (volume24h > 100000) trendScore += 40;
    else if (volume24h > 50000) trendScore += 30;
    else if (volume24h > 10000) trendScore += 20;
    else if (volume24h > 1000) trendScore += 10;
    
    // Liquidity weight
    if (liquidity > 100000) trendScore += 30;
    else if (liquidity > 50000) trendScore += 20;
    else if (liquidity > 10000) trendScore += 10;

    // Volume relative to liquidity (high turnover = active trading)
    const volumeToLiquidity = liquidity > 0 ? volume24h / liquidity : 0;
    if (volumeToLiquidity > 0.5) trendScore += 20;
    else if (volumeToLiquidity > 0.2) trendScore += 10;

    // Volume change estimate (comparing 24h to average daily)
    const avgDailyVolume = volume > 0 ? volume / 30 : volume24h;
    const volumeVsAvg = avgDailyVolume > 0 ? volume24h / avgDailyVolume : 1;
    
    let volumeVsAverage: string;
    if (volumeVsAvg > 3) {
      volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average - SURGING`;
      trendScore += 25;
    } else if (volumeVsAvg > 2) {
      volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average - HIGH`;
      trendScore += 15;
    } else if (volumeVsAvg > 1.2) {
      volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average`;
      trendScore += 5;
    } else {
      volumeVsAverage = "Normal activity";
    }

    // Determine price direction signal
    let priceDirection: string;
    let signal: string;
    if (yesPrice > 0.85) {
      priceDirection = "Strong YES";
      signal = `YES favored at ${(yesPrice * 100).toFixed(0)}%`;
    } else if (yesPrice > 0.65) {
      priceDirection = "Leaning YES";
      signal = `Moderate YES at ${(yesPrice * 100).toFixed(0)}%`;
    } else if (yesPrice < 0.15) {
      priceDirection = "Strong NO";
      signal = `NO favored at ${((1 - yesPrice) * 100).toFixed(0)}%`;
    } else if (yesPrice < 0.35) {
      priceDirection = "Leaning NO";
      signal = `Moderate NO at ${((1 - yesPrice) * 100).toFixed(0)}%`;
    } else {
      priceDirection = "Contested";
      signal = `Toss-up at ${(yesPrice * 100).toFixed(0)}% YES`;
    }

    // Generate why trending explanation
    let whyTrending: string;
    if (volumeVsAvg > 2) {
      whyTrending = "Unusual volume spike - likely news event or price movement";
    } else if (volumeToLiquidity > 0.3) {
      whyTrending = "High turnover rate - active price discovery in progress";
    } else if (liquidity > 50000 && volume24h > 20000) {
      whyTrending = "Deep liquid market with sustained interest";
    } else {
      whyTrending = "Steady trading activity";
    }

    const cat = event.category || "other";
    categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;

    trendingMarkets.push({
      rank: 0,
      title: event.title || market.question || "Unknown",
      slug: event.slug || "",
      conditionId: market.conditionId || event.id || "",
      currentPrice: yesPrice,
      priceDirection,
      volume24h,
      volumeVsAverage,
      liquidity,
      trendScore,
      category: cat,
      signal,
      whyTrending,
    });
  }

  // Sort by trend score
  trendingMarkets.sort((a, b) => b.trendScore - a.trendScore);
  
  // Assign ranks
  trendingMarkets.forEach((m, idx) => {
    m.rank = idx + 1;
  });

  const finalMarkets = trendingMarkets.slice(0, limit);
  
  // Generate market summary
  const surgingCount = finalMarkets.filter(m => m.volumeVsAverage.includes("SURGING")).length;
  const contestedCount = finalMarkets.filter(m => m.priceDirection === "Contested").length;
  
  let marketSummary: string;
  if (surgingCount > 3) {
    marketSummary = `🔥 Active day! ${surgingCount} markets with surging volume. News events likely driving activity.`;
  } else if (contestedCount > 5) {
    marketSummary = `⚖️ Many contested markets. Good opportunities for traders with information edge.`;
  } else if (finalMarkets.length > 0) {
    marketSummary = `📊 Normal market conditions. ${finalMarkets.length} active markets identified.`;
  } else {
    marketSummary = "😴 Low market activity. Consider checking back during US market hours.";
  }

  return successResult({
    marketSummary,
    trendingMarkets: finalMarkets,
    categories: categoryBreakdown,
    totalActive: events.length,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Analyze user's Polymarket positions with personalized recommendations
 *
 * This tool receives portfolio context from the Context app (client-side fetched)
 * and combines it with live market data to provide actionable insights.
 */
async function handleAnalyzeMyPositions(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const portfolio = args?.portfolio as PolymarketContext | undefined;
  const focusMarket = args?.focus_market as string | undefined;

  if (!portfolio || !portfolio.positions) {
    return errorResult(
      "Portfolio context is required. The Context app should inject this automatically."
    );
  }

  if (portfolio.positions.length === 0) {
    return successResult({
      walletAddress: portfolio.walletAddress,
      totalPositions: 0,
      portfolioSummary: {
        totalValue: 0,
        totalUnrealizedPnL: 0,
        totalUnrealizedPnLPercent: 0,
        riskyPositions: 0,
      },
      positionAnalyses: [],
      overallRecommendation: "You have no active Polymarket positions to analyze.",
      fetchedAt: new Date().toISOString(),
    });
  }

  // Filter to focus market if specified
  const positionsToAnalyze = focusMarket
    ? portfolio.positions.filter((p) => p.conditionId === focusMarket)
    : portfolio.positions;

  const positionAnalyses: Array<{
    conditionId: string;
    marketTitle: string;
    outcome: string;
    shares: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    positionValue: number;
    exitLiquidity: {
      estimatedSlippage: number;
      canExitCleanly: boolean;
      liquidityScore: string;
    };
    recommendation: string;
  }> = [];

  let totalValue = 0;
  let totalUnrealizedPnL = 0;
  let riskyPositions = 0;

  for (const position of positionsToAnalyze) {
    try {
      // Fetch current market data using the existing liquidity handler
      const liquidityResult = await handleAnalyzeMarketLiquidity({
        tokenId: position.tokenId,
      });

      // Extract data from liquidity analysis
      const liquidityData = JSON.parse(
        (liquidityResult.content[0] as { text: string }).text
      );

      const currentPrice = liquidityData.currentPrice || position.avgEntryPrice;
      const positionValue = position.shares * currentPrice;
      const costBasis = position.shares * position.avgEntryPrice;
      const unrealizedPnL = positionValue - costBasis;
      const unrealizedPnLPercent =
        costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;

      // Simulate exit for this specific position size
      const exitSimulation = simulatePositionExit(
        liquidityData.whaleCost,
        positionValue
      );

      const canExitCleanly = exitSimulation.slippage < 2;
      if (!canExitCleanly) {
        riskyPositions++;
      }

      // Generate position-specific recommendation
      const recommendation = generatePositionRecommendation({
        unrealizedPnLPercent,
        currentPrice,
        liquidityScore: liquidityData.liquidityScore,
        canExitCleanly,
        slippage: exitSimulation.slippage,
      });

      positionAnalyses.push({
        conditionId: position.conditionId,
        marketTitle: position.marketTitle || position.conditionId,
        outcome: position.outcome,
        shares: position.shares,
        avgEntryPrice: position.avgEntryPrice,
        currentPrice,
        unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
        unrealizedPnLPercent: Number(unrealizedPnLPercent.toFixed(2)),
        positionValue: Number(positionValue.toFixed(2)),
        exitLiquidity: {
          estimatedSlippage: exitSimulation.slippage,
          canExitCleanly,
          liquidityScore: liquidityData.liquidityScore,
        },
        recommendation,
      });

      totalValue += positionValue;
      totalUnrealizedPnL += unrealizedPnL;
    } catch (error) {
      // If we can't fetch market data, include position with limited analysis
      positionAnalyses.push({
        conditionId: position.conditionId,
        marketTitle: position.marketTitle || position.conditionId,
        outcome: position.outcome,
        shares: position.shares,
        avgEntryPrice: position.avgEntryPrice,
        currentPrice: position.avgEntryPrice,
        unrealizedPnL: 0,
        unrealizedPnLPercent: 0,
        positionValue: position.shares * position.avgEntryPrice,
        exitLiquidity: {
          estimatedSlippage: 0,
          canExitCleanly: true,
          liquidityScore: "unknown",
        },
        recommendation: "Unable to fetch live market data for this position.",
      });
    }
  }

  const totalCostBasis = positionAnalyses.reduce(
    (sum, p) => sum + p.shares * p.avgEntryPrice,
    0
  );
  const totalUnrealizedPnLPercent =
    totalCostBasis > 0 ? (totalUnrealizedPnL / totalCostBasis) * 100 : 0;

  // Generate overall recommendation
  const overallRecommendation = generateOverallRecommendation({
    totalPositions: positionAnalyses.length,
    totalUnrealizedPnLPercent,
    riskyPositions,
    positionAnalyses,
  });

  return successResult({
    walletAddress: portfolio.walletAddress,
    totalPositions: positionAnalyses.length,
    portfolioSummary: {
      totalValue: Number(totalValue.toFixed(2)),
      totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
      totalUnrealizedPnLPercent: Number(totalUnrealizedPnLPercent.toFixed(2)),
      riskyPositions,
    },
    positionAnalyses,
    overallRecommendation,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Helper: Simulate exit based on whale cost data
 */
function simulatePositionExit(
  whaleCost: {
    sell1k?: { slippagePercent: number };
    sell5k?: { slippagePercent: number };
    sell10k?: { slippagePercent: number };
  } | undefined,
  positionValue: number
): { slippage: number } {
  if (!whaleCost) {
    return { slippage: 0 };
  }

  // Interpolate slippage based on position size
  if (positionValue <= 1000) {
    return { slippage: Number(whaleCost.sell1k?.slippagePercent || 0) };
  } else if (positionValue <= 5000) {
    return { slippage: Number(whaleCost.sell5k?.slippagePercent || 0) };
  } else {
    return { slippage: Number(whaleCost.sell10k?.slippagePercent || 0) };
  }
}

/**
 * Helper: Generate recommendation for a single position
 */
function generatePositionRecommendation(params: {
  unrealizedPnLPercent: number;
  currentPrice: number;
  liquidityScore: string;
  canExitCleanly: boolean;
  slippage: number;
}): string {
  const { unrealizedPnLPercent, currentPrice, liquidityScore, canExitCleanly, slippage } = params;

  const parts: string[] = [];

  // P&L commentary
  if (unrealizedPnLPercent > 50) {
    parts.push("🎉 Strong gains! Consider taking some profit.");
  } else if (unrealizedPnLPercent > 20) {
    parts.push("📈 Position is profitable.");
  } else if (unrealizedPnLPercent < -20) {
    parts.push("📉 Position underwater. Evaluate if thesis still holds.");
  }

  // Price commentary
  if (currentPrice > 0.9) {
    parts.push("Price near max - limited upside remaining.");
  } else if (currentPrice < 0.1) {
    parts.push("Price near floor - high risk/reward if thesis is correct.");
  }

  // Liquidity commentary
  if (!canExitCleanly) {
    parts.push(`⚠️ Exit liquidity is ${liquidityScore}. Expect ~${slippage.toFixed(1)}% slippage on exit.`);
  } else if (liquidityScore === "excellent" || liquidityScore === "good") {
    parts.push("✅ Good exit liquidity available.");
  }

  return parts.length > 0 ? parts.join(" ") : "No specific recommendations.";
}

/**
 * Helper: Generate overall portfolio recommendation
 */
function generateOverallRecommendation(params: {
  totalPositions: number;
  totalUnrealizedPnLPercent: number;
  riskyPositions: number;
  positionAnalyses: Array<{ outcome: string; positionValue: number }>;
}): string {
  const { totalPositions, totalUnrealizedPnLPercent, riskyPositions, positionAnalyses } = params;

  const parts: string[] = [];

  // Overall P&L
  if (totalUnrealizedPnLPercent > 30) {
    parts.push(`Portfolio up ${totalUnrealizedPnLPercent.toFixed(1)}% overall. Strong performance!`);
  } else if (totalUnrealizedPnLPercent < -20) {
    parts.push(`Portfolio down ${Math.abs(totalUnrealizedPnLPercent).toFixed(1)}%. Review positions carefully.`);
  } else {
    parts.push(`Portfolio ${totalUnrealizedPnLPercent >= 0 ? "up" : "down"} ${Math.abs(totalUnrealizedPnLPercent).toFixed(1)}%.`);
  }

  // Liquidity warnings
  if (riskyPositions > 0) {
    parts.push(`⚠️ ${riskyPositions} of ${totalPositions} positions have poor exit liquidity.`);
  }

  // Concentration check
  const yesValue = positionAnalyses
    .filter((p) => p.outcome === "YES")
    .reduce((sum, p) => sum + p.positionValue, 0);
  const noValue = positionAnalyses
    .filter((p) => p.outcome === "NO")
    .reduce((sum, p) => sum + p.positionValue, 0);
  const total = yesValue + noValue;

  if (total > 0) {
    const yesPercent = (yesValue / total) * 100;
    if (yesPercent > 80) {
      parts.push("Portfolio heavily weighted to YES outcomes. Consider hedging.");
    } else if (yesPercent < 20) {
      parts.push("Portfolio heavily weighted to NO outcomes.");
    }
  }

  return parts.join(" ");
}

// ============================================================================
// TIER 2: RAW DATA TOOL HANDLERS
// ============================================================================

async function handleGetEvents(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const active = args?.active !== false;
  const closed = args?.closed === true;
  const limit = Math.min((args?.limit as number) || 50, 100);
  const offset = (args?.offset as number) || 0;

  const endpoint = `/events?closed=${closed}&limit=${limit}&offset=${offset}&order=id&ascending=false`;
  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  const filteredEvents = active ? events.filter((e) => e.active !== false) : events;

  const simplified = filteredEvents.map((e) => ({
    id: e.id,
    title: e.title,
    slug: e.slug,
    category: e.category,
    volume: e.volume,
    liquidity: e.liquidity,
    endDate: e.endDate,
    active: e.active,
    marketsCount: e.markets?.length || 0,
  }));

  return successResult({
    events: simplified,
    count: simplified.length,
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

  const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;

  if (!event) {
    return errorResult(`Event not found: ${slug}`);
  }

  // Transform markets to include tokens array in the expected format
  const markets = (event.markets || []).map((m) => {
    // Parse clobTokenIds and outcomePrices (API returns as JSON strings)
    const tokenIds = parseJsonArray(m.clobTokenIds);
    const prices = parseJsonArray(m.outcomePrices);

    const yesTokenId = tokenIds[0];
    const noTokenId = tokenIds[1];
    const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;
    const noPrice = prices[1] ? parseFloat(prices[1]) : 0.5;

    // Build tokens array - use token_id (not id) to match schema
    const tokens: Array<{ token_id: string; outcome: string }> = [];
    if (yesTokenId) {
      tokens.push({ token_id: yesTokenId, outcome: "Yes" });
    }
    if (noTokenId) {
      tokens.push({ token_id: noTokenId, outcome: "No" });
    }

    return {
      conditionId: m.conditionId,
      question: m.question,
      outcomePrices: prices,
      volume: m.volume,
      liquidity: m.liquidity,
      tokens,
    };
  });

  return successResult({
    event: {
      id: event.id,
      title: event.title,
      description: event.description,
      category: event.category,
      resolutionSource: event.resolutionSource,
      startDate: event.startDate,
      endDate: event.endDate,
      volume: event.volume,
      liquidity: event.liquidity,
      active: event.active,
      closed: event.closed,
    },
    markets,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOrderbook(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenId = args?.tokenId as string;
  const merged = args?.merged as boolean;

  if (!tokenId) {
    return errorResult("tokenId is required");
  }

  // Fetch direct orderbook for this token
  const orderbook = (await fetchClob(`/book?token_id=${tokenId}`)) as OrderbookResponse;

  const directBids = orderbook.bids || [];
  const directAsks = orderbook.asks || [];

  // If merged=true, try to get complement token and merge orderbooks
  // This matches what Polymarket UI shows
  if (merged) {
    try {
      // Use the market's condition_id to look up the complement token
      const conditionId = orderbook.market;
      let complementTokenId = "";
      
      if (conditionId) {
        const market = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
        if (market?.tokens) {
          const otherToken = market.tokens.find((t: { token_id: string }) => t.token_id !== tokenId);
          if (otherToken) {
            complementTokenId = otherToken.token_id;
          }
        }
      }

      if (complementTokenId) {
        const complementBook = (await fetchClob(`/book?token_id=${complementTokenId}`)) as OrderbookResponse;
        
        // Build merged orderbook
        const mergedBids: Array<{ price: number; size: number; source: string }> = [];
        const mergedAsks: Array<{ price: number; size: number; source: string }> = [];

        // Direct bids/asks
        for (const b of directBids) {
          mergedBids.push({ price: Number(b.price), size: Number(b.size), source: "direct" });
        }
        for (const a of directAsks) {
          mergedAsks.push({ price: Number(a.price), size: Number(a.size), source: "direct" });
        }

        // Synthetic: complement asks → this token's bids (sell complement = buy this)
        for (const a of complementBook.asks || []) {
          const syntheticPrice = 1 - Number(a.price);
          if (syntheticPrice > 0 && syntheticPrice < 1) {
            mergedBids.push({ price: syntheticPrice, size: Number(a.size), source: "synthetic" });
          }
        }

        // Synthetic: complement bids → this token's asks (buy complement = sell this)
        for (const b of complementBook.bids || []) {
          const syntheticPrice = 1 - Number(b.price);
          if (syntheticPrice > 0 && syntheticPrice < 1) {
            mergedAsks.push({ price: syntheticPrice, size: Number(b.size), source: "synthetic" });
          }
        }

        // Sort
        mergedBids.sort((a, b) => b.price - a.price);
        mergedAsks.sort((a, b) => a.price - b.price);

        const bestBid = mergedBids.length > 0 ? mergedBids[0].price : 0;
        const bestAsk = mergedAsks.length > 0 ? mergedAsks[0].price : 1;

        return successResult({
          market: orderbook.market || "",
          assetId: orderbook.asset_id || tokenId,
          view: "merged",
          note: "Merged orderbook combines direct orders + synthetic liquidity from complement token (matches Polymarket UI)",
          bids: mergedBids.slice(0, 20),
          asks: mergedAsks.slice(0, 20),
          bestBid: Number(bestBid.toFixed(4)),
          bestAsk: Number(bestAsk.toFixed(4)),
          midPrice: Number(((bestBid + bestAsk) / 2).toFixed(4)),
          spread: Number((bestAsk - bestBid).toFixed(4)),
          spreadCents: Number(((bestAsk - bestBid) * 100).toFixed(1)),
          fetchedAt: new Date().toISOString(),
        });
      }
    } catch {
      // Fall through to raw orderbook
    }
  }

  // Return raw/direct orderbook
  const bestBid = directBids.length > 0 ? Number(directBids[0].price) : 0;
  const bestAsk = directAsks.length > 0 ? Number(directAsks[0].price) : 1;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = bestAsk - bestBid;

  return successResult({
    market: orderbook.market || "",
    assetId: orderbook.asset_id || tokenId,
    view: "raw",
    warning: "⚠️ This shows DIRECT orders only. Polymarket UI shows merged orderbook including synthetic liquidity. Use merged=true to see UI-equivalent view.",
    bids: directBids.slice(0, 20).map((b) => ({ price: Number(b.price), size: Number(b.size) })),
    asks: directAsks.slice(0, 20).map((a) => ({ price: Number(a.price), size: Number(a.size) })),
    bestBid,
    bestAsk,
    midPrice: Number(midPrice.toFixed(4)),
    spread: Number(spread.toFixed(4)),
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetPrices(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenIds = args?.tokenIds as string[];

  if (!tokenIds || tokenIds.length === 0) {
    return errorResult("tokenIds array is required");
  }

  const prices: Record<string, { buy: number; sell: number; mid: number; spread: number }> = {};

  try {
    // Get BUY prices (what you pay to buy)
    const buyResp = (await fetchClobPost("/prices", 
      tokenIds.map(id => ({ token_id: id, side: "BUY" }))
    )) as Record<string, { BUY?: string } | string>;

    // Get SELL prices (what you receive when selling)
    const sellResp = (await fetchClobPost("/prices",
      tokenIds.map(id => ({ token_id: id, side: "SELL" }))
    )) as Record<string, { SELL?: string } | string>;

    for (const tokenId of tokenIds) {
      // CLOB response format: { "tokenId": { "BUY": "0.91" } } or { "tokenId": "0.91" }
      const buyData = buyResp[tokenId];
      const sellData = sellResp[tokenId];
      
      const buy = buyData 
        ? (typeof buyData === "object" && buyData.BUY ? Number(buyData.BUY) : Number(buyData))
        : 0;
      const sell = sellData
        ? (typeof sellData === "object" && sellData.SELL ? Number(sellData.SELL) : Number(sellData))
        : 0;
      
      const mid = (buy + sell) / 2 || buy || sell;
      const spread = buy - sell;

      prices[tokenId] = {
        buy: Number(buy.toFixed(4)),
        sell: Number(sell.toFixed(4)),
        mid: Number(mid.toFixed(4)),
        spread: Number(spread.toFixed(4)),
      };
    }
  } catch {
    // If CLOB fails, return zeros (market may be settled)
    for (const tokenId of tokenIds) {
      prices[tokenId] = { buy: 0, sell: 0, mid: 0, spread: 0 };
    }
  }

  return successResult({
    prices,
    note: "buy = price to purchase shares, sell = price received when selling, spread = buy - sell",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetPriceHistory(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenId = args?.tokenId as string;
  const interval = (args?.interval as string) || "1d";
  const fidelity = args?.fidelity as number;

  if (!tokenId) {
    return errorResult("tokenId is required");
  }

  let endpoint = `/prices-history?market=${tokenId}&interval=${interval}`;
  if (fidelity) {
    endpoint += `&fidelity=${fidelity}`;
  }

  const historyResp = (await fetchClob(endpoint)) as { history: Array<{ t: number; p: number }> };
  const history = historyResp.history || [];

  const prices = history.map((h) => h.p);
  const high = prices.length > 0 ? Math.max(...prices) : 0;
  const low = prices.length > 0 ? Math.min(...prices) : 0;
  const first = prices[0] || 0;
  const last = prices[prices.length - 1] || 0;
  const change = last - first;
  const changePercent = first > 0 ? (change / first) * 100 : 0;

  return successResult({
    tokenId,
    history: history.map((h) => ({
      timestamp: new Date(h.t * 1000).toISOString(),
      price: h.p,
    })),
    summary: {
      high,
      low,
      change: Number(change.toFixed(4)),
      changePercent: Number(changePercent.toFixed(2)),
      dataPoints: history.length,
    },
    fetchedAt: new Date().toISOString(),
  });
}

async function handleSearchMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const query = args?.query as string;
  const category = args?.category as string;
  const active = args?.active !== false;
  const limit = Math.min((args?.limit as number) || 20, 50);

  let endpoint = `/events?closed=false&limit=${limit}`;
  if (category) {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  let filtered = events;

  // Filter by query if provided
  if (query) {
    const queryLower = query.toLowerCase();
    filtered = events.filter(
      (e) =>
        e.title?.toLowerCase().includes(queryLower) ||
        e.description?.toLowerCase().includes(queryLower)
    );
  }

  if (active) {
    filtered = filtered.filter((e) => e.active !== false);
  }

  const results = filtered.map((e) => ({
    title: e.title,
    slug: e.slug,
    category: e.category,
    conditionId: e.markets?.[0]?.conditionId,
    volume: e.volume,
    liquidity: e.liquidity,
    active: e.active,
  }));

  return successResult({
    results,
    count: results.length,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface GammaEvent {
  id?: string;
  title?: string;
  slug?: string;
  description?: string;
  category?: string;
  resolutionSource?: string;
  startDate?: string;
  endDate?: string;
  endDateIso?: string;
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  active?: boolean;
  closed?: boolean;
  tags?: Array<{ slug?: string; label?: string }>;
  markets?: GammaMarket[];
  conditionId?: string;
  parentEvent?: string;
}

interface GammaMarket {
  conditionId?: string;
  question?: string;
  title?: string;
  description?: string;
  outcomePrices?: string[] | string; // API may return JSON string
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  clobTokenIds?: string[] | string; // API may return JSON string
  tokens?: Array<{ token_id: string }>;
}

interface ClobMarket {
  condition_id?: string;
  tokens?: Array<{ token_id: string; outcome: string }>;
}

interface OrderbookResponse {
  market?: string;
  asset_id?: string;
  timestamp?: string;
  bids?: Array<{ price: string; size: string }>;
  asks?: Array<{ price: string; size: string }>;
}

interface TradeResponse {
  id?: string;
  market?: string;
  asset_id?: string;
  side?: string;
  size?: string;
  price?: string;
  match_time?: string;
  timestamp?: string;
}

// PolymarketContext and PolymarketPosition are imported from @ctxprotocol/sdk

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
app.use(express.json());

// Store transports for both SSE (legacy) and Streamable HTTP (modern)
const sseTransports: Record<string, SSEServerTransport> = {};
const httpTransports: Record<string, StreamableHTTPServerTransport> = {};

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "polymarket-intelligence",
    version: "1.0.0",
    tools: TOOLS.map((t) => t.name),
    description: "Polymarket Intelligence MCP - Whale cost, market efficiency, smart money tracking",
  });
});

// ============================================================================
// MODERN: Streamable HTTP Transport (/mcp) - Recommended
// ============================================================================

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && httpTransports[sessionId]) {
    // Reuse existing session
    transport = httpTransports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session initialization
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        httpTransports[id] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete httpTransports[transport.sessionId];
      }
    };

    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session - send initialize request first" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = httpTransports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = httpTransports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

// ============================================================================
// LEGACY: SSE Transport (/sse) - For backwards compatibility
// ============================================================================

app.get("/sse", async (_req: Request, res: Response) => {
  console.log("New SSE connection established (legacy transport)");
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`SSE connection closed: ${transport.sessionId}`);
    delete sseTransports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports[sessionId];

  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).json({ error: "No transport found for sessionId" });
  }
});

const port = Number(process.env.PORT || 4003);
app.listen(port, () => {
  console.log("\n🎯 Polymarket Intelligence MCP Server v1.0.0");
  console.log("   Whale cost analysis • Market efficiency • Smart money tracking\n");
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp (recommended)`);
  console.log(`📡 SSE endpoint: http://localhost:${port}/sse (legacy)`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🛠️  Available tools (${TOOLS.length}):`);
  console.log("   INTELLIGENCE:");
  for (const tool of TOOLS.slice(0, 9)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("   RAW DATA:");
  for (const tool of TOOLS.slice(9)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("");
});

