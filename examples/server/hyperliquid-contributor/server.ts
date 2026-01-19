/**
 * Hyperliquid Ultimate MCP Server v2.3.1
 *
 * A standard MCP server built with @modelcontextprotocol/sdk.
 * The world's most comprehensive Hyperliquid MCP server.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 *
 * ============================================================================
 * TOOL ARCHITECTURE
 * ============================================================================
 *
 * TIER 1: INTELLIGENCE LAYER (High-Value Composite Tools)
 * --------------------------------------------------------
 * These tools synthesize multiple data sources into actionable insights.
 * They encode domain expertise and answer complex questions.
 *
 *   • analyze_large_order        - Comprehensive large order impact analysis
 *   • calculate_price_impact     - Orderbook absorption simulation
 *   • get_funding_analysis       - Cross-venue funding arbitrage detection
 *   • get_open_interest_analysis - OI concentration and liquidation risk
 *   • analyze_my_positions       - DIRECT position risk assessment (main account only)
 *   • analyze_vault_exposure     - Vault position analysis & shadow positions (NEW v2.3)
 *   • analyze_full_portfolio     - COMPLETE exposure: main + vaults + sub-accounts (NEW v2.3)
 *   • analyze_trader_performance - P&L analysis, win rate, fee optimization
 *   • analyze_spot_markets       - Spot market depth and opportunity detection
 *   • analyze_whale_wallet       - Comprehensive whale position analysis
 *
 * TIER 2: RAW DATA LAYER (Building Blocks)
 * ----------------------------------------
 * Direct API access for custom analysis. Use when Tier 1 tools
 * don't cover your specific use case.
 *
 *   • get_orderbook           - L2 orderbook depth
 *   • get_market_info         - Price, volume, funding, OI for a coin
 *   • list_markets            - All available perpetual markets
 *   • get_candles             - OHLCV historical data
 *   • get_recent_trades       - Trade tape with whale detection
 *   • get_staking_summary     - HYPE staking mechanics
 *   • get_user_delegations    - Wallet staking positions
 *   • get_markets_at_oi_cap   - Markets at open interest limits
 *   • get_hlp_vault_stats     - HLP vault APR and TVL
 *   • get_funding_history     - Historical funding rates
 *   • get_exchange_stats      - Exchange-wide volume and OI
 *   • get_volume_history      - Historical volume trends
 *   • get_spot_meta           - Spot market metadata (NEW)
 *   • get_user_fills          - User trade history (NEW)
 *   • get_user_fees           - Fee schedule and VIP tiers (NEW)
 *   • get_user_state          - User perp positions for any address (NEW)
 *   • get_spot_balances       - User spot token balances (NEW)
 *   • get_open_orders         - User's active orders (NEW)
 *   • get_order_status        - Single order status (NEW)
 *   • get_user_portfolio      - Historical P&L data (NEW)
 *   • get_user_vault_equities - User's vault positions (NEW)
 *   • get_referral_state      - Referral stats and rewards (NEW)
 *   • get_sub_accounts        - Sub-account details (NEW)
 *
 * ============================================================================
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createL1ActionHash,
  type Signature as HyperliquidSignature,
} from "@nktkas/hyperliquid/signing";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response, type NextFunction } from "express";
import { createContextMiddleware, type HyperliquidContext } from "@ctxprotocol/sdk";

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (standard MCP feature, required by Context)
// - _meta.contextRequirements: Context types needed for portfolio tools (MCP spec)
//
// NOTE: _meta is part of the MCP spec for arbitrary tool metadata.
// The Context platform reads _meta.contextRequirements to inject user portfolio data.
//
// All tools include:
// - confidence: 0-1 score for analysis reliability (on Tier 1 tools)
// - dataSources: Array of API endpoints used (transparency)
// - dataFreshness: "real-time" | "near-real-time" | "cached" | "historical"
//
// See: https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema
// ============================================================================

const TOOLS = [
  // ============================================================================
  // TIER 2: RAW DATA LAYER - Orderbook & Liquidity
  // ============================================================================
  {
    name: "get_orderbook",
    description:
      "Get the Level 2 orderbook for a Hyperliquid perpetual market. Returns bids/asks with cumulative depth, liquidity metrics, and volume context for understanding market absorption capacity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: {
          type: "string",
          description: 'The coin symbol (e.g., "HYPE", "BTC", "ETH")',
        },
        nSigFigs: {
          type: "number",
          description:
            "Aggregate price levels to N significant figures (2-5). Lower = wider view.",
          minimum: 2,
          maximum: 5,
        },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        midPrice: { type: "number" },
        spread: { type: "number", description: "Spread in basis points" },
        bids: { type: "array", description: "Bid levels with cumulative depth" },
        asks: { type: "array", description: "Ask levels with cumulative depth" },
        totalBidLiquidity: { type: "number", description: "Total bid liquidity in USD" },
        totalAskLiquidity: { type: "number", description: "Total ask liquidity in USD" },
        liquidityContext: {
          type: "object",
          description: "Context comparing orderbook to daily volume",
        },
        note: { type: "string" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "midPrice", "bids", "asks", "totalBidLiquidity", "totalAskLiquidity", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Price Impact Analysis
  // ============================================================================

  {
    name: "calculate_price_impact",
    description:
      "🧠 INTELLIGENCE: Calculate the price impact of selling or buying a specific amount. Simulates execution through the orderbook, estimates TWAP duration for minimal impact, and provides absorption analysis. CRITICAL for analyzing large order flows.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        side: { type: "string", enum: ["sell", "buy"], description: "sell hits bids, buy lifts asks" },
        size: { type: "number", description: "Size in base asset units" },
        sizeInUsd: { type: "number", description: "Alternative: size in USD (overrides size)" },
      },
      required: ["coin", "side"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        side: { type: "string" },
        orderSize: { type: "number" },
        orderNotional: { type: "number" },
        midPrice: { type: "number" },
        averageFillPrice: { type: "number" },
        worstFillPrice: { type: "number" },
        priceImpactPercent: { type: "number" },
        slippageBps: { type: "number" },
        filledSize: { type: "number" },
        filledPercent: { type: "number" },
        remainingSize: { type: "number" },
        levelsConsumed: { type: "number" },
        canAbsorb: { type: "boolean" },
        absorption: { type: "string" },
        volumeContext: { type: "object" },
        hiddenLiquidityNote: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence in estimate (limited by visible book depth)" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "side", "orderSize", "canAbsorb", "absorption", "volumeContext", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Market Data
  // ============================================================================

  // ==================== MARKET DATA ====================
  {
    name: "get_market_info",
    description:
      "Get comprehensive market information: price, volume, open interest, funding rate, max leverage, and market health metrics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE", "BTC")' },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        markPrice: { type: "number" },
        indexPrice: { type: "number" },
        midPrice: { type: "number" },
        premium: { type: "number", description: "Premium/discount vs index (%)" },
        spread: { type: "number", description: "Spread in bps" },
        openInterest: { type: "number", description: "OI in base units" },
        openInterestUsd: { type: "number" },
        fundingRate: { type: "number", description: "Hourly funding rate" },
        fundingRateAnnualized: { type: "number" },
        volume24h: { type: "number" },
        priceChange24h: { type: "number" },
        maxLeverage: { type: "number" },
        impactPrices: { type: "object" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "markPrice", "fundingRate", "openInterest", "volume24h", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "list_markets",
    description: "List all available perpetual markets on Hyperliquid with prices and basic info.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        markets: { type: "array" },
        count: { type: "number" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["markets", "count", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Funding Analysis
  // ============================================================================

  {
    name: "get_funding_analysis",
    description:
      "🧠 INTELLIGENCE: Get comprehensive funding rate analysis including current rates, predicted rates across venues (Binance, Bybit, Hyperliquid), and arbitrage opportunities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE", "BTC")' },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        currentFunding: { type: "object" },
        predictedFundings: { type: "array" },
        fundingArbitrage: { type: "object" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence in arbitrage opportunity" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "currentFunding", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Staking & Delegation
  // ============================================================================
  {
    name: "get_staking_summary",
    description:
      "Get Hyperliquid staking statistics and mechanics. Essential for understanding HYPE token dynamics.",
    inputSchema: {
      type: "object" as const,
      properties: {
        includeValidators: { type: "boolean", description: "Include validator info (default: false)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        stakingMechanics: { type: "object" },
        currentHypePrice: { type: "number" },
        note: { type: "string" },
        validators: { type: "string" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["stakingMechanics", "note", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_user_delegations",
    description: "Get staking delegations for a specific wallet address.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        delegations: { type: "array" },
        totalDelegated: { type: "number" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "delegations", "totalDelegated", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Open Interest Analysis
  // ============================================================================

  {
    name: "get_open_interest_analysis",
    description:
      "🧠 INTELLIGENCE: Analyze open interest for a coin: current OI, OI changes, long/short ratio estimation, and OI caps. Identifies liquidation cascade risk.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        openInterest: { type: "number" },
        openInterestUsd: { type: "number" },
        oiToVolumeRatio: { type: "number" },
        fundingImpliedBias: { type: "string" },
        atOpenInterestCap: { type: "boolean" },
        liquidationRisk: { type: "string", enum: ["low", "moderate", "high"] },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence in risk assessment" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "openInterest", "openInterestUsd", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Historical Data
  // ============================================================================
  {
    name: "get_candles",
    description: "Get historical OHLCV candle data for technical analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        interval: { type: "string", enum: ["1m", "5m", "15m", "1h", "4h", "1d", "1w"] },
        limit: { type: "number", description: "Number of candles (default 100, max 500)" },
      },
      required: ["coin", "interval"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        interval: { type: "string" },
        candles: { type: "array" },
        summary: { type: "object" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "interval", "candles", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Recent Trades
  // ============================================================================
  {
    name: "get_recent_trades",
    description: "Get recent trades with whale detection. Returns the last ~100 trades chronologically and flags any exceeding the whale threshold. NOTE: True whale trades ($100k+) are rare events and may not appear in this snapshot. Use analyze_whale_wallet with known addresses for reliable whale tracking.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        whaleThresholdUsd: { type: "number", description: "USD threshold for whale trades (default: $100,000). Lower for altcoins, higher for BTC." },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        trades: { type: "array" },
        whaleTrades: { type: "array", description: "Trades exceeding whale threshold (may be empty)" },
        whaleStatus: { type: "string", description: "Human-readable status of whale detection" },
        summary: { type: "object" },
        limitations: { type: "string", description: "Data source limitations to consider" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "trades", "summary", "whaleStatus", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Comprehensive Analysis
  // ============================================================================

  {
    name: "analyze_large_order",
    description:
      "🧠 INTELLIGENCE: COMPREHENSIVE analysis for large order scenarios (like team unlocks, whale sells). Combines orderbook depth, volume context, funding sentiment, and OI analysis. Provides execution recommendations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        side: { type: "string", enum: ["sell", "buy"] },
        size: { type: "number", description: "Order size in base units" },
        sizeInUsd: { type: "number", description: "Alternative: size in USD" },
        executionStrategy: { type: "string", enum: ["market", "twap", "otc"] },
      },
      required: ["coin", "side"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        orderSummary: { type: "object" },
        marketImpact: { type: "object" },
        executionRecommendation: { type: "object" },
        marketContext: { type: "object" },
        reflexivityRisk: { type: "object" },
        conclusion: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence in analysis (based on data quality)" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "orderSummary", "marketImpact", "executionRecommendation", "conclusion", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Additional Tools
  // ============================================================================
  {
    name: "get_markets_at_oi_cap",
    description: "Get list of perpetual markets currently at their open interest caps.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        marketsAtCap: { type: "array", items: { type: "string" } },
        count: { type: "number" },
        note: { type: "string" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["marketsAtCap", "count", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_hlp_vault_stats",
    description: "Get HLP (Hyperliquidity Provider) vault statistics including APR, TVL, and performance.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        vaultAddress: { type: "string" },
        apr: { type: "number" },
        tvl: { type: "number" },
        followerCount: { type: "number" },
        performance: { type: "object" },
        lockupPeriod: { type: "string" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["apr", "tvl", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_funding_history",
    description: "Get historical funding rates for a coin over a time period.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        days: { type: "number", description: "Number of days of history (default: 30, max: 90)" },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        fundingHistory: { type: "array" },
        summary: { type: "object" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "fundingHistory", "summary", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_exchange_stats",
    description: "Get aggregated exchange-wide statistics: total 24h volume, total OI, and market counts.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        totalVolume24h: { type: "number" },
        totalOpenInterest: { type: "number" },
        marketCount: { type: "number" },
        topMarketsByVolume: { type: "array" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["totalVolume24h", "totalOpenInterest", "marketCount", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_volume_history",
    description: "Analyze historical volume trends for a coin. Critical for understanding liquidity trends.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE"). If omitted, analyzes major markets.' },
        days: { type: "number", description: "Number of days of history (default: 30, max: 90)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        dailyVolumes: { type: "array" },
        summary: { type: "object" },
        dataSources: { type: "array", items: { type: "string" }, description: "API endpoints used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["dailyVolumes", "summary", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Spot Markets
  // ============================================================================

  {
    name: "get_spot_meta",
    description: "Get spot market metadata including all tokens and trading pairs available on Hyperliquid spot.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        tokens: { type: "array", description: "List of all spot tokens with decimals and metadata" },
        universe: { type: "array", description: "List of all spot trading pairs" },
        assetContexts: { type: "array", description: "Current prices and volumes for spot pairs" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["tokens", "universe", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_spot_balances",
    description: "Get spot token balances for any wallet address with CURRENT market values and unrealized P&L. Unlike perps, spot holdings are simply owned tokens (no margin/leverage).",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        balances: {
          type: "array",
          description: "Token balances with current prices and P&L",
          items: {
            type: "object",
            properties: {
              coin: { type: "string" },
              total: { type: "number" },
              hold: { type: "number", description: "Locked in open orders" },
              available: { type: "number" },
              entryNtl: { type: "number", description: "Cost basis (what you paid)" },
              currentPrice: { type: "number" },
              currentValue: { type: "number", description: "Current market value" },
              unrealizedPnl: { type: "number" },
              unrealizedPnlPercent: { type: "number" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            totalEntryValue: { type: "number", description: "Total cost basis" },
            totalCurrentValue: { type: "number", description: "Total current market value" },
            totalUnrealizedPnl: { type: "number" },
            totalUnrealizedPnlPercent: { type: "number" },
          },
        },
        totalValue: { type: "number", description: "Total current value (for backwards compatibility)" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "balances", "summary", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - User State & Positions
  // ============================================================================

  {
    name: "get_user_state",
    description: "Get perpetual positions and margin state for any wallet address. Includes positions, margin usage, and withdrawable balance.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        assetPositions: { type: "array", description: "All open perp positions with P&L" },
        marginSummary: { type: "object", description: "Account value and margin usage" },
        crossMarginSummary: { type: "object" },
        withdrawable: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "assetPositions", "marginSummary", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_open_orders",
    description: "Get all open orders for a wallet address. Includes limit orders, trigger orders, and TP/SL orders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        orders: { type: "array", description: "All open orders with prices, sizes, and types" },
        orderCount: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "orders", "orderCount", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_order_status",
    description: "Get the status of a specific order by order ID. Shows if filled, canceled, or open.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
        oid: { type: "string", description: "Order ID (number or hex string)" },
      },
      required: ["address", "oid"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", description: "Order status (open, filled, canceled, etc.)" },
        order: { type: "object", description: "Full order details if available" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["status", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Trade History & Fills
  // ============================================================================

  {
    name: "get_user_fills",
    description: "Get trade fill history for a wallet. Returns up to 2000 most recent fills with P&L and fees.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
        startTime: { type: "number", description: "Start time in ms (optional)" },
        endTime: { type: "number", description: "End time in ms (optional)" },
        aggregateByTime: { type: "boolean", description: "Aggregate partial fills (default: false)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        fills: { type: "array", description: "Trade fills with price, size, P&L, and fees" },
        fillCount: { type: "number" },
        summary: { type: "object", description: "Volume and P&L summary" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "fills", "fillCount", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Fees & Referrals
  // ============================================================================

  {
    name: "get_user_fees",
    description: "Get fee schedule and VIP tier info for a wallet. Includes maker/taker rates, discounts, and staking benefits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        feeSchedule: { type: "object", description: "Full fee schedule with tiers" },
        userRates: { type: "object", description: "User's current maker/taker rates" },
        dailyVolume: { type: "array", description: "Recent daily trading volume" },
        activeDiscounts: { type: "object", description: "Referral and staking discounts" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "feeSchedule", "userRates", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_referral_state",
    description: "Get referral program state for a wallet including referred volume, rewards, and builder fees.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        referralState: { type: "object", description: "Referral stats and earnings" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "referralState", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Portfolio & Vaults
  // ============================================================================

  {
    name: "get_user_portfolio",
    description: "Get historical portfolio data including account value and P&L history over different timeframes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        portfolio: { type: "object", description: "Portfolio data by timeframe (day, week, month, allTime)" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "portfolio", "dataSources", "dataFreshness"],
    },
  },

  {
    name: "get_user_vault_equities",
    description: "Get all vault positions for a wallet including equity in each vault.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        vaultEquities: { type: "array", description: "List of vault positions with equity" },
        totalEquity: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "vaultEquities", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Sub-Accounts
  // ============================================================================

  {
    name: "get_sub_accounts",
    description: "Get all sub-accounts for a master wallet including their positions and balances.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Master wallet address (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        subAccounts: { type: "array", description: "Sub-account details with positions" },
        subAccountCount: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "subAccounts", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Trader Performance Analysis
  // ============================================================================

  {
    name: "analyze_trader_performance",
    description:
      "🧠 INTELLIGENCE: Comprehensive trading performance analysis for any wallet. Combines fills, fees, and portfolio data to calculate win rate, P&L, fee efficiency, and trading patterns. Identifies optimization opportunities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address to analyze (0x...)" },
        days: { type: "number", description: "Days of history to analyze (default: 30, max: 90)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        tradingStats: {
          type: "object",
          properties: {
            totalTrades: { type: "number" },
            winRate: { type: "number" },
            profitFactor: { type: "number" },
            totalPnL: { type: "number" },
            totalVolume: { type: "number" },
            averageTradeSize: { type: "number" },
          },
        },
        feeAnalysis: {
          type: "object",
          properties: {
            totalFeesPaid: { type: "number" },
            effectiveFeeRate: { type: "number" },
            currentTier: { type: "string" },
            potentialSavings: { type: "number" },
            nextTierVolume: { type: "number" },
          },
        },
        tradingPatterns: {
          type: "object",
          properties: {
            mostTradedCoins: { type: "array" },
            preferredSide: { type: "string" },
            averageHoldTime: { type: "string" },
          },
        },
        recommendations: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "tradingStats", "feeAnalysis", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Spot Market Analysis
  // ============================================================================

  {
    name: "analyze_spot_markets",
    description:
      "🧠 INTELLIGENCE: Comprehensive spot market analysis. Identifies high-volume pairs, liquidity depth, price divergences between spot and perp, and arbitrage opportunities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minVolume: { type: "number", description: "Minimum 24h volume filter in USD (default: 10000)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        marketOverview: {
          type: "object",
          properties: {
            totalSpotPairs: { type: "number" },
            totalVolume24h: { type: "number" },
            activeTokens: { type: "number" },
          },
        },
        topMarketsByVolume: { type: "array" },
        spotPerpDivergences: {
          type: "array",
          description: "Pairs with significant spot-perp price differences",
        },
        liquidityAnalysis: { type: "array" },
        opportunities: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["marketOverview", "topMarketsByVolume", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Whale Wallet Analysis
  // ============================================================================

  {
    name: "analyze_whale_wallet",
    description:
      "🧠 INTELLIGENCE: Deep analysis of any wallet's positions, orders, and trading activity. Identifies position sizing, leverage usage, directional bias, and recent activity patterns. Essential for tracking notable traders.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string", description: "Wallet address to analyze (0x...)" },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        accountSummary: {
          type: "object",
          properties: {
            totalAccountValue: { type: "number" },
            totalPositionValue: { type: "number" },
            marginUtilization: { type: "number" },
            unrealizedPnL: { type: "number" },
          },
        },
        positions: {
          type: "array",
          description: "All positions with size, leverage, and P&L",
        },
        directionalBias: {
          type: "object",
          properties: {
            netLongExposure: { type: "number" },
            netShortExposure: { type: "number" },
            bias: { type: "string", enum: ["strongly_long", "long", "neutral", "short", "strongly_short"] },
          },
        },
        openOrders: {
          type: "object",
          properties: {
            orderCount: { type: "number" },
            pendingBuyNotional: { type: "number" },
            pendingSellNotional: { type: "number" },
          },
        },
        riskAssessment: {
          type: "object",
          properties: {
            leverageRisk: { type: "string", enum: ["low", "medium", "high", "extreme"] },
            concentrationRisk: { type: "string" },
            liquidationRisk: { type: "string" },
          },
        },
        insights: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["address", "accountSummary", "positions", "directionalBias", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Portfolio Analysis
  // ============================================================================

  {
    name: "analyze_my_positions",
    description:
      "🧠 INTELLIGENCE: Analyze your DIRECT Hyperliquid perpetual positions (main trading account) with risk assessment, P&L breakdown, " +
      "liquidation warnings, and personalized recommendations. Does NOT include vault positions - use analyze_vault_exposure for that. Requires portfolio context.",

    // ✅ Context requirements in _meta (preserved by MCP SDK)
    // The Context platform reads this to inject user's Hyperliquid portfolio data.
    _meta: {
      contextRequirements: ["hyperliquid"],
    },

    inputSchema: {
      type: "object" as const,
      properties: {
        portfolio: {
          type: "object",
          description: "Your Hyperliquid portfolio context (injected by the Context app)",
          properties: {
            walletAddress: { type: "string" },
            perpPositions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  coin: { type: "string" },
                  size: { type: "number" },
                  entryPrice: { type: "number" },
                  unrealizedPnl: { type: "number" },
                  liquidationPrice: { type: "number" },
                  positionValue: { type: "number" },
                  leverage: { type: "object" },
                  marginUsed: { type: "number" },
                },
              },
            },
            openOrders: { type: "array" },
            spotBalances: { type: "array" },
            accountSummary: { type: "object" },
            fetchedAt: { type: "string" },
          },
          required: ["walletAddress", "perpPositions", "accountSummary"],
        },
        focus_coin: {
          type: "string",
          description: "Optional: specific coin to focus analysis on (e.g., 'ETH')",
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
            accountValue: { type: "number" },
            totalUnrealizedPnL: { type: "number" },
            totalMarginUsed: { type: "number" },
            marginUtilization: { type: "number", description: "Percentage of margin used" },
            atRiskPositions: { type: "number", description: "Positions near liquidation" },
          },
        },
        positionAnalyses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              coin: { type: "string" },
              direction: { type: "string", enum: ["LONG", "SHORT"] },
              size: { type: "number" },
              entryPrice: { type: "number" },
              currentPrice: { type: "number" },
              unrealizedPnL: { type: "number" },
              unrealizedPnLPercent: { type: "number" },
              leverage: { type: "number" },
              liquidationPrice: { type: "number" },
              distanceToLiquidation: { type: "number", description: "Percentage distance to liquidation" },
              riskLevel: { type: "string", enum: ["low", "medium", "high", "critical"] },
              recommendation: { type: "string" },
            },
          },
        },
        vaultExposureNote: { type: "string", description: "Note if user has vault equity that should be analyzed separately" },
        overallRecommendation: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "Confidence in risk assessment" },
        dataSources: { type: "array", items: { type: "string" }, description: "Data sources used" },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "totalPositions", "portfolioSummary", "positionAnalyses", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Vault Exposure Analysis (NEW)
  // ============================================================================

  {
    name: "analyze_vault_exposure",
    description:
      "🧠 INTELLIGENCE: Analyze your exposure through Hyperliquid vaults (like HLP). Shows your equity in each vault, " +
      "the vault's positions, and calculates your 'shadow positions' (proportional share of vault positions). " +
      "Essential for understanding true market exposure when you're invested in vaults.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: "Wallet address (0x...). If not provided, requires portfolio context.",
        },
        portfolio: {
          type: "object",
          description: "Optional: Your Hyperliquid portfolio context (injected by the Context app) - only walletAddress is used",
        },
      },
      required: [],
    },
    _meta: {
      contextRequirements: ["hyperliquid"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string" },
        vaultSummary: {
          type: "object",
          properties: {
            totalVaultEquity: { type: "number", description: "Total USD value across all vaults" },
            vaultCount: { type: "number" },
          },
        },
        vaults: {
          type: "array",
          items: {
            type: "object",
            properties: {
              vaultAddress: { type: "string" },
              vaultName: { type: "string" },
              userEquity: { type: "number" },
              ownershipPercent: { type: "number" },
              vaultTotalEquity: { type: "number" },
              apr: { type: "number" },
              lockupUntil: { type: "string" },
              shadowPositions: {
                type: "array",
                description: "User's proportional share of vault positions",
                items: {
                  type: "object",
                  properties: {
                    coin: { type: "string" },
                    direction: { type: "string", enum: ["LONG", "SHORT"] },
                    effectiveSize: { type: "number", description: "Your share of this position" },
                    effectiveNotional: { type: "number" },
                    vaultFullSize: { type: "number" },
                  },
                },
              },
            },
          },
        },
        aggregatedExposure: {
          type: "object",
          description: "Combined exposure across all vaults by coin",
          properties: {
            byCoins: { type: "array" },
            netLongExposure: { type: "number" },
            netShortExposure: { type: "number" },
            bias: { type: "string" },
          },
        },
        insights: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "vaultSummary", "vaults", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER - Full Portfolio Analysis (NEW)
  // ============================================================================

  {
    name: "analyze_full_portfolio",
    description:
      "🧠 INTELLIGENCE: COMPREHENSIVE portfolio analysis combining ALL exposure sources: " +
      "(1) Direct trading positions (main account), (2) Vault exposure (HLP, user vaults), (3) Sub-accounts. " +
      "Provides true total market exposure with clear source labeling. Use this to answer 'What is my REAL exposure?'",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: "Wallet address (0x...). If not provided, requires portfolio context.",
        },
        portfolio: {
          type: "object",
          description: "Optional: Your Hyperliquid portfolio context (injected by the Context app)",
        },
      },
      required: [],
    },
    _meta: {
      contextRequirements: ["hyperliquid"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        walletAddress: { type: "string" },
        portfolioOverview: {
          type: "object",
          properties: {
            totalAccountValue: { type: "number", description: "Main account + vault equity + sub-accounts" },
            mainAccountValue: { type: "number" },
            vaultEquity: { type: "number" },
            subAccountsValue: { type: "number" },
          },
        },
        directPositions: {
          type: "object",
          description: "Positions in main trading account",
          properties: {
            source: { type: "string", enum: ["main_account"] },
            positions: { type: "array" },
            totalValue: { type: "number" },
            unrealizedPnL: { type: "number" },
          },
        },
        vaultExposure: {
          type: "object",
          description: "Exposure through vault positions",
          properties: {
            source: { type: "string", enum: ["vaults"] },
            vaults: { type: "array" },
            totalEquity: { type: "number" },
            shadowPositions: { type: "array", description: "Aggregated proportional positions across vaults" },
          },
        },
        subAccountPositions: {
          type: "object",
          description: "Positions in sub-accounts",
          properties: {
            source: { type: "string", enum: ["sub_accounts"] },
            accounts: { type: "array" },
            totalValue: { type: "number" },
          },
        },
        aggregatedExposure: {
          type: "object",
          description: "Total exposure by coin across ALL sources",
          properties: {
            byCoin: { type: "array" },
            netLongExposure: { type: "number" },
            netShortExposure: { type: "number" },
            directionalBias: { type: "string" },
          },
        },
        riskSummary: {
          type: "object",
          properties: {
            positionsAtRisk: { type: "number" },
            highLeveragePositions: { type: "number" },
            concentrationRisk: { type: "string" },
          },
        },
        insights: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time", "near-real-time", "cached", "historical"] },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "portfolioOverview", "directPositions", "vaultExposure", "aggregatedExposure", "confidence", "dataSources", "dataFreshness"],
    },
  },

  // ============================================================================
  // TIER 3: WRITE ACTIONS (Handshake Required)
  // ============================================================================
  // These tools return signature requests that require user approval.
  // The Context platform intercepts these and shows an approval UI.
  // ============================================================================

  {
    name: "place_order",
    description:
      "🔐 WRITE ACTION: Place a perpetual order on Hyperliquid. " +
      "Returns a signature request that must be approved by the user. " +
      "Supports limit, market, stop-loss, and take-profit orders. " +
      "The signature is used to authorize the order without exposing the user's private key. " +
      "To CLOSE a position: set closeEntirePosition=true and the size will be auto-calculated from the user's current position.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: {
          type: "string",
          description: 'The coin symbol (e.g., "ETH", "BTC", "HYPE")',
        },
        isBuy: {
          type: "boolean",
          description: "true for long/buy, false for short/sell",
        },
        size: {
          type: "number",
          description: "Order size in base units (e.g., 0.1 ETH). NOT required if closeEntirePosition=true.",
        },
        price: {
          type: "number",
          description: "Limit price. For market orders, this is auto-calculated with slippage.",
        },
        orderType: {
          type: "string",
          description: 'Order type: "limit" (default), "market" (IOC with slippage), "stop_loss", or "take_profit"',
        },
        triggerPrice: {
          type: "number",
          description: "Trigger price for stop-loss or take-profit orders (required for those types)",
        },
        reduceOnly: {
          type: "boolean",
          description: "If true, order can only reduce position size (default: false, auto-set true for SL/TP)",
        },
        postOnly: {
          type: "boolean",
          description: "If true, order will only be placed if it would be a maker order (default: false)",
        },
        closeEntirePosition: {
          type: "boolean",
          description: "If true, automatically use the FULL position size from portfolio context. Sets reduceOnly=true. Use this for closing positions instead of guessing the size.",
        },
        portfolio: {
          type: "object",
          description: "Optional: Your Hyperliquid portfolio context (injected by the Context app)",
        },
      },
      required: ["coin", "isBuy"],
    },
    _meta: {
      contextRequirements: ["hyperliquid"],
      handshakeAction: true, // Marks this tool as requiring user signature
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["handshake_required", "success", "error"] },
        message: { type: "string" },
        orderDetails: {
          type: "object",
          properties: {
            coin: { type: "string" },
            side: { type: "string", enum: ["buy", "sell"] },
            size: { type: "number" },
            price: { type: "number" },
            notionalValue: { type: "number" },
            reduceOnly: { type: "boolean" },
            postOnly: { type: "boolean" },
          },
        },
        _meta: {
          type: "object",
          description: "Contains handshakeAction for signature request",
        },
      },
      required: ["status", "message"],
    },
  },

  // ============================================================================
  // SECURITY VERIFICATION TOOL (Development/Testing Only)
  // Tests client-side signature detection by returning various EIP-712 patterns.
  // ============================================================================
  {
    name: "verify_signature_security",
    description:
      "🔒 Security verification tool for testing signature request handling. " +
      "Returns different EIP-712 signature patterns to verify client detection works. " +
      "Use with scenario: 'standard_order', 'withdrawal_request', or 'transfer_request'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scenario: {
          type: "string",
          description: 'Scenario to test: "standard_order" (safe), "withdrawal_request" (should warn), "transfer_request" (should warn), "unknown_action" (caution)',
        },
      },
      required: ["scenario"],
    },
    _meta: {
      handshakeAction: true, // Marks this tool as requiring user signature
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string" },
        message: { type: "string" },
        _meta: { type: "object" },
      },
    },
  },

  {
    name: "submit_signed_action",
    description:
      "🔐 INTERNAL: Submit a signed action to Hyperliquid. " +
      "This tool is called automatically after the user signs an order request. " +
      "It takes the signature and order details from the handshake flow and submits to Hyperliquid.",
    inputSchema: {
      type: "object" as const,
      properties: {
        signature: {
          type: "string",
          description: "The EIP-712 signature from the user's wallet",
        },
        action: {
          type: "object",
          description: "The action to submit (order details from place_order)",
          properties: {
            asset: { type: "number", description: "Asset index" },
            isBuy: { type: "boolean" },
            limitPx: { type: "number", description: "Limit price in fixed-point" },
            sz: { type: "number", description: "Size in fixed-point" },
            reduceOnly: { type: "boolean" },
            cloid: { type: "string", description: "Client order ID" },
          },
        },
        vaultAddress: {
          type: "string",
          description: "Optional vault address if trading for a vault",
        },
      },
      required: ["signature", "action"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["success", "error"] },
        message: { type: "string" },
        response: {
          type: "object",
          description: "Response from Hyperliquid exchange API",
        },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string", enum: ["real-time"] },
        fetchedAt: { type: "string" },
      },
      required: ["status", "message"],
    },
  },
];

// ============================================================================
// MCP SERVER SETUP (Standard @modelcontextprotocol/sdk pattern)
// ============================================================================

const server = new Server(
  { name: "hyperliquid-ultimate", version: "2.3.1" },
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
        case "get_orderbook":
          return await handleGetOrderbook(args);
        case "calculate_price_impact":
          return await handleCalculatePriceImpact(args);
        case "get_market_info":
          return await handleGetMarketInfo(args);
        case "list_markets":
          return await handleListMarkets();
        case "get_funding_analysis":
          return await handleGetFundingAnalysis(args);
        case "get_staking_summary":
          return await handleGetStakingSummary(args);
        case "get_user_delegations":
          return await handleGetUserDelegations(args);
        case "get_open_interest_analysis":
          return await handleGetOpenInterestAnalysis(args);
        case "get_candles":
          return await handleGetCandles(args);
        case "get_recent_trades":
          return await handleGetRecentTrades(args);
        case "analyze_large_order":
          return await handleAnalyzeLargeOrder(args);
        case "get_markets_at_oi_cap":
          return await handleGetMarketsAtOiCap();
        case "get_hlp_vault_stats":
          return await handleGetHlpVaultStats();
        case "get_funding_history":
          return await handleGetFundingHistory(args);
        case "get_exchange_stats":
          return await handleGetExchangeStats();
        case "get_volume_history":
          return await handleGetVolumeHistory(args);
        case "get_spot_meta":
          return await handleGetSpotMeta();
        case "get_spot_balances":
          return await handleGetSpotBalances(args);
        case "get_user_state":
          return await handleGetUserState(args);
        case "get_open_orders":
          return await handleGetOpenOrders(args);
        case "get_order_status":
          return await handleGetOrderStatus(args);
        case "get_user_fills":
          return await handleGetUserFills(args);
        case "get_user_fees":
          return await handleGetUserFees(args);
        case "get_referral_state":
          return await handleGetReferralState(args);
        case "get_user_portfolio":
          return await handleGetUserPortfolio(args);
        case "get_user_vault_equities":
          return await handleGetUserVaultEquities(args);
        case "get_sub_accounts":
          return await handleGetSubAccounts(args);
        case "analyze_trader_performance":
          return await handleAnalyzeTraderPerformance(args);
        case "analyze_spot_markets":
          return await handleAnalyzeSpotMarkets(args);
        case "analyze_whale_wallet":
          return await handleAnalyzeWhaleWallet(args);
        case "analyze_my_positions":
          return await handleAnalyzeMyPositions(args);
        case "analyze_vault_exposure":
          return await handleAnalyzeVaultExposure(args);
        case "analyze_full_portfolio":
          return await handleAnalyzeFullPortfolio(args);
        case "place_order":
          return await handlePlaceOrder(args);
        case "verify_signature_security":
          return handleVerifySignatureSecurity(args);
        case "submit_signed_action":
          return await handleSubmitSignedAction(args ?? {});
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
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],  // Backward compat
    // Standard MCP feature (required by Context for payment verification)
    structuredContent: data,
  };
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function handleGetOrderbook(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  if (!coin) return errorResult("coin parameter is required");

  const nSigFigs = args?.nSigFigs as number | undefined;
  const [bookData, metaAndCtx] = await Promise.all([
    fetchL2Book(coin, nSigFigs),
    fetchMetaAndAssetCtxs(),
  ]);

  const parsed = parseOrderbook(bookData, coin);
  const volume24h = getVolume24h(metaAndCtx, coin);

  const bidLiquidityPercent = volume24h > 0 ? (parsed.totalBidLiquidity / volume24h) * 100 : 0;
  const askLiquidityPercent = volume24h > 0 ? (parsed.totalAskLiquidity / volume24h) * 100 : 0;

  let liquidityScore: string;
  if (bidLiquidityPercent > 5) liquidityScore = "deep";
  else if (bidLiquidityPercent > 1) liquidityScore = "moderate";
  else if (bidLiquidityPercent > 0.1) liquidityScore = "thin";
  else liquidityScore = "very thin";

  return successResult({
    ...parsed,
    liquidityContext: {
      bidLiquidityAsPercentOfDailyVolume: Number(bidLiquidityPercent.toFixed(4)),
      askLiquidityAsPercentOfDailyVolume: Number(askLiquidityPercent.toFixed(4)),
      volume24h,
      liquidityScore,
    },
    note: "Visible orderbook only shows ~20 levels. Hidden liquidity, market makers, and OTC desks provide additional absorption capacity not reflected here.",
    dataSources: ["l2Book", "metaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
  });
}

async function handleCalculatePriceImpact(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  const side = args?.side as "sell" | "buy";
  let size = args?.size as number | undefined;
  const sizeInUsd = args?.sizeInUsd as number | undefined;

  if (!coin) return errorResult("coin parameter is required");
  if (!side || !["sell", "buy"].includes(side)) return errorResult("side must be 'sell' or 'buy'");

  const [bookData, metaAndCtx] = await Promise.all([fetchL2Book(coin), fetchMetaAndAssetCtxs()]);
  const parsed = parseOrderbook(bookData, coin);
  const volume24h = getVolume24h(metaAndCtx, coin);

  if (sizeInUsd && !size) size = sizeInUsd / parsed.midPrice;
  if (!size || size <= 0) return errorResult("size or sizeInUsd required");

  const impact = calculatePriceImpact(parsed, side, size);
  const orderNotional = size * parsed.midPrice;
  const orderAsPercentOfVolume = volume24h > 0 ? (orderNotional / volume24h) * 100 : 0;

  let twapDuration: string, twapImpact: string;
  if (orderAsPercentOfVolume < 1) { twapDuration = "1-2 hours"; twapImpact = "minimal (<0.1%)"; }
  else if (orderAsPercentOfVolume < 5) { twapDuration = "4-8 hours"; twapImpact = "low (0.1-0.5%)"; }
  else if (orderAsPercentOfVolume < 15) { twapDuration = "12-24 hours"; twapImpact = "moderate (0.5-2%)"; }
  else { twapDuration = "2-5 days or OTC recommended"; twapImpact = "significant (2%+) even with TWAP"; }

  // Calculate confidence based on how much of the order can be absorbed
  const confidence = impact.canAbsorb ? (impact.slippageBps < 50 ? 0.85 : 0.7) : 0.5;

  return successResult({
    ...impact,
    volumeContext: {
      orderAsPercentOfDailyVolume: Number(orderAsPercentOfVolume.toFixed(2)),
      volume24h,
      estimatedTwapDuration: twapDuration,
      twapImpactEstimate: twapImpact,
    },
    hiddenLiquidityNote: "Visible book capacity is limited. Professional market makers use TWAP/algorithmic execution to minimize impact.",
    confidence,
    dataSources: ["l2Book", "metaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
  });
}

async function handleGetMarketInfo(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  if (!coin) return errorResult("coin parameter is required");

  const [metaAndCtx, bookData, mids] = await Promise.all([
    fetchMetaAndAssetCtxs(),
    fetchL2Book(coin),
    fetchAllMids(),
  ]);

  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Coin ${coin} not found`);

  const asset = meta.universe[idx];
  const ctx = ctxs[idx];
  const parsed = parseOrderbook(bookData, coin);

  const markPrice = Number(ctx.markPx || mids[coin] || 0);
  const indexPrice = Number(ctx.oraclePx || 0);
  const openInterest = Number(ctx.openInterest || 0);
  const fundingRate = Number(ctx.funding || 0);
  const volume24h = Number(ctx.dayNtlVlm || 0);
  const prevDayPx = Number(ctx.prevDayPx || 0);
  const premium = Number(ctx.premium || 0);
  const impactPxs = (ctx as unknown as { impactPxs?: string[] }).impactPxs;

  return successResult({
    coin,
    markPrice,
    indexPrice,
    midPrice: parsed.midPrice,
    premium: Number((premium * 100).toFixed(4)),
    spread: parsed.spread,
    openInterest,
    openInterestUsd: openInterest * markPrice,
    fundingRate,
    fundingRateAnnualized: fundingRate * 24 * 365 * 100,
    volume24h,
    priceChange24h: prevDayPx > 0 ? Number((((markPrice - prevDayPx) / prevDayPx) * 100).toFixed(2)) : 0,
    maxLeverage: asset.maxLeverage,
    impactPrices: impactPxs ? { impactBid: Number(impactPxs[0]), impactAsk: Number(impactPxs[1]) } : null,
    dataSources: ["metaAndAssetCtxs", "l2Book", "allMids"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleListMarkets(): Promise<CallToolResult> {
  const [meta, mids] = await Promise.all([fetchMeta(), fetchAllMids()]);

  const markets = meta.universe.map((asset) => ({
    symbol: asset.name,
    markPrice: Number(mids[asset.name] || 0),
    maxLeverage: asset.maxLeverage,
    szDecimals: asset.szDecimals,
  }));

  return successResult({
    markets,
    count: markets.length,
    dataSources: ["meta", "allMids"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetFundingAnalysis(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  if (!coin) return errorResult("coin parameter is required");

  const [metaAndCtx, predictedFundings] = await Promise.all([
    fetchMetaAndAssetCtxs(),
    fetchPredictedFundings(),
  ]);

  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Coin ${coin} not found`);

  const ctx = ctxs[idx];
  const fundingRate = Number(ctx.funding || 0);
  const annualized = fundingRate * 24 * 365 * 100;

  const coinPredictions = predictedFundings.find((p: [string, unknown[]]) => p[0] === coin);
  const predictions: Array<{ venue: string; rate: number; nextFundingTime: string }> = [];

  if (coinPredictions && Array.isArray(coinPredictions[1])) {
    for (const pred of coinPredictions[1]) {
      const [venue, data] = pred as [string, { fundingRate: string; nextFundingTime: number } | null];
      if (!data) continue;
      predictions.push({
        venue,
        rate: Number(data.fundingRate),
        nextFundingTime: new Date(data.nextFundingTime).toISOString(),
      });
    }
  }

  const hlRate = predictions.find((p) => p.venue === "HlPerp")?.rate ?? fundingRate;
  const binRate = predictions.find((p) => p.venue === "BinPerp")?.rate;
  let arbitrageOpportunity: { strategy: string; annualizedSpread: string } | null = null;

  if (binRate !== undefined) {
    const diff = (binRate - hlRate) * 24 * 365 * 100;
    if (Math.abs(diff) > 5) {
      arbitrageOpportunity = {
        strategy: diff > 0 ? "Long HL, Short Binance" : "Short HL, Long Binance",
        annualizedSpread: `${Math.abs(diff).toFixed(2)}%`,
      };
    }
  }

  // Calculate confidence based on arbitrage opportunity clarity
  const confidence = arbitrageOpportunity ? 0.8 : (predictions.length > 0 ? 0.7 : 0.5);

  return successResult({
    coin,
    currentFunding: {
      rate: fundingRate,
      annualized: Number(annualized.toFixed(2)),
      sentiment: fundingRate > 0 ? "bullish (longs pay shorts)" : fundingRate < 0 ? "bearish (shorts pay longs)" : "neutral",
    },
    predictedFundings: predictions,
    fundingArbitrage: arbitrageOpportunity,
    confidence,
    dataSources: ["metaAndAssetCtxs", "predictedFundings"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetStakingSummary(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const includeValidators = (args?.includeValidators as boolean) ?? false;
  const mids = await fetchAllMids();
  const hypePrice = Number(mids.HYPE || 0);

  return successResult({
    stakingMechanics: {
      delegationLockup: "1 day",
      unstakingQueue: "7 days",
      minValidatorSelfDelegation: 10_000,
      rewardDistribution: "Accrued every minute, distributed daily, auto-redelegated",
      rewardFormula: "Inversely proportional to sqrt(total HYPE staked)",
    },
    currentHypePrice: hypePrice,
    note: "Staking stats are not directly available via public API. Use app.hyperliquid.xyz/staking for current totals.",
    validators: includeValidators ? "Use https://stake.nansen.ai/stake/hyperliquid for validator list" : null,
    dataSources: ["allMids"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetUserDelegations(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const delegations = await fetchDelegations(address);
  const parsed = delegations.map((d) => ({
    validator: d.validator,
    amount: Number(d.amount),
    lockedUntil: new Date(d.lockedUntilTimestamp).toISOString(),
  }));
  const totalDelegated = parsed.reduce((sum, d) => sum + d.amount, 0);

  return successResult({
    address,
    delegations: parsed,
    totalDelegated,
    dataSources: ["delegations"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOpenInterestAnalysis(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  if (!coin) return errorResult("coin parameter is required");

  const [metaAndCtx, marketsAtCap] = await Promise.all([
    fetchMetaAndAssetCtxs(),
    fetchPerpsAtOiCap().catch(() => [] as string[]),
  ]);

  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Coin ${coin} not found`);

  const ctx = ctxs[idx];
  const openInterest = Number(ctx.openInterest || 0);
  const markPrice = Number(ctx.markPx || 0);
  const volume24h = Number(ctx.dayNtlVlm || 0);
  const fundingRate = Number(ctx.funding || 0);
  const oiUsd = openInterest * markPrice;
  const oiToVolumeRatio = volume24h > 0 ? oiUsd / volume24h : 0;
  const atCap = marketsAtCap.includes(coin);

  let fundingBias: string;
  if (fundingRate > 0.0001) fundingBias = "heavily long-biased";
  else if (fundingRate > 0) fundingBias = "slightly long-biased";
  else if (fundingRate < -0.0001) fundingBias = "heavily short-biased";
  else if (fundingRate < 0) fundingBias = "slightly short-biased";
  else fundingBias = "neutral";

  let liquidationRisk: string;
  if (oiToVolumeRatio > 3) liquidationRisk = "high - large OI relative to volume could cause cascades";
  else if (oiToVolumeRatio > 1.5) liquidationRisk = "moderate - significant OI concentration";
  else liquidationRisk = "low - healthy OI/volume ratio";

  // Calculate confidence based on data quality
  const confidence = volume24h > 0 ? 0.85 : 0.6;

  return successResult({
    coin,
    openInterest,
    openInterestUsd: oiUsd,
    oiToVolumeRatio: Number(oiToVolumeRatio.toFixed(2)),
    fundingImpliedBias: fundingBias,
    atOpenInterestCap: atCap,
    liquidationRisk,
    confidence,
    dataSources: ["metaAndAssetCtxs", "perpsAtOpenInterestCap"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetCandles(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  const interval = args?.interval as string;
  const limit = Math.min((args?.limit as number) || 100, 500);

  if (!coin) return errorResult("coin parameter is required");
  if (!interval) return errorResult("interval parameter is required");

  const now = Date.now();
  const intervalMs = getIntervalMs(interval);
  const startTime = now - intervalMs * limit;

  const candles = await fetchCandleSnapshot(coin, interval, startTime, now);
  const parsed = candles.map((c) => ({
    time: new Date(c.t).toISOString(),
    open: Number(c.o),
    high: Number(c.h),
    low: Number(c.l),
    close: Number(c.c),
    volume: Number(c.v),
  }));

  const highs = parsed.map((c) => c.high);
  const lows = parsed.map((c) => c.low);
  const volumes = parsed.map((c) => c.volume);
  const firstClose = parsed.at(0)?.close ?? 0;
  const lastClose = parsed.at(-1)?.close ?? 0;

  return successResult({
    coin,
    interval,
    candles: parsed,
    summary: {
      periodHigh: Math.max(...highs),
      periodLow: Math.min(...lows),
      priceChange: firstClose > 0 ? Number((((lastClose - firstClose) / firstClose) * 100).toFixed(2)) : 0,
      totalVolume: volumes.reduce((a, b) => a + b, 0),
    },
    dataSources: ["candleSnapshot"],
    dataFreshness: "historical" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetRecentTrades(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  const whaleThreshold = (args?.whaleThresholdUsd as number) || 100_000;

  if (!coin) return errorResult("coin parameter is required");

  const trades = await fetchRecentTrades(coin);
  const tradesArray = Array.isArray(trades) ? trades : [trades];

  let totalVolume = 0, totalNotional = 0, buyVolume = 0, sellVolume = 0;
  let whaleBuyVolume = 0, whaleSellVolume = 0;
  const whaleTrades: Record<string, unknown>[] = [];

  const parsed = tradesArray.slice(0, 100).map((t) => {
    const price = Number(t.px);
    const size = Number(t.sz);
    const notional = price * size;
    const side = t.side.toLowerCase() === "b" ? "buy" : "sell";

    totalVolume += size;
    totalNotional += notional;
    if (side === "buy") buyVolume += size;
    else sellVolume += size;

    const trade = {
      price,
      size,
      notional: Number(notional.toFixed(2)),
      side,
      time: new Date(t.time).toISOString(),
      isWhale: notional >= whaleThreshold,
    };

    if (notional >= whaleThreshold) {
      whaleTrades.push(trade);
      if (side === "buy") whaleBuyVolume += size;
      else whaleSellVolume += size;
    }

    return trade;
  });

  // Provide clear feedback when no whale trades detected
  const whaleStatus = whaleTrades.length === 0
    ? `No whale trades detected in last ${parsed.length} trades (threshold: $${whaleThreshold.toLocaleString()}). Note: This API only captures a snapshot of recent trades - true whale activity ($500k+) is rare and may not appear in this window.`
    : `${whaleTrades.length} whale trade(s) detected above $${whaleThreshold.toLocaleString()} threshold`;

  return successResult({
    coin,
    trades: parsed,
    whaleTrades,
    whaleStatus,
    summary: {
      totalVolume,
      totalNotional: Number(totalNotional.toFixed(2)),
      buyVolume,
      sellVolume,
      buyRatio: totalVolume > 0 ? Number(((buyVolume / totalVolume) * 100).toFixed(2)) : 50,
      whaleTradeCount: whaleTrades.length,
      whaleBuyVolume,
      whaleSellVolume,
      whaleNetFlow: whaleBuyVolume - whaleSellVolume,
    },
    limitations: "The recentTrades API returns only the last ~100 trades chronologically. Whale trades ($100k+) are rare events that may not appear in this snapshot. For more reliable whale tracking, consider monitoring specific known whale wallet addresses using analyze_whale_wallet.",
    dataSources: ["recentTrades"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeLargeOrder(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  const side = args?.side as "sell" | "buy";
  let size = args?.size as number | undefined;
  const sizeInUsd = args?.sizeInUsd as number | undefined;

  if (!coin) return errorResult("coin parameter is required");
  if (!side) return errorResult("side parameter is required");

  const [bookData, metaAndCtx] = await Promise.all([fetchL2Book(coin), fetchMetaAndAssetCtxs()]);
  const parsed = parseOrderbook(bookData, coin);
  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Coin ${coin} not found`);

  const ctx = ctxs[idx];
  const volume24h = Number(ctx.dayNtlVlm || 0);
  const openInterest = Number(ctx.openInterest || 0);
  const fundingRate = Number(ctx.funding || 0);
  const markPrice = Number(ctx.markPx || parsed.midPrice);

  if (sizeInUsd && !size) size = sizeInUsd / parsed.midPrice;
  if (!size || size <= 0) return errorResult("size or sizeInUsd required");

  const orderNotional = size * parsed.midPrice;
  const impact = calculatePriceImpact(parsed, side, size);
  const asPercentOfVolume = volume24h > 0 ? (orderNotional / volume24h) * 100 : 0;
  const asPercentOfOI = openInterest > 0 ? (size / openInterest) * 100 : 0;

  let immediateImpact: string;
  if (impact.canAbsorb && impact.slippageBps < 50) immediateImpact = "manageable - visible book can absorb with minor slippage";
  else if (impact.canAbsorb) immediateImpact = "significant - would move price but book absorbs";
  else immediateImpact = "severe - would exhaust visible liquidity";

  let priceDropEstimate: string;
  if (asPercentOfVolume < 2) priceDropEstimate = "1-3% with market order, <0.5% with TWAP";
  else if (asPercentOfVolume < 10) priceDropEstimate = "3-8% with market order, 1-3% with TWAP";
  else if (asPercentOfVolume < 30) priceDropEstimate = "8-15% with market order, 3-5% with TWAP";
  else priceDropEstimate = "15%+ likely, recommend OTC";

  let recommendedStrategy: string, twapDuration: string, twapImpact: string, otcRec: string;
  if (asPercentOfVolume < 1) {
    recommendedStrategy = "Market order acceptable";
    twapDuration = "Not necessary";
    twapImpact = "N/A";
    otcRec = "Not needed for this size";
  } else if (asPercentOfVolume < 5) {
    recommendedStrategy = "TWAP recommended";
    twapDuration = "4-8 hours";
    twapImpact = "<1% expected";
    otcRec = "Optional - TWAP sufficient";
  } else if (asPercentOfVolume < 15) {
    recommendedStrategy = "Extended TWAP or split execution";
    twapDuration = "12-24 hours";
    twapImpact = "1-3% expected";
    otcRec = "Consider for portion of order";
  } else {
    recommendedStrategy = "OTC strongly recommended";
    twapDuration = "2-5 days if on-exchange";
    twapImpact = "3-5%+ even with long TWAP";
    otcRec = "Highly recommended - contact Flowdesk, Wintermute, or similar";
  }

  let reflexivityRisk: string, cascadePotential: string, worstCase: string;
  if (asPercentOfVolume < 5 && fundingRate > 0) {
    reflexivityRisk = "low";
    cascadePotential = "Unlikely to trigger panic selling";
    worstCase = "Add 2-3% to base estimate";
  } else if (asPercentOfVolume < 15) {
    reflexivityRisk = "moderate";
    cascadePotential = "May trigger some copycat selling and long liquidations";
    worstCase = "Add 5-8% to base estimate";
  } else {
    reflexivityRisk = "high";
    cascadePotential = "Could trigger significant liquidation cascade and panic";
    worstCase = "Double the base estimate possible";
  }

  const sideWord = side === "sell" ? "sell" : "buy";
  let conclusion: string;
  if (asPercentOfVolume < 2) {
    conclusion = `This ${sideWord} order represents only ${asPercentOfVolume.toFixed(1)}% of daily volume and can be executed on-exchange with minimal impact. ${recommendedStrategy}.`;
  } else if (asPercentOfVolume < 10) {
    conclusion = `This ${sideWord} order is ${asPercentOfVolume.toFixed(1)}% of daily volume. With proper TWAP execution over several hours, impact can be minimized to 1-3%.`;
  } else if (asPercentOfVolume < 30) {
    conclusion = `Significant ${sideWord} pressure at ${asPercentOfVolume.toFixed(1)}% of daily volume. Extended TWAP or partial OTC execution recommended. Expect 3-8% price impact.`;
  } else {
    conclusion = `Very large ${sideWord} order at ${asPercentOfVolume.toFixed(1)}% of daily volume. OTC execution strongly recommended.`;
  }

  // Calculate confidence based on volume data quality
  const confidence = volume24h > 0 ? (asPercentOfVolume < 10 ? 0.85 : 0.7) : 0.5;

  return successResult({
    coin,
    orderSummary: {
      size,
      notional: orderNotional,
      side,
      asPercentOfDailyVolume: Number(asPercentOfVolume.toFixed(2)),
      asPercentOfOpenInterest: Number(asPercentOfOI.toFixed(2)),
    },
    marketImpact: {
      immediateImpact,
      visibleBookAbsorption: impact.filledPercent,
      estimatedSlippage: impact.slippageBps,
      priceDropEstimate,
    },
    executionRecommendation: {
      recommendedStrategy,
      twapDuration,
      expectedImpactWithTwap: twapImpact,
      otcRecommendation: otcRec,
    },
    marketContext: {
      currentPrice: markPrice,
      volume24h,
      openInterest,
      openInterestUsd: openInterest * markPrice,
      fundingSentiment: fundingRate > 0 ? "longs paying (bullish bias)" : "shorts paying (bearish bias)",
      bidLiquidity: parsed.totalBidLiquidity,
      askLiquidity: parsed.totalAskLiquidity,
    },
    reflexivityRisk: { riskLevel: reflexivityRisk, potentialCascade: cascadePotential, worstCaseImpact: worstCase },
    conclusion,
    confidence,
    dataSources: ["l2Book", "metaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketsAtOiCap(): Promise<CallToolResult> {
  const markets = await fetchPerpsAtOiCap();
  return successResult({
    marketsAtCap: markets,
    count: markets.length,
    note: "Markets at OI cap have limited capacity for new positions.",
    dataSources: ["perpsAtOpenInterestCap"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

const HLP_VAULT_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

async function handleGetHlpVaultStats(): Promise<CallToolResult> {
  const vaultData = await fetchVaultDetails(HLP_VAULT_ADDRESS);
  if (!vaultData) return errorResult("Failed to fetch HLP vault data");

  const tvl = vaultData.followers?.reduce((sum, f) => sum + Number(f.vaultEquity || 0), 0) ?? 0;

  const performance: Record<string, unknown> = {};
  if (vaultData.portfolio) {
    for (const [period, data] of vaultData.portfolio) {
      const pnlHistory = data.pnlHistory || [];
      const lastPnl = pnlHistory.at(-1)?.[1] ?? "0";
      const firstPnl = pnlHistory.at(0)?.[1] ?? "0";
      performance[period] = {
        pnl: Number(lastPnl) - Number(firstPnl),
        volume: Number(data.vlm || 0),
        dataPoints: pnlHistory.length,
      };
    }
  }

  return successResult({
    name: vaultData.name || "HLP",
    vaultAddress: HLP_VAULT_ADDRESS,
    apr: vaultData.apr ?? 0,
    aprAnnualized: (vaultData.apr ?? 0) * 100,
    tvl,
    tvlFormatted: `$${(tvl / 1_000_000).toFixed(2)}M`,
    followerCount: vaultData.followers?.length ?? 0,
    leaderCommission: vaultData.leaderCommission ?? 0,
    performance,
    lockupPeriod: "4 days",
    isClosed: vaultData.isClosed ?? false,
    allowDeposits: vaultData.allowDeposits ?? true,
    note: "HLP is the protocol vault that provides liquidity. APR reflects recent performance.",
    dataSources: ["vaultDetails"],
    dataFreshness: "near-real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetFundingHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = args?.coin as string;
  const days = Math.min((args?.days as number) || 30, 90);

  if (!coin) return errorResult("coin parameter is required");

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;

  const fundingData = await fetchFundingHistory(coin, startTime, endTime);
  if (!fundingData || fundingData.length === 0) return errorResult(`No funding history available for ${coin}`);

  const parsed = fundingData.map((f) => {
    const rate = Number(f.fundingRate);
    return {
      time: new Date(f.time).toISOString(),
      fundingRate: rate,
      premium: Number(f.premium),
      annualized: rate * 24 * 365 * 100,
    };
  });

  const rates = parsed.map((p) => p.fundingRate);
  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const positiveCount = rates.filter((r) => r > 0).length;

  const halfIdx = Math.floor(rates.length / 2);
  const firstHalfAvg = rates.slice(0, halfIdx).reduce((a, b) => a + b, 0) / halfIdx;
  const secondHalfAvg = rates.slice(halfIdx).reduce((a, b) => a + b, 0) / (rates.length - halfIdx);
  const trendDiff = secondHalfAvg - firstHalfAvg;

  let trend: string;
  if (Math.abs(trendDiff) < 0.00001) trend = "stable";
  else if (trendDiff > 0) trend = "increasing (becoming more bullish)";
  else trend = "decreasing (becoming less bullish or bearish)";

  return successResult({
    coin,
    daysAnalyzed: days,
    fundingHistory: parsed,
    summary: {
      avgFundingRate: avgRate,
      avgAnnualized: avgRate * 24 * 365 * 100,
      maxFundingRate: Math.max(...rates),
      minFundingRate: Math.min(...rates),
      positiveFundingPercent: (positiveCount / rates.length) * 100,
      trend,
      interpretation: avgRate > 0
        ? `Longs have paid shorts on average (${(avgRate * 24 * 365 * 100).toFixed(2)}% annualized).`
        : `Shorts have paid longs on average.`,
    },
    dataSources: ["fundingHistory"],
    dataFreshness: "historical" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetExchangeStats(): Promise<CallToolResult> {
  const metaAndCtx = await fetchMetaAndAssetCtxs();
  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];

  let totalVolume = 0, totalOI = 0;
  const marketVolumes: Array<{ coin: string; volume24h: number; openInterest: number }> = [];

  for (let i = 0; i < meta.universe.length; i++) {
    const coin = meta.universe[i].name;
    const ctx = ctxs[i];
    const volume = Number(ctx.dayNtlVlm || 0);
    const markPrice = Number(ctx.markPx || 0);
    const oi = Number(ctx.openInterest || 0) * markPrice;

    totalVolume += volume;
    totalOI += oi;
    if (volume > 0) marketVolumes.push({ coin, volume24h: volume, openInterest: oi });
  }

  marketVolumes.sort((a, b) => b.volume24h - a.volume24h);
  const topMarkets = marketVolumes.slice(0, 10).map((m) => ({
    coin: m.coin,
    volume24h: m.volume24h,
    percentOfTotal: totalVolume > 0 ? Number(((m.volume24h / totalVolume) * 100).toFixed(2)) : 0,
  }));

  return successResult({
    totalVolume24h: totalVolume,
    totalVolume24hFormatted: `$${(totalVolume / 1_000_000_000).toFixed(2)}B`,
    totalOpenInterest: totalOI,
    totalOpenInterestFormatted: `$${(totalOI / 1_000_000_000).toFixed(2)}B`,
    marketCount: meta.universe.length,
    activeMarkets: marketVolumes.length,
    topMarketsByVolume: topMarkets,
    volumeConcentration: {
      top3Percent: topMarkets.slice(0, 3).reduce((s, m) => s + m.percentOfTotal, 0),
      top10Percent: topMarkets.reduce((s, m) => s + m.percentOfTotal, 0),
    },
    note: "Volume is 24h notional volume.",
    dataSources: ["metaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetVolumeHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coin = (args?.coin as string) || "HYPE";
  const days = Math.min((args?.days as number) || 30, 90);

  const now = Date.now();
  const intervalMs = 24 * 60 * 60 * 1000;
  const startTime = now - intervalMs * days;

  const candles = await fetchCandleSnapshot(coin, "1d", startTime, now);
  if (!candles || candles.length === 0) return errorResult(`No historical data available for ${coin}`);

  const dailyVolumes = candles.map((c) => ({
    date: new Date(c.t).toISOString().split("T")[0],
    volume: Number(c.v) * Number(c.c),
    rawVolume: Number(c.v),
    closePrice: Number(c.c),
  }));

  const volumes = dailyVolumes.map((d) => d.volume);
  const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;

  const recentVolumes = volumes.slice(-7);
  const recentAvg = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const recentVsAvgRatio = avgVolume > 0 ? recentAvg / avgVolume : 1;

  const firstWeek = volumes.slice(0, 7);
  const lastWeek = volumes.slice(-7);
  const firstWeekAvg = firstWeek.reduce((a, b) => a + b, 0) / firstWeek.length;
  const lastWeekAvg = lastWeek.reduce((a, b) => a + b, 0) / lastWeek.length;
  const percentChange = firstWeekAvg > 0 ? ((lastWeekAvg - firstWeekAvg) / firstWeekAvg) * 100 : 0;

  let trend: string;
  if (percentChange > 20) trend = "significantly increasing";
  else if (percentChange > 5) trend = "increasing";
  else if (percentChange < -20) trend = "significantly decreasing";
  else if (percentChange < -5) trend = "decreasing";
  else trend = "stable";

  return successResult({
    coin,
    daysAnalyzed: dailyVolumes.length,
    dailyVolumes,
    summary: {
      avgDailyVolume: avgVolume,
      avgDailyVolumeFormatted: `$${(avgVolume / 1_000_000).toFixed(2)}M`,
      maxDailyVolume: Math.max(...volumes),
      minDailyVolume: Math.min(...volumes),
      recentAvg7d: recentAvg,
      recentVsAvgRatio: Number(recentVsAvgRatio.toFixed(2)),
      trend,
      percentChange: Number(percentChange.toFixed(2)),
      interpretation: recentVsAvgRatio < 0.7
        ? "Recent volume is significantly below average - liquidity may be drying up"
        : recentVsAvgRatio > 1.3
          ? "Recent volume is significantly above average - increased activity"
          : "Recent volume is within normal range",
    },
    dataSources: ["candleSnapshot"],
    dataFreshness: "historical" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - Spot Markets
// ============================================================================

async function handleGetSpotMeta(): Promise<CallToolResult> {
  const data = await fetchSpotMetaAndAssetCtxs();
  const [meta, assetCtxs] = data;

  return successResult({
    tokens: meta.tokens.map(t => ({
      name: t.name,
      szDecimals: t.szDecimals,
      weiDecimals: t.weiDecimals,
      index: t.index,
      tokenId: t.tokenId,
      isCanonical: t.isCanonical,
      fullName: t.fullName,
    })),
    universe: meta.universe.map((u, idx) => ({
      name: u.name,
      tokens: u.tokens,
      index: u.index,
      isCanonical: u.isCanonical,
      volume24h: assetCtxs[idx] ? Number(assetCtxs[idx].dayNtlVlm) : 0,
      markPx: assetCtxs[idx] ? Number(assetCtxs[idx].markPx) : 0,
      midPx: assetCtxs[idx] ? Number(assetCtxs[idx].midPx) : 0,
    })),
    assetContexts: assetCtxs,
    dataSources: ["spotMetaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetSpotBalances(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  // Fetch balances AND current spot prices in parallel
  const [data, spotData] = await Promise.all([
    fetchSpotClearinghouseState(address),
    fetchSpotMetaAndAssetCtxs(),
  ]);

  const balances = data.balances || [];
  const [spotMeta, spotCtxs] = spotData;

  // Build price lookup from spot asset contexts
  // Note: spotCtxs indices correspond to spotMeta.universe indices
  const tokenPrices: Record<number, number> = {};
  for (let i = 0; i < spotMeta.universe.length; i++) {
    const pair = spotMeta.universe[i];
    const ctx = spotCtxs[i];
    if (ctx && pair.tokens[0] !== 0) { // Skip USDC pairs where base is USDC
      const baseTokenIdx = pair.tokens[0];
      const price = Number(ctx.markPx || ctx.midPx || 0);
      if (price > 0) {
        tokenPrices[baseTokenIdx] = price;
      }
    }
  }
  // USDC is always worth $1
  tokenPrices[0] = 1;

  const parsedBalances = balances.map(b => {
    const total = Number(b.total);
    const hold = Number(b.hold);
    const entryNtl = Number(b.entryNtl);
    const currentPrice = tokenPrices[b.token] || 0;
    const currentValue = total * currentPrice;
    const unrealizedPnl = currentPrice > 0 ? currentValue - entryNtl : 0;

    return {
      coin: b.coin,
      token: b.token,
      total,
      hold,
      available: total - hold,
      entryNtl,
      currentPrice,
      currentValue: Number(currentValue.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
      unrealizedPnlPercent: entryNtl > 0 ? Number(((unrealizedPnl / entryNtl) * 100).toFixed(2)) : 0,
    };
  });

  const totalEntryValue = parsedBalances.reduce((sum, b) => sum + b.entryNtl, 0);
  const totalCurrentValue = parsedBalances.reduce((sum, b) => sum + b.currentValue, 0);
  const totalUnrealizedPnl = parsedBalances.reduce((sum, b) => sum + b.unrealizedPnl, 0);

  return successResult({
    address,
    balances: parsedBalances,
    summary: {
      totalEntryValue: Number(totalEntryValue.toFixed(2)),
      totalCurrentValue: Number(totalCurrentValue.toFixed(2)),
      totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(2)),
      totalUnrealizedPnlPercent: totalEntryValue > 0 
        ? Number(((totalUnrealizedPnl / totalEntryValue) * 100).toFixed(2)) 
        : 0,
    },
    // Backwards compatibility
    totalValue: Number(totalCurrentValue.toFixed(2)),
    dataSources: ["spotClearinghouseState", "spotMetaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - User State & Positions
// ============================================================================

async function handleGetUserState(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchClearinghouseState(address);

  const positions = data.assetPositions.map(ap => ({
    coin: ap.position.coin,
    size: Number(ap.position.szi),
    entryPrice: Number(ap.position.entryPx),
    markPrice: Number(ap.position.positionValue) / Math.abs(Number(ap.position.szi)) || 0,
    unrealizedPnl: Number(ap.position.unrealizedPnl),
    liquidationPrice: Number(ap.position.liquidationPx),
    leverage: ap.position.leverage,
    marginUsed: Number(ap.position.marginUsed),
    positionValue: Number(ap.position.positionValue),
    returnOnEquity: Number(ap.position.returnOnEquity),
    cumFunding: ap.position.cumFunding,
  }));

  return successResult({
    address,
    assetPositions: positions,
    marginSummary: {
      accountValue: Number(data.marginSummary.accountValue),
      totalMarginUsed: Number(data.marginSummary.totalMarginUsed),
      totalNtlPos: Number(data.marginSummary.totalNtlPos),
      totalRawUsd: Number(data.marginSummary.totalRawUsd),
    },
    crossMarginSummary: {
      accountValue: Number(data.crossMarginSummary.accountValue),
      totalMarginUsed: Number(data.crossMarginSummary.totalMarginUsed),
      totalNtlPos: Number(data.crossMarginSummary.totalNtlPos),
      totalRawUsd: Number(data.crossMarginSummary.totalRawUsd),
    },
    withdrawable: Number(data.withdrawable),
    crossMaintenanceMarginUsed: Number(data.crossMaintenanceMarginUsed),
    dataSources: ["clearinghouseState"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOpenOrders(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const orders = await fetchOpenOrders(address);

  const parsedOrders = orders.map(o => ({
    coin: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    size: Number(o.sz),
    origSize: Number(o.origSz),
    limitPrice: Number(o.limitPx),
    orderType: o.orderType,
    orderId: o.oid,
    timestamp: o.timestamp,
    isTrigger: o.isTrigger,
    triggerPrice: o.isTrigger ? Number(o.triggerPx) : null,
    triggerCondition: o.triggerCondition,
    reduceOnly: o.reduceOnly,
    isPositionTpsl: o.isPositionTpsl,
  }));

  return successResult({
    address,
    orders: parsedOrders,
    orderCount: parsedOrders.length,
    dataSources: ["frontendOpenOrders"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOrderStatus(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  const oid = args?.oid as string;
  if (!address) return errorResult("address parameter is required");
  if (!oid) return errorResult("oid parameter is required");

  const data = await fetchOrderStatus(address, oid);

  return successResult({
    status: data.status,
    order: data.order || null,
    dataSources: ["orderStatus"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - Trade History & Fills
// ============================================================================

async function handleGetUserFills(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  const startTime = args?.startTime as number | undefined;
  const endTime = args?.endTime as number | undefined;
  const aggregateByTime = args?.aggregateByTime as boolean | undefined;

  if (!address) return errorResult("address parameter is required");

  const fills = await fetchUserFills(address, aggregateByTime, startTime, endTime);

  const parsedFills = fills.map(f => ({
    coin: f.coin,
    side: f.side === "B" ? "buy" : "sell",
    direction: f.dir,
    price: Number(f.px),
    size: Number(f.sz),
    notional: Number(f.px) * Number(f.sz),
    closedPnl: Number(f.closedPnl),
    fee: Number(f.fee),
    feeToken: f.feeToken,
    builderFee: f.builderFee ? Number(f.builderFee) : null,
    time: f.time,
    hash: f.hash,
    orderId: f.oid,
    tradeId: f.tid,
    crossed: f.crossed,
    startPosition: Number(f.startPosition),
  }));

  // Calculate summary stats
  const totalVolume = parsedFills.reduce((sum, f) => sum + f.notional, 0);
  const totalPnl = parsedFills.reduce((sum, f) => sum + f.closedPnl, 0);
  const totalFees = parsedFills.reduce((sum, f) => sum + f.fee, 0);

  return successResult({
    address,
    fills: parsedFills,
    fillCount: parsedFills.length,
    summary: {
      totalVolume,
      totalPnl,
      totalFees,
      avgTradeSize: parsedFills.length > 0 ? totalVolume / parsedFills.length : 0,
    },
    dataSources: ["userFills"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - Fees & Referrals
// ============================================================================

async function handleGetUserFees(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchUserFees(address);

  return successResult({
    address,
    feeSchedule: data.feeSchedule,
    userRates: {
      perpMaker: Number(data.userAddRate),
      perpTaker: Number(data.userCrossRate),
      spotMaker: Number(data.userSpotAddRate),
      spotTaker: Number(data.userSpotCrossRate),
      perpMakerPercent: Number(data.userAddRate) * 100,
      perpTakerPercent: Number(data.userCrossRate) * 100,
      spotMakerPercent: Number(data.userSpotAddRate) * 100,
      spotTakerPercent: Number(data.userSpotCrossRate) * 100,
    },
    dailyVolume: data.dailyUserVlm,
    activeDiscounts: {
      referralDiscount: Number(data.activeReferralDiscount),
      stakingDiscount: data.activeStakingDiscount ? Number(data.activeStakingDiscount.discount) : 0,
    },
    stakingLink: data.stakingLink,
    trial: data.trial,
    feeTrialReward: Number(data.feeTrialReward),
    dataSources: ["userFees"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetReferralState(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchReferralState(address);

  return successResult({
    address,
    referralState: data,
    dataSources: ["referral"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - Portfolio & Vaults
// ============================================================================

async function handleGetUserPortfolio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchUserPortfolio(address);

  const portfolio: Record<string, { accountValueHistory: Array<{ time: string; value: number }>; pnlHistory: Array<{ time: string; pnl: number }>; volume: number }> = {};

  for (const [period, periodData] of data) {
    portfolio[period] = {
      accountValueHistory: periodData.accountValueHistory.map(([ts, val]) => ({
        time: new Date(ts).toISOString(),
        value: Number(val),
      })),
      pnlHistory: periodData.pnlHistory.map(([ts, pnl]) => ({
        time: new Date(ts).toISOString(),
        pnl: Number(pnl),
      })),
      volume: Number(periodData.vlm),
    };
  }

  return successResult({
    address,
    portfolio,
    dataSources: ["portfolio"],
    dataFreshness: "near-real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetUserVaultEquities(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchUserVaultEquities(address);

  const vaultEquities = data.map(v => ({
    vaultAddress: v.vaultAddress,
    equity: Number(v.equity),
  }));

  const totalEquity = vaultEquities.reduce((sum, v) => sum + v.equity, 0);

  return successResult({
    address,
    vaultEquities,
    totalEquity,
    dataSources: ["userVaultEquities"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 2 HANDLERS - Sub-Accounts
// ============================================================================

async function handleGetSubAccounts(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  const data = await fetchSubAccounts(address);

  // API returns null if no sub-accounts
  if (!data) {
    return successResult({
      address,
      subAccounts: [],
      subAccountCount: 0,
      dataSources: ["subAccounts"],
      dataFreshness: "real-time" as const,
      fetchedAt: new Date().toISOString(),
    });
  }

  const subAccounts = data.map(sa => ({
    name: sa.name,
    subAccountUser: sa.subAccountUser,
    master: sa.master,
    accountValue: Number(sa.clearinghouseState.marginSummary.accountValue),
    totalMarginUsed: Number(sa.clearinghouseState.marginSummary.totalMarginUsed),
    withdrawable: Number(sa.clearinghouseState.withdrawable),
    positionCount: sa.clearinghouseState.assetPositions.length,
    spotBalances: sa.spotState.balances.map(b => ({
      coin: b.coin,
      total: Number(b.total),
      hold: Number(b.hold),
    })),
  }));

  return successResult({
    address,
    subAccounts,
    subAccountCount: subAccounts.length,
    dataSources: ["subAccounts"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 1 HANDLERS - Intelligence Layer
// ============================================================================

async function handleAnalyzeTraderPerformance(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  const days = Math.min((args?.days as number) || 30, 90);
  if (!address) return errorResult("address parameter is required");

  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;

  // Fetch all required data in parallel
  const [fills, fees, portfolio] = await Promise.all([
    fetchUserFills(address, false, startTime, now),
    fetchUserFees(address),
    fetchUserPortfolio(address),
  ]);

  // Calculate trading stats
  const trades = fills.filter(f => Number(f.closedPnl) !== 0);
  const wins = trades.filter(f => Number(f.closedPnl) > 0);
  const losses = trades.filter(f => Number(f.closedPnl) < 0);

  const totalPnl = trades.reduce((sum, f) => sum + Number(f.closedPnl), 0);
  const totalVolume = fills.reduce((sum, f) => sum + Number(f.px) * Number(f.sz), 0);
  const totalFees = fills.reduce((sum, f) => sum + Number(f.fee), 0);
  const grossProfit = wins.reduce((sum, f) => sum + Number(f.closedPnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, f) => sum + Number(f.closedPnl), 0));

  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Analyze trading patterns
  const coinVolumes: Record<string, number> = {};
  let buyVolume = 0, sellVolume = 0;
  for (const fill of fills) {
    const notional = Number(fill.px) * Number(fill.sz);
    coinVolumes[fill.coin] = (coinVolumes[fill.coin] || 0) + notional;
    if (fill.side === "B") buyVolume += notional;
    else sellVolume += notional;
  }

  const sortedCoins = Object.entries(coinVolumes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([coin, vol]) => ({ coin, volume: vol, percent: (vol / totalVolume) * 100 }));

  // Fee analysis
  const effectiveFeeRate = totalVolume > 0 ? (totalFees / totalVolume) * 100 : 0;
  const currentTaker = Number(fees.userCrossRate) * 100;
  const baseTaker = Number(fees.feeSchedule.cross) * 100;

  // Determine VIP tier and next tier
  let currentTier = "Standard";
  let nextTierVolume = 0;
  const vipTiers = fees.feeSchedule.tiers.vip;
  for (let i = 0; i < vipTiers.length; i++) {
    const tierCutoff = Number(vipTiers[i].ntlCutoff);
    if (totalVolume >= tierCutoff) {
      currentTier = `VIP ${i + 1}`;
      if (i < vipTiers.length - 1) {
        nextTierVolume = Number(vipTiers[i + 1].ntlCutoff) - totalVolume;
      }
    }
  }

  const potentialSavings = (baseTaker - currentTaker) * totalVolume / 100;

  // Generate recommendations
  const recommendations: string[] = [];
  if (winRate < 40) recommendations.push("Win rate is below 40%. Consider tightening stop losses or improving entry criteria.");
  if (profitFactor < 1) recommendations.push("Profit factor is below 1 (losing money). Review your risk/reward ratio.");
  if (effectiveFeeRate > currentTaker) recommendations.push("Effective fee rate suggests mostly taker orders. Consider using limit orders for lower fees.");
  if (nextTierVolume > 0 && nextTierVolume < totalVolume * 0.5) recommendations.push(`Trade $${nextTierVolume.toFixed(0)} more to reach the next VIP tier and reduce fees.`);
  if (sortedCoins[0] && sortedCoins[0].percent > 80) recommendations.push(`High concentration (${sortedCoins[0].percent.toFixed(0)}%) in ${sortedCoins[0].coin}. Consider diversifying.`);

  const confidence = fills.length > 10 ? 0.85 : fills.length > 0 ? 0.6 : 0.3;

  return successResult({
    address,
    period: `${days} days`,
    tradingStats: {
      totalTrades: trades.length,
      totalFills: fills.length,
      winRate: Number(winRate.toFixed(2)),
      wins: wins.length,
      losses: losses.length,
      profitFactor: profitFactor === Infinity ? "∞" : Number(profitFactor.toFixed(2)),
      totalPnL: Number(totalPnl.toFixed(2)),
      totalVolume: Number(totalVolume.toFixed(2)),
      averageTradeSize: fills.length > 0 ? Number((totalVolume / fills.length).toFixed(2)) : 0,
    },
    feeAnalysis: {
      totalFeesPaid: Number(totalFees.toFixed(2)),
      effectiveFeeRate: `${effectiveFeeRate.toFixed(4)}%`,
      currentTier,
      currentTakerRate: `${currentTaker.toFixed(3)}%`,
      currentMakerRate: `${(Number(fees.userAddRate) * 100).toFixed(3)}%`,
      potentialSavings: Number(potentialSavings.toFixed(2)),
      nextTierVolume: nextTierVolume > 0 ? Number(nextTierVolume.toFixed(0)) : null,
      stakingDiscount: fees.activeStakingDiscount ? `${(Number(fees.activeStakingDiscount.discount) * 100).toFixed(0)}%` : "0%",
    },
    tradingPatterns: {
      mostTradedCoins: sortedCoins,
      preferredSide: buyVolume > sellVolume * 1.2 ? "buyer" : sellVolume > buyVolume * 1.2 ? "seller" : "balanced",
      buyVsSellRatio: totalVolume > 0 ? Number((buyVolume / totalVolume * 100).toFixed(1)) : 50,
    },
    recommendations,
    confidence,
    dataSources: ["userFills", "userFees", "portfolio"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeSpotMarkets(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const minVolume = (args?.minVolume as number) || 10000;

  // Fetch spot and perp data in parallel
  const [spotData, perpData] = await Promise.all([
    fetchSpotMetaAndAssetCtxs(),
    fetchMetaAndAssetCtxs(),
  ]);

  const [spotMeta, spotCtxs] = spotData;
  const perpMeta = perpData[0];
  const perpCtxs = perpData[1];

  // Build perp price lookup
  const perpPrices: Record<string, number> = {};
  for (let i = 0; i < perpMeta.universe.length; i++) {
    perpPrices[perpMeta.universe[i].name] = Number(perpCtxs[i].markPx || 0);
  }

  // Analyze spot markets
  const markets: Array<{
    pair: string;
    baseToken: string;
    volume24h: number;
    markPx: number;
    midPx: number;
    prevDayPx: number;
    priceChange24h: number;
    perpPrice: number | null;
    spotPerpDiff: number | null;
  }> = [];

  for (let i = 0; i < spotMeta.universe.length; i++) {
    const pair = spotMeta.universe[i];
    const ctx = spotCtxs[i];
    if (!ctx) continue;

    const volume24h = Number(ctx.dayNtlVlm);
    if (volume24h < minVolume) continue;

    const baseTokenIdx = pair.tokens[0];
    const baseToken = spotMeta.tokens.find(t => t.index === baseTokenIdx)?.name || "UNKNOWN";
    const markPx = Number(ctx.markPx);
    const prevDayPx = Number(ctx.prevDayPx);
    const priceChange24h = prevDayPx > 0 ? ((markPx - prevDayPx) / prevDayPx) * 100 : 0;

    const perpPrice = perpPrices[baseToken] || null;
    const spotPerpDiff = perpPrice ? ((markPx - perpPrice) / perpPrice) * 100 : null;

    markets.push({
      pair: pair.name,
      baseToken,
      volume24h,
      markPx,
      midPx: Number(ctx.midPx),
      prevDayPx,
      priceChange24h: Number(priceChange24h.toFixed(2)),
      perpPrice,
      spotPerpDiff: spotPerpDiff !== null ? Number(spotPerpDiff.toFixed(4)) : null,
    });
  }

  // Sort by volume
  markets.sort((a, b) => b.volume24h - a.volume24h);

  // Find spot-perp divergences (potential arbitrage)
  const divergences = markets
    .filter(m => m.spotPerpDiff !== null && Math.abs(m.spotPerpDiff) > 0.1)
    .sort((a, b) => Math.abs(b.spotPerpDiff || 0) - Math.abs(a.spotPerpDiff || 0))
    .slice(0, 10)
    .map(m => ({
      pair: m.pair,
      spotPrice: m.markPx,
      perpPrice: m.perpPrice,
      divergencePercent: m.spotPerpDiff,
      direction: m.spotPerpDiff! > 0 ? "spot premium" : "spot discount",
    }));

  const totalVolume = markets.reduce((sum, m) => sum + m.volume24h, 0);

  // Generate opportunities
  const opportunities: string[] = [];
  if (divergences.length > 0) {
    const topDiv = divergences[0];
    opportunities.push(`${topDiv.pair} has ${Math.abs(topDiv.divergencePercent!).toFixed(2)}% spot-perp divergence (${topDiv.direction})`);
  }
  const topGainers = markets.filter(m => m.priceChange24h > 5).slice(0, 3);
  for (const gainer of topGainers) {
    opportunities.push(`${gainer.pair} up ${gainer.priceChange24h}% with $${(gainer.volume24h / 1000).toFixed(0)}K volume`);
  }

  return successResult({
    marketOverview: {
      totalSpotPairs: spotMeta.universe.length,
      activePairs: markets.length,
      totalVolume24h: totalVolume,
      totalVolume24hFormatted: `$${(totalVolume / 1_000_000).toFixed(2)}M`,
      activeTokens: spotMeta.tokens.length,
    },
    topMarketsByVolume: markets.slice(0, 15),
    spotPerpDivergences: divergences,
    liquidityAnalysis: markets.slice(0, 10).map(m => ({
      pair: m.pair,
      volume24h: m.volume24h,
      volumeCategory: m.volume24h > 1_000_000 ? "high" : m.volume24h > 100_000 ? "medium" : "low",
    })),
    opportunities,
    confidence: markets.length > 0 ? 0.85 : 0.5,
    dataSources: ["spotMetaAndAssetCtxs", "metaAndAssetCtxs"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeWhaleWallet(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const address = args?.address as string;
  if (!address) return errorResult("address parameter is required");

  // Fetch all wallet data in parallel
  const [state, orders, spotBalances] = await Promise.all([
    fetchClearinghouseState(address),
    fetchOpenOrders(address),
    fetchSpotClearinghouseState(address).catch(() => ({ balances: [] })),
  ]);

  // Parse positions
  const positions = state.assetPositions.map(ap => {
    const size = Number(ap.position.szi);
    const entryPx = Number(ap.position.entryPx);
    const posValue = Number(ap.position.positionValue);
    const markPx = size !== 0 ? posValue / Math.abs(size) : 0;

    return {
      coin: ap.position.coin,
      direction: size > 0 ? "LONG" : "SHORT",
      size: Math.abs(size),
      entryPrice: entryPx,
      markPrice: markPx,
      positionValue: posValue,
      unrealizedPnl: Number(ap.position.unrealizedPnl),
      unrealizedPnlPercent: Number(ap.position.marginUsed) > 0
        ? (Number(ap.position.unrealizedPnl) / Number(ap.position.marginUsed)) * 100
        : 0,
      leverage: ap.position.leverage.value,
      leverageType: ap.position.leverage.type,
      marginUsed: Number(ap.position.marginUsed),
      liquidationPrice: Number(ap.position.liquidationPx),
      maxLeverage: ap.position.maxLeverage,
    };
  });

  // Calculate directional bias
  let longExposure = 0, shortExposure = 0;
  for (const pos of positions) {
    if (pos.direction === "LONG") longExposure += pos.positionValue;
    else shortExposure += pos.positionValue;
  }
  const netExposure = longExposure - shortExposure;
  const totalExposure = longExposure + shortExposure;

  let bias: "strongly_long" | "long" | "neutral" | "short" | "strongly_short";
  const biasRatio = totalExposure > 0 ? netExposure / totalExposure : 0;
  if (biasRatio > 0.7) bias = "strongly_long";
  else if (biasRatio > 0.3) bias = "long";
  else if (biasRatio < -0.7) bias = "strongly_short";
  else if (biasRatio < -0.3) bias = "short";
  else bias = "neutral";

  // Parse orders
  let pendingBuyNotional = 0, pendingSellNotional = 0;
  for (const order of orders) {
    const notional = Number(order.sz) * Number(order.limitPx);
    if (order.side === "B") pendingBuyNotional += notional;
    else pendingSellNotional += notional;
  }

  // Risk assessment
  const accountValue = Number(state.marginSummary.accountValue);
  const totalMarginUsed = Number(state.marginSummary.totalMarginUsed);
  const marginUtilization = accountValue > 0 ? (totalMarginUsed / accountValue) * 100 : 0;
  const totalUnrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // Determine leverage risk
  const maxLeverage = Math.max(...positions.map(p => p.leverage), 0);
  let leverageRisk: "low" | "medium" | "high" | "extreme";
  if (maxLeverage > 25) leverageRisk = "extreme";
  else if (maxLeverage > 15) leverageRisk = "high";
  else if (maxLeverage > 5) leverageRisk = "medium";
  else leverageRisk = "low";

  // Concentration risk
  const topPosition = positions.sort((a, b) => b.positionValue - a.positionValue)[0];
  const concentrationPercent = topPosition && totalExposure > 0
    ? (topPosition.positionValue / totalExposure) * 100
    : 0;
  const concentrationRisk = concentrationPercent > 80
    ? `High - ${concentrationPercent.toFixed(0)}% in ${topPosition?.coin}`
    : concentrationPercent > 50
      ? `Medium - ${concentrationPercent.toFixed(0)}% in ${topPosition?.coin}`
      : "Low - well diversified";

  // Liquidation risk assessment
  let liquidationRisk = "Low";
  const nearLiquidation = positions.filter(p => {
    const distToLiq = p.direction === "LONG"
      ? ((p.markPrice - p.liquidationPrice) / p.markPrice) * 100
      : ((p.liquidationPrice - p.markPrice) / p.markPrice) * 100;
    return distToLiq < 10;
  });
  if (nearLiquidation.length > 0) liquidationRisk = `High - ${nearLiquidation.length} position(s) within 10% of liquidation`;
  else if (marginUtilization > 80) liquidationRisk = "Medium - high margin utilization";

  // Generate insights
  const insights: string[] = [];
  if (totalExposure > 1_000_000) insights.push(`Large trader with $${(totalExposure / 1_000_000).toFixed(2)}M total exposure`);
  if (bias !== "neutral") insights.push(`Directional bias: ${bias.replace("_", " ")}`);
  if (maxLeverage > 10) insights.push(`Using up to ${maxLeverage}x leverage`);
  if (orders.length > 0) insights.push(`${orders.length} open orders worth $${((pendingBuyNotional + pendingSellNotional) / 1000).toFixed(0)}K pending`);
  if (spotBalances.balances.length > 0) {
    const spotTotal = spotBalances.balances.reduce((sum, b) => sum + Number(b.entryNtl), 0);
    if (spotTotal > 10000) insights.push(`Also holds $${(spotTotal / 1000).toFixed(0)}K in spot tokens`);
  }

  return successResult({
    address,
    accountSummary: {
      totalAccountValue: accountValue,
      totalPositionValue: totalExposure,
      marginUtilization: Number(marginUtilization.toFixed(2)),
      unrealizedPnL: Number(totalUnrealizedPnl.toFixed(2)),
      withdrawable: Number(state.withdrawable),
    },
    positions: positions.sort((a, b) => b.positionValue - a.positionValue),
    directionalBias: {
      netLongExposure: longExposure,
      netShortExposure: shortExposure,
      netExposure,
      bias,
      biasRatio: Number(biasRatio.toFixed(2)),
    },
    openOrders: {
      orderCount: orders.length,
      pendingBuyNotional,
      pendingSellNotional,
      netPendingNotional: pendingBuyNotional - pendingSellNotional,
    },
    spotHoldings: spotBalances.balances.map(b => ({
      token: b.coin,
      total: Number(b.total),
      hold: Number(b.hold),
    })),
    riskAssessment: {
      leverageRisk,
      maxLeverageUsed: maxLeverage,
      concentrationRisk,
      liquidationRisk,
      marginUtilization: `${marginUtilization.toFixed(1)}%`,
    },
    insights,
    confidence: positions.length > 0 ? 0.9 : 0.7,
    dataSources: ["clearinghouseState", "frontendOpenOrders", "spotClearinghouseState"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeMyPositions(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const portfolio = args?.portfolio as HyperliquidContext | undefined;
  const focusCoin = args?.focus_coin as string | undefined;

  if (!portfolio || !portfolio.perpPositions) {
    return errorResult(
      "Portfolio context is required. The Context app should inject this automatically."
    );
  }

  const { perpPositions, accountSummary, walletAddress } = portfolio;

  // Check if user has vault equity (for advisory note)
  let vaultExposureNote: string | null = null;
  try {
    const vaultEquities = await fetchUserVaultEquities(walletAddress);
    if (vaultEquities && vaultEquities.length > 0) {
      const totalVaultEquity = vaultEquities.reduce((sum, v) => sum + Number(v.equity), 0);
      if (totalVaultEquity > 0) {
        vaultExposureNote = `📊 Note: You also have $${totalVaultEquity.toFixed(2)} in ${vaultEquities.length} vault(s). ` +
          `Use 'analyze_vault_exposure' to see your vault positions, or 'analyze_full_portfolio' for complete exposure.`;
      }
    }
  } catch {
    // Silently ignore - vault check is advisory only
  }

  if (perpPositions.length === 0) {
    return successResult({
      walletAddress,
      totalPositions: 0,
      portfolioSummary: {
        accountValue: accountSummary.accountValue,
        totalUnrealizedPnL: 0,
        totalMarginUsed: 0,
        marginUtilization: 0,
        atRiskPositions: 0,
      },
      positionAnalyses: [],
      vaultExposureNote: vaultExposureNote || "No vault exposure detected.",
      overallRecommendation: vaultExposureNote 
        ? "You have no direct trading positions, but you have vault exposure. Use 'analyze_vault_exposure' to see your vault positions."
        : "You have no active Hyperliquid positions to analyze.",
      confidence: 1.0,
      dataSources: ["portfolio context (injected)", "userVaultEquities"],
      dataFreshness: "real-time" as const,
      fetchedAt: new Date().toISOString(),
    });
  }

  // Filter to focus coin if specified
  const positionsToAnalyze = focusCoin
    ? perpPositions.filter((p) => p.coin.toUpperCase() === focusCoin.toUpperCase())
    : perpPositions;

  const positionAnalyses: Array<{
    coin: string;
    direction: "LONG" | "SHORT";
    size: number;
    entryPrice: number;
    currentPrice: number;
    unrealizedPnL: number;
    unrealizedPnLPercent: number;
    leverage: number;
    liquidationPrice: number;
    distanceToLiquidation: number;
    riskLevel: "low" | "medium" | "high" | "critical";
    recommendation: string;
  }> = [];

  let totalUnrealizedPnL = 0;
  let atRiskPositions = 0;

  for (const position of positionsToAnalyze) {
    const direction: "LONG" | "SHORT" = position.size > 0 ? "LONG" : "SHORT";
    const absSize = Math.abs(position.size);

    // Calculate distance to liquidation
    let distanceToLiquidation: number;
    if (direction === "LONG") {
      distanceToLiquidation = position.markPrice
        ? ((position.markPrice - position.liquidationPrice) / position.markPrice) * 100
        : 0;
    } else {
      distanceToLiquidation = position.markPrice
        ? ((position.liquidationPrice - position.markPrice) / position.markPrice) * 100
        : 0;
    }

    // Determine risk level
    let riskLevel: "low" | "medium" | "high" | "critical";
    if (distanceToLiquidation < 5) {
      riskLevel = "critical";
      atRiskPositions++;
    } else if (distanceToLiquidation < 15) {
      riskLevel = "high";
      atRiskPositions++;
    } else if (distanceToLiquidation < 30) {
      riskLevel = "medium";
    } else {
      riskLevel = "low";
    }

    // Calculate PnL percentage
    const unrealizedPnLPercent =
      position.marginUsed > 0 ? (position.unrealizedPnl / position.marginUsed) * 100 : 0;

    totalUnrealizedPnL += position.unrealizedPnl;

    // Generate recommendation
    const recommendation = generatePositionRecommendation({
      direction,
      unrealizedPnLPercent,
      riskLevel,
      distanceToLiquidation,
      leverage: position.leverage.value,
    });

    positionAnalyses.push({
      coin: position.coin,
      direction,
      size: absSize,
      entryPrice: position.entryPrice,
      currentPrice: position.markPrice || position.entryPrice,
      unrealizedPnL: Number(position.unrealizedPnl.toFixed(2)),
      unrealizedPnLPercent: Number(unrealizedPnLPercent.toFixed(2)),
      leverage: position.leverage.value,
      liquidationPrice: position.liquidationPrice,
      distanceToLiquidation: Number(distanceToLiquidation.toFixed(2)),
      riskLevel,
      recommendation,
    });
  }

  // Calculate margin utilization
  const marginUtilization =
    accountSummary.accountValue > 0
      ? (accountSummary.totalMarginUsed / accountSummary.accountValue) * 100
      : 0;

  // Generate overall recommendation
  const overallRecommendation = generateOverallRecommendation({
    totalPositions: positionAnalyses.length,
    totalUnrealizedPnL,
    marginUtilization,
    atRiskPositions,
    accountValue: accountSummary.accountValue,
  });

  // Calculate confidence based on position data quality
  const confidence = positionAnalyses.length > 0 ? 0.9 : 0.5;

  return successResult({
    walletAddress,
    totalPositions: positionAnalyses.length,
    portfolioSummary: {
      accountValue: Number(accountSummary.accountValue.toFixed(2)),
      totalUnrealizedPnL: Number(totalUnrealizedPnL.toFixed(2)),
      totalMarginUsed: Number(accountSummary.totalMarginUsed.toFixed(2)),
      marginUtilization: Number(marginUtilization.toFixed(2)),
      atRiskPositions,
    },
    positionAnalyses,
    vaultExposureNote: vaultExposureNote || null,
    overallRecommendation,
    confidence,
    dataSources: ["portfolio context (injected)", "userVaultEquities"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// NEW TIER 1 HANDLERS - Vault & Full Portfolio Analysis
// ============================================================================

async function handleAnalyzeVaultExposure(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  // Get address from args or portfolio context
  let address = args?.address as string | undefined;
  if (!address) {
    const portfolio = args?.portfolio as { walletAddress?: string } | undefined;
    address = portfolio?.walletAddress;
  }
  if (!address) return errorResult("address or portfolio.walletAddress is required");

  // Fetch vault equities for this user
  const vaultEquities = await fetchUserVaultEquities(address);
  
  if (!vaultEquities || vaultEquities.length === 0) {
    return successResult({
      walletAddress: address,
      vaultSummary: {
        totalVaultEquity: 0,
        vaultCount: 0,
      },
      vaults: [],
      aggregatedExposure: {
        byCoin: [],
        netLongExposure: 0,
        netShortExposure: 0,
        bias: "neutral (no vault positions)",
      },
      insights: ["No vault positions detected. Your exposure is limited to direct trading positions."],
      confidence: 1.0,
      dataSources: ["userVaultEquities"],
      dataFreshness: "real-time" as const,
      fetchedAt: new Date().toISOString(),
    });
  }

  const vaultAnalyses: Array<{
    vaultAddress: string;
    vaultName: string;
    userEquity: number;
    ownershipPercent: number;
    vaultTotalEquity: number;
    apr: number;
    lockupUntil: string | null;
    shadowPositions: Array<{
      coin: string;
      direction: "LONG" | "SHORT";
      effectiveSize: number;
      effectiveNotional: number;
      vaultFullSize: number;
    }>;
  }> = [];

  // Aggregate exposure across all vaults by coin
  const coinExposure: Record<string, { long: number; short: number }> = {};
  const insights: string[] = [];

  // Fetch details and positions for each vault
  for (const vault of vaultEquities) {
    const userEquity = Number(vault.equity);
    if (userEquity <= 0) continue;

    // Fetch vault details and clearinghouse state in parallel
    const [vaultDetails, vaultState] = await Promise.all([
      fetchVaultDetails(vault.vaultAddress).catch(() => null),
      fetchClearinghouseState(vault.vaultAddress).catch(() => null),
    ]);

    const vaultName = vaultDetails?.name || "Unknown Vault";
    const vaultTotalEquity = Number(vaultState?.marginSummary?.accountValue || 0);
    const ownershipPercent = vaultTotalEquity > 0 ? (userEquity / vaultTotalEquity) * 100 : 0;
    const apr = vaultDetails?.apr || 0;

    // Find user's lockup info from followers
    let lockupUntil: string | null = null;
    if (vaultDetails?.followers) {
      const userFollower = vaultDetails.followers.find(
        f => f.user.toLowerCase() === address!.toLowerCase()
      );
      if (userFollower) {
        lockupUntil = new Date(userFollower.lockupUntil).toISOString();
      }
    }

    // Calculate shadow positions
    const shadowPositions: typeof vaultAnalyses[0]["shadowPositions"] = [];
    
    if (vaultState?.assetPositions) {
      for (const ap of vaultState.assetPositions) {
        const fullSize = Number(ap.position.szi);
        if (fullSize === 0) continue;

        const direction: "LONG" | "SHORT" = fullSize > 0 ? "LONG" : "SHORT";
        const effectiveSize = Math.abs(fullSize) * (ownershipPercent / 100);
        const markPrice = Number(ap.position.positionValue) / Math.abs(fullSize);
        const effectiveNotional = effectiveSize * markPrice;

        shadowPositions.push({
          coin: ap.position.coin,
          direction,
          effectiveSize: Number(effectiveSize.toFixed(6)),
          effectiveNotional: Number(effectiveNotional.toFixed(2)),
          vaultFullSize: Math.abs(fullSize),
        });

        // Aggregate by coin
        if (!coinExposure[ap.position.coin]) {
          coinExposure[ap.position.coin] = { long: 0, short: 0 };
        }
        if (direction === "LONG") {
          coinExposure[ap.position.coin].long += effectiveNotional;
        } else {
          coinExposure[ap.position.coin].short += effectiveNotional;
        }
      }
    }

    vaultAnalyses.push({
      vaultAddress: vault.vaultAddress,
      vaultName,
      userEquity,
      ownershipPercent: Number(ownershipPercent.toFixed(4)),
      vaultTotalEquity,
      apr: Number((apr * 100).toFixed(2)),
      lockupUntil,
      shadowPositions,
    });
  }

  // Calculate aggregated exposure
  const byCoin = Object.entries(coinExposure).map(([coin, exp]) => ({
    coin,
    longExposure: Number(exp.long.toFixed(2)),
    shortExposure: Number(exp.short.toFixed(2)),
    netExposure: Number((exp.long - exp.short).toFixed(2)),
    bias: exp.long > exp.short * 1.2 ? "LONG" : exp.short > exp.long * 1.2 ? "SHORT" : "NEUTRAL",
  })).sort((a, b) => Math.abs(b.netExposure) - Math.abs(a.netExposure));

  const netLongExposure = byCoin.reduce((sum, c) => sum + Math.max(0, c.netExposure), 0);
  const netShortExposure = byCoin.reduce((sum, c) => sum + Math.abs(Math.min(0, c.netExposure)), 0);
  const totalExposure = netLongExposure + netShortExposure;
  
  let bias: string;
  if (totalExposure === 0) bias = "neutral (no positions)";
  else if (netLongExposure > netShortExposure * 1.5) bias = "strongly_long";
  else if (netLongExposure > netShortExposure * 1.1) bias = "long";
  else if (netShortExposure > netLongExposure * 1.5) bias = "strongly_short";
  else if (netShortExposure > netLongExposure * 1.1) bias = "short";
  else bias = "neutral";

  // Generate insights
  const totalVaultEquity = vaultAnalyses.reduce((sum, v) => sum + v.userEquity, 0);
  insights.push(`Total vault equity: $${totalVaultEquity.toFixed(2)} across ${vaultAnalyses.length} vault(s)`);
  
  if (byCoin.length > 0) {
    const topExposure = byCoin[0];
    insights.push(`Largest vault exposure: ${topExposure.coin} (${topExposure.bias}, $${Math.abs(topExposure.netExposure).toFixed(0)} net)`);
  }

  const hlpVault = vaultAnalyses.find(v => v.vaultName === "HLP" || v.vaultAddress === HLP_VAULT_ADDRESS);
  if (hlpVault) {
    insights.push(`HLP exposure: $${hlpVault.userEquity.toFixed(2)} (${hlpVault.ownershipPercent.toFixed(4)}% ownership, APR: ${hlpVault.apr}%)`);
  }

  return successResult({
    walletAddress: address,
    vaultSummary: {
      totalVaultEquity,
      vaultCount: vaultAnalyses.length,
    },
    vaults: vaultAnalyses,
    aggregatedExposure: {
      byCoin,
      netLongExposure: Number(netLongExposure.toFixed(2)),
      netShortExposure: Number(netShortExposure.toFixed(2)),
      bias,
    },
    insights,
    confidence: vaultAnalyses.length > 0 ? 0.85 : 1.0,
    dataSources: ["userVaultEquities", "vaultDetails", "clearinghouseState"],
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeFullPortfolio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  // Get address from args or portfolio context
  let address = args?.address as string | undefined;
  const portfolio = args?.portfolio as HyperliquidContext | undefined;
  if (!address && portfolio) {
    address = portfolio.walletAddress;
  }
  if (!address) return errorResult("address or portfolio.walletAddress is required");

  // Fetch all data sources in parallel
  const [userState, vaultEquities, subAccounts, spotBalances, spotData] = await Promise.all([
    fetchClearinghouseState(address),
    fetchUserVaultEquities(address).catch(() => []),
    fetchSubAccounts(address).catch(() => null),
    fetchSpotClearinghouseState(address).catch(() => ({ balances: [] })),
    fetchSpotMetaAndAssetCtxs().catch(() => [{ tokens: [], universe: [] }, []] as SpotMetaAndAssetCtxsResponse),
  ]);

  const insights: string[] = [];
  const dataSources: string[] = ["clearinghouseState"];

  // Build spot price lookup for valuing spot holdings
  const [spotMeta, spotCtxs] = spotData;
  const tokenPrices: Record<number, number> = { 0: 1 }; // USDC = $1
  for (let i = 0; i < spotMeta.universe.length; i++) {
    const pair = spotMeta.universe[i];
    const ctx = spotCtxs[i];
    if (ctx && pair.tokens[0] !== 0) {
      const price = Number(ctx.markPx || ctx.midPx || 0);
      if (price > 0) tokenPrices[pair.tokens[0]] = price;
    }
  }

  // 1. DIRECT POSITIONS (Main Account)
  const directPositions = userState.assetPositions.map(ap => {
    const size = Number(ap.position.szi);
    const posValue = Number(ap.position.positionValue);
    return {
      coin: ap.position.coin,
      direction: size > 0 ? "LONG" as const : "SHORT" as const,
      size: Math.abs(size),
      positionValue: posValue,
      unrealizedPnl: Number(ap.position.unrealizedPnl),
      leverage: ap.position.leverage.value,
      source: "main_account" as const,
    };
  });

  const directTotalValue = Number(userState.marginSummary.accountValue);
  const directUnrealizedPnl = directPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);

  // 2. VAULT EXPOSURE
  let vaultTotalEquity = 0;
  const vaultShadowPositions: Array<{
    coin: string;
    direction: "LONG" | "SHORT";
    effectiveSize: number;
    effectiveNotional: number;
    source: string;
  }> = [];
  const vaultDetails: Array<{
    name: string;
    address: string;
    userEquity: number;
    ownershipPercent: number;
  }> = [];

  if (vaultEquities.length > 0) {
    dataSources.push("userVaultEquities", "vaultDetails");

    for (const vault of vaultEquities) {
      const userEquity = Number(vault.equity);
      if (userEquity <= 0) continue;
      vaultTotalEquity += userEquity;

      // Fetch vault state to get positions
      const [vd, vs] = await Promise.all([
        fetchVaultDetails(vault.vaultAddress).catch(() => null),
        fetchClearinghouseState(vault.vaultAddress).catch(() => null),
      ]);

      const vaultName = vd?.name || "Unknown Vault";
      const vaultAccountValue = Number(vs?.marginSummary?.accountValue || 0);
      const ownershipPercent = vaultAccountValue > 0 ? (userEquity / vaultAccountValue) * 100 : 0;

      vaultDetails.push({
        name: vaultName,
        address: vault.vaultAddress,
        userEquity,
        ownershipPercent: Number(ownershipPercent.toFixed(4)),
      });

      // Calculate shadow positions
      if (vs?.assetPositions) {
        for (const ap of vs.assetPositions) {
          const fullSize = Number(ap.position.szi);
          if (fullSize === 0) continue;

          const direction: "LONG" | "SHORT" = fullSize > 0 ? "LONG" : "SHORT";
          const effectiveSize = Math.abs(fullSize) * (ownershipPercent / 100);
          const markPrice = Math.abs(Number(ap.position.positionValue) / fullSize);

          vaultShadowPositions.push({
            coin: ap.position.coin,
            direction,
            effectiveSize: Number(effectiveSize.toFixed(6)),
            effectiveNotional: Number((effectiveSize * markPrice).toFixed(2)),
            source: `vault:${vaultName}`,
          });
        }
      }
    }
  }

  // 3. SUB-ACCOUNT POSITIONS
  let subAccountsTotalValue = 0;
  const subAccountDetails: Array<{
    name: string;
    address: string;
    accountValue: number;
    positions: Array<{ coin: string; direction: string; size: number; positionValue: number }>;
  }> = [];

  if (subAccounts && subAccounts.length > 0) {
    dataSources.push("subAccounts");

    for (const sa of subAccounts) {
      const saValue = Number(sa.clearinghouseState.marginSummary.accountValue);
      subAccountsTotalValue += saValue;

      const positions = sa.clearinghouseState.assetPositions.map(ap => ({
        coin: ap.position.coin,
        direction: Number(ap.position.szi) > 0 ? "LONG" : "SHORT",
        size: Math.abs(Number(ap.position.szi)),
        positionValue: Number(ap.position.positionValue),
      }));

      subAccountDetails.push({
        name: sa.name,
        address: sa.subAccountUser,
        accountValue: saValue,
        positions,
      });
    }
  }

  // 4. AGGREGATE EXPOSURE BY COIN (across all sources)
  const coinExposure: Record<string, { long: number; short: number; sources: string[] }> = {};

  // Add direct positions
  for (const pos of directPositions) {
    if (!coinExposure[pos.coin]) coinExposure[pos.coin] = { long: 0, short: 0, sources: [] };
    if (pos.direction === "LONG") coinExposure[pos.coin].long += pos.positionValue;
    else coinExposure[pos.coin].short += pos.positionValue;
    if (!coinExposure[pos.coin].sources.includes("main_account")) {
      coinExposure[pos.coin].sources.push("main_account");
    }
  }

  // Add vault shadow positions
  for (const pos of vaultShadowPositions) {
    if (!coinExposure[pos.coin]) coinExposure[pos.coin] = { long: 0, short: 0, sources: [] };
    if (pos.direction === "LONG") coinExposure[pos.coin].long += pos.effectiveNotional;
    else coinExposure[pos.coin].short += pos.effectiveNotional;
    if (!coinExposure[pos.coin].sources.includes(pos.source)) {
      coinExposure[pos.coin].sources.push(pos.source);
    }
  }

  // Add sub-account positions
  for (const sa of subAccountDetails) {
    for (const pos of sa.positions) {
      if (!coinExposure[pos.coin]) coinExposure[pos.coin] = { long: 0, short: 0, sources: [] };
      if (pos.direction === "LONG") coinExposure[pos.coin].long += pos.positionValue;
      else coinExposure[pos.coin].short += pos.positionValue;
      const source = `sub:${sa.name}`;
      if (!coinExposure[pos.coin].sources.includes(source)) {
        coinExposure[pos.coin].sources.push(source);
      }
    }
  }

  const aggregatedByCoin = Object.entries(coinExposure).map(([coin, exp]) => ({
    coin,
    totalLong: Number(exp.long.toFixed(2)),
    totalShort: Number(exp.short.toFixed(2)),
    netExposure: Number((exp.long - exp.short).toFixed(2)),
    sources: exp.sources,
  })).sort((a, b) => Math.abs(b.netExposure) - Math.abs(a.netExposure));

  const totalLongExposure = aggregatedByCoin.reduce((sum, c) => sum + Math.max(0, c.netExposure), 0);
  const totalShortExposure = aggregatedByCoin.reduce((sum, c) => sum + Math.abs(Math.min(0, c.netExposure)), 0);

  // Determine directional bias
  let directionalBias: string;
  const totalNet = totalLongExposure - totalShortExposure;
  const totalGross = totalLongExposure + totalShortExposure;
  if (totalGross === 0) directionalBias = "no exposure";
  else if (totalNet / totalGross > 0.5) directionalBias = "strongly_long";
  else if (totalNet / totalGross > 0.2) directionalBias = "long";
  else if (totalNet / totalGross < -0.5) directionalBias = "strongly_short";
  else if (totalNet / totalGross < -0.2) directionalBias = "short";
  else directionalBias = "neutral";

  // 5. RISK SUMMARY
  const positionsAtRisk = directPositions.filter(p => {
    // Simple heuristic - high leverage = higher risk
    return p.leverage > 15;
  }).length;

  const highLeveragePositions = directPositions.filter(p => p.leverage > 10).length;

  // Concentration risk
  let concentrationRisk = "low";
  if (aggregatedByCoin.length > 0 && totalGross > 0) {
    const topConcentration = Math.abs(aggregatedByCoin[0].netExposure) / totalGross;
    if (topConcentration > 0.8) concentrationRisk = `high - ${(topConcentration * 100).toFixed(0)}% in ${aggregatedByCoin[0].coin}`;
    else if (topConcentration > 0.5) concentrationRisk = `medium - ${(topConcentration * 100).toFixed(0)}% in ${aggregatedByCoin[0].coin}`;
  }

  // 6. SPOT HOLDINGS WITH CURRENT VALUES
  const spotHoldingsWithValue = spotBalances.balances.map(b => {
    const total = Number(b.total);
    const entryNtl = Number(b.entryNtl);
    const currentPrice = tokenPrices[b.token] || 0;
    const currentValue = total * currentPrice;
    const unrealizedPnl = currentPrice > 0 ? currentValue - entryNtl : 0;
    return {
      token: b.coin,
      tokenIndex: b.token,
      total,
      hold: Number(b.hold),
      available: total - Number(b.hold),
      entryNotional: entryNtl,
      currentPrice,
      currentValue: Number(currentValue.toFixed(2)),
      unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
    };
  });
  const spotTotalValue = spotHoldingsWithValue.reduce((sum, b) => sum + b.currentValue, 0);
  const spotTotalPnl = spotHoldingsWithValue.reduce((sum, b) => sum + b.unrealizedPnl, 0);
  
  if (spotBalances.balances.length > 0) {
    dataSources.push("spotClearinghouseState", "spotMetaAndAssetCtxs");
  }

  // 7. GENERATE INSIGHTS
  const totalAccountValue = directTotalValue + vaultTotalEquity + subAccountsTotalValue + spotTotalValue;
  insights.push(`Total portfolio: $${totalAccountValue.toFixed(2)} (Perp: $${directTotalValue.toFixed(2)}, Vaults: $${vaultTotalEquity.toFixed(2)}, Sub-accounts: $${subAccountsTotalValue.toFixed(2)}, Spot: $${spotTotalValue.toFixed(2)})`);

  if (vaultTotalEquity > directTotalValue * 0.5) {
    insights.push(`⚠️ Significant vault exposure (${((vaultTotalEquity / totalAccountValue) * 100).toFixed(0)}% of portfolio) - shadow positions affect your real market exposure`);
  }

  if (spotTotalValue > 1000) {
    const nonUsdcSpot = spotHoldingsWithValue.filter(b => b.token !== "USDC" && b.currentValue > 100);
    if (nonUsdcSpot.length > 0) {
      const topSpot = nonUsdcSpot.sort((a, b) => b.currentValue - a.currentValue)[0];
      insights.push(`Spot holdings: $${spotTotalValue.toFixed(0)} total (largest: ${topSpot.token} worth $${topSpot.currentValue.toFixed(0)}, P&L: ${topSpot.unrealizedPnl >= 0 ? "+" : ""}$${topSpot.unrealizedPnl.toFixed(0)})`);
    }
  }

  if (aggregatedByCoin.length > 0) {
    const topCoin = aggregatedByCoin[0];
    const topDirection = topCoin.netExposure > 0 ? "LONG" : "SHORT";
    insights.push(`Largest perp exposure: ${topCoin.coin} ${topDirection} $${Math.abs(topCoin.netExposure).toFixed(2)} (from: ${topCoin.sources.join(", ")})`);
  }

  if (directionalBias !== "neutral" && directionalBias !== "no exposure") {
    insights.push(`Overall perp bias: ${directionalBias.replace("_", " ").toUpperCase()}`);
  }

  return successResult({
    walletAddress: address,
    portfolioOverview: {
      totalAccountValue: Number(totalAccountValue.toFixed(2)),
      mainAccountValue: Number(directTotalValue.toFixed(2)),
      vaultEquity: Number(vaultTotalEquity.toFixed(2)),
      subAccountsValue: Number(subAccountsTotalValue.toFixed(2)),
      spotValue: Number(spotTotalValue.toFixed(2)),
    },
    directPositions: {
      source: "main_account",
      positions: directPositions,
      totalValue: Number(directTotalValue.toFixed(2)),
      unrealizedPnL: Number(directUnrealizedPnl.toFixed(2)),
    },
    vaultExposure: {
      source: "vaults",
      vaults: vaultDetails,
      totalEquity: Number(vaultTotalEquity.toFixed(2)),
      shadowPositions: vaultShadowPositions,
    },
    subAccountPositions: {
      source: "sub_accounts",
      accounts: subAccountDetails,
      totalValue: Number(subAccountsTotalValue.toFixed(2)),
    },
    spotHoldings: {
      source: "spot",
      balances: spotHoldingsWithValue,
      totalValue: Number(spotTotalValue.toFixed(2)),
      totalUnrealizedPnl: Number(spotTotalPnl.toFixed(2)),
    },
    aggregatedExposure: {
      byCoin: aggregatedByCoin,
      netLongExposure: Number(totalLongExposure.toFixed(2)),
      netShortExposure: Number(totalShortExposure.toFixed(2)),
      directionalBias,
    },
    riskSummary: {
      positionsAtRisk,
      highLeveragePositions,
      concentrationRisk,
    },
    insights,
    confidence: 0.9,
    dataSources,
    dataFreshness: "real-time" as const,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// HANDSHAKE: Place Order (Signature Request)
// ============================================================================

/**
 * EIP-712 domain for Hyperliquid L1 action signing.
 * This is the domain used by signL1Action in the @nktkas/hyperliquid SDK.
 * IMPORTANT: Hyperliquid requires chainId 1337 regardless of actual network!
 * Source: https://nktkas.gitbook.io/hyperliquid/utilities/signing
 */
