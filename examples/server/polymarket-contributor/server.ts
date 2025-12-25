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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { createContextMiddleware, type PolymarketContext, type PolymarketPosition } from "@ctxprotocol/sdk";

// ============================================================================
// API ENDPOINTS
// ============================================================================

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (required by Context)
// - _meta.contextRequirements: Context types needed for portfolio tools (MCP spec)
//
// NOTE: _meta is part of the MCP spec for arbitrary tool metadata.
// The Context platform reads _meta.contextRequirements to inject user portfolio data.
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
      'Check if a market is efficiently priced. Calculates the "vig" (sum of YES + NO prices), identifies if fees/spread are eating potential edge, and reports true implied probabilities. Accepts either conditionId OR slug - both work equally well.',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID (hex string starting with 0x). Works with IDs from discover_trending_markets or other tools.",
        },
        slug: {
          type: "string",
          description: "The event slug (e.g., 'will-trump-release-epstein-files-by'). Alternative to conditionId.",
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
    name: "analyze_top_holders",
    description:
      'Deep analysis of who the whales are in a market. Shows top holders, their conviction level (position size), whether they\'re in profit/loss, and concentration risk. Answers: "Who are the smart money players and what are they betting on?"',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID (hex string starting with 0x)",
        },
        slug: {
          type: "string",
          description: "The event slug. Alternative to conditionId.",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        conditionId: { type: "string" },
        currentPrice: { type: "number" },
        whaleAnalysis: {
          type: "object",
          properties: {
            yesWhales: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  address: { type: "string" },
                  shares: { type: "number" },
                  positionValue: { type: "number" },
                  estimatedEntry: { type: "number", description: "Estimated avg entry price" },
                  unrealizedPnL: { type: "number" },
                  convictionScore: { type: "string", enum: ["extreme", "high", "moderate", "low"] },
                },
              },
            },
            noWhales: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  address: { type: "string" },
                  shares: { type: "number" },
                  positionValue: { type: "number" },
                  estimatedEntry: { type: "number" },
                  unrealizedPnL: { type: "number" },
                  convictionScore: { type: "string", enum: ["extreme", "high", "moderate", "low"] },
                },
              },
            },
          },
        },
        marketConcentration: {
          type: "object",
          properties: {
            top5YesPercent: { type: "number" },
            top5NoPercent: { type: "number" },
            whaleCount: { type: "number" },
            concentrationRisk: { type: "string", enum: ["high", "moderate", "low"] },
          },
        },
        smartMoneySignal: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["YES", "NO", "NEUTRAL"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            reasoning: { type: "string" },
          },
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["market", "conditionId", "whaleAnalysis", "smartMoneySignal"],
    },
  },

  {
    name: "find_correlated_markets",
    description:
      'Find markets that might be correlated for hedging purposes. If betting on "Bitcoin > $100k", shows related crypto markets. Accepts either conditionId OR slug - both work equally well.',
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID (hex string starting with 0x). Works with IDs from discover_trending_markets or other tools.",
        },
        slug: {
          type: "string",
          description: "The event slug (e.g., 'bitcoin-100k'). Alternative to conditionId.",
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
      'Parse market resolution rules and highlight potential "gotchas". Extracts the description, resolution source, and edge cases that could cause unexpected resolution. Accepts either conditionId OR slug - both work equally well.',
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The event slug (e.g., 'will-trump-release-epstein-files-by'). Alternative to conditionId.",
        },
        conditionId: {
          type: "string",
          description: "The market condition ID (hex string starting with 0x). Works with IDs from discover_trending_markets or other tools.",
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
      `Advanced tool for finding Polymarket opportunities with complex filtering. Supports strategies: lottery_tickets (1-15¢), moderate_conviction (35-65¢), high_confidence (70-90¢), momentum, mispriced, near_resolution.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. If no results match the criteria, say "No matching markets found" - do NOT make up markets that might exist.

⚠️ FOR SIMPLER QUERIES: If user wants 'likely bets', 'safer bets', or 'bets that will probably win' → use find_moderate_probability_bets instead. For filtering by probability like 'coinflip bets' or 'unlikely bets' → use get_bets_by_probability instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        strategy: {
          type: "string",
          enum: ["all", "lottery_tickets", "moderate_conviction", "high_confidence", "mispriced", "momentum", "near_resolution"],
          description: `Trading strategy to use:
            - all: Scan all strategies (default)
            - lottery_tickets: 1-15¢ bets with 7-100x potential (very unlikely to win, but huge payoff if right)
            - moderate_conviction: 35-65¢ bets with 1.5-2.8x potential (coin-flip probability, balanced risk/reward)
            - high_confidence: 70-90¢ bets with 1.1-1.4x potential (likely outcomes, lower but safer returns)
            - mispriced: Markets where price differs significantly from estimated true probability
            - momentum: Markets with strong recent price movement in one direction
            - near_resolution: Markets closing soon where you can lock in returns`,
        },
        priceRange: {
          type: "object",
          description: "Filter for YES token price range (0.0 to 1.0). E.g., { min: 0.50, max: 0.75 } for moderate probability bets",
          properties: {
            min: { type: "number", description: "Minimum price (0.0-1.0)" },
            max: { type: "number", description: "Maximum price (0.0-1.0)" },
          },
        },
        targetProbability: {
          type: "string",
          enum: ["longshot", "moderate", "likely", "near_certain"],
          description: "Filter by implied probability range: longshot (1-20%), moderate (35-65%), likely (65-85%), near_certain (85-98%)",
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
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this, never construct URLs" },
              conditionId: { type: "string" },
              slug: { type: "string" },
              opportunityType: {
                type: "string",
                enum: ["lottery_tickets", "moderate_conviction", "high_confidence", "mispriced", "momentum", "near_resolution"],
              },
              signal: { type: "string" },
              currentPrice: { type: "number" },
              impliedProbability: { type: "string" },
              suggestedSide: { type: "string", enum: ["YES", "NO", "EITHER"] },
              potentialReturn: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              riskFactors: { type: "array", items: { type: "string" } },
              whyThisOpportunity: { type: "string" },
            },
            required: ["market", "url", "currentPrice"],
          },
        },
        noOpportunitiesReason: {
          type: "string",
          description: "If no good opportunities, explains why and what to do instead",
        },
        suggestions: {
          type: "array",
          description: "Alternative actions to try when no opportunities match the criteria",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              reason: { type: "string" },
              availableCount: { type: "number" },
            },
          },
        },
        nearestMatches: {
          type: "array",
          description: "Markets that almost matched the criteria",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              currentPrice: { type: "number" },
              whyNotMatched: { type: "string" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["summary", "opportunities"],
    },
  },

  {
    name: "find_moderate_probability_bets",
    description:
      `🎯 BEST TOOL for 'likely bets', 'safer bets', or 'bets that will probably win'. Finds prediction market bets priced 40-75¢ (40-75% implied probability) with good liquidity. Returns 1.3-2.5x if correct. USE THIS instead of find_trading_opportunities when user wants higher probability outcomes.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent additional markets or URLs. Each result includes a real 'url' field - use ONLY those URLs.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        minPrice: {
          type: "number",
          description: "Minimum YES price (default 0.40 = 40% probability)",
        },
        maxPrice: {
          type: "number",
          description: "Maximum YES price (default 0.75 = 75% probability)",
        },
        minLiquidity: {
          type: "number",
          description: "Minimum liquidity in USD (default: 10000)",
        },
        category: {
          type: "string",
          enum: ["politics", "crypto", "sports", "entertainment", "science", "all"],
          description: "Filter by category (default: all)",
        },
        sortBy: {
          type: "string",
          enum: ["return_potential", "liquidity", "volume", "closing_soon"],
          description: "How to rank results (default: return_potential)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        opportunities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this, never construct URLs" },
              slug: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number" },
              impliedProbability: { type: "string" },
              potentialReturn: { type: "string" },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              endDate: { type: "string" },
              category: { type: "string" },
              whyThisBet: { type: "string" },
            },
            required: ["market", "url", "currentPrice"],
          },
        },
        summary: {
          type: "object",
          properties: {
            marketsScanned: { type: "number" },
            matchingBets: { type: "number" },
            priceRange: { type: "string" },
            avgReturn: { type: "string" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["opportunities", "summary"],
    },
  },

  {
    name: "get_bets_by_probability",
    description:
      `🎯 SIMPLEST tool for filtering bets by win probability. Use when user asks for: 'coinflip bets' → likelihood='coinflip', 'unlikely bets'/'longshots' → likelihood='very_unlikely', 'likely bets' → likelihood='likely'. Options: very_unlikely (1-15%), unlikely (15-35%), coinflip (35-65%), likely (65-85%), very_likely (85-95%).

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent additional markets or construct URLs from titles. Use ONLY the 'url' field provided in each result.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        likelihood: {
          type: "string",
          enum: ["very_unlikely", "unlikely", "coinflip", "likely", "very_likely"],
          description: "How likely the bet is to win: very_unlikely (1-15%), unlikely (15-35%), coinflip (35-65%), likely (65-85%), very_likely (85-95%)",
        },
        category: {
          type: "string",
          enum: ["politics", "crypto", "sports", "all"],
          description: "Filter by category (default: all)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 5)",
        },
      },
      required: ["likelihood"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        bets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this, never construct URLs" },
              slug: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number" },
              impliedProbability: { type: "string" },
              potentialReturn: { type: "string" },
              liquidity: { type: "number" },
              volume24h: { type: "number" },
              category: { type: "string" },
            },
            required: ["market", "url", "currentPrice"],
          },
        },
        summary: {
          type: "object",
          properties: {
            likelihood: { type: "string" },
            probabilityRange: { type: "string" },
            betsFound: { type: "number" },
            returnRange: { type: "string" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["bets", "summary"],
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
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this, never construct URLs" },
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
            required: ["title", "url", "currentPrice"],
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

    // ✅ Context requirements in _meta (preserved by MCP SDK)
    // The Context platform reads this to inject user's Polymarket portfolio data.
    _meta: {
      contextRequirements: ["polymarket"],
    },

    inputSchema: {
      type: "object" as const,
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

  // ==================== CROSS-PLATFORM INTEROPERABILITY ====================

  {
    name: "get_comparable_markets",
    description: `📊 CROSS-PLATFORM: Get markets in a STANDARDIZED format for comparing with other platforms (Kalshi, Odds API).

Returns markets with normalized probabilities (0-1 scale) and standardized fields that can be 
directly compared across prediction markets and sportsbooks.

USE THIS TOOL when you need to:
- Find arbitrage opportunities between Polymarket and other platforms
- Compare probability assessments across markets
- Build cross-platform market analysis

⚠️ CROSS-PLATFORM MATCHING GUIDE:
Markets on different platforms have DIFFERENT titles for the SAME event:
  - Polymarket: "Super Bowl Champion 2026"
  - Odds API: "NFL Super Bowl Winner"  
  - Kalshi: "Who wins Super Bowl LX?"

DO NOT use exact title matching! Instead, use FUZZY MATCHING with these fields:
  1. keywords: Check if 50%+ of keywords overlap between platforms
  2. teams: For sports, check if the same teams appear
  3. eventCategory: Filter to same category first (sports, politics, etc.)
  4. normalizedProbability: Once matched, compare these directly (all 0-1 scale)

MATCHING EXAMPLE:
  Polymarket keywords: ["super", "bowl", "champion", "2026", "nfl"]
  Odds API keywords: ["nfl", "super", "bowl", "winner"]
  → Overlap: ["super", "bowl", "nfl"] = 60% match → SAME MARKET!
  → Compare: Polymarket 0.25 vs Odds API 0.22 = 3% gap

PLATFORM COMPATIBILITY:
  - Sports comparisons: Use Polymarket + Odds API (Kalshi has NO sports markets)
  - Politics comparisons: Use Polymarket + Kalshi`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Filter by category: sports, politics, crypto, entertainment, science, business",
        },
        keywords: {
          type: "string",
          description: "Keywords to search for (uses OR matching for multi-word queries)",
        },
        minVolume: {
          type: "number",
          description: "Minimum 24h volume in USD (default: 1000)",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 30, max: 100)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        platform: { type: "string", const: "polymarket" },
        markets: {
          type: "array",
          description: "Markets in standardized format. Use keywords/teams for FUZZY MATCHING with other platforms - NOT title matching!",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Human-readable title. DO NOT use for cross-platform matching (titles differ by platform)" },
              description: { type: "string" },
              eventCategory: { type: "string", description: "Standardized category (sports, politics, crypto, etc). Filter by this FIRST when matching" },
              keywords: { 
                type: "array", 
                items: { type: "string" }, 
                description: "🔑 USE FOR MATCHING: Check if 50%+ keywords overlap with other platform's keywords array" 
              },
              teams: { 
                type: "array", 
                items: { type: "string" }, 
                description: "🔑 USE FOR MATCHING: For sports, check if same teams appear on both platforms" 
              },
              outcomes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    normalizedProbability: { type: "number", description: "🎯 COMPARE THIS: 0-1 scale, directly comparable across all platforms" },
                    rawPrice: { type: "number", description: "Original Polymarket price (0-1)" },
                  },
                },
              },
              volume24h: { type: "number" },
              liquidity: { type: "number" },
              endDate: { type: "string", description: "Resolution date - can help confirm same event across platforms" },
              url: { type: "string" },
              platformMarketId: { type: "string", description: "conditionId for Polymarket" },
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
    description: "Get list of events (markets) from Polymarket with optional filters. By default returns LIVE (active) markets. Use closed=true for resolved/finished markets.",
    inputSchema: {
      type: "object" as const,
      properties: {
        active: {
          type: "boolean",
          description: "Filter to active events only (default: true)",
        },
        closed: {
          type: "boolean",
          description: "Include closed/resolved events (default: false)",
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
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this" },
              slug: { type: "string" },
              category: { type: "string" },
              volume: { type: "number" },
              liquidity: { type: "number" },
              endDate: { type: "string" },
              active: { type: "boolean" },
              marketsCount: { type: "number" },
            },
            required: ["title", "url"],
          },
        },
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
    description: `Search for Polymarket prediction markets by keyword or category.

⚠️ IMPORTANT FOR LLMs: This tool distinguishes between LIVE and RESOLVED markets:
- LIVE markets: Still trading, outcome not yet determined. Users can place bets on these.
- RESOLVED markets: Already finished, outcome determined. For historical reference only - cannot trade.

By default, only LIVE (tradeable) markets are returned. Use status='resolved' for finished markets or status='all' for both.

CROSS-PLATFORM TIP: When searching for multiple topics like "NBA NFL MLB", use matchMode='any' (default) 
to find markets matching ANY of those terms, not all of them.

Each result includes:
- url: Direct link to the market on Polymarket (always use this, never construct URLs)
- status: Either "live" (tradeable) or "resolved" (finished)
- endDate: When the market resolves/resolved`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (searches title and description). Multiple words are searched based on matchMode.",
        },
        matchMode: {
          type: "string",
          enum: ["any", "all"],
          description: "How to match multiple words: 'any' (default) = match markets containing ANY word (good for 'NBA NFL MLB'), 'all' = require ALL words to match (good for 'Bitcoin price 2025')",
        },
        category: {
          type: "string",
          description: "Filter by category (e.g., 'politics', 'crypto', 'sports')",
        },
        status: {
          type: "string",
          enum: ["live", "resolved", "all"],
          description: "Filter by market status: 'live' (default) = still trading/open for bets, 'resolved' = already finished/closed, 'all' = both",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 20, max: 50)",
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
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - always use this" },
              slug: { type: "string" },
              status: { type: "string", enum: ["live", "resolved"], description: "live=tradeable, resolved=finished" },
              category: { type: "string" },
              conditionId: { type: "string" },
              volume: { type: "number" },
              liquidity: { type: "number" },
              endDate: { type: "string", description: "When market resolves/resolved" },
            },
            required: ["title", "url", "status"],
          },
        },
        count: { type: "number" },
        statusBreakdown: {
          type: "object",
          properties: {
            live: { type: "number", description: "Count of live/tradeable markets" },
            resolved: { type: "number", description: "Count of resolved/finished markets" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["results", "count"],
    },
  },

  {
    name: "get_market_trades",
    description: "Get recent trades for a specific market. Shows who's buying/selling, at what prices, and trade sizes. Essential for understanding order flow and market activity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
        limit: {
          type: "number",
          description: "Number of trades to return (default: 50, max: 100)",
        },
      },
      required: ["conditionId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        trades: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              timestamp: { type: "string" },
              side: { type: "string", enum: ["BUY", "SELL"] },
              outcome: { type: "string", enum: ["YES", "NO"] },
              price: { type: "number" },
              size: { type: "number" },
              notional: { type: "number", description: "USD value of trade" },
              trader: { type: "string", description: "Wallet address (may be proxy)" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            totalTrades: { type: "number" },
            totalVolume: { type: "number" },
            buyVolume: { type: "number" },
            sellVolume: { type: "number" },
            avgPrice: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["market", "trades", "summary"],
    },
  },

  {
    name: "get_user_positions",
    description: "Get positions AND trading history for any Polymarket wallet. Shows BOTH open positions (unrealized P&L) AND closed positions (realized P&L with true win rate). Essential for whale tracking - the 'tradingHistory' section shows actual win rate based on completed trades, not just current position values.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: "The wallet address to look up (can be proxy wallet or main wallet)",
        },
        sizeThreshold: {
          type: "number",
          description: "Minimum position size in shares to include (default: 0)",
        },
        limit: {
          type: "number",
          description: "Maximum positions to return (default: 50)",
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        openPositions: {
          type: "array",
          description: "Currently open positions (unrealized P&L)",
          items: {
            type: "object",
            properties: {
              conditionId: { type: "string" },
              marketTitle: { type: "string" },
              outcome: { type: "string", enum: ["YES", "NO"] },
              size: { type: "number", description: "Number of shares" },
              avgPrice: { type: "number", description: "Average entry price" },
              currentPrice: { type: "number" },
              initialValue: { type: "number" },
              currentValue: { type: "number" },
              unrealizedPnL: { type: "number" },
              unrealizedPnLPercent: { type: "number" },
            },
          },
        },
        tradingHistory: {
          type: "object",
          description: "Historical trading performance from closed positions - THIS is the TRUE win rate",
          properties: {
            totalClosedTrades: { type: "number" },
            wins: { type: "number", description: "Trades with positive realized P&L" },
            losses: { type: "number", description: "Trades with negative realized P&L" },
            winRate: { type: "number", description: "Win percentage based on REALIZED trades (0-100)" },
            totalRealizedPnL: { type: "number", description: "Total profit/loss from closed positions" },
            recentTrades: {
              type: "array",
              description: "Most recent closed trades",
              items: {
                type: "object",
                properties: {
                  marketTitle: { type: "string" },
                  outcome: { type: "string" },
                  realizedPnL: { type: "number" },
                },
              },
            },
          },
        },
        openPositionsSummary: {
          type: "object",
          description: "Summary of currently OPEN positions (unrealized, may change)",
          properties: {
            totalOpenPositions: { type: "number" },
            totalValue: { type: "number" },
            totalUnrealizedPnL: { type: "number" },
            profitablePositions: { type: "number" },
            underwaterPositions: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["address", "openPositions", "tradingHistory", "openPositionsSummary"],
    },
  },

  {
    name: "get_top_holders",
    description: "Get the top holders (biggest positions) for a specific market. Shows who the whales are, their position sizes, and implied conviction. Essential for smart money analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
        outcome: {
          type: "string",
          enum: ["YES", "NO", "BOTH"],
          description: "Which outcome to show holders for (default: BOTH)",
        },
        limit: {
          type: "number",
          description: "Number of top holders to return per outcome (default: 20)",
        },
      },
      required: ["conditionId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        market: { type: "string" },
        conditionId: { type: "string" },
        topHolders: {
          type: "object",
          properties: {
            yes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  address: { type: "string" },
                  size: { type: "number", description: "Number of shares" },
                  value: { type: "number", description: "Current position value in USD" },
                  percentOfSupply: { type: "number", description: "% of total YES shares" },
                },
              },
            },
            no: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  rank: { type: "number" },
                  address: { type: "string" },
                  size: { type: "number" },
                  value: { type: "number" },
                  percentOfSupply: { type: "number" },
                },
              },
            },
          },
        },
        concentration: {
          type: "object",
          description: "How concentrated the market is",
          properties: {
            top10YesPercent: { type: "number", description: "% of YES held by top 10" },
            top10NoPercent: { type: "number", description: "% of NO held by top 10" },
            whaleCount: { type: "number", description: "Holders with > $1000 position" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["market", "conditionId", "topHolders"],
    },
  },

  {
    name: "get_market_comments",
    description: "Get comments and discussion for a market or event. Useful for understanding market sentiment, identifying controversies, and seeing what traders are saying.",
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The event slug (e.g., 'will-trump-win')",
        },
        limit: {
          type: "number",
          description: "Number of comments to return (default: 50)",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        event: { type: "string" },
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              author: { type: "string" },
              content: { type: "string" },
              createdAt: { type: "string" },
              likes: { type: "number" },
            },
          },
        },
        totalComments: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["comments"],
    },
  },

  // ==================== DISCOVERY LAYER TOOLS ====================
  // These tools enable cross-platform data composition by exposing
  // all available categories, tags, and browsing capabilities.

  {
    name: "get_all_categories",
    description: `📂 DISCOVERY: List ALL available categories on Polymarket.

Returns category IDs and slugs that can be used with browse_category.

CATEGORIES include: Politics, Crypto, Sports, Science, Pop Culture, Business, etc.

DATA FLOW:
  get_all_categories → category_slug → browse_category → events with conditionIds

EXAMPLE USE CASES:
  - "What categories of predictions exist?" → Call this
  - "Find crypto markets" → Call this, then browse_category({ slug: "crypto" })
  
CROSS-PLATFORM: Use this to find categories that overlap with other data sources (e.g., Sports category overlaps with sportsbook futures).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max categories to return (default: 50)",
          default: 50,
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        categories: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Category ID" },
              label: { type: "string", description: "Display name (e.g., 'Politics')" },
              slug: { type: "string", description: "URL-friendly ID for filtering (e.g., 'politics')" },
              parentCategory: { type: "string", description: "Parent category if nested" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      required: ["categories", "fetchedAt"],
    },
  },

  {
    name: "get_all_tags",
    description: `🏷️ DISCOVERY: List ALL available tags on Polymarket.

Tags are more granular than categories. Examples: "NBA", "Bitcoin", "Trump", "Fed", "Olympics".

Returns tag IDs that can be used with browse_by_tag to find all markets with that tag.

DATA FLOW:
  get_all_tags → tag_id → browse_by_tag → events/markets with conditionIds

EXAMPLE USE CASES:
  - "Find all NBA prediction markets" → Get NBA tag_id, then browse_by_tag
  - "What Bitcoin markets exist?" → Get Bitcoin tag_id, then browse_by_tag
  
COMPOSABILITY WITH ODDS API:
  1. Get NBA tag from Polymarket → browse NBA markets → find "Lakers win championship" at 45%
  2. Call Odds API get_outrights({ sport: "basketball_nba_championship_winner" }) → Lakers +450 (18%)
  3. Compare prices for arbitrage opportunities`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max tags to return (default: 100)",
          default: 100,
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tags: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Tag ID for filtering" },
              label: { type: "string", description: "Display name" },
              slug: { type: "string", description: "URL-friendly identifier" },
            },
          },
        },
        totalCount: { type: "number" },
        hint: { type: "string" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      required: ["tags", "fetchedAt"],
    },
  },

  {
    name: "browse_category",
    description: `📊 BROWSE: Get all events and markets within a category.

INPUT: category slug from get_all_categories (e.g., "politics", "crypto", "sports")

RETURNS: Events with:
  - conditionId (use with check_market_efficiency, analyze_whale_flow, etc.)
  - tokenIds (use with analyze_market_liquidity, get_orderbook)
  - Current prices and volumes
  - Direct URLs to markets

DATA FLOW:
  browse_category → conditionId → [any analysis tool]
  browse_category → slug → get_event_by_slug → detailed market data

CROSS-PLATFORM COMPOSABILITY:
  - Browse "sports" category → find championship markets → compare with Odds API futures
  - Browse "crypto" category → compare with exchange prices from CoinGecko`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Category slug from get_all_categories (e.g., 'politics', 'crypto', 'sports')",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
          default: 50,
        },
        sortBy: {
          type: "string",
          enum: ["volume", "liquidity", "endDate"],
          description: "Sort order (default: volume)",
          default: "volume",
        },
        includeResolved: {
          type: "boolean",
          description: "Include resolved/closed markets (default: false)",
          default: false,
        },
      },
      required: ["category"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        category: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              slug: { type: "string" },
              url: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number" },
              volume: { type: "number" },
              liquidity: { type: "number" },
              endDate: { type: "string" },
              status: { type: "string", enum: ["live", "resolved"] },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      required: ["category", "events", "fetchedAt"],
    },
  },

  {
    name: "browse_by_tag",
    description: `🔍 BROWSE: Get all events/markets with a specific tag.

INPUT: tag_id from get_all_tags

More granular than categories. Use for:
  - Specific sports leagues: "NBA", "NFL", "Premier League"
  - Crypto assets: "Bitcoin", "Ethereum", "Solana"  
  - People: "Trump", "Biden", "Elon Musk"
  - Topics: "AI", "Fed", "Elections"

DATA FLOW:
  get_all_tags → tag_id → browse_by_tag → events with conditionIds → analysis tools

CROSS-PLATFORM EXAMPLE (Sports):
  1. browse_by_tag({ tag_id: "<NBA_TAG_ID>" }) → "Lakers NBA Finals" at 45%
  2. Odds API get_outrights({ sport: "basketball_nba_championship_winner" }) → Lakers +450
  3. Convert: +450 = 18.2% implied probability
  4. DISCREPANCY: Polymarket 45% vs Sportsbooks 18% = potential arbitrage`,
    inputSchema: {
      type: "object" as const,
      properties: {
        tag_id: {
          type: "string",
          description: "Tag ID from get_all_tags",
        },
        limit: {
          type: "number",
          description: "Max results (default: 50)",
          default: 50,
        },
        includeResolved: {
          type: "boolean",
          description: "Include resolved markets (default: false)",
          default: false,
        },
      },
      required: ["tag_id"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tag_id: { type: "string" },
        events: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              slug: { type: "string" },
              url: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number" },
              volume: { type: "number" },
              liquidity: { type: "number" },
              endDate: { type: "string" },
              category: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      required: ["tag_id", "events", "fetchedAt"],
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
        case "analyze_top_holders":
          return await handleAnalyzeTopHolders(args);
        case "find_correlated_markets":
          return await handleFindCorrelatedMarkets(args);
        case "check_market_rules":
          return await handleCheckMarketRules(args);
        case "find_arbitrage_opportunities":
          return await handleFindArbitrageOpportunities(args);
        case "find_trading_opportunities":
          return await handleFindTradingOpportunities(args);
        case "find_moderate_probability_bets":
          return await handleFindModerateProbabilityBets(args);
        case "get_bets_by_probability":
          return await handleGetBetsByProbability(args);
        case "discover_trending_markets":
          return await handleDiscoverTrendingMarkets(args);
        case "analyze_my_positions":
          return await handleAnalyzeMyPositions(args);

        // Cross-Platform Interoperability
        case "get_comparable_markets":
          return await handleGetComparableMarkets(args);

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
        case "get_market_trades":
          return await handleGetMarketTrades(args);
        case "get_user_positions":
          return await handleGetUserPositions(args);
        case "get_top_holders":
          return await handleGetTopHolders(args);
        case "get_market_comments":
          return await handleGetMarketComments(args);

        // Discovery Layer Tools
        case "get_all_categories":
          return await handleGetAllCategories(args);
        case "get_all_tags":
          return await handleGetAllTags(args);
        case "browse_category":
          return await handleBrowseCategory(args);
        case "browse_by_tag":
          return await handleBrowseByTag(args);

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

async function fetchGamma(endpoint: string, timeoutMs = 15000): Promise<unknown> {
  const url = `${GAMMA_API_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gamma API error (${response.status}): ${text.slice(0, 200)}`);
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Gamma API timeout after ${timeoutMs}ms for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchClob(endpoint: string, options?: RequestInit, timeoutMs = 15000): Promise<unknown> {
  const url = `${CLOB_API_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
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
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`CLOB API timeout after ${timeoutMs}ms for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchClobPost(endpoint: string, body: unknown): Promise<unknown> {
  return fetchClob(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function fetchDataApi(endpoint: string, timeoutMs = 15000): Promise<unknown> {
  const url = `${DATA_API_URL}${endpoint}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  
  try {
    const response = await fetch(url, { signal: controller.signal });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Data API error (${response.status}): ${text.slice(0, 200)}`);
    }

    return response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Data API timeout after ${timeoutMs}ms for ${endpoint}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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
    // Query by conditionId - use CLOB API for fast validation, then search Gamma for full data
    // Note: Gamma API /markets?condition_id= does NOT filter (tested via Context7 docs)
    
    // Step 1: Validate conditionId exists via CLOB API (fast)
    try {
      const clobMarket = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
      if (!clobMarket || !clobMarket.condition_id) {
        return errorResult(`Market not found for conditionId: ${conditionId}`);
      }
    } catch {
      return errorResult(`Market not found for conditionId: ${conditionId}`);
    }

    // Step 2: Search through Gamma events to get full market data (needed for prices, question, etc.)
    const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
    for (const event of events) {
      const found = event.markets?.find(m => m.conditionId === conditionId);
      if (found) {
        market = found;
        break;
      }
    }
    
    // Fallback: search through closed events
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
    
    // If CLOB found it but Gamma didn't, create minimal market object from CLOB data
    if (!market) {
      // Re-fetch CLOB data to build minimal market
      const clobMarket = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
      const tokenIds = clobMarket.tokens?.map(t => t.token_id) || [];
      market = {
        conditionId: conditionId,
        question: `Market ${conditionId.slice(0, 10)}...`,
        clobTokenIds: tokenIds,
      };
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
  let sourceEvent: GammaEvent | undefined;

  if (slug) {
    sourceEvent = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
  } else {
    // Query by conditionId - validate via CLOB API first, then search Gamma events
    // Note: Gamma API /markets?condition_id= does NOT filter (per Context7 docs)
    
    try {
      const clobMarket = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
      if (!clobMarket || !clobMarket.condition_id) {
        return errorResult(`Market not found for conditionId: ${conditionId}`);
      }
    } catch {
      return errorResult(`Market not found for conditionId: ${conditionId}`);
    }

    // Search in active events for a market with this conditionId
    const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
    sourceEvent = events.find(e => 
      e.markets?.some(m => m.conditionId === conditionId)
    );
    
    // Fallback: search closed events
    if (!sourceEvent) {
      const closedEvents = (await fetchGamma(`/events?closed=true&limit=50`)) as GammaEvent[];
      sourceEvent = closedEvents.find(e => 
        e.markets?.some(m => m.conditionId === conditionId)
      );
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
  let event: GammaEvent | undefined;

  if (slug) {
    event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
  } else {
    // Query by conditionId - validate via CLOB API first, then search Gamma events
    // Note: Gamma API /markets?condition_id= does NOT filter (per Context7 docs)
    
    try {
      const clobMarket = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
      if (!clobMarket || !clobMarket.condition_id) {
        return errorResult(`Market not found for conditionId: ${conditionId}`);
      }
    } catch {
      return errorResult(`Market not found for conditionId: ${conditionId}`);
    }

    // Search in active events
    const events = (await fetchGamma(`/events?closed=false&limit=100`)) as GammaEvent[];
    event = events.find(e => 
      e.markets?.some(m => m.conditionId === conditionId)
    );
    
    // Fallback: search closed events
    if (!event) {
      const closedEvents = (await fetchGamma(`/events?closed=true&limit=50`)) as GammaEvent[];
      event = closedEvents.find(e => 
        e.markets?.some(m => m.conditionId === conditionId)
      );
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
 * Probability range presets for targetProbability parameter
 */
const PROBABILITY_RANGES: Record<string, { min: number; max: number }> = {
  longshot: { min: 0.01, max: 0.20 },      // 1-20%
  moderate: { min: 0.35, max: 0.65 },      // 35-65%
  likely: { min: 0.65, max: 0.85 },        // 65-85%
  near_certain: { min: 0.85, max: 0.98 },  // 85-98%
};

/**
 * Find genuine trading opportunities across multiple strategies
 */
async function handleFindTradingOpportunities(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  // Parse arguments
  let strategy = (args?.strategy as string) || "all";
  const category = args?.category as string;
  const minLiquidity = (args?.minLiquidity as number) || 1000;
  const riskTolerance = (args?.riskTolerance as string) || "moderate";
  const priceRange = args?.priceRange as { min?: number; max?: number } | undefined;
  const targetProbability = args?.targetProbability as string | undefined;


  // Calculate effective price range from targetProbability or priceRange
  let effectivePriceMin = 0;
  let effectivePriceMax = 1;
  
  if (targetProbability && PROBABILITY_RANGES[targetProbability]) {
    effectivePriceMin = PROBABILITY_RANGES[targetProbability].min;
    effectivePriceMax = PROBABILITY_RANGES[targetProbability].max;
  } else if (priceRange) {
    effectivePriceMin = priceRange.min ?? 0;
    effectivePriceMax = priceRange.max ?? 1;
  }

  const hasPriceFilter = effectivePriceMin > 0 || effectivePriceMax < 1;

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
    url: string;
    conditionId: string;
    slug: string;
    opportunityType: string;
    signal: string;
    currentPrice: number;
    impliedProbability: string;
    suggestedSide: string;
    potentialReturn: string;
    confidence: string;
    liquidity: number;
    volume24h: number;
    riskFactors: string[];
    whyThisOpportunity: string;
    score: number; // internal scoring
  }> = [];

  // Track all markets for suggestions when empty
  const allMarketsData: Array<{
    market: string;
    conditionId: string;
    slug: string;
    yesPrice: number;
    noPrice: number;
    liquidity: number;
    volume24h: number;
  }> = [];

  let marketsScanned = 0;

  // Count markets by price range for suggestions
  let lotteryTicketCount = 0;
  let moderateCount = 0;
  let likelyCount = 0;

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

      // Track all markets for suggestions
      allMarketsData.push({
        market: marketTitle,
        conditionId: market.conditionId || "",
        slug: eventSlug,
        yesPrice,
        noPrice,
        liquidity: marketLiquidity,
        volume24h: marketVolume24h,
      });

      // Count by price range
      if (yesPrice < 0.15 || noPrice < 0.15) lotteryTicketCount++;
      if (yesPrice >= 0.35 && yesPrice <= 0.65) moderateCount++;
      if (yesPrice >= 0.65 && yesPrice <= 0.85) likelyCount++;

      // Apply price filter if specified
      const matchesPriceFilter = !hasPriceFilter || 
        (yesPrice >= effectivePriceMin && yesPrice <= effectivePriceMax) ||
        (noPrice >= effectivePriceMin && noPrice <= effectivePriceMax);

      // ============ STRATEGY 1: LOTTERY TICKETS (formerly asymmetric_upside) ============
      // Look for cheap positions (< 15¢) with potential 6x+ returns
      if (strategy === "all" || strategy === "lottery_tickets") {
        const cheapThreshold = riskTolerance === "conservative" ? 0.10 : riskTolerance === "aggressive" ? 0.20 : 0.15;
        
        // Apply strategy-specific or user-specified price filter
        const strategyMin = hasPriceFilter ? effectivePriceMin : 0.01;
        const strategyMax = hasPriceFilter ? effectivePriceMax : cheapThreshold;
        
        if (yesPrice >= strategyMin && yesPrice <= strategyMax && yesPrice > 0.01) {
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
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "lottery_tickets",
            signal: `YES at ${(yesPrice * 100).toFixed(1)}¢ - potential ${potentialMultiple}x return`,
            currentPrice: yesPrice,
            impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
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
        if (noPrice >= strategyMin && noPrice <= strategyMax && noPrice > 0.01) {
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
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "lottery_tickets",
            signal: `NO at ${(noPrice * 100).toFixed(1)}¢ - potential ${potentialMultiple}x return`,
            currentPrice: noPrice,
            impliedProbability: `${(noPrice * 100).toFixed(0)}%`,
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

      // ============ STRATEGY 2: MODERATE CONVICTION (35-65% bets) ============
      // Balanced risk/reward with 1.5-2.8x returns
      if (strategy === "all" || strategy === "moderate_conviction") {
        const strategyMin = hasPriceFilter ? effectivePriceMin : 0.35;
        const strategyMax = hasPriceFilter ? effectivePriceMax : 0.65;
        
        if (yesPrice >= strategyMin && yesPrice <= strategyMax) {
          const potentialReturn = ((1 - yesPrice) / yesPrice * 100).toFixed(0);
          const riskFactors: string[] = [];
          
          if (marketLiquidity < 10000) riskFactors.push("Moderate liquidity");
          
          let confidence: "high" | "medium" | "low" = "medium";
          if (marketLiquidity > 50000 && marketVolume24h > 10000) confidence = "high";
          if (marketLiquidity < 10000) confidence = "low";

          const score = (marketLiquidity / 1000) + (marketVolume24h / 500) + (50 - Math.abs(yesPrice - 0.5) * 100);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "moderate_conviction",
            signal: `YES at ${(yesPrice * 100).toFixed(0)}¢ - ${potentialReturn}% potential return`,
            currentPrice: yesPrice,
            impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
            suggestedSide: "YES",
            potentialReturn: `${potentialReturn}% if YES wins`,
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `Balanced risk/reward bet. Market implies ~${(yesPrice * 100).toFixed(0)}% chance of YES. If you think it's more likely, good expected value.`,
            score,
          });
        }
      }

      // ============ STRATEGY 3: HIGH CONFIDENCE (70-90% likely outcomes) ============
      // Safer bets with lower but more reliable returns
      if (strategy === "all" || strategy === "high_confidence") {
        const strategyMin = hasPriceFilter ? effectivePriceMin : 0.70;
        const strategyMax = hasPriceFilter ? effectivePriceMax : 0.90;
        
        if (yesPrice >= strategyMin && yesPrice <= strategyMax) {
          const potentialReturn = ((1 - yesPrice) / yesPrice * 100).toFixed(0);
          const riskFactors: string[] = [];
          
          if (marketLiquidity < 20000) riskFactors.push("Check liquidity before large bets");
          
          let confidence: "high" | "medium" | "low" = "high";
          if (marketLiquidity < 20000) confidence = "medium";

          const score = (marketLiquidity / 1000) + (marketVolume24h / 500) + (yesPrice * 50);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "high_confidence",
            signal: `YES at ${(yesPrice * 100).toFixed(0)}¢ - ${potentialReturn}% if correct`,
            currentPrice: yesPrice,
            impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
            suggestedSide: "YES",
            potentialReturn: `${potentialReturn}% if YES wins`,
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `High probability bet. Market strongly favors YES at ${(yesPrice * 100).toFixed(0)}%. Lower return but higher win rate. Good for building consistent profits.`,
            score,
          });
        }
        
        // Check NO side for high confidence (when YES is very unlikely)
        if (noPrice >= strategyMin && noPrice <= strategyMax) {
          const potentialReturn = ((1 - noPrice) / noPrice * 100).toFixed(0);
          const riskFactors: string[] = [];
          
          if (marketLiquidity < 20000) riskFactors.push("Check liquidity before large bets");
          
          let confidence: "high" | "medium" | "low" = "high";
          if (marketLiquidity < 20000) confidence = "medium";

          const score = (marketLiquidity / 1000) + (marketVolume24h / 500) + (noPrice * 50);

          opportunities.push({
            rank: 0,
            market: marketTitle,
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "high_confidence",
            signal: `NO at ${(noPrice * 100).toFixed(0)}¢ - ${potentialReturn}% if correct`,
            currentPrice: noPrice,
            impliedProbability: `${(noPrice * 100).toFixed(0)}% NO wins`,
            suggestedSide: "NO",
            potentialReturn: `${potentialReturn}% if NO wins`,
            confidence,
            liquidity: marketLiquidity,
            volume24h: marketVolume24h,
            riskFactors,
            whyThisOpportunity: `High probability NO bet. Market strongly favors NO at ${(noPrice * 100).toFixed(0)}%. Good for consistent profits if you agree with market sentiment.`,
            score,
          });
        }
      }

      // ============ STRATEGY 4: MOMENTUM ============
      // High volume relative to liquidity = active market with price discovery
      if ((strategy === "all" || strategy === "momentum") && matchesPriceFilter) {
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
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "momentum",
            signal: `Volume ${(volumeToLiquidityRatio * 100).toFixed(0)}% of liquidity in 24h`,
            currentPrice: yesPrice,
            impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
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

      // ============ STRATEGY 5: MISPRICED (formerly value) ============
      // Look for markets where YES + NO doesn't sum to ~1
      if ((strategy === "all" || strategy === "mispriced") && matchesPriceFilter) {
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
            url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
            conditionId: market.conditionId || "",
            slug: eventSlug,
            opportunityType: "mispriced",
            signal,
            currentPrice: yesPrice,
            impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
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

      // ============ STRATEGY 6: NEAR RESOLUTION ============
      // Markets ending soon with clear direction
      if ((strategy === "all" || strategy === "near_resolution") && matchesPriceFilter) {
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
                url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
                conditionId: market.conditionId || "",
                slug: eventSlug,
                opportunityType: "near_resolution",
                signal: `Resolves in ${daysRemaining.toFixed(1)} days - ${isYesFavored ? "YES" : "NO"} at ${(favoredPrice * 100).toFixed(0)}%`,
                currentPrice: yesPrice,
                impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
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
    marketConditions = "No markets match your specific criteria.";
  } else if (opportunities.length < 3) {
    marketConditions = "Few opportunities available matching your criteria.";
  } else if (opportunities.filter(o => o.confidence === "high").length > 3) {
    marketConditions = "Active market with multiple high-confidence opportunities. Good time to trade.";
  } else {
    marketConditions = "Normal market conditions with some speculative opportunities.";
  }

  // Build suggestions and nearestMatches when no opportunities found
  let noOpportunitiesReason: string | undefined;
  let suggestions: Array<{ action: string; reason: string; availableCount?: number }> | undefined;
  let nearestMatches: Array<{ market: string; currentPrice: number; whyNotMatched: string }> | undefined;

  if (opportunities.length === 0) {
    const priceFilterStr = hasPriceFilter 
      ? `price ${(effectivePriceMin * 100).toFixed(0)}-${(effectivePriceMax * 100).toFixed(0)}¢` 
      : "any price";
    
    noOpportunitiesReason = `No bets found matching: ${priceFilterStr}, liquidity >$${minLiquidity}, strategy: ${strategy}`;

    suggestions = [];
    
    if (lotteryTicketCount > 0 && strategy !== "lottery_tickets") {
      suggestions.push({
        action: "Try 'lottery_tickets' strategy",
        availableCount: lotteryTicketCount,
        reason: "Many low-probability high-return bets available (1-15¢ range)",
      });
    }
    
    if (moderateCount > 0 && strategy !== "moderate_conviction") {
      suggestions.push({
        action: "Try 'moderate_conviction' strategy",
        availableCount: moderateCount,
        reason: "Balanced risk/reward bets available (35-65¢ range)",
      });
    }
    
    if (likelyCount > 0 && strategy !== "high_confidence") {
      suggestions.push({
        action: "Try 'high_confidence' strategy",
        availableCount: likelyCount,
        reason: "Safer bets with likely outcomes available (65-85¢ range)",
      });
    }

    if (minLiquidity > 5000) {
      suggestions.push({
        action: `Lower minLiquidity to ${Math.floor(minLiquidity / 2)}`,
        reason: "More markets available with lower liquidity requirement",
      });
    }

    if (hasPriceFilter) {
      suggestions.push({
        action: "Expand price range or remove targetProbability filter",
        reason: "Wider range captures more opportunities",
      });
    }

    // Find nearest matches (markets that almost qualified)
    nearestMatches = allMarketsData
      .filter(m => {
        if (!hasPriceFilter) return false;
        const nearMin = m.yesPrice >= effectivePriceMin - 0.10 && m.yesPrice < effectivePriceMin;
        const nearMax = m.yesPrice > effectivePriceMax && m.yesPrice <= effectivePriceMax + 0.10;
        return nearMin || nearMax;
      })
      .slice(0, 3)
      .map(m => ({
        market: m.market,
        currentPrice: m.yesPrice,
        whyNotMatched: m.yesPrice < effectivePriceMin 
          ? `Price ${(m.yesPrice * 100).toFixed(0)}¢ is below your ${(effectivePriceMin * 100).toFixed(0)}¢ minimum`
          : `Price ${(m.yesPrice * 100).toFixed(0)}¢ is above your ${(effectivePriceMax * 100).toFixed(0)}¢ maximum`,
      }));
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
    ...(suggestions && suggestions.length > 0 && { suggestions }),
    ...(nearestMatches && nearestMatches.length > 0 && { nearestMatches }),
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Find moderate probability bets (40-75%) with decent liquidity
 * Dedicated tool for "more likely" outcomes with 1.3-2.5x returns
 */
async function handleFindModerateProbabilityBets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const minPrice = (args?.minPrice as number) ?? 0.40;
  const maxPrice = (args?.maxPrice as number) ?? 0.75;
  const minLiquidity = (args?.minLiquidity as number) ?? 10000;
  const category = args?.category as string;
  const sortBy = (args?.sortBy as string) ?? "return_potential";
  const limit = (args?.limit as number) ?? 10;

  // Fetch active markets
  let endpoint = `/events?closed=false&limit=150&order=liquidity&ascending=false`;
  if (category && category !== "all") {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  const opportunities: Array<{
    market: string;
    url: string;
    slug: string;
    conditionId: string;
    currentPrice: number;
    impliedProbability: string;
    potentialReturn: string;
    liquidity: number;
    volume24h: number;
    endDate: string;
    category: string;
    whyThisBet: string;
    sortScore: number;
  }> = [];

  let marketsScanned = 0;

  for (const event of events) {
    if (!event.markets || event.markets.length === 0) continue;

    const eventLiquidity = Number(event.liquidity || 0);
    const eventVolume24h = Number(event.volume24hr || 0);
    const eventSlug = event.slug || "";
    const eventCategory = (event as GammaEvent & { category?: string }).category || "other";
    const eventEndDate = event.endDate || event.endDateIso || "";

    for (const market of event.markets) {
      const gammaPrices = parseJsonArray(market.outcomePrices);
      if (gammaPrices.length < 2) continue;

      const yesPrice = parseFloat(gammaPrices[0]) || 0;
      const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
      const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
      const marketTitle = market.question || event.title || "Unknown";

      if (marketLiquidity < minLiquidity) continue;
      if (yesPrice <= 0) continue;

      marketsScanned++;

      // Check if price is in desired range
      if (yesPrice >= minPrice && yesPrice <= maxPrice) {
        const returnPercent = ((1 - yesPrice) / yesPrice * 100);
        const returnMultiple = (1 / yesPrice);

        // Calculate sort score based on sortBy
        let sortScore = 0;
        switch (sortBy) {
          case "return_potential":
            sortScore = returnPercent;
            break;
          case "liquidity":
            sortScore = marketLiquidity;
            break;
          case "volume":
            sortScore = marketVolume24h;
            break;
          case "closing_soon":
            if (eventEndDate) {
              const daysRemaining = (new Date(eventEndDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
              sortScore = daysRemaining > 0 ? 1 / daysRemaining : 0;
            }
            break;
        }

        opportunities.push({
          market: marketTitle,
          url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
          slug: eventSlug,
          conditionId: market.conditionId || "",
          currentPrice: yesPrice,
          impliedProbability: `${(yesPrice * 100).toFixed(0)}%`,
          potentialReturn: `${returnPercent.toFixed(0)}% (${returnMultiple.toFixed(2)}x)`,
          liquidity: marketLiquidity,
          volume24h: marketVolume24h,
          endDate: eventEndDate,
          category: eventCategory,
          whyThisBet: `Market implies ${(yesPrice * 100).toFixed(0)}% chance. If YES wins, you get ${returnPercent.toFixed(0)}% return. More likely to win than lottery tickets, with solid upside.`,
          sortScore,
        });
      }
    }
  }

  // Sort and limit
  opportunities.sort((a, b) => b.sortScore - a.sortScore);
  const finalOpportunities = opportunities.slice(0, limit).map(({ sortScore, ...rest }) => rest);

  // Calculate average return
  const avgReturn = opportunities.length > 0
    ? opportunities.reduce((sum, o) => sum + ((1 - o.currentPrice) / o.currentPrice * 100), 0) / opportunities.length
    : 0;

  return successResult({
    opportunities: finalOpportunities,
    summary: {
      marketsScanned,
      matchingBets: opportunities.length,
      priceRange: `${(minPrice * 100).toFixed(0)}-${(maxPrice * 100).toFixed(0)}¢`,
      avgReturn: `${avgReturn.toFixed(0)}%`,
    },
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * Simple tool to get bets by likelihood category
 */
async function handleGetBetsByProbability(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const likelihood = args?.likelihood as string;
  const category = args?.category as string;
  const limit = (args?.limit as number) ?? 5;

  if (!likelihood) {
    return errorResult("likelihood parameter is required");
  }

  // Define probability ranges for each likelihood
  const likelihoodRanges: Record<string, { min: number; max: number; description: string }> = {
    very_unlikely: { min: 0.01, max: 0.15, description: "1-15%" },
    unlikely: { min: 0.15, max: 0.35, description: "15-35%" },
    coinflip: { min: 0.35, max: 0.65, description: "35-65%" },
    likely: { min: 0.65, max: 0.85, description: "65-85%" },
    very_likely: { min: 0.85, max: 0.95, description: "85-95%" },
  };

  const range = likelihoodRanges[likelihood];
  if (!range) {
    return errorResult(`Invalid likelihood: ${likelihood}. Must be one of: ${Object.keys(likelihoodRanges).join(", ")}`);
  }

  // Fetch active markets
  let endpoint = `/events?closed=false&limit=100&order=liquidity&ascending=false`;
  if (category && category !== "all") {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint)) as GammaEvent[];

  const bets: Array<{
    market: string;
    url: string;
    slug: string;
    conditionId: string;
    currentPrice: number;
    impliedProbability: string;
    potentialReturn: string;
    liquidity: number;
    volume24h: number;
    category: string;
  }> = [];

  for (const event of events) {
    if (!event.markets || event.markets.length === 0) continue;

    const eventLiquidity = Number(event.liquidity || 0);
    const eventVolume24h = Number(event.volume24hr || 0);
    const eventSlug = event.slug || "";
    const eventCategory = (event as GammaEvent & { category?: string }).category || "other";

    for (const market of event.markets) {
      const gammaPrices = parseJsonArray(market.outcomePrices);
      if (gammaPrices.length < 2) continue;

      const yesPrice = parseFloat(gammaPrices[0]) || 0;
      const noPrice = parseFloat(gammaPrices[1]) || 0;
      const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
      const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
      const marketTitle = market.question || event.title || "Unknown";

      // Minimum liquidity check
      if (marketLiquidity < 5000) continue;
      if (yesPrice <= 0) continue;

      // Check YES side
      if (yesPrice >= range.min && yesPrice <= range.max) {
        const returnPercent = ((1 - yesPrice) / yesPrice * 100);
        bets.push({
          market: marketTitle,
          url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
          slug: eventSlug,
          conditionId: market.conditionId || "",
          currentPrice: yesPrice,
          impliedProbability: `${(yesPrice * 100).toFixed(0)}% YES`,
          potentialReturn: `${returnPercent.toFixed(0)}%`,
          liquidity: marketLiquidity,
          volume24h: marketVolume24h,
          category: eventCategory,
        });
      }
      
      // Check NO side
      if (noPrice >= range.min && noPrice <= range.max) {
        const returnPercent = ((1 - noPrice) / noPrice * 100);
        bets.push({
          market: marketTitle,
          url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
          slug: eventSlug,
          conditionId: market.conditionId || "",
          currentPrice: noPrice,
          impliedProbability: `${(noPrice * 100).toFixed(0)}% NO`,
          potentialReturn: `${returnPercent.toFixed(0)}%`,
          liquidity: marketLiquidity,
          volume24h: marketVolume24h,
          category: eventCategory,
        });
      }
    }
  }

  // Sort by liquidity and limit
  bets.sort((a, b) => b.liquidity - a.liquidity);
  const finalBets = bets.slice(0, limit);

  // Calculate return range
  const returns = finalBets.map(b => ((1 - b.currentPrice) / b.currentPrice * 100));
  const minReturn = returns.length > 0 ? Math.min(...returns) : 0;
  const maxReturn = returns.length > 0 ? Math.max(...returns) : 0;

  return successResult({
    bets: finalBets,
    summary: {
      likelihood,
      probabilityRange: range.description,
      betsFound: bets.length,
      returnRange: returns.length > 0 ? `${minReturn.toFixed(0)}-${maxReturn.toFixed(0)}%` : "N/A",
    },
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
    url: string;
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

    const eventSlug = event.slug || "";
    trendingMarkets.push({
      rank: 0,
      title: event.title || market.question || "Unknown",
      url: eventSlug ? `https://polymarket.com/event/${eventSlug}` : "",
      slug: eventSlug,
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
// CROSS-PLATFORM INTEROPERABILITY HANDLER
// ============================================================================

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
    'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'too', 'very',
    'can', 'just', 'should', 'now', 'before', 'after', 'during', 'while',
  ]);
  
  return text.toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word))
    .slice(0, 15); // Limit to 15 keywords
}

/**
 * Extract team names from sports-related text
 */
function extractTeams(text: string): string[] {
  const teams: string[] = [];
  const textLower = text.toLowerCase();
  
  // Common sports team patterns
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
  
  // Sports detection
  if (['nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'ufc', 'mma', 'boxing', 'f1', 'nascar', 'olympics', 'world cup', 'super bowl', 'championship'].some(s => textLower.includes(s))) {
    return 'sports';
  }
  
  // Politics
  if (['election', 'president', 'senate', 'congress', 'vote', 'trump', 'biden', 'democrat', 'republican', 'governor', 'political', 'poll'].some(s => textLower.includes(s))) {
    return 'politics';
  }
  
  // Crypto
  if (['bitcoin', 'ethereum', 'crypto', 'btc', 'eth', 'solana', 'token', 'defi', 'nft', 'blockchain'].some(s => textLower.includes(s))) {
    return 'crypto';
  }
  
  // Entertainment
  if (['oscar', 'grammy', 'emmy', 'movie', 'film', 'tv', 'show', 'actor', 'singer', 'celebrity', 'music', 'album', 'award'].some(s => textLower.includes(s))) {
    return 'entertainment';
  }
  
  // Finance/Business
  if (['stock', 'market', 'fed', 'interest rate', 'recession', 'inflation', 'gdp', 'economic', 'company', 'earnings', 'ipo', 'merger'].some(s => textLower.includes(s))) {
    return 'business';
  }
  
  // Science/Tech
  if (['ai', 'spacex', 'nasa', 'launch', 'scientific', 'research', 'climate', 'technology', 'tech'].some(s => textLower.includes(s))) {
    return 'science';
  }
  
  return category || 'other';
}

async function handleGetComparableMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = args?.category as string | undefined;
  const keywords = args?.keywords as string | undefined;
  const minVolume = (args?.minVolume as number) || 1000;
  const limit = Math.min((args?.limit as number) || 30, 100);

  try {
    // IMPORTANT: The Gamma API doesn't properly filter by category, so we must fetch MORE events
    // and filter client-side. Political/sports markets may not be in the first 100 results.
    // When category filter is specified, fetch 500 events to ensure we capture all relevant markets.
    const fetchLimit = category ? 500 : limit * 5;
    const events = (await fetchGamma(`/events?closed=false&limit=${fetchLimit}&order=volume&ascending=false`)) as GammaEvent[];

    let filtered = events || [];

    // Filter by keywords if provided (using OR matching)
    if (keywords) {
      const queryWords = keywords.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2);
      
      filtered = filtered.filter((e) => {
        const searchText = ((e.title || '') + ' ' + (e.description || '')).toLowerCase();
        return queryWords.some(word => searchText.includes(word));
      });
    }

    // Filter by minimum volume
    filtered = filtered.filter(e => (e.volume || 0) >= minVolume);

    // Filter by category if provided
    if (category) {
      filtered = filtered.filter(e => {
        const marketCategory = categorizeMarket(e.title || '', e.category);
        return marketCategory.toLowerCase() === category.toLowerCase();
      });
    }

    // Transform to standardized format
    const markets = filtered
      .slice(0, limit)
      .map((e) => {
        const title = e.title || '';
        const description = e.description || '';
        const fullText = title + ' ' + description;
        
        // Extract outcomes from the first market (most events have one main market)
        const mainMarket = e.markets?.[0];
        const prices = parseJsonArray(mainMarket?.outcomePrices);
        // Standard Polymarket markets have Yes/No outcomes with prices in outcomePrices array
        const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;
        const noPrice = prices[1] ? parseFloat(prices[1]) : 0.5;
        const outcomes = [
          { name: 'Yes', normalizedProbability: yesPrice, rawPrice: yesPrice },
          { name: 'No', normalizedProbability: noPrice, rawPrice: noPrice },
        ];

        return {
          title,
          description: description.slice(0, 200) + (description.length > 200 ? '...' : ''),
          eventCategory: categorizeMarket(title, e.category),
          keywords: extractKeywords(fullText),
          teams: extractTeams(fullText),
          outcomes,
          volume24h: e.volume || 0,
          liquidity: e.liquidity || 0,
          endDate: e.endDate || e.endDateIso || null,
          url: e.slug ? `https://polymarket.com/event/${e.slug}` : null,
          platformMarketId: mainMarket?.conditionId || e.id,
        };
      });

    const sportsCount = markets.filter(m => m.eventCategory === 'sports').length;
    const politicsCount = markets.filter(m => m.eventCategory === 'politics').length;

    return successResult({
      platform: 'polymarket',
      markets,
      totalCount: markets.length,
      categoryBreakdown: {
        sports: sportsCount,
        politics: politicsCount,
        crypto: markets.filter(m => m.eventCategory === 'crypto').length,
        other: markets.filter(m => !['sports', 'politics', 'crypto'].includes(m.eventCategory)).length,
      },
      hint: `Returned ${markets.length} markets. Probabilities are normalized 0-1. Compare with Kalshi (yesPrice/100) or Odds API (1/decimal_odds).`,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get comparable markets: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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

  const simplified = filteredEvents
    .filter((e) => e.slug) // Only include events with valid slugs (for URL generation)
    .map((e) => ({
      id: e.id,
      title: e.title,
      url: `https://polymarket.com/event/${e.slug}`, // Always include URL
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
  const status = (args?.status as string) || "live"; // Default to live (tradeable) markets
  const limit = Math.min((args?.limit as number) || 20, 50);
  // matchMode: "all" = all words must match, "any" = any word matches (better for multi-topic searches)
  const matchMode = (args?.matchMode as string) || "any"; // Default to "any" for better cross-platform compatibility

  // Determine which markets to fetch based on status filter
  // closed=false means live/active markets, closed=true means resolved/finished markets
  // Use order=id&ascending=false to get NEWEST markets first (critical for finding recent crypto markets)
  // IMPORTANT: Gamma API doesn't do server-side text search, so we must fetch more and filter client-side
  let fetchLimit = query ? 500 : limit * 5; // Fetch more when searching to find relevant markets
  
  let allEvents: GammaEvent[] = [];
  
  // Build query string with ordering to get newest markets first
  const orderParams = "&order=id&ascending=false";
  
  if (status === "all") {
    // Fetch both live and resolved markets
    const [liveEvents, resolvedEvents] = await Promise.all([
      fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
      fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
    ]);
    allEvents = [...(liveEvents || []), ...(resolvedEvents || [])];
  } else if (status === "resolved") {
    // Only resolved/finished markets
    allEvents = (await fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`)) as GammaEvent[];
  } else {
    // Default: only live/tradeable markets
    allEvents = (await fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`)) as GammaEvent[];
  }

  let filtered = allEvents || [];

  // Filter by query if provided
  // matchMode="any": ANY word matches (good for "NBA NFL MLB" to find NBA OR NFL OR MLB markets)
  // matchMode="all": ALL words must match (good for "Bitcoin price 2025" to require all terms)
  if (query) {
    // Split query into words and filter out common stop words
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by']);
    const queryWords = query.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 1 && !stopWords.has(word));
    
    filtered = filtered.filter((e) => {
      const titleLower = (e.title || '').toLowerCase();
      const descLower = (e.description || '').toLowerCase();
      const searchText = titleLower + ' ' + descLower;
      
      if (matchMode === "all") {
        // ALL query words must be present (strict matching)
        return queryWords.every(word => searchText.includes(word));
      } else {
        // ANY query word matches (better for multi-topic searches like "NBA NFL MLB")
        return queryWords.some(word => searchText.includes(word));
      }
    });
  }

  // Count by status for breakdown
  let liveCount = 0;
  let resolvedCount = 0;

  const results = filtered
    .filter((e) => e.slug) // Only include markets with valid slugs (for URL generation)
    .slice(0, limit)
    .map((e) => {
      // Determine market status: closed=true means resolved, active=false means not trading
      const isResolved = e.closed === true;
      const marketStatus = isResolved ? "resolved" : "live";
      
      if (isResolved) {
        resolvedCount++;
      } else {
        liveCount++;
      }

      return {
        title: e.title,
        url: `https://polymarket.com/event/${e.slug}`, // Always include URL from slug
        slug: e.slug,
        status: marketStatus,
        category: e.category,
        conditionId: e.markets?.[0]?.conditionId,
        volume: e.volume,
        liquidity: e.liquidity,
        endDate: e.endDate || e.endDateIso,
      };
    });

  return successResult({
    results,
    count: results.length,
    statusBreakdown: {
      live: liveCount,
      resolved: resolvedCount,
    },
    hint: status === "live"
      ? "Showing LIVE markets only (open for trading). Use status='resolved' to see finished markets."
      : status === "resolved"
        ? "Showing RESOLVED markets only (already finished). Use status='live' to see tradeable markets."
        : "Showing ALL markets (both live and resolved).",
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 RAW DATA HANDLERS
// ============================================================================

async function handleGetMarketTrades(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const limit = Math.min((args?.limit as number) || 50, 100);

  if (!conditionId) {
    return errorResult("conditionId is required");
  }

  try {
    const trades = (await fetchDataApi(`/trades?market=${conditionId}&limit=${limit}`)) as DataApiTrade[];

    if (!trades || !Array.isArray(trades)) {
      return successResult({
        market: conditionId,
        trades: [],
        summary: { totalTrades: 0, totalVolume: 0, buyVolume: 0, sellVolume: 0, avgPrice: 0 },
        fetchedAt: new Date().toISOString(),
      });
    }

    let totalVolume = 0;
    let buyVolume = 0;
    let sellVolume = 0;
    let priceSum = 0;

    const formattedTrades = trades.map((t) => {
      const price = Number(t.price || 0);
      const size = Number(t.size || 0);
      const notional = price * size;
      const side = t.side?.toUpperCase() || "BUY";

      totalVolume += notional;
      priceSum += price;
      if (side === "BUY") buyVolume += notional;
      else sellVolume += notional;

      return {
        id: t.id || "",
        timestamp: t.timestamp || t.matchTime || "",
        side,
        outcome: t.outcome || "YES",
        price,
        size,
        notional: Number(notional.toFixed(2)),
        trader: t.trader || t.proxyWallet || "",
      };
    });

    return successResult({
      market: conditionId,
      trades: formattedTrades,
      summary: {
        totalTrades: trades.length,
        totalVolume: Number(totalVolume.toFixed(2)),
        buyVolume: Number(buyVolume.toFixed(2)),
        sellVolume: Number(sellVolume.toFixed(2)),
        avgPrice: trades.length > 0 ? Number((priceSum / trades.length).toFixed(4)) : 0,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to fetch trades: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetUserPositions(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const address = args?.address as string;
  const sizeThreshold = (args?.sizeThreshold as number) || 0;
  const limit = Math.min((args?.limit as number) || 50, 100);

  if (!address) {
    return errorResult("address is required");
  }

  try {
    // Fetch BOTH open positions AND closed positions in parallel
    const [openPositions, closedPositions] = await Promise.all([
      fetchDataApi(`/positions?user=${address}&limit=${limit}${sizeThreshold > 0 ? `&sizeThreshold=${sizeThreshold}` : ""}`)
        .catch(() => []) as Promise<DataApiPosition[]>,
      fetchDataApi(`/closed-positions?user=${address}&limit=${limit}`)
        .catch(() => []) as Promise<DataApiClosedPosition[]>,
    ]);

    // Process OPEN positions (unrealized P&L)
    let totalOpenValue = 0;
    let totalUnrealizedPnL = 0;
    let profitableCount = 0;
    let underwaterCount = 0;

    const formattedOpenPositions = (Array.isArray(openPositions) ? openPositions : []).map((p) => {
      const size = Number(p.size || 0);
      const avgPrice = Number(p.avgPrice || 0);
      const curPrice = Number(p.curPrice || avgPrice);
      const initialValue = Number(p.initialValue || size * avgPrice);
      const currentValue = Number(p.currentValue || size * curPrice);
      const pnl = Number(p.cashPnl || currentValue - initialValue);
      const pnlPercent = initialValue > 0 ? (pnl / initialValue) * 100 : 0;

      totalOpenValue += currentValue;
      totalUnrealizedPnL += pnl;
      if (pnl > 0.01) profitableCount++;
      else if (pnl < -0.01) underwaterCount++;

      return {
        conditionId: p.conditionId || "",
        marketTitle: p.title || p.question || "Unknown",
        outcome: p.outcome || "YES",
        size,
        avgPrice,
        currentPrice: curPrice,
        initialValue: Number(initialValue.toFixed(2)),
        currentValue: Number(currentValue.toFixed(2)),
        unrealizedPnL: Number(pnl.toFixed(2)),
        unrealizedPnLPercent: Number(pnlPercent.toFixed(2)),
      };
    });

    // Process CLOSED positions (realized P&L) - THIS IS THE TRUE WIN RATE
    let wins = 0;
    let losses = 0;
    let totalRealizedPnL = 0;

    const closedArray = Array.isArray(closedPositions) ? closedPositions : [];
    const recentTrades: Array<{ marketTitle: string; outcome: string; realizedPnL: number }> = [];

    for (const p of closedArray) {
      const realizedPnL = Number(p.realizedPnl || 0);
      totalRealizedPnL += realizedPnL;
      
      if (realizedPnL > 0.01) wins++;
      else if (realizedPnL < -0.01) losses++;

      // Keep most recent 10 trades for display
      if (recentTrades.length < 10) {
        recentTrades.push({
          marketTitle: p.title || "Unknown",
          outcome: p.outcome || "YES",
          realizedPnL: Number(realizedPnL.toFixed(2)),
        });
      }
    }

    const totalClosedTrades = wins + losses;
    const winRate = totalClosedTrades > 0 ? (wins / totalClosedTrades) * 100 : 0;

    return successResult({
      address,
      openPositions: formattedOpenPositions,
      tradingHistory: {
        totalClosedTrades,
        wins,
        losses,
        winRate: Number(winRate.toFixed(1)),
        totalRealizedPnL: Number(totalRealizedPnL.toFixed(2)),
        recentTrades,
        note: "Win rate is calculated from CLOSED positions (realized P&L), not open positions",
      },
      openPositionsSummary: {
        totalOpenPositions: formattedOpenPositions.length,
        totalValue: Number(totalOpenValue.toFixed(2)),
        totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
        profitablePositions: profitableCount,
        underwaterPositions: underwaterCount,
        note: "Open positions show UNREALIZED P&L - these may change before resolution",
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to fetch positions: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetTopHolders(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const outcome = (args?.outcome as string) || "BOTH";
  const limit = Math.min((args?.limit as number) || 20, 50);

  if (!conditionId) {
    return errorResult("conditionId is required");
  }

  try {
    // Data API /positions endpoint requires user address, so we aggregate from trades
    // This gives us active traders and their net positions
    const trades = (await fetchDataApi(
      `/trades?market=${conditionId}&limit=500`
    )) as DataApiTrade[];

    if (!trades || !Array.isArray(trades)) {
      return successResult({
        market: conditionId,
        conditionId,
        topHolders: { yes: [], no: [] },
        concentration: { top10YesPercent: 0, top10NoPercent: 0, whaleCount: 0 },
        note: "No trade data available for this market",
        fetchedAt: new Date().toISOString(),
      });
    }

    // Aggregate trades by wallet to estimate positions
    // Net position = sum of buys - sum of sells
    const walletPositions: Record<string, { yes: number; no: number; address: string }> = {};

    for (const t of trades) {
      const wallet = t.proxyWallet || t.trader || "";
      if (!wallet) continue;

      if (!walletPositions[wallet]) {
        walletPositions[wallet] = { yes: 0, no: 0, address: wallet };
      }

      const size = Number(t.size || 0);
      const side = t.side?.toUpperCase();
      const outcomeType = t.outcome?.toLowerCase() || "yes";

      if (outcomeType === "yes" || outcomeType === "0") {
        if (side === "BUY" || side === "B") {
          walletPositions[wallet].yes += size;
        } else {
          walletPositions[wallet].yes -= size;
        }
      } else {
        if (side === "BUY" || side === "B") {
          walletPositions[wallet].no += size;
        } else {
          walletPositions[wallet].no -= size;
        }
      }
    }

    // Convert to arrays and filter positive positions
    const yesHolders = Object.values(walletPositions)
      .filter(w => w.yes > 0)
      .map(w => ({ address: w.address, size: w.yes }))
      .sort((a, b) => b.size - a.size);

    const noHolders = Object.values(walletPositions)
      .filter(w => w.no > 0)
      .map(w => ({ address: w.address, size: w.no }))
      .sort((a, b) => b.size - a.size);

    // Calculate totals for percentages
    const totalYes = yesHolders.reduce((sum, p) => sum + p.size, 0);
    const totalNo = noHolders.reduce((sum, p) => sum + p.size, 0);

    // Get current prices for value calculation
    let yesPrice = 0.5;
    let noPrice = 0.5;
    try {
      const market = (await fetchClob(`/markets/${conditionId}`)) as ClobMarket;
      const tokens = market?.tokens;
      if (tokens && tokens.length >= 2) {
        const pricesResp = (await fetchClobPost("/prices", [
          { token_id: tokens[0].token_id, side: "BUY" },
          { token_id: tokens[1].token_id, side: "BUY" },
        ])) as Record<string, { BUY?: string } | string>;

        const yesData = pricesResp[tokens[0].token_id];
        const noData = pricesResp[tokens[1].token_id];
        if (yesData) yesPrice = typeof yesData === "object" && yesData.BUY ? Number(yesData.BUY) : Number(yesData);
        if (noData) noPrice = typeof noData === "object" && noData.BUY ? Number(noData.BUY) : Number(noData);
      }
    } catch {
      // Use defaults
    }

    const formatHolders = (holders: Array<{ address: string; size: number }>, total: number, price: number) => {
      return holders
        .slice(0, limit)
        .map((p, idx) => {
          const value = p.size * price;
          return {
            rank: idx + 1,
            address: p.address,
            size: Number(p.size.toFixed(2)),
            value: Number(value.toFixed(2)),
            percentOfSupply: total > 0 ? Number(((p.size / total) * 100).toFixed(2)) : 0,
          };
        });
    };

    const topYes = outcome === "NO" ? [] : formatHolders(yesHolders, totalYes, yesPrice);
    const topNo = outcome === "YES" ? [] : formatHolders(noHolders, totalNo, noPrice);

    // Calculate concentration
    const top10YesPercent = topYes.slice(0, 10).reduce((sum, h) => sum + h.percentOfSupply, 0);
    const top10NoPercent = topNo.slice(0, 10).reduce((sum, h) => sum + h.percentOfSupply, 0);
    const whaleCount = [...topYes, ...topNo].filter(h => h.value > 1000).length;

    // Get market title
    let marketTitle = conditionId;
    try {
      const events = (await fetchGamma(`/events?closed=false&limit=50`)) as GammaEvent[];
      for (const e of events) {
        const m = e.markets?.find(m => m.conditionId === conditionId);
        if (m) {
          marketTitle = m.question || e.title || conditionId;
          break;
        }
      }
    } catch {
      // Use conditionId as title
    }

    return successResult({
      market: marketTitle,
      conditionId,
      topHolders: { yes: topYes, no: topNo },
      concentration: {
        top10YesPercent: Number(top10YesPercent.toFixed(2)),
        top10NoPercent: Number(top10NoPercent.toFixed(2)),
        whaleCount,
      },
      note: "Positions estimated from recent trade activity (last 500 trades)",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to fetch top holders: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetMarketComments(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  const limit = Math.min((args?.limit as number) || 50, 100);

  if (!slug) {
    return errorResult("slug is required");
  }

  try {
    // Gamma API has a comments endpoint for events
    const comments = (await fetchGamma(`/comments?slug=${slug}&limit=${limit}`)) as GammaComment[];

    if (!comments || !Array.isArray(comments)) {
      // Try alternative endpoint
      const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
      return successResult({
        event: event?.title || slug,
        comments: [],
        totalComments: 0,
        note: "No comments found for this market",
        fetchedAt: new Date().toISOString(),
      });
    }

    const formattedComments = comments.map((c) => ({
      id: c.id || "",
      author: c.userAddress || c.author || "anonymous",
      content: c.content || c.text || "",
      createdAt: c.createdAt || c.timestamp || "",
      likes: Number(c.likes || c.upvotes || 0),
    }));

    return successResult({
      event: slug,
      comments: formattedComments,
      totalComments: comments.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Comments endpoint may not be available - return gracefully
    return successResult({
      event: slug,
      comments: [],
      totalComments: 0,
      note: "Comments not available for this market",
      fetchedAt: new Date().toISOString(),
    });
  }
}

// ============================================================================
// DISCOVERY LAYER HANDLERS
// Enable cross-platform data composition by exposing categories, tags, and browsing
// ============================================================================

async function handleGetAllCategories(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const limit = (args?.limit as number) || 50;

  try {
    // Fetch categories from Gamma API
    const categories = await fetchGamma(`/categories?limit=${limit}`) as Array<{
      id: string;
      label?: string;
      slug?: string;
      parentCategory?: string;
    }>;

    const formatted = (categories || []).map((c) => ({
      id: c.id || "",
      label: c.label || "",
      slug: c.slug || "",
      parentCategory: c.parentCategory || null,
    }));

    return successResult({
      categories: formatted,
      totalCount: formatted.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get categories: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetAllTags(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const limit = (args?.limit as number) || 100;

  try {
    // Fetch tags from Gamma API
    const tags = await fetchGamma(`/tags?limit=${limit}`) as Array<{
      id: string;
      label?: string;
      slug?: string;
    }>;

    const formatted = (tags || []).map((t) => ({
      id: t.id || "",
      label: t.label || "",
      slug: t.slug || "",
    }));

    return successResult({
      tags: formatted,
      totalCount: formatted.length,
      hint: "Use tag id with browse_by_tag to get all markets for that tag",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get tags: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleBrowseCategory(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  // Accept both "category" and "slug" parameters for flexibility (AI sometimes uses wrong name)
  const category = (args?.category || args?.slug) as string;
  const limit = (args?.limit as number) || 50;
  const sortBy = (args?.sortBy as string) || "volume";
  const includeResolved = args?.includeResolved === true;

  if (!category) {
    return errorResult("category parameter is required. Use get_all_categories to find available categories.");
  }

  try {
    const closed = includeResolved ? "true" : "false";
    const orderField = sortBy === "endDate" ? "endDate" : sortBy === "liquidity" ? "liquidity" : "volume";
    
    const events = await fetchGamma(
      `/events?category=${category}&closed=${closed}&limit=${limit}&order=${orderField}&ascending=false`
    ) as GammaEvent[];

    const formatted = (events || [])
      .filter((e) => e.slug)
      .map((e) => {
        const market = e.markets?.[0];
        const prices = parseJsonArray(market?.outcomePrices);
        const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;

        return {
          title: e.title || "",
          slug: e.slug || "",
          url: `https://polymarket.com/event/${e.slug}`,
          conditionId: market?.conditionId || e.id || "",
          currentPrice: yesPrice,
          volume: e.volume || 0,
          liquidity: e.liquidity || 0,
          endDate: e.endDate || e.endDateIso || "",
          status: e.closed ? "resolved" : "live",
        };
      });

    return successResult({
      category,
      events: formatted,
      totalCount: formatted.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to browse category: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleBrowseByTag(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tag_id = args?.tag_id as string;
  const limit = (args?.limit as number) || 50;
  const includeResolved = args?.includeResolved === true;

  if (!tag_id) {
    return errorResult("tag_id parameter is required. Use get_all_tags to find available tags.");
  }

  try {
    const closed = includeResolved ? "true" : "false";
    
    const events = await fetchGamma(
      `/events?tag_id=${tag_id}&closed=${closed}&limit=${limit}&order=volume&ascending=false`
    ) as GammaEvent[];

    const formatted = (events || [])
      .filter((e) => e.slug)
      .map((e) => {
        const market = e.markets?.[0];
        const prices = parseJsonArray(market?.outcomePrices);
        const yesPrice = prices[0] ? parseFloat(prices[0]) : 0.5;

        return {
          title: e.title || "",
          slug: e.slug || "",
          url: `https://polymarket.com/event/${e.slug}`,
          conditionId: market?.conditionId || e.id || "",
          currentPrice: yesPrice,
          volume: e.volume || 0,
          liquidity: e.liquidity || 0,
          endDate: e.endDate || e.endDateIso || "",
          category: e.category || "",
        };
      });

    return successResult({
      tag_id,
      events: formatted,
      totalCount: formatted.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to browse by tag: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// NEW TIER 1 INTELLIGENCE HANDLER: analyze_top_holders
// ============================================================================

async function handleAnalyzeTopHolders(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const slug = args?.slug as string;

  if (!conditionId && !slug) {
    return errorResult("Either conditionId or slug is required");
  }

  // Resolve conditionId from slug if needed
  let resolvedConditionId = conditionId;
  let marketTitle = "";

  if (slug) {
    const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
    if (!event?.markets?.[0]) {
      return errorResult(`Event not found: ${slug}`);
    }
    resolvedConditionId = event.markets[0].conditionId || "";
    marketTitle = event.markets[0].question || event.title || slug;
  }

  if (!resolvedConditionId) {
    return errorResult("Could not resolve conditionId");
  }

  // Get top holders using the raw data handler
  const holdersResult = await handleGetTopHolders({ conditionId: resolvedConditionId, outcome: "BOTH", limit: 20 });
  if (holdersResult.isError) {
    return holdersResult;
  }

  const holdersData = JSON.parse((holdersResult.content[0] as { text: string }).text);

  // Get current market price
  let currentPrice = 0.5;
  let noPrice = 0.5;
  try {
    const market = (await fetchClob(`/markets/${resolvedConditionId}`)) as ClobMarket;
    const tokens = market?.tokens;
    if (tokens && tokens.length >= 2) {
      const pricesResp = (await fetchClobPost("/prices", [
        { token_id: tokens[0].token_id, side: "BUY" },
        { token_id: tokens[1].token_id, side: "BUY" },
      ])) as Record<string, { BUY?: string } | string>;

      const yesData = pricesResp[tokens[0].token_id];
      const noData = pricesResp[tokens[1].token_id];
      if (yesData) currentPrice = typeof yesData === "object" && yesData.BUY ? Number(yesData.BUY) : Number(yesData);
      if (noData) noPrice = typeof noData === "object" && noData.BUY ? Number(noData.BUY) : Number(noData);
    }
  } catch {
    // Use defaults
  }

  // Analyze YES whales
  const yesWhales = (holdersData.topHolders?.yes || []).slice(0, 10).map((h: { rank: number; address: string; size: number; value: number; percentOfSupply: number }) => {
    // Estimate if they're in profit based on current price vs typical entry
    // If price is high, assume early holders are in profit
    const estimatedEntry = currentPrice * 0.7; // Rough estimate
    const currentValue = h.size * currentPrice;
    const estimatedInitial = h.size * estimatedEntry;
    const unrealizedPnL = currentValue - estimatedInitial;

    let convictionScore: "extreme" | "high" | "moderate" | "low";
    if (h.value > 10000) convictionScore = "extreme";
    else if (h.value > 5000) convictionScore = "high";
    else if (h.value > 1000) convictionScore = "moderate";
    else convictionScore = "low";

    return {
      rank: h.rank,
      address: h.address,
      shares: h.size,
      positionValue: h.value,
      estimatedEntry: Number(estimatedEntry.toFixed(4)),
      unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
      convictionScore,
    };
  });

  // Analyze NO whales
  const noWhales = (holdersData.topHolders?.no || []).slice(0, 10).map((h: { rank: number; address: string; size: number; value: number; percentOfSupply: number }) => {
    const estimatedEntry = noPrice * 0.7;
    const currentValue = h.size * noPrice;
    const estimatedInitial = h.size * estimatedEntry;
    const unrealizedPnL = currentValue - estimatedInitial;

    let convictionScore: "extreme" | "high" | "moderate" | "low";
    if (h.value > 10000) convictionScore = "extreme";
    else if (h.value > 5000) convictionScore = "high";
    else if (h.value > 1000) convictionScore = "moderate";
    else convictionScore = "low";

    return {
      rank: h.rank,
      address: h.address,
      shares: h.size,
      positionValue: h.value,
      estimatedEntry: Number(estimatedEntry.toFixed(4)),
      unrealizedPnL: Number(unrealizedPnL.toFixed(2)),
      convictionScore,
    };
  });

  // Calculate concentration metrics
  const top5YesPercent = holdersData.topHolders?.yes?.slice(0, 5).reduce((sum: number, h: { percentOfSupply: number }) => sum + h.percentOfSupply, 0) || 0;
  const top5NoPercent = holdersData.topHolders?.no?.slice(0, 5).reduce((sum: number, h: { percentOfSupply: number }) => sum + h.percentOfSupply, 0) || 0;
  
  let concentrationRisk: "high" | "moderate" | "low";
  if (top5YesPercent > 50 || top5NoPercent > 50) concentrationRisk = "high";
  else if (top5YesPercent > 30 || top5NoPercent > 30) concentrationRisk = "moderate";
  else concentrationRisk = "low";

  // Determine smart money signal
  const totalYesValue = yesWhales.reduce((sum: number, w: { positionValue: number }) => sum + w.positionValue, 0);
  const totalNoValue = noWhales.reduce((sum: number, w: { positionValue: number }) => sum + w.positionValue, 0);
  const yesExtreme = yesWhales.filter((w: { convictionScore: string }) => w.convictionScore === "extreme" || w.convictionScore === "high").length;
  const noExtreme = noWhales.filter((w: { convictionScore: string }) => w.convictionScore === "extreme" || w.convictionScore === "high").length;

  let direction: "YES" | "NO" | "NEUTRAL";
  let confidence: "high" | "medium" | "low";
  let reasoning: string;

  if (totalYesValue > totalNoValue * 1.5 && yesExtreme > noExtreme) {
    direction = "YES";
    confidence = yesExtreme >= 3 ? "high" : "medium";
    reasoning = `${yesWhales.length} whales with $${totalYesValue.toFixed(0)} in YES positions vs $${totalNoValue.toFixed(0)} in NO. ${yesExtreme} high-conviction YES holders.`;
  } else if (totalNoValue > totalYesValue * 1.5 && noExtreme > yesExtreme) {
    direction = "NO";
    confidence = noExtreme >= 3 ? "high" : "medium";
    reasoning = `${noWhales.length} whales with $${totalNoValue.toFixed(0)} in NO positions vs $${totalYesValue.toFixed(0)} in YES. ${noExtreme} high-conviction NO holders.`;
  } else {
    direction = "NEUTRAL";
    confidence = "low";
    reasoning = `Whale positions roughly balanced. YES: $${totalYesValue.toFixed(0)}, NO: $${totalNoValue.toFixed(0)}. No clear smart money consensus.`;
  }

  // Generate recommendation
  let recommendation: string;
  if (direction !== "NEUTRAL" && confidence !== "low") {
    recommendation = `Smart money appears to favor ${direction}. Consider aligning with whale positions, but verify with your own research.`;
  } else if (concentrationRisk === "high") {
    recommendation = `⚠️ High concentration risk - top 5 holders control ${Math.max(top5YesPercent, top5NoPercent).toFixed(0)}% of supply. Large exits could move price significantly.`;
  } else {
    recommendation = "No strong whale consensus. Market may be more efficient or whales may be waiting for more information.";
  }

  // Get market title if we don't have it
  if (!marketTitle) {
    marketTitle = holdersData.market || resolvedConditionId;
  }

  return successResult({
    market: marketTitle,
    conditionId: resolvedConditionId,
    currentPrice,
    whaleAnalysis: {
      yesWhales,
      noWhales,
    },
    marketConcentration: {
      top5YesPercent: Number(top5YesPercent.toFixed(2)),
      top5NoPercent: Number(top5NoPercent.toFixed(2)),
      whaleCount: holdersData.concentration?.whaleCount || 0,
      concentrationRisk,
    },
    smartMoneySignal: {
      direction,
      confidence,
      reasoning,
    },
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface DataApiTrade {
  id?: string;
  timestamp?: string;
  matchTime?: string;
  side?: string;
  outcome?: string;
  price?: string | number;
  size?: string | number;
  trader?: string;
  proxyWallet?: string;
}

interface DataApiPosition {
  conditionId?: string;
  market?: string;
  title?: string;
  question?: string;
  outcome?: string;
  outcomeIndex?: number;
  size?: string | number;
  avgPrice?: string | number;
  curPrice?: string | number;
  initialValue?: string | number;
  currentValue?: string | number;
  cashPnl?: string | number;
  percentPnl?: string | number;
  proxyWallet?: string;
  user?: string;
}

interface DataApiClosedPosition {
  conditionId?: string;
  title?: string;
  slug?: string;
  outcome?: string;
  outcomeIndex?: number;
  avgPrice?: string | number;
  totalBought?: string | number;
  realizedPnl?: string | number;
  curPrice?: string | number;
  timestamp?: string | number;
  proxyWallet?: string;
  eventSlug?: string;
  endDate?: string;
}

interface GammaComment {
  id?: string;
  userAddress?: string;
  author?: string;
  content?: string;
  text?: string;
  createdAt?: string;
  timestamp?: string;
  likes?: number;
  upvotes?: number;
}

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

// Store transports for Streamable HTTP
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Auth middleware using @ctxprotocol/sdk - 1 line!
const verifyContextAuth = createContextMiddleware();

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
// STREAMABLE HTTP TRANSPORT (/mcp)
// ============================================================================

app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize request first." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.get("/debug-tools", (_req: Request, res: Response) => {
  const analyzePos = TOOLS.find(t => t.name === "analyze_my_positions");
  res.json({
    name: analyzePos?.name,
    _meta: analyzePos?._meta,
    contextRequirements: analyzePos?._meta?.contextRequirements,
    inputSchemaKeys: Object.keys(analyzePos?.inputSchema || {}),
  });
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Debug: log what we're sending
  const analyzePos = TOOLS.find(t => t.name === "analyze_my_positions");
  console.log("[DEBUG] analyze_my_positions _meta:", analyzePos?._meta);
  console.log("[DEBUG] contextRequirements:", analyzePos?._meta?.contextRequirements);
  
  return { tools: TOOLS };
});

const port = Number(process.env.PORT || 4003);
app.listen(port, () => {
  console.log("\n🎯 Polymarket Intelligence MCP Server v1.0.0");
  console.log("   Whale cost analysis • Market efficiency • Smart money tracking\n");
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🛠️  Available tools (${TOOLS.length}):`);
  console.log("   INTELLIGENCE (12 tools):");
  for (const tool of TOOLS.slice(0, 12)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("   RAW DATA (10 tools):");
  for (const tool of TOOLS.slice(12)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("");
});