const HYPERLIQUID_AGENT_DOMAIN = {
  name: "Exchange",
  version: "1",
  chainId: 1337, // Hyperliquid requires chainId 1337 for all L1 actions
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
};

/**
 * EIP-712 types for Hyperliquid L1 action signing (Agent type).
 * Orders use signL1Action which signs an Agent with connectionId = hash of msgpack(action).
 * Source: https://nktkas.gitbook.io/hyperliquid/utilities/signing
 */
const HYPERLIQUID_AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
};

/**
 * Handle place_order tool - returns a signature request for user approval.
 *
 * This demonstrates the Handshake Architecture:
 * 1. Tool receives order parameters
 * 2. Tool validates and prepares the order
 * 3. Tool returns a SignatureRequest in _meta.handshakeAction
 * 4. Context platform intercepts and shows approval UI
 * 5. User signs with their wallet (no private key exposure)
 * 6. Signature is returned to the tool for order submission
 */
// ============================================================================
// PRICE AND SIZE FORMATTING HELPERS (Battle-Tested from Python Implementation)
// ============================================================================

/**
 * Formats a price according to Hyperliquid's rules:
 * - Maximum 5 significant figures
 * - Integer prices always allowed
 * - Truncates (not rounds) to avoid price improvement
 * 
 * Based on the @nktkas/hyperliquid SDK's formatPrice function.
 */
function formatPrice(price: number, szDecimals: number): string {
  // Integer prices are always allowed
  if (Number.isInteger(price)) {
    return price.toString();
  }

  // For perps: max 5 significant figures
  const MAX_SIG_FIGS = 5;
  
  // Convert to string with many decimal places
  const priceStr = price.toPrecision(MAX_SIG_FIGS + 2);
  const priceNum = Number(priceStr);
  
  // Calculate max decimal places: 6 - szDecimals for perps
  // (This follows the formula from Python: MAX_DECIMALS_PRICE - sz_decimals)
  const MAX_DECIMALS_PRICE = 6;
  const maxDecimals = MAX_DECIMALS_PRICE - szDecimals;
  
  // Truncate to max significant figures and decimal places
  const factor = Math.pow(10, maxDecimals);
  const truncated = Math.floor(priceNum * factor) / factor;
  
  // Ensure we don't have too many significant figures
  let result = truncated.toString();
  const parts = result.split(".");
  const intPart = parts[0];
  const decPart = parts[1] || "";
  
  // Count significant figures
  const allDigits = (intPart + decPart).replace(/^0+/, "");
  if (allDigits.length > MAX_SIG_FIGS) {
    // Truncate to 5 significant figures
    result = Number(truncated.toPrecision(MAX_SIG_FIGS)).toString();
  }
  
  return result;
}

/**
 * Formats a size according to Hyperliquid's szDecimals rules.
 * Truncates (not rounds) to avoid accidentally opening larger positions.
 * 
 * Based on the @nktkas/hyperliquid SDK's formatSize function.
 */
function formatSize(size: number, szDecimals: number): string {
  // Truncate to szDecimals decimal places
  const factor = Math.pow(10, szDecimals);
  const truncated = Math.floor(size * factor) / factor;
  
  // Ensure we return the correct number of decimal places
  const result = truncated.toFixed(szDecimals);
  
  // Remove trailing zeros but keep at least one decimal if needed
  return result.replace(/\.?0+$/, "") || "0";
}

/**
 * Gets the best price from the L2 order book.
 * Alternates between maker (limit) and taker (market-ish) prices for better fills.
 */
async function getAdjustedPrice(
  coin: string, 
  side: "BUY" | "SELL", 
  szDecimals: number,
  attemptNumber: number = 0
): Promise<string> {
  const l2Book = await fetchL2Book(coin);
  const bids = l2Book.levels[0];
  const asks = l2Book.levels[1];
  
  if (!bids.length || !asks.length) {
    throw new Error("Order book is empty");
  }
  
  const bestBid = Number(bids[0].px);
  const bestAsk = Number(asks[0].px);
  
  // Alternate between taker (cross the spread) and maker (join the spread)
  const useTakerPrice = attemptNumber % 2 === 0;
  
  let price: number;
  if (side === "BUY") {
    // For buys: taker = best ask, maker = best bid
    price = useTakerPrice ? bestAsk : bestBid;
  } else {
    // For sells: taker = best bid, maker = best ask
    price = useTakerPrice ? bestBid : bestAsk;
  }
  
  return formatPrice(price, szDecimals);
}

// ============================================================================
// SECURITY VERIFICATION HANDLER
// Tests different EIP-712 patterns to verify client-side security detection
// ============================================================================

function handleVerifySignatureSecurity(args: Record<string, unknown> | undefined): CallToolResult {
  const scenario = (args?.scenario as string) ?? "standard_order";
  
  let signatureRequest: Record<string, unknown>;
  
  switch (scenario) {
    case "standard_order":
      // Safe Hyperliquid order pattern - should show BLUE safe banner
      signatureRequest = {
        _action: "signature_request",
        domain: HYPERLIQUID_AGENT_DOMAIN,
        types: HYPERLIQUID_AGENT_TYPES,
        primaryType: "Agent",
        message: {
          source: "a",
          connectionId: "0x" + "a".repeat(64), // Mock hash
        },
        meta: {
          title: "Test Order",
          subtitle: "Buy 0.001 ETH at $3300",
          description: "Standard order signature - client should show BLUE safe banner",
          protocol: "Hyperliquid",
          warningLevel: "info",
        },
      };
      break;

    case "withdrawal_request":
      // Withdrawal pattern - should show RED danger banner
      signatureRequest = {
        _action: "signature_request",
        domain: {
          name: "HyperliquidSignTransaction",
          version: "1",
          chainId: 42161, // Arbitrum - NOT the safe 1337
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        types: {
          HyperliquidWithdraw: [
            { name: "hyperliquidChain", type: "string" },
            { name: "destination", type: "address" },
            { name: "amount", type: "string" },
            { name: "time", type: "uint64" },
          ],
        },
        primaryType: "HyperliquidWithdraw",
        message: {
          hyperliquidChain: "Mainnet",
          destination: "0xEXAMPLE_DESTINATION_ADDRESS",
          amount: "100",
          time: Date.now(),
        },
        meta: {
          title: "Confirm Trade",
          subtitle: "Buy 0.01 ETH at market price",
          description: "This LOOKS like a trade but EIP-712 shows withdrawal - client should show RED danger banner!",
          protocol: "Hyperliquid",
          warningLevel: "info",
        },
      };
      break;
      
    case "transfer_request":
      // Transfer pattern - should show RED danger banner
      signatureRequest = {
        _action: "signature_request",
        domain: {
          name: "SomeProtocol",
          version: "1",
          chainId: 1,
        },
        types: {
          Transfer: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
        primaryType: "Transfer",
        message: {
          to: "0xEXAMPLE_RECIPIENT_ADDRESS",
          amount: "1000000000000000000",
        },
        meta: {
          title: "Approve Trade",
          subtitle: "Standard approval for trading",
          description: "This LOOKS like an approval but is a transfer - client should show RED danger banner!",
          protocol: "Unknown",
          warningLevel: "info",
        },
      };
      break;
      
    default:
      // Unknown pattern - should show YELLOW caution banner
      signatureRequest = {
        _action: "signature_request",
        domain: {
          name: "UnknownProtocol",
          version: "1",
          chainId: 12345,
        },
        types: {
          CustomAction: [
            { name: "data", type: "bytes" },
          ],
        },
        primaryType: "CustomAction",
        message: {
          data: "0x" + "0".repeat(64),
        },
        meta: {
          title: "Quick Action",
          subtitle: "One-click operation",
          description: "Unknown signature type - client should show YELLOW caution banner",
          protocol: "Unknown",
          warningLevel: "info",
        },
      };
  }
  
  const expectedBehavior = {
    standard_order: "BLUE safe banner (Trade Order)",
    withdrawal_request: "RED danger banner + checkbox required + raw payload expanded",
    transfer_request: "RED danger banner + checkbox required + raw payload expanded",
    unknown_action: "YELLOW caution banner",
  }[scenario] ?? "YELLOW caution banner";

  return successResult({
    status: "handshake_required",
    message: `🔒 Security verification for scenario: ${scenario}`,
    scenario,
    expectedClientBehavior: expectedBehavior,
    _meta: {
      handshakeAction: signatureRequest,
    },
  });
}

async function handlePlaceOrder(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  // Extract and validate parameters
  const coin = args?.coin as string;
  const isBuy = args?.isBuy as boolean;
  let size = args?.size as number | undefined;
  const priceArg = args?.price as number | undefined;
  const orderType = (args?.orderType as string) ?? "limit";
  const triggerPrice = args?.triggerPrice as number | undefined;
  let reduceOnly = (args?.reduceOnly as boolean) ?? false;
  const postOnly = (args?.postOnly as boolean) ?? false;
  const closeEntirePosition = (args?.closeEntirePosition as boolean) ?? false;
  const portfolio = args?.portfolio as HyperliquidContext | undefined;

  if (!coin) return errorResult("coin parameter is required");
  if (typeof isBuy !== "boolean") return errorResult("isBuy parameter is required (true/false)");
  
  // Handle closeEntirePosition: auto-calculate size from portfolio
  if (closeEntirePosition) {
    if (!portfolio?.perpPositions?.length) {
      return errorResult("closeEntirePosition=true requires portfolio context with positions. Make sure wallet is connected.");
    }
    
    // Find the position for this coin
    const position = portfolio.perpPositions.find(
      (p) => p.coin?.toUpperCase() === coin.toUpperCase()
    );
    
    if (!position || !position.size) {
      return errorResult(`No open position found for ${coin}. Cannot close non-existent position.`);
    }
    
    // Get absolute size of position
    const positionSize = Math.abs(Number(position.size));
    if (positionSize <= 0) {
      return errorResult(`Position size for ${coin} is zero. Nothing to close.`);
    }
    
    size = positionSize;
    reduceOnly = true; // Closing a position is always reduce-only
    
    console.log(`[place_order] closeEntirePosition=true: Using full position size ${size} for ${coin}`);
  }
  
  if (typeof size !== "number" || size <= 0) return errorResult("size must be a positive number (or use closeEntirePosition=true)");

  // Validate order type
  const validOrderTypes = ["limit", "market", "stop_loss", "take_profit"];
  if (!validOrderTypes.includes(orderType)) {
    return errorResult(`Invalid orderType: ${orderType}. Must be one of: ${validOrderTypes.join(", ")}`);
  }

  // Trigger orders (stop-loss, take-profit) require trigger price and are always reduce-only
  if (orderType === "stop_loss" || orderType === "take_profit") {
    if (typeof triggerPrice !== "number" || triggerPrice <= 0) {
      return errorResult(`triggerPrice is required for ${orderType} orders`);
    }
    reduceOnly = true; // SL/TP are always reduce-only
  }

  // Get asset index and szDecimals from market metadata
  const metaAndCtx = await fetchMetaAndAssetCtxs();
  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const assetInfo = meta.universe.find(
    (m) => m.name.toUpperCase() === coin.toUpperCase()
  );
  const assetIndex = meta.universe.findIndex(
    (m) => m.name.toUpperCase() === coin.toUpperCase()
  );

  if (assetIndex === -1 || !assetInfo) {
    return errorResult(`Unknown coin: ${coin}. Use list_markets to see available markets.`);
  }

  // Get szDecimals for proper formatting (critical for order success!)
  const szDecimals = assetInfo.szDecimals;
  console.log(`[place_order] ${coin} szDecimals: ${szDecimals}, orderType: ${orderType}`);

  // Get current market price
  const assetCtx = ctxs[assetIndex];
  const currentPrice = assetCtx ? Number(assetCtx.markPx) : 0;
  
  if (currentPrice === 0) {
    return errorResult(`Could not get current market price for ${coin}`);
  }

  // Calculate execution price based on order type
  let executionPrice: number;
  const MARKET_SLIPPAGE = 0.01; // 1% slippage for market orders
  
  if (orderType === "market") {
    // Market orders: use IOC with slippage price
    // Buy: 1% above market, Sell: 1% below market
    executionPrice = isBuy 
      ? currentPrice * (1 + MARKET_SLIPPAGE)
      : currentPrice * (1 - MARKET_SLIPPAGE);
    console.log(`[place_order] Market order - using IOC with ${MARKET_SLIPPAGE * 100}% slippage: ${executionPrice}`);
  } else if (orderType === "stop_loss" || orderType === "take_profit") {
    // Trigger orders: use trigger price as execution price
    executionPrice = triggerPrice ?? currentPrice;
  } else {
    // Limit orders: use provided price or current price
    if (typeof priceArg !== "number" || priceArg <= 0) {
      return errorResult("price is required for limit orders");
    }
    executionPrice = priceArg;
  }

  // Format price and size according to Hyperliquid's requirements
  const formattedPrice = formatPrice(executionPrice, szDecimals);
  const formattedSize = formatSize(size, szDecimals);
  const formattedTriggerPrice = triggerPrice ? formatPrice(triggerPrice, szDecimals) : undefined;
  
  console.log(`[place_order] Original: price=${executionPrice}, size=${size}`);
  console.log(`[place_order] Formatted: price=${formattedPrice}, size=${formattedSize}`);

  // Validate formatted size is not zero
  if (Number(formattedSize) === 0) {
    return errorResult(
      `Size ${size} is too small for ${coin} (minimum precision: ${Math.pow(10, -szDecimals)})`
    );
  }

  const notionalValue = Number(formattedSize) * Number(formattedPrice);

  // Validate limit order makes sense (skip for market/trigger orders)
  if (orderType === "limit") {
    if (isBuy && Number(formattedPrice) > currentPrice * 1.5) {
      console.warn(`[place_order] Buy order price ${formattedPrice} is >50% above current price ${currentPrice}`);
    }
    if (!isBuy && Number(formattedPrice) < currentPrice * 0.5) {
      console.warn(`[place_order] Sell order price ${formattedPrice} is >50% below current price ${currentPrice}`);
    }
  }

  // Generate nonce as timestamp in milliseconds (required by Hyperliquid)
  const nonce = Date.now();

  // Build the order type structure based on orderType
  // See: https://nktkas.gitbook.io/hyperliquid/api-reference/exchange-methods/order
  let orderTypeStruct: Record<string, unknown>;
  
  if (orderType === "stop_loss" || orderType === "take_profit") {
    // Trigger orders (stop-loss / take-profit)
    orderTypeStruct = {
      trigger: {
        isMarket: true, // Execute as market when triggered
        triggerPx: formattedTriggerPrice,
        tpsl: orderType === "stop_loss" ? "sl" : "tp",
      },
    };
  } else if (orderType === "market") {
    // Market orders use IOC (Immediate-or-Cancel)
    orderTypeStruct = { limit: { tif: "Ioc" } };
  } else if (postOnly) {
    // Post-only limit orders
    orderTypeStruct = { limit: { tif: "Alo" } };
  } else {
    // Regular limit orders
    orderTypeStruct = { limit: { tif: "Gtc" } };
  }

  // Build the order action in the exact format required by Hyperliquid
  const orderAction = {
    type: "order",
    orders: [
      {
        a: assetIndex,             // asset index
        b: isBuy,                  // isBuy
        p: formattedPrice,         // price as formatted string
        s: formattedSize,          // size as formatted string
        r: reduceOnly,             // reduceOnly
        t: orderTypeStruct,        // order type (limit/trigger)
      },
    ],
    grouping: "na", // no grouping
  };

  // Use @nktkas/hyperliquid SDK to create the correct L1 action hash
  // This hash becomes the connectionId in the Agent EIP-712 message
  const connectionId = createL1ActionHash({
    action: orderAction,
    nonce,
  });

  // Build the Agent EIP-712 message for signing
  // This is the correct format for signL1Action
  const agentMessage = {
    source: "a", // Hyperliquid convention for mainnet
    connectionId,
  };

  // Build human-readable order description based on type
  const orderTypeLabel = {
    limit: "Limit",
    market: "Market",
    stop_loss: "Stop Loss",
    take_profit: "Take Profit",
  }[orderType] || "Limit";
  
  const sideLabel = isBuy ? "Buy" : "Sell";
  const priceDisplay = orderType === "market" 
    ? `~$${Number(formattedPrice).toFixed(2)} (market)` 
    : `$${formattedPrice}`;
  const triggerDisplay = formattedTriggerPrice 
    ? ` @ trigger $${formattedTriggerPrice}` 
    : "";

  // Build the signature request with customizable UI elements
  // Tool developers can set title, subtitle for generic marketplace use
  const signatureRequest = {
    _action: "signature_request" as const,
    domain: HYPERLIQUID_AGENT_DOMAIN,
    types: HYPERLIQUID_AGENT_TYPES,
    primaryType: "Agent",
    message: agentMessage,
    meta: {
      // UI Customization - these appear in the signature card
      title: `${orderTypeLabel} ${sideLabel} Order`,
      subtitle: `${sideLabel} ${formattedSize} ${coin} at ${priceDisplay}${triggerDisplay}`,
      description: `${orderTypeLabel} ${sideLabel.toLowerCase()} order for ${formattedSize} ${coin}`,
      protocol: "Hyperliquid",
      action: `${orderTypeLabel} ${sideLabel}`,
      tokenSymbol: coin,
      tokenAmount: formattedSize,
      warningLevel: notionalValue > 10000 ? "caution" as const : "info" as const,
      // Include the action data needed for submission
      _orderData: {
        action: orderAction,
        nonce,
      },
    },
    callbackToolName: "submit_signed_action",
  };

  // Build order details for response
  const orderDetails = {
    coin,
    orderType,
    side: isBuy ? "buy" : "sell",
    size: formattedSize,
    price: formattedPrice,
    triggerPrice: formattedTriggerPrice,
    notionalValue: Number(notionalValue.toFixed(2)),
    reduceOnly,
    postOnly,
    currentMarketPrice: currentPrice,
    szDecimals,
  };

  const approvalMessage = `Please approve the ${orderTypeLabel.toLowerCase()} ${sideLabel.toLowerCase()} order for ${formattedSize} ${coin}${triggerDisplay}`;

  // Return the handshake response
  // The Context platform will intercept _meta.handshakeAction and show approval UI
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "handshake_required",
          message: approvalMessage,
          orderDetails,
        }, null, 2),
      },
    ],
    structuredContent: {
      status: "handshake_required",
      message: approvalMessage,
      orderDetails,
      // Handshake action in _meta to avoid MCP SDK stripping unknown fields
      _meta: {
        handshakeAction: signatureRequest,
      },
    },
  };
}

/**
 * Handle submit_signed_action - Submit a signed action to Hyperliquid exchange.
 * This is called after the user signs an order request via the handshake flow.
 * 
 * The action and nonce come from meta._orderData in the original signatureRequest.
 */
async function handleSubmitSignedAction(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const signature = args.signature as string;
  // The action comes pre-formatted from place_order via meta._orderData
  const action = args.action as {
    type: "order";
    orders: Array<{
      a: number;
      b: boolean;
      p: string;
      s: string;
      r: boolean;
      t: { limit: { tif: string } };
    }>;
    grouping: string;
  };
  const nonce = args.nonce as number;
  const vaultAddress = args.vaultAddress as string | undefined;

  if (!signature) {
    return errorResult("Missing signature from handshake");
  }

  if (!action) {
    return errorResult("Missing action details from handshake");
  }

  if (!nonce) {
    return errorResult("Missing nonce from handshake");
  }

  // Parse the signature into r, s, v components
  // The signature from MetaMask/wallets is a 65-byte hex string (130 chars + 0x prefix)
  // Format: 0x + r (64 chars) + s (64 chars) + v (2 chars)
  let sigR: string;
  let sigS: string;
  let sigV: number;

  const cleanSig = signature.startsWith("0x") ? signature.slice(2) : signature;
  
  if (cleanSig.length === 130) {
    // Standard signature format: r (32 bytes) + s (32 bytes) + v (1 byte)
    sigR = `0x${cleanSig.slice(0, 64)}`;
    sigS = `0x${cleanSig.slice(64, 128)}`;
    sigV = parseInt(cleanSig.slice(128, 130), 16);
    
    // Normalize v value (27/28 or 0/1)
    if (sigV < 27) {
      sigV += 27;
    }
  } else {
    return errorResult(`Invalid signature length: ${cleanSig.length}, expected 130 hex chars`);
  }

  // Build the exchange API request
  // The action is already properly formatted by place_order using the SDK parser
  const exchangeRequest = {
    action,
    nonce,
    signature: {
      r: sigR,
      s: sigS,
      v: sigV,
    } as HyperliquidSignature,
    vaultAddress: vaultAddress || null,
  };

  try {
    // Submit to Hyperliquid exchange endpoint
    const response = await fetch("https://api.hyperliquid.xyz/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exchangeRequest),
    });

    const responseData = await response.json();

    if (!response.ok) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: `Exchange API error: ${response.status}`,
              error: responseData,
              dataSources: ["https://api.hyperliquid.xyz/exchange"],
              dataFreshness: "real-time",
              fetchedAt: new Date().toISOString(),
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Check for Hyperliquid-specific errors in response
    if (responseData.status === "err") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "error",
              message: responseData.response || "Order rejected by exchange",
              error: responseData,
              dataSources: ["https://api.hyperliquid.xyz/exchange"],
              dataFreshness: "real-time",
              fetchedAt: new Date().toISOString(),
            }, null, 2),
          },
        ],
        isError: true,
      };
    }

    // Extract order details from the action for the response
    const order = action.orders[0];
    
    // Success!
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "success",
            message: "Order submitted successfully to Hyperliquid",
            response: responseData,
            orderDetails: {
              asset: order.a,
              side: order.b ? "buy" : "sell",
              price: order.p,
              size: order.s,
              reduceOnly: order.r,
              orderType: order.t,
            },
            dataSources: ["https://api.hyperliquid.xyz/exchange"],
            dataFreshness: "real-time",
            fetchedAt: new Date().toISOString(),
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to submit order to exchange: ${message}`);
  }
}

function generatePositionRecommendation(params: {
  direction: "LONG" | "SHORT";
  unrealizedPnLPercent: number;
  riskLevel: string;
  distanceToLiquidation: number;
  leverage: number;
}): string {
  const { direction, unrealizedPnLPercent, riskLevel, distanceToLiquidation, leverage } = params;
  const parts: string[] = [];

  // Risk warnings
  if (riskLevel === "critical") {
    parts.push(
      `🚨 CRITICAL: Only ${distanceToLiquidation.toFixed(1)}% from liquidation! Consider adding margin or reducing position.`
    );
  } else if (riskLevel === "high") {
    parts.push(`⚠️ High risk: ${distanceToLiquidation.toFixed(1)}% from liquidation.`);
  }

  // PnL commentary
  if (unrealizedPnLPercent > 50) {
    parts.push(`📈 Strong gains (+${unrealizedPnLPercent.toFixed(1)}%). Consider taking partial profit.`);
  } else if (unrealizedPnLPercent < -30) {
    parts.push(`📉 Significant loss (${unrealizedPnLPercent.toFixed(1)}%). Evaluate if thesis still holds.`);
  }

  // Leverage warning
  if (leverage > 20) {
    parts.push(`High leverage (${leverage}x) increases liquidation risk.`);
  }

  return parts.length > 0 ? parts.join(" ") : `${direction} position within normal parameters.`;
}

function generateOverallRecommendation(params: {
  totalPositions: number;
  totalUnrealizedPnL: number;
  marginUtilization: number;
  atRiskPositions: number;
  accountValue: number;
}): string {
  const { totalUnrealizedPnL, marginUtilization, atRiskPositions, accountValue } = params;
  const parts: string[] = [];

  // Account summary
  const pnlPercent = accountValue > 0 ? (totalUnrealizedPnL / accountValue) * 100 : 0;
  parts.push(
    `Account value: $${accountValue.toFixed(2)}, PnL: ${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%.`
  );

  // Risk warnings
  if (atRiskPositions > 0) {
    parts.push(`🚨 ${atRiskPositions} position(s) at elevated liquidation risk!`);
  }

  // Margin utilization
  if (marginUtilization > 80) {
    parts.push(
      `⚠️ High margin utilization (${marginUtilization.toFixed(1)}%). Limited capacity for new positions.`
    );
  } else if (marginUtilization > 50) {
    parts.push(`Margin utilization: ${marginUtilization.toFixed(1)}%.`);
  }

  return parts.join(" ");
}

// ============================================================================
// API FETCH FUNCTIONS
// ============================================================================

async function hyperliquidPost(body: object): Promise<unknown> {
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Hyperliquid API error (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

function fetchL2Book(coin: string, nSigFigs?: number): Promise<L2BookResponse> {
  const body: Record<string, unknown> = { type: "l2Book", coin };
  if (nSigFigs) body.nSigFigs = nSigFigs;
  return hyperliquidPost(body) as Promise<L2BookResponse>;
}

function fetchMeta(): Promise<MetaResponse> {
  return hyperliquidPost({ type: "meta" }) as Promise<MetaResponse>;
}

function fetchAllMids(): Promise<AllMidsResponse> {
  return hyperliquidPost({ type: "allMids" }) as Promise<AllMidsResponse>;
}

function fetchMetaAndAssetCtxs(): Promise<MetaAndAssetCtxsResponse> {
  return hyperliquidPost({ type: "metaAndAssetCtxs" }) as Promise<MetaAndAssetCtxsResponse>;
}

function fetchRecentTrades(coin: string): Promise<RecentTradesResponse[]> {
  return hyperliquidPost({ type: "recentTrades", coin }) as Promise<RecentTradesResponse[]>;
}

function fetchPredictedFundings(): Promise<[string, unknown[]][]> {
  return hyperliquidPost({ type: "predictedFundings" }) as Promise<[string, unknown[]][]>;
}

function fetchDelegations(user: string): Promise<Array<{ validator: string; amount: string; lockedUntilTimestamp: number }>> {
  return hyperliquidPost({ type: "delegations", user }) as Promise<Array<{ validator: string; amount: string; lockedUntilTimestamp: number }>>;
}

function fetchPerpsAtOiCap(): Promise<string[]> {
  return hyperliquidPost({ type: "perpsAtOpenInterestCap" }) as Promise<string[]>;
}

function fetchCandleSnapshot(coin: string, interval: string, startTime: number, endTime: number): Promise<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>> {
  return hyperliquidPost({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } }) as Promise<Array<{ t: number; o: string; h: string; l: string; c: string; v: string }>>;
}

function fetchVaultDetails(vaultAddress: string): Promise<VaultDetailsResponse | null> {
  return hyperliquidPost({ type: "vaultDetails", vaultAddress, user: null }) as Promise<VaultDetailsResponse | null>;
}

function fetchFundingHistory(coin: string, startTime: number, endTime: number): Promise<FundingHistoryResponse[]> {
  return hyperliquidPost({ type: "fundingHistory", coin, startTime, endTime }) as Promise<FundingHistoryResponse[]>;
}

function fetchSpotMetaAndAssetCtxs(): Promise<SpotMetaAndAssetCtxsResponse> {
  return hyperliquidPost({ type: "spotMetaAndAssetCtxs" }) as Promise<SpotMetaAndAssetCtxsResponse>;
}

function fetchSpotClearinghouseState(user: string): Promise<SpotClearinghouseStateResponse> {
  return hyperliquidPost({ type: "spotClearinghouseState", user }) as Promise<SpotClearinghouseStateResponse>;
}

function fetchClearinghouseState(user: string): Promise<ClearinghouseStateResponse> {
  return hyperliquidPost({ type: "clearinghouseState", user }) as Promise<ClearinghouseStateResponse>;
}

function fetchOpenOrders(user: string): Promise<OpenOrderResponse[]> {
  return hyperliquidPost({ type: "frontendOpenOrders", user }) as Promise<OpenOrderResponse[]>;
}

function fetchOrderStatus(user: string, oid: string | number): Promise<OrderStatusResponse> {
  return hyperliquidPost({ type: "orderStatus", user, oid }) as Promise<OrderStatusResponse>;
}

function fetchUserFills(user: string, aggregateByTime?: boolean, startTime?: number, endTime?: number): Promise<UserFillResponse[]> {
  const body: Record<string, unknown> = { type: "userFills", user };
  if (aggregateByTime !== undefined) body.aggregateByTime = aggregateByTime;
  if (startTime !== undefined) body.startTime = startTime;
  if (endTime !== undefined) body.endTime = endTime;
  return hyperliquidPost(body) as Promise<UserFillResponse[]>;
}

function fetchUserFees(user: string): Promise<UserFeesResponse> {
  return hyperliquidPost({ type: "userFees", user }) as Promise<UserFeesResponse>;
}

function fetchReferralState(user: string): Promise<ReferralStateResponse> {
  return hyperliquidPost({ type: "referral", user }) as Promise<ReferralStateResponse>;
}

function fetchUserPortfolio(user: string): Promise<UserPortfolioResponse> {
  return hyperliquidPost({ type: "portfolio", user }) as Promise<UserPortfolioResponse>;
}

function fetchUserVaultEquities(user: string): Promise<UserVaultEquityResponse[]> {
  return hyperliquidPost({ type: "userVaultEquities", user }) as Promise<UserVaultEquityResponse[]>;
}

function fetchSubAccounts(user: string): Promise<SubAccountResponse[] | null> {
  return hyperliquidPost({ type: "subAccounts", user }) as Promise<SubAccountResponse[] | null>;
}

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

type L2Level = { px: string; sz: string; n: number };
type L2BookResponse = { coin: string; time: number; levels: [L2Level[], L2Level[]] };
type MetaResponse = { universe: Array<{ name: string; szDecimals: number; maxLeverage: number; onlyIsolated?: boolean }> };
type AllMidsResponse = { [coin: string]: string };
type AssetCtx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium?: string; oraclePx?: string; markPx?: string };
type MetaAndAssetCtxsResponse = { 0: MetaResponse; 1: AssetCtx[] };
type RecentTradesResponse = { coin: string; side: string; px: string; sz: string; time: number; hash: string };
type OrderbookLevel = { price: number; size: number; numOrders: number; cumulativeSize: number; cumulativeNotional: number };
type ParsedOrderbook = { coin: string; midPrice: number; spread: number; bids: OrderbookLevel[]; asks: OrderbookLevel[]; totalBidLiquidity: number; totalAskLiquidity: number; fetchedAt: string };
type VaultDetailsResponse = { name: string; vaultAddress: string; leader: string; description: string; portfolio: Array<[string, { accountValueHistory: Array<[number, string]>; pnlHistory: Array<[number, string]>; vlm: string }]>; apr: number; followerState: unknown; leaderFraction: number; leaderCommission: number; followers: Array<{ user: string; vaultEquity: string; pnl: string; allTimePnl: string; daysFollowing: number; vaultEntryTime: number; lockupUntil: number }>; maxDistributable: number; maxWithdrawable: number; isClosed: boolean; allowDeposits: boolean };
type FundingHistoryResponse = { coin: string; fundingRate: string; premium: string; time: number };

// New types for additional endpoints
type SpotToken = { name: string; szDecimals: number; weiDecimals: number; index: number; tokenId: string; isCanonical: boolean; evmContract: string | null; fullName: string | null };
type SpotUniverse = { name: string; tokens: [number, number]; index: number; isCanonical: boolean };
type SpotAssetCtx = { dayNtlVlm: string; markPx: string; midPx: string; prevDayPx: string };
type SpotMetaAndAssetCtxsResponse = [{ tokens: SpotToken[]; universe: SpotUniverse[] }, SpotAssetCtx[]];

type SpotBalance = { coin: string; token: number; total: string; hold: string; entryNtl: string };
type SpotClearinghouseStateResponse = { balances: SpotBalance[] };

type AssetPosition = {
  position: {
    coin: string;
    cumFunding: { allTime: string; sinceChange: string; sinceOpen: string };
    entryPx: string;
    leverage: { rawUsd: string; type: string; value: number };
    liquidationPx: string;
    marginUsed: string;
    maxLeverage: number;
    positionValue: string;
    returnOnEquity: string;
    szi: string;
    unrealizedPnl: string;
  };
  type: string;
};
type ClearinghouseStateResponse = {
  assetPositions: AssetPosition[];
  crossMaintenanceMarginUsed: string;
  crossMarginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string };
  marginSummary: { accountValue: string; totalMarginUsed: string; totalNtlPos: string; totalRawUsd: string };
  time: number;
  withdrawable: string;
};

type OpenOrderResponse = {
  coin: string;
  isPositionTpsl: boolean;
  isTrigger: boolean;
  limitPx: string;
  oid: number;
  orderType: string;
  origSz: string;
  reduceOnly: boolean;
  side: string;
  sz: string;
  timestamp: number;
  triggerCondition: string;
  triggerPx: string;
};

type OrderStatusResponse = { status: string; order?: Record<string, unknown> };

type UserFillResponse = {
  closedPnl: string;
  coin: string;
  crossed: boolean;
  dir: string;
  hash: string;
  oid: number;
  px: string;
  side: string;
  startPosition: string;
  sz: string;
  time: number;
  fee: string;
  feeToken: string;
  builderFee?: string;
  tid: number;
};

type UserFeesResponse = {
  dailyUserVlm: Array<{ date: string; userCross: string; userAdd: string; exchange: string }>;
  feeSchedule: {
    cross: string;
    add: string;
    spotCross: string;
    spotAdd: string;
    tiers: { vip: Array<{ ntlCutoff: string; cross: string; add: string; spotCross: string; spotAdd: string }>; mm: Array<{ makerFractionCutoff: string; add: string }> };
    referralDiscount: string;
    stakingDiscountTiers: Array<{ bpsOfMaxSupply: string; discount: string }>;
  };
  userCrossRate: string;
  userAddRate: string;
  userSpotCrossRate: string;
  userSpotAddRate: string;
  activeReferralDiscount: string;
  trial: unknown;
  feeTrialReward: string;
  nextTrialAvailableTimestamp: number | null;
  stakingLink: { type: string; stakingUser?: string } | null;
  activeStakingDiscount: { bpsOfMaxSupply: string; discount: string } | null;
};

type ReferralStateResponse = Record<string, unknown>;

type UserPortfolioResponse = Array<[string, { accountValueHistory: Array<[number, string]>; pnlHistory: Array<[number, string]>; vlm: string }]>;

type UserVaultEquityResponse = { vaultAddress: string; equity: string };

type SubAccountResponse = {
  name: string;
  subAccountUser: string;
  master: string;
  clearinghouseState: ClearinghouseStateResponse;
  spotState: SpotClearinghouseStateResponse;
};

// ============================================================================
// PARSING FUNCTIONS
// ============================================================================

function parseOrderbook(data: L2BookResponse, coin: string): ParsedOrderbook {
  const [rawBids, rawAsks] = data.levels;

  let cumBidSize = 0, cumBidNotional = 0;
  const bids: OrderbookLevel[] = rawBids.map((level) => {
    const price = Number(level.px);
    const size = Number(level.sz);
    cumBidSize += size;
    cumBidNotional += size * price;
    return { price, size, numOrders: level.n, cumulativeSize: cumBidSize, cumulativeNotional: cumBidNotional };
  });

  let cumAskSize = 0, cumAskNotional = 0;
  const asks: OrderbookLevel[] = rawAsks.map((level) => {
    const price = Number(level.px);
    const size = Number(level.sz);
    cumAskSize += size;
    cumAskNotional += size * price;
    return { price, size, numOrders: level.n, cumulativeSize: cumAskSize, cumulativeNotional: cumAskNotional };
  });

  const bestBid = bids.at(0)?.price ?? 0;
  const bestAsk = asks.at(0)?.price ?? 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const spread = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10_000 : 0;

  return { coin, midPrice, spread: Number(spread.toFixed(2)), bids, asks, totalBidLiquidity: cumBidNotional, totalAskLiquidity: cumAskNotional, fetchedAt: new Date().toISOString() };
}

function calculatePriceImpact(book: ParsedOrderbook, side: "sell" | "buy", size: number): { coin: string; side: string; orderSize: number; orderNotional: number; midPrice: number; averageFillPrice: number; worstFillPrice: number; priceImpactPercent: number; slippageBps: number; filledSize: number; filledPercent: number; remainingSize: number; levelsConsumed: number; canAbsorb: boolean; absorption: string; fetchedAt: string } {
  const levels = side === "sell" ? book.bids : book.asks;
  const midPrice = book.midPrice;

  let remainingSize = size, totalFilled = 0, totalNotional = 0, levelsConsumed = 0, worstPrice = midPrice;

  for (const level of levels) {
    if (remainingSize <= 0) break;
    const fillSize = Math.min(remainingSize, level.size);
    totalFilled += fillSize;
    totalNotional += fillSize * level.price;
    remainingSize -= fillSize;
    levelsConsumed++;
    worstPrice = level.price;
  }

  const avgFillPrice = totalFilled > 0 ? totalNotional / totalFilled : midPrice;
  const priceImpact = ((avgFillPrice - midPrice) / midPrice) * 100;
  const slippageBps = Math.abs(priceImpact) * 100;
  const filledPercent = (totalFilled / size) * 100;
  const canAbsorb = remainingSize <= 0;

  let absorption: string;
  if (!canAbsorb) absorption = "would exhaust visible book";
  else if (slippageBps < 10) absorption = "easily absorbed";
  else if (slippageBps < 50) absorption = "absorbed with minor impact";
  else if (slippageBps < 200) absorption = "absorbed with moderate impact";
  else absorption = "absorbed with significant impact";

  return { coin: book.coin, side, orderSize: size, orderNotional: size * midPrice, midPrice, averageFillPrice: Number(avgFillPrice.toFixed(6)), worstFillPrice: worstPrice, priceImpactPercent: Number(priceImpact.toFixed(4)), slippageBps: Number(slippageBps.toFixed(2)), filledSize: totalFilled, filledPercent: Number(filledPercent.toFixed(2)), remainingSize, levelsConsumed, canAbsorb, absorption, fetchedAt: new Date().toISOString() };
}

function getVolume24h(metaAndCtx: MetaAndAssetCtxsResponse, coin: string): number {
  const meta = metaAndCtx[0];
  const ctxs = metaAndCtx[1];
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) return 0;
  return Number(ctxs[idx].dayNtlVlm || 0);
}

function getIntervalMs(interval: string): number {
  const map: Record<string, number> = { "1m": 60 * 1000, "5m": 5 * 60 * 1000, "15m": 15 * 60 * 1000, "1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000, "1d": 24 * 60 * 60 * 1000, "1w": 7 * 24 * 60 * 60 * 1000 };
  return map[interval] || 60 * 60 * 1000;
}

// ============================================================================
// EXPRESS SERVER (Streamable HTTP Transport - Protocol 2025-11-25)
// ============================================================================

const app = express();
app.use(express.json());

// Session management for Streamable HTTP transport
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Auth middleware using @ctxprotocol/sdk - 1 line!
const verifyContextAuth = createContextMiddleware();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "hyperliquid-ultimate",
    version: "2.3.1",
    protocol: "2025-11-25",
    transport: "streamable-http",
    toolCount: TOOLS.length,
    tools: TOOLS.map((t) => t.name),
    tier1Tools: TOOLS.filter((t) => t.description.includes("🧠 INTELLIGENCE")).map((t) => t.name),
    tier2Tools: TOOLS.filter((t) => !t.description.includes("🧠 INTELLIGENCE")).map((t) => t.name),
    newInV23: ["analyze_vault_exposure", "analyze_full_portfolio"],
    description: "The world's most comprehensive Hyperliquid MCP server",
  });
});

// Streamable HTTP endpoint - handles all MCP communication
app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    // Reuse existing session
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    // New session initialization
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      },
    });

    // Clean up on transport close
    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    // Connect the MCP server to this transport
    await server.connect(transport);
  } else {
    // Invalid request - no session and not an initialize request
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize request first." },
      id: null,
    });
    return;
  }

  // Handle the request
  await transport.handleRequest(req, res, req.body);
});

// Handle GET requests for SSE streaming (optional, for notifications)
app.get("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

// Handle DELETE requests for session cleanup
app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

// Backwards compatibility: SSE endpoint (deprecated, redirects to /mcp)
app.get("/sse", (_req: Request, res: Response) => {
  res.status(410).json({
    error: "SSE transport deprecated",
    message: "Please use the Streamable HTTP transport at /mcp instead",
    migration: {
      oldEndpoint: "GET /sse + POST /messages?sessionId=xxx",
      newEndpoint: "POST /mcp with mcp-session-id header",
      protocol: "2025-11-25",
    },
  });
});

const port = Number(process.env.PORT || 4002);
app.listen(port, () => {
  const tier1 = TOOLS.filter((t) => t.description.includes("🧠 INTELLIGENCE"));
  const tier2 = TOOLS.filter((t) => !t.description.includes("🧠 INTELLIGENCE"));
  
  console.log("\n🚀 Hyperliquid Ultimate MCP Server v2.3.0");
  console.log(`   The world's most comprehensive Hyperliquid MCP`);
  console.log(`   ${TOOLS.length} tools (${tier1.length} intelligence + ${tier2.length} raw data)\n`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`🔄 Protocol: Streamable HTTP (2025-11-25)\n`);
  console.log(`✨ NEW in v2.3.0: Vault Exposure Analysis`);
  console.log(`   • analyze_vault_exposure - See your shadow positions in vaults`);
  console.log(`   • analyze_full_portfolio - Complete exposure across all sources\n`);
  console.log(`🧠 TIER 1 - INTELLIGENCE TOOLS (${tier1.length}):`);
  tier1.forEach((tool) => {
    console.log(`   • ${tool.name}`);
  });
  console.log(`\n📊 TIER 2 - RAW DATA TOOLS (${tier2.length}):`);
  tier2.forEach((tool) => {
    console.log(`   • ${tool.name}`);
  });
  console.log("");
});
