/**
 * Coinglass MCP Server v1.0.0
 * 
 * Comprehensive crypto derivatives intelligence from Coinglass API.
 * 
 * TIER 1: INTELLIGENCE LAYER (8 tools)
 * - calculate_squeeze_probability - Predict short/long squeezes
 * - analyze_market_sentiment - Cross-market sentiment analysis
 * - find_funding_arbitrage - Best funding rate opportunities
 * - get_btc_valuation_score - Multi-indicator BTC valuation
 * - detect_liquidation_risk - Liquidation cascade prediction
 * - analyze_smart_money - Top trader vs retail positioning
 * - scan_volume_anomalies - Unusual volume detection
 * - get_market_overview - Complete derivatives dashboard
 * 
 * TIER 2: RAW DATA LAYER (35+ tools)
 * Full access to Coinglass API endpoints
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";

const COINGLASS_API = "https://open-api-v4.coinglass.com";
const API_KEY = process.env.COINGLASS_API_KEY || "";

// Top coins for scans
const TOP_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "DOT"];

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER
  // ============================================================================
  {
    name: "calculate_squeeze_probability",
    description: "🧠 INTELLIGENCE: Calculate short/long squeeze probability by analyzing funding rates, OI, liquidations, and long/short ratios. Identifies coins PRIMED for explosive moves.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Coin symbol (e.g., BTC, ETH)" },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        squeezeProbability: { type: "object" },
        factors: { type: "object" },
        signals: { type: "array", items: { type: "string" } },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        dataFreshness: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "squeezeProbability", "confidence"],
    },
  },
  {
    name: "analyze_market_sentiment",
    description: "🧠 INTELLIGENCE: Analyze overall market sentiment using Fear & Greed Index, funding rates, long/short ratios, and liquidation data across top coins.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Coins to analyze (defaults to top 10)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        overallSentiment: { type: "string" },
        sentimentScore: { type: "number" },
        fearGreedIndex: { type: "object" },
        fundingBias: { type: "object" },
        longShortRatio: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["overallSentiment", "sentimentScore", "confidence"],
    },
  },
  {
    name: "find_funding_arbitrage",
    description: "🧠 INTELLIGENCE: Find the best funding rate arbitrage opportunities across all perpetual contracts with risk assessment.",
    inputSchema: {
      type: "object" as const,
      properties: {
        minApr: { type: "number", description: "Minimum annualized yield % (default: 20)" },
        limit: { type: "number", description: "Max results (default: 15)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        opportunities: { type: "array" },
        marketStats: { type: "object" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["opportunities"],
    },
  },
  {
    name: "get_btc_valuation_score",
    description: "🧠 INTELLIGENCE: Get BTC valuation score using AHR999, Rainbow Chart, Bubble Index, Puell Multiple, and Fear & Greed combined analysis.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        valuationScore: { type: "number" },
        valuationZone: { type: "string" },
        indicators: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["valuationScore", "valuationZone", "confidence"],
    },
  },
  {
    name: "detect_liquidation_risk",
    description: "🧠 INTELLIGENCE: Detect liquidation cascade risk by analyzing OI concentration, recent liquidations, and leverage levels.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Coin symbol (e.g., BTC)" },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        riskLevel: { type: "string" },
        riskScore: { type: "number" },
        liquidationData: { type: "object" },
        oiData: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "riskLevel", "riskScore", "confidence"],
    },
  },
  {
    name: "analyze_smart_money",
    description: "🧠 INTELLIGENCE: Analyze top trader positioning vs retail using top trader position/account ratios and taker buy/sell volume.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Trading pair (e.g., BTCUSDT)" },
        exchange: { type: "string", description: "Exchange (default: Binance)" },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        topTraderPosition: { type: "object" },
        topTraderAccount: { type: "object" },
        takerFlow: { type: "object" },
        interpretation: { type: "string" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "interpretation", "confidence"],
    },
  },
  {
    name: "scan_volume_anomalies",
    description: "🧠 INTELLIGENCE: Scan for unusual volume activity across coins comparing current vs historical averages.",
    inputSchema: {
      type: "object" as const,
      properties: {
        threshold: { type: "number", description: "Volume multiplier threshold (default: 2x)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        anomalies: { type: "array" },
        scannedCoins: { type: "number" },
        anomaliesFound: { type: "number" },
        marketContext: { type: "string" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["anomalies", "scannedCoins"],
    },
  },
  {
    name: "get_market_overview",
    description: "🧠 INTELLIGENCE: Get complete derivatives market overview - total OI, volume, liquidations, funding, and sentiment across all exchanges.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        totalOpenInterest: { type: "number" },
        totalVolume24h: { type: "number" },
        totalLiquidations24h: { type: "object" },
        avgFundingRate: { type: "number" },
        marketSentiment: { type: "string" },
        topGainers: { type: "array" },
        topLosers: { type: "array" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["totalOpenInterest", "totalVolume24h"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Futures
  // ============================================================================
  {
    name: "get_supported_coins",
    description: "📊 RAW: Get list of all supported coins on Coinglass",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { coins: { type: "array" }, count: { type: "number" } }, required: ["coins"] },
  },
  {
    name: "get_supported_exchanges",
    description: "📊 RAW: Get list of all supported futures exchanges",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { exchanges: { type: "array" }, count: { type: "number" } }, required: ["exchanges"] },
  },
  {
    name: "get_exchange_pairs",
    description: "📊 RAW: Get supported trading pairs for futures exchanges",
    inputSchema: { type: "object" as const, properties: { exchange: { type: "string" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "object" } }, required: ["data"] },
  },
  {
    name: "get_futures_coins_markets",
    description: "📊 RAW: Get futures market data for all coins (OI, volume, funding, liquidations)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { markets: { type: "array" } }, required: ["markets"] },
  },
  {
    name: "get_futures_pairs_markets",
    description: "📊 RAW: Get detailed market data for a specific coin's trading pairs",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Coin (e.g., BTC)" } }, required: ["symbol"] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_price_history",
    description: "📊 RAW: Get OHLCV price history for a futures pair",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string", description: "Trading pair (e.g., BTCUSDT)" },
        interval: { type: "string", enum: ["1h", "4h", "12h", "1d", "1w"], default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_funding_rates",
    description: "📊 RAW: Get current funding rates for a coin across all exchanges",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string" } }, required: ["symbol"] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_funding_rate_history",
    description: "📊 RAW: Get historical funding rate OHLC data",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_funding_arbitrage_list",
    description: "📊 RAW: Get funding rate arbitrage opportunities list",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_oi_by_exchange",
    description: "📊 RAW: Get open interest breakdown by exchange for a coin",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string" } }, required: ["symbol"] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_oi_history",
    description: "📊 RAW: Get aggregated open interest history (stablecoin margin)",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_oi_coin_margin_history",
    description: "📊 RAW: Get aggregated open interest history (coin margin)",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        exchanges: { type: "string", default: "Binance,OKX,Bybit" },
        interval: { type: "string", default: "1d" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_liquidation_history",
    description: "📊 RAW: Get liquidation history for a trading pair",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_aggregated_liquidations",
    description: "📊 RAW: Get aggregated liquidation history across exchanges",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_global_long_short_ratio",
    description: "📊 RAW: Get global long/short account ratio history",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_top_trader_position_ratio",
    description: "📊 RAW: Get top trader long/short position ratio history",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_top_trader_account_ratio",
    description: "📊 RAW: Get top trader long/short account ratio history",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_taker_buy_sell_volume",
    description: "📊 RAW: Get taker buy/sell volume history for a pair",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_aggregated_taker_volume",
    description: "📊 RAW: Get aggregated taker buy/sell volume across exchanges",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_cvd_history",
    description: "📊 RAW: Get Cumulative Volume Delta (CVD) history",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_volume_footprint",
    description: "📊 RAW: Get volume footprint chart data (buy/sell at price levels)",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_rsi_list",
    description: "📊 RAW: Get RSI values for all coins across timeframes",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_indicator_ma",
    description: "📊 RAW: Get Moving Average indicator data",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        window: { type: "number", default: 20 },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_indicator_boll",
    description: "📊 RAW: Get Bollinger Bands indicator data",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        window: { type: "number", default: 20 },
        mult: { type: "number", default: 2 },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Indices
  // ============================================================================
  {
    name: "get_ahr999_index",
    description: "📊 RAW: Get AHR999 index (BTC accumulation indicator)",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_rainbow_chart",
    description: "📊 RAW: Get Bitcoin Rainbow Chart data",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_fear_greed_index",
    description: "📊 RAW: Get Crypto Fear & Greed Index history",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_bubble_index",
    description: "📊 RAW: Get Bitcoin Bubble Index data",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_puell_multiple",
    description: "📊 RAW: Get Puell Multiple indicator",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_btc_vs_m2",
    description: "📊 RAW: Get Bitcoin vs Global M2 Supply growth data",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_pi_cycle_indicator",
    description: "📊 RAW: Get Pi Cycle Top Indicator data",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_bull_market_indicators",
    description: "📊 RAW: Get Bull Market Peak Indicators",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - ETF
  // ============================================================================
  {
    name: "get_btc_etf_netflow",
    description: "📊 RAW: Get Bitcoin ETF net assets/flow history",
    inputSchema: { type: "object" as const, properties: { ticker: { type: "string", description: "ETF ticker (e.g., GBTC, IBIT)" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Exchange
  // ============================================================================
  {
    name: "get_exchange_balance",
    description: "📊 RAW: Get exchange balance list for a coin",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", default: "BTC" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_exchange_balance_chart",
    description: "📊 RAW: Get historical exchange balance chart",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", default: "BTC" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Spot
  // ============================================================================
  {
    name: "get_spot_coins_markets",
    description: "📊 RAW: Get spot market data for all coins",
    inputSchema: { type: "object" as const, properties: { page: { type: "number", default: 1 }, per_page: { type: "number", default: 50 } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_spot_price_history",
    description: "📊 RAW: Get spot price OHLCV history",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: { type: "string", default: "Binance" },
        symbol: { type: "string" },
        interval: { type: "string", default: "1h" },
        limit: { type: "number", default: 100 },
      },
      required: ["symbol"],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Options
  // ============================================================================
  {
    name: "get_options_oi_history",
    description: "📊 RAW: Get options open interest history by exchange",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", default: "BTC" },
        unit: { type: "string", default: "USD" },
        range: { type: "string", default: "1h" },
      },
      required: [],
    },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
];

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "coinglass-intelligence", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      // Tier 1 Intelligence Tools
      case "calculate_squeeze_probability": return await handleCalculateSqueezeProbability(args);
      case "analyze_market_sentiment": return await handleAnalyzeMarketSentiment(args);
      case "find_funding_arbitrage": return await handleFindFundingArbitrage(args);
      case "get_btc_valuation_score": return await handleGetBtcValuationScore();
      case "detect_liquidation_risk": return await handleDetectLiquidationRisk(args);
      case "analyze_smart_money": return await handleAnalyzeSmartMoney(args);
      case "scan_volume_anomalies": return await handleScanVolumeAnomalies(args);
      case "get_market_overview": return await handleGetMarketOverview();
      // Tier 2 Raw Tools
      case "get_supported_coins": return await handleGetSupportedCoins();
      case "get_supported_exchanges": return await handleGetSupportedExchanges();
      case "get_exchange_pairs": return await handleGetExchangePairs(args);
      case "get_futures_coins_markets": return await handleGetFuturesCoinsMarkets();
      case "get_futures_pairs_markets": return await handleGetFuturesPairsMarkets(args);
      case "get_price_history": return await handleGetPriceHistory(args);
      case "get_funding_rates": return await handleGetFundingRates(args);
      case "get_funding_rate_history": return await handleGetFundingRateHistory(args);
      case "get_funding_arbitrage_list": return await handleGetFundingArbitrageList();
      case "get_oi_by_exchange": return await handleGetOiByExchange(args);
      case "get_oi_history": return await handleGetOiHistory(args);
      case "get_oi_coin_margin_history": return await handleGetOiCoinMarginHistory(args);
      case "get_liquidation_history": return await handleGetLiquidationHistory(args);
      case "get_aggregated_liquidations": return await handleGetAggregatedLiquidations(args);
      case "get_global_long_short_ratio": return await handleGetGlobalLongShortRatio(args);
      case "get_top_trader_position_ratio": return await handleGetTopTraderPositionRatio(args);
      case "get_top_trader_account_ratio": return await handleGetTopTraderAccountRatio(args);
      case "get_taker_buy_sell_volume": return await handleGetTakerBuySellVolume(args);
      case "get_aggregated_taker_volume": return await handleGetAggregatedTakerVolume(args);
      case "get_cvd_history": return await handleGetCvdHistory(args);
      case "get_volume_footprint": return await handleGetVolumeFootprint(args);
      case "get_rsi_list": return await handleGetRsiList();
      case "get_indicator_ma": return await handleGetIndicatorMa(args);
      case "get_indicator_boll": return await handleGetIndicatorBoll(args);
      case "get_ahr999_index": return await handleGetAhr999Index();
      case "get_rainbow_chart": return await handleGetRainbowChart();
      case "get_fear_greed_index": return await handleGetFearGreedIndex();
      case "get_bubble_index": return await handleGetBubbleIndex();
      case "get_puell_multiple": return await handleGetPuellMultiple();
      case "get_btc_vs_m2": return await handleGetBtcVsM2();
      case "get_pi_cycle_indicator": return await handleGetPiCycleIndicator();
      case "get_bull_market_indicators": return await handleGetBullMarketIndicators();
      case "get_btc_etf_netflow": return await handleGetBtcEtfNetflow(args);
      case "get_exchange_balance": return await handleGetExchangeBalance(args);
      case "get_exchange_balance_chart": return await handleGetExchangeBalanceChart(args);
      case "get_spot_coins_markets": return await handleGetSpotCoinsMarkets(args);
      case "get_spot_price_history": return await handleGetSpotPriceHistory(args);
      case "get_options_oi_history": return await handleGetOptionsOiHistory(args);
      default: return errorResult(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : "Unknown error");
  }
});

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function successResult(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

// ============================================================================
// API HELPERS
// ============================================================================

async function coinglassGet(endpoint: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const url = new URL(`${COINGLASS_API}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": API_KEY },
  });
  if (!res.ok) throw new Error(`Coinglass API error (${res.status}): ${await res.text()}`);
  const json = await res.json() as { code: string; msg?: string; data?: unknown };
  if (json.code !== "0") throw new Error(`Coinglass error: ${json.msg || "Unknown"}`);
  return json.data;
}

// ============================================================================
// TIER 1: INTELLIGENCE HANDLERS
// ============================================================================

async function handleCalculateSqueezeProbability(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";

  // Note: Funding rates, OI, and L/S ratio endpoints require higher tier subscription
  // Use available indicators for squeeze analysis
  const [fearGreedData, bullIndicators, exchangeBalance] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history").catch(() => null),
    coinglassGet("/api/bull-market-peak-indicator").catch(() => []),
    coinglassGet("/api/exchange/balance/list", { symbol }).catch(() => []),
  ]);

  // Parse Fear & Greed for sentiment
  let fgValue = 50;
  const fgData = fearGreedData as { data_list?: number[] } | null;
  if (fgData && fgData.data_list && fgData.data_list.length > 0) {
    fgValue = fgData.data_list[fgData.data_list.length - 1] || 50;
  }

  // Parse exchange balance for flow signals
  const balances = Array.isArray(exchangeBalance) ? exchangeBalance : [];
  let totalFlowIn = 0, totalFlowOut = 0;
  for (const b of balances) {
    const bal = b as { balance_change_24h?: number; balance_change_1d?: number };
    const change = bal.balance_change_24h || bal.balance_change_1d || 0;
    if (change > 0) totalFlowIn += change;
    else totalFlowOut += Math.abs(change);
  }
  const netFlow = totalFlowIn - totalFlowOut;

  // Calculate squeeze probabilities based on available data
  const signals: string[] = [];
  let shortSqueeze = 0, longSqueeze = 0;

  // Fear & Greed extremes often precede squeezes
  if (fgValue <= 20) {
    shortSqueeze += 30;
    signals.push(`Extreme Fear (${fgValue}) - shorts may be overextended`);
  } else if (fgValue <= 35) {
    shortSqueeze += 15;
    signals.push(`Fear zone (${fgValue}) - potential short squeeze setup`);
  } else if (fgValue >= 80) {
    longSqueeze += 30;
    signals.push(`Extreme Greed (${fgValue}) - longs may be overextended`);
  } else if (fgValue >= 65) {
    longSqueeze += 15;
    signals.push(`Greed zone (${fgValue}) - potential long squeeze setup`);
  }

  // Exchange flows (outflow = bullish, inflow = bearish)
  if (netFlow < -1000) {
    shortSqueeze += 20;
    signals.push(`Strong exchange outflow (${netFlow.toFixed(0)} ${symbol}) - accumulation`);
  } else if (netFlow > 1000) {
    longSqueeze += 20;
    signals.push(`Strong exchange inflow (+${netFlow.toFixed(0)} ${symbol}) - distribution`);
  }

  shortSqueeze = Math.min(75, shortSqueeze);
  longSqueeze = Math.min(75, longSqueeze);

  const dominant = shortSqueeze > longSqueeze + 10 ? "short_squeeze" : longSqueeze > shortSqueeze + 10 ? "long_squeeze" : "neutral";
  const recommendation = dominant === "short_squeeze"
    ? `Elevated short squeeze probability (${shortSqueeze}%). Fear levels and exchange outflows suggest potential upside.`
    : dominant === "long_squeeze"
      ? `Elevated long squeeze probability (${longSqueeze}%). Greed levels and exchange inflows suggest potential downside.`
      : "No clear squeeze setup based on available data. Market relatively balanced.";

  return successResult({
    symbol,
    squeezeProbability: { shortSqueeze, longSqueeze, dominant },
    factors: {
      fearGreedIndex: fgValue,
      exchangeNetFlow: netFlow,
      flowDirection: netFlow > 0 ? "inflow" : "outflow",
    },
    signals,
    recommendation,
    confidence: Math.max(shortSqueeze, longSqueeze) > 40 ? 0.65 : 0.5,
    limitations: "⚠️ Hobbyist tier: Funding rates, OI, and L/S ratio data not available. Analysis based on Fear & Greed + Exchange flows.",
    dataSources: ["fear-greed-history", "exchange/balance/list", "bull-market-peak-indicator"],
    dataFreshness: "real-time",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeMarketSentiment(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const coins = (args?.coins as string[]) || TOP_COINS;

  const [fearGreed, bullIndicators] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history").catch(() => null),
    coinglassGet("/api/bull-market-peak-indicator").catch(() => []),
  ]);

  // Parse fear & greed - API returns object with data_list, not array
  let fgValue = 50, fgSentiment = "Neutral";
  const fgData = fearGreed as { data_list?: number[]; price_list?: number[]; time_list?: number[] } | null;
  if (fgData && fgData.data_list && fgData.data_list.length > 0) {
    fgValue = fgData.data_list[fgData.data_list.length - 1] || 50;
    fgSentiment = fgValue >= 75 ? "Extreme Greed" : fgValue >= 55 ? "Greed" : fgValue >= 45 ? "Neutral" : fgValue >= 25 ? "Fear" : "Extreme Fear";
  }

  // Parse bull market indicators
  const bullData = Array.isArray(bullIndicators) ? bullIndicators : [];
  const ahr999 = bullData.find((b: { indicator_name?: string }) => b.indicator_name?.includes("Ahr999")) as { current_value?: string } | undefined;
  const piCycle = bullData.find((b: { indicator_name?: string }) => b.indicator_name?.includes("Pi Cycle")) as { current_value?: string; target_value?: string } | undefined;

  // Calculate sentiment based on available indicators
  let sentimentScore = fgValue; // Start with Fear & Greed as base

  // Adjust based on AHR999 if available
  const ahr999Value = ahr999?.current_value ? parseFloat(ahr999.current_value) : null;
  if (ahr999Value !== null) {
    if (ahr999Value < 0.45) sentimentScore -= 10; // Strong buy zone = bearish sentiment currently
    else if (ahr999Value > 4) sentimentScore += 15; // Bubble zone
  }

  const overallSentiment = sentimentScore >= 75 ? "Extreme Greed" : sentimentScore >= 55 ? "Greed" : sentimentScore >= 45 ? "Neutral" : sentimentScore >= 25 ? "Fear" : "Extreme Fear";

  const recommendation = sentimentScore >= 65
    ? "Market sentiment is greedy. Consider taking profits or tightening stops."
    : sentimentScore <= 35
      ? "Market sentiment is fearful. Historical buying opportunity - consider DCA."
      : sentimentScore <= 25
        ? "Extreme fear - historically the best time to accumulate."
        : "Neutral sentiment. Market in wait-and-see mode.";

  return successResult({
    overallSentiment,
    sentimentScore: Math.round(sentimentScore),
    fearGreedIndex: { value: fgValue, sentiment: fgSentiment },
    bullMarketIndicators: {
      ahr999: ahr999Value,
      piCyclePrice: piCycle?.current_value,
      piCycleTarget: piCycle?.target_value,
    },
    analyzedCoins: coins,
    recommendation,
    confidence: 0.8,
    dataSources: ["fear-greed-history", "bull-market-peak-indicator"],
    limitations: "Hobbyist tier: Funding rate data not available. Sentiment based on Fear & Greed + Bull indicators.",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleFindFundingArbitrage(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const minApr = (args?.minApr as number) || 20;
  const limit = (args?.limit as number) || 15;

  const arbData = await coinglassGet("/api/futures/fundingRate/arbitrage") as Array<{
    symbol: string;
    buy: { exchange: string; open_interest_usd: number; funding_rate: number; funding_rate_interval: number };
    sell: { exchange: string; open_interest_usd: number; funding_rate: number; funding_rate_interval: number };
    apr: number;
    funding: number;
    fee: number;
    spread: number;
    next_funding_time: number;
  }>;

  const opportunities = arbData
    .filter(a => a.apr >= minApr)
    .sort((a, b) => b.apr - a.apr)
    .slice(0, limit)
    .map(a => ({
      symbol: a.symbol,
      annualizedYield: a.apr,
      fundingDiff: a.funding,
      longExchange: a.buy.exchange,
      longFundingRate: a.buy.funding_rate,
      shortExchange: a.sell.exchange,
      shortFundingRate: a.sell.funding_rate,
      totalFee: a.fee,
      priceSpread: a.spread,
      minOiUsd: Math.min(a.buy.open_interest_usd, a.sell.open_interest_usd),
      riskLevel: a.buy.open_interest_usd > 10_000_000 && a.sell.open_interest_usd > 10_000_000 ? "low" : a.buy.open_interest_usd > 1_000_000 ? "medium" : "high",
      nextFundingTime: new Date(a.next_funding_time).toISOString(),
    }));

  const avgApr = opportunities.reduce((sum, o) => sum + o.annualizedYield, 0) / (opportunities.length || 1);

  return successResult({
    opportunities,
    totalFound: opportunities.length,
    marketStats: { avgApr: avgApr.toFixed(2), minAprFilter: minApr },
    note: "Long on buy exchange, short on sell exchange to collect funding. Check liquidity before execution.",
    confidence: 0.85,
    dataSources: ["fundingRate/arbitrage"],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetBtcValuationScore(): Promise<CallToolResult> {
  const [ahr999Data, rainbowData, bubbleData, fearGreedData, puellData] = await Promise.all([
    coinglassGet("/api/index/ahr999").catch(() => null),
    coinglassGet("/api/index/bitcoin/rainbow-chart").catch(() => null),
    coinglassGet("/api/index/bitcoin/bubble-index").catch(() => null),
    coinglassGet("/api/index/fear-greed-history").catch(() => null),
    coinglassGet("/api/index/puell-multiple").catch(() => null),
  ]);

  // Parse AHR999 - returns array of objects
  const ahr999Arr = Array.isArray(ahr999Data) ? ahr999Data : [];
  const latestAhr = ahr999Arr[ahr999Arr.length - 1] as { ahr999_value?: number; ahr999?: number; value?: number } | undefined;
  const ahr999Value = latestAhr?.ahr999_value || latestAhr?.ahr999 || latestAhr?.value || 1;
  const ahr999Signal = ahr999Value < 0.45 ? "strong_buy" : ahr999Value < 1.2 ? "buy" : ahr999Value < 4 ? "hold" : "sell";

  // Parse Fear & Greed - API returns object with data_list, NOT array
  let fgValue = 50;
  const fgData = fearGreedData as { data_list?: number[] } | null;
  if (fgData && fgData.data_list && fgData.data_list.length > 0) {
    fgValue = fgData.data_list[fgData.data_list.length - 1] || 50;
  }

  // Parse Puell Multiple - returns array
  const puellArr = Array.isArray(puellData) ? puellData : [];
  const latestPuell = puellArr[puellArr.length - 1] as { puell_multiple?: number; value?: number } | undefined;
  const puellValue = latestPuell?.puell_multiple || latestPuell?.value || 1;
  const puellSignal = puellValue < 0.5 ? "strong_buy" : puellValue < 1 ? "buy" : puellValue < 4 ? "hold" : "sell";

  // Parse Bubble Index - returns array
  const bubbleArr = Array.isArray(bubbleData) ? bubbleData : [];
  const latestBubble = bubbleArr[bubbleArr.length - 1] as { bubble_index?: number; index?: number } | undefined;
  const bubbleValue = latestBubble?.bubble_index || latestBubble?.index || 0;

  // Calculate composite score (0-100, higher = more overvalued)
  let valuationScore = 50;
  if (ahr999Signal === "strong_buy") valuationScore -= 20;
  else if (ahr999Signal === "buy") valuationScore -= 10;
  else if (ahr999Signal === "sell") valuationScore += 20;

  if (puellSignal === "strong_buy") valuationScore -= 15;
  else if (puellSignal === "buy") valuationScore -= 7;
  else if (puellSignal === "sell") valuationScore += 15;

  valuationScore += (fgValue - 50) * 0.3;
  valuationScore += bubbleValue * 0.5;

  valuationScore = Math.max(0, Math.min(100, valuationScore));

  const valuationZone = valuationScore < 25 ? "Undervalued (Strong Buy Zone)" : valuationScore < 40 ? "Fair Value (Accumulation)" : valuationScore < 60 ? "Neutral" : valuationScore < 75 ? "Overvalued (Caution)" : "Bubble Territory (Extreme Caution)";

  const recommendation = valuationScore < 30
    ? "Bitcoin appears undervalued across multiple indicators. Consider DCA accumulation."
    : valuationScore < 50
      ? "Fair value range. Normal accumulation strategies apply."
      : valuationScore < 70
        ? "Above fair value. Consider taking partial profits on rallies."
        : "Overvalued territory. High risk of correction. Defensive positioning recommended.";

  return successResult({
    valuationScore: Math.round(valuationScore),
    valuationZone,
    indicators: {
      ahr999: { value: ahr999Value, signal: ahr999Signal },
      fearGreed: { value: fgValue, sentiment: fgValue >= 75 ? "Extreme Greed" : fgValue >= 55 ? "Greed" : fgValue >= 45 ? "Neutral" : fgValue >= 25 ? "Fear" : "Extreme Fear" },
      puellMultiple: { value: puellValue, signal: puellSignal },
      bubbleIndex: { value: bubbleValue },
    },
    currentPrice: fgData && (fgData as { price_list?: number[] }).price_list ? (fgData as { price_list: number[] }).price_list[(fgData as { price_list: number[] }).price_list.length - 1] : null,
    recommendation,
    confidence: 0.85,
    dataSources: ["ahr999", "fear-greed-history", "puell-multiple", "bubble-index"],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleDetectLiquidationRisk(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";

  const [liqData, oiData] = await Promise.all([
    coinglassGet("/api/futures/liquidation/aggregated-history", { symbol, exchange_list: "Binance,OKX,Bybit", interval: "1h", limit: 24 }).catch(() => []),
    coinglassGet("/api/futures/openInterest/exchange-list", { symbol }).catch(() => []),
  ]);

  const liquidations = Array.isArray(liqData) ? liqData : [];
  const ois = Array.isArray(oiData) ? oiData : [];

  // Calculate liquidation stats
  let totalLongLiq = 0, totalShortLiq = 0;
  for (const liq of liquidations) {
    const l = liq as { aggregated_long_liquidation_usd?: number; aggregated_short_liquidation_usd?: number };
    totalLongLiq += l.aggregated_long_liquidation_usd || 0;
    totalShortLiq += l.aggregated_short_liquidation_usd || 0;
  }
  const totalLiq24h = totalLongLiq + totalShortLiq;
  const liqBias = totalLongLiq > totalShortLiq * 1.5 ? "long_heavy" : totalShortLiq > totalLongLiq * 1.5 ? "short_heavy" : "balanced";

  // Get OI data
  const allOi = ois.find((o: { exchange?: string }) => o.exchange === "All") as { openInterest?: number; openInterestChangePercent24h?: number } | undefined;
  const totalOi = allOi?.openInterest || 0;
  const oiChange = allOi?.openInterestChangePercent24h || 0;

  // Calculate risk score
  const liqOiRatio = totalOi > 0 ? (totalLiq24h / totalOi) * 100 : 0;
  let riskScore = 0;

  if (liqOiRatio > 5) riskScore += 40;
  else if (liqOiRatio > 2) riskScore += 25;
  else if (liqOiRatio > 1) riskScore += 15;

  if (oiChange > 10) riskScore += 20;
  else if (oiChange > 5) riskScore += 10;

  if (liqBias !== "balanced") riskScore += 15;

  const riskLevel = riskScore >= 50 ? "high" : riskScore >= 25 ? "moderate" : "low";

  const recommendation = riskLevel === "high"
    ? "High liquidation cascade risk. Reduce leverage, tighten stops, or hedge positions."
    : riskLevel === "moderate"
      ? "Elevated risk. Monitor closely, especially around key price levels."
      : "Normal conditions. Standard risk management applies.";

  return successResult({
    symbol,
    riskLevel,
    riskScore,
    liquidationData: {
      longLiquidations24h: totalLongLiq,
      shortLiquidations24h: totalShortLiq,
      totalLiquidations24h: totalLiq24h,
      liqBias,
      liqOiRatio: liqOiRatio.toFixed(2),
    },
    oiData: { totalOi, oiChange24h: oiChange },
    recommendation,
    confidence: 0.75,
    dataSources: ["liquidation/aggregated-history", "openInterest/exchange-list"],
    dataFreshness: "real-time",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeSmartMoney(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string) || "BTCUSDT";
  const exchange = (args?.exchange as string) || "Binance";

  const [posRatio, accRatio, takerVol] = await Promise.all([
    coinglassGet("/api/futures/top-long-short-position-ratio/history", { exchange, symbol, interval: "1h", limit: 24 }).catch(() => []),
    coinglassGet("/api/futures/top-long-short-account-ratio/history", { exchange, symbol, interval: "1h", limit: 24 }).catch(() => []),
    coinglassGet("/api/futures/v2/taker-buy-sell-volume/history", { exchange, symbol, interval: "1h", limit: 24 }).catch(() => []),
  ]);

  const posRatios = Array.isArray(posRatio) ? posRatio : [];
  const accRatios = Array.isArray(accRatio) ? accRatio : [];
  const takerVols = Array.isArray(takerVol) ? takerVol : [];

  // Latest top trader position
  const latestPos = posRatios[posRatios.length - 1] as { top_position_long_percent?: number; top_position_short_percent?: number; top_position_long_short_ratio?: number } | undefined;
  const topPosLong = latestPos?.top_position_long_percent || 50;
  const topPosShort = latestPos?.top_position_short_percent || 50;
  const topPosRatio = latestPos?.top_position_long_short_ratio || 1;

  // Latest top trader account
  const latestAcc = accRatios[accRatios.length - 1] as { top_account_long_percent?: number; top_account_short_percent?: number; top_account_long_short_ratio?: number } | undefined;
  const topAccLong = latestAcc?.top_account_long_percent || 50;
  const topAccShort = latestAcc?.top_account_short_percent || 50;
  const topAccRatio = latestAcc?.top_account_long_short_ratio || 1;

  // Taker flow analysis
  let totalBuy = 0, totalSell = 0;
  for (const tv of takerVols) {
    const t = tv as { taker_buy_volume_usd?: string; taker_sell_volume_usd?: string };
    totalBuy += parseFloat(t.taker_buy_volume_usd || "0");
    totalSell += parseFloat(t.taker_sell_volume_usd || "0");
  }
  const takerNetFlow = totalBuy - totalSell;
  const takerBias = takerNetFlow > totalBuy * 0.1 ? "buy_heavy" : takerNetFlow < -totalSell * 0.1 ? "sell_heavy" : "balanced";

  // Interpretation
  let interpretation: string;
  if (topPosRatio > 1.3 && takerBias === "buy_heavy") {
    interpretation = "Smart money heavily long, takers buying. Bullish confluence.";
  } else if (topPosRatio < 0.8 && takerBias === "sell_heavy") {
    interpretation = "Smart money heavily short, takers selling. Bearish confluence.";
  } else if (topPosRatio > 1.3 && takerBias === "sell_heavy") {
    interpretation = "Smart money long but retail selling. Potential accumulation.";
  } else if (topPosRatio < 0.8 && takerBias === "buy_heavy") {
    interpretation = "Smart money short but retail buying. Potential distribution.";
  } else {
    interpretation = "Mixed signals. No clear smart money trend.";
  }

  const recommendation = topPosRatio > 1.2
    ? "Top traders are positioned long. Consider aligning with smart money."
    : topPosRatio < 0.8
      ? "Top traders are positioned short. Exercise caution on longs."
      : "Top traders are neutral. Wait for clearer positioning.";

  return successResult({
    symbol,
    exchange,
    topTraderPosition: { longPercent: topPosLong, shortPercent: topPosShort, ratio: topPosRatio },
    topTraderAccount: { longPercent: topAccLong, shortPercent: topAccShort, ratio: topAccRatio },
    takerFlow: { totalBuy24h: totalBuy, totalSell24h: totalSell, netFlow: takerNetFlow, bias: takerBias },
    interpretation,
    recommendation,
    confidence: 0.7,
    dataSources: ["top-long-short-position-ratio/history", "top-long-short-account-ratio/history", "v2/taker-buy-sell-volume/history"],
    dataFreshness: "real-time",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleScanVolumeAnomalies(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const threshold = (args?.threshold as number) || 2;

  const marketsData = await coinglassGet("/api/spot/coins-markets", { page: 1, per_page: 50 }) as Array<{
    symbol: string;
    current_price: number;
    volume_usd_24h: number;
    volume_usd_1h: number;
    volume_change_percent_24h: number;
    volume_change_percent_1h: number;
  }>;

  const anomalies = marketsData
    .filter(m => {
      const hourlyChange = Math.abs(m.volume_change_percent_1h || 0);
      return hourlyChange > (threshold - 1) * 100;
    })
    .map(m => ({
      symbol: m.symbol,
      currentPrice: m.current_price,
      volume1h: m.volume_usd_1h,
      volume24h: m.volume_usd_24h,
      volumeChange1h: m.volume_change_percent_1h,
      volumeChange24h: m.volume_change_percent_24h,
      significance: Math.abs(m.volume_change_percent_1h || 0) > 200 ? "extreme" : "notable",
    }))
    .sort((a, b) => Math.abs(b.volumeChange1h) - Math.abs(a.volumeChange1h))
    .slice(0, 15);

  const extremeCount = anomalies.filter(a => a.significance === "extreme").length;
  const marketContext = extremeCount >= 3
    ? "HIGH ALERT: Multiple extreme volume anomalies. Potential market-wide event."
    : anomalies.length > 5
      ? "Elevated activity: Several coins showing unusual volume."
      : "Normal conditions with some localized activity.";

  return successResult({
    anomalies,
    scannedCoins: marketsData.length,
    anomaliesFound: anomalies.length,
    threshold: `${threshold}x normal`,
    marketContext,
    dataSources: ["spot/coins-markets"],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketOverview(): Promise<CallToolResult> {
  const [fearGreed, bullIndicators, etfData, exchangeBalance] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history").catch(() => null),
    coinglassGet("/api/bull-market-peak-indicator").catch(() => []),
    coinglassGet("/api/etf/bitcoin/net-assets/history").catch(() => []),
    coinglassGet("/api/exchange/balance/list", { symbol: "BTC" }).catch(() => []),
  ]);

  // Fear & Greed - API returns object with data_list, NOT array
  let fgValue = 50, fgSentiment = "Neutral";
  let btcPrice = 0;
  const fgData = fearGreed as { data_list?: number[]; price_list?: number[] } | null;
  if (fgData && fgData.data_list && fgData.data_list.length > 0) {
    fgValue = fgData.data_list[fgData.data_list.length - 1] || 50;
    fgSentiment = fgValue >= 75 ? "Extreme Greed" : fgValue >= 55 ? "Greed" : fgValue >= 45 ? "Neutral" : fgValue >= 25 ? "Fear" : "Extreme Fear";
    if (fgData.price_list && fgData.price_list.length > 0) {
      btcPrice = fgData.price_list[fgData.price_list.length - 1];
    }
  }

  // Bull market indicators
  const bullData = Array.isArray(bullIndicators) ? bullIndicators : [];
  const indicatorHits = bullData.filter((b: { hit_status?: boolean }) => b.hit_status).length;
  const totalIndicators = bullData.length;

  // ETF data
  const etfArr = Array.isArray(etfData) ? etfData : [];
  const latestEtf = etfArr[etfArr.length - 1] as { net_assets_usd?: number; change_usd?: number } | undefined;
  const etfNetAssets = latestEtf?.net_assets_usd || 0;
  const etfDailyChange = latestEtf?.change_usd || 0;

  // Exchange balances
  const balances = Array.isArray(exchangeBalance) ? exchangeBalance : [];
  let totalExchangeBtc = 0;
  let btcChange24h = 0;
  for (const b of balances) {
    const bal = b as { total_balance?: number; balance_change_1d?: number };
    totalExchangeBtc += bal.total_balance || 0;
    btcChange24h += bal.balance_change_1d || 0;
  }

  return successResult({
    btcPrice,
    btcPriceFormatted: `$${btcPrice.toLocaleString()}`,
    fearGreedIndex: { value: fgValue, sentiment: fgSentiment },
    marketSentiment: fgSentiment,
    bullMarketIndicators: {
      indicatorsTriggered: indicatorHits,
      totalIndicators,
      summary: indicatorHits === 0 ? "No bull market peak signals" : `${indicatorHits}/${totalIndicators} peak indicators triggered`,
    },
    etfData: {
      totalNetAssets: etfNetAssets,
      totalNetAssetsFormatted: `$${(etfNetAssets / 1e9).toFixed(2)}B`,
      dailyChange: etfDailyChange,
      dailyChangeFormatted: `$${(etfDailyChange / 1e6).toFixed(1)}M`,
    },
    exchangeData: {
      totalBtcOnExchanges: totalExchangeBtc,
      btcChange24h,
      flowDirection: btcChange24h > 0 ? "inflow (bearish)" : "outflow (bullish)",
    },
    limitations: "⚠️ Hobbyist tier: OI, volume, and liquidation data require plan upgrade.",
    dataSources: ["fear-greed-history", "bull-market-peak-indicator", "etf/bitcoin/net-assets/history", "exchange/balance/list"],
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// TIER 2: RAW DATA HANDLERS
// ============================================================================

async function handleGetSupportedCoins(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/supported-coins");
  const coins = Array.isArray(data) ? data : [];
  return successResult({ coins, count: coins.length, fetchedAt: new Date().toISOString() });
}

async function handleGetSupportedExchanges(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/supported-exchanges");
  const exchanges = Array.isArray(data) ? data : [];
  return successResult({ exchanges, count: exchanges.length, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangePairs(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = args?.exchange as string | undefined;
  const params: Record<string, string | number> = {};
  if (exchange) params.exchange = exchange;
  const data = await coinglassGet("/api/futures/supported-exchange-pairs", params);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesCoinsMarkets(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/coins-markets");
  return successResult({ markets: data, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesPairsMarkets(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const data = await coinglassGet("/api/futures/pairs-markets", { symbol });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetPriceHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/price/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFundingRates(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const data = await coinglassGet("/api/futures/fundingRate/exchange-list", { symbol });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFundingRateHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/fundingRate/ohlc-history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFundingArbitrageList(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/fundingRate/arbitrage");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetOiByExchange(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const data = await coinglassGet("/api/futures/openInterest/exchange-list", { symbol });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetOiHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchange_list = (args?.exchange_list as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  const data = await coinglassGet("/api/futures/open-interest/aggregated-stablecoin-history", { symbol, exchange_list, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetOiCoinMarginHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchanges = (args?.exchanges as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1d";
  const limit = (args?.limit as number) || 100;
  const data = await coinglassGet("/api/futures/openInterest/ohlc-aggregated-coin-margin-history", { symbol, exchanges, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetLiquidationHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/liquidation/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetAggregatedLiquidations(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchange_list = (args?.exchange_list as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  const data = await coinglassGet("/api/futures/liquidation/aggregated-history", { exchange_list, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetGlobalLongShortRatio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/globalLongShortAccountRatio/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetTopTraderPositionRatio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/top-long-short-position-ratio/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetTopTraderAccountRatio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/top-long-short-account-ratio/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetTakerBuySellVolume(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/v2/taker-buy-sell-volume/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetAggregatedTakerVolume(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchange_list = (args?.exchange_list as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  const data = await coinglassGet("/api/futures/aggregated-taker-buy-sell-volume/history", { exchange_list, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetCvdHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/cvd/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetVolumeFootprint(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/volume/footprint-history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetRsiList(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/rsi/list");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetIndicatorMa(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const window = (args?.window as number) || 20;
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/indicators/ma", { exchange, symbol, interval, window, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetIndicatorBoll(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const window = (args?.window as number) || 20;
  const mult = (args?.mult as number) || 2;
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/futures/indicators/boll", { exchange, symbol, interval, window, mult, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetAhr999Index(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/ahr999");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetRainbowChart(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/bitcoin/rainbow-chart");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFearGreedIndex(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/fear-greed-history");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBubbleIndex(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/bitcoin/bubble-index");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetPuellMultiple(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/puell-multiple");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBtcVsM2(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/bitcoin-vs-global-m2-growth");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetPiCycleIndicator(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/pi");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBullMarketIndicators(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/bull-market-peak-indicator");
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBtcEtfNetflow(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const ticker = args?.ticker as string | undefined;
  const params: Record<string, string | number> = {};
  if (ticker) params.ticker = ticker;
  const data = await coinglassGet("/api/etf/bitcoin/net-assets/history", params);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangeBalance(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string) || "BTC";
  const data = await coinglassGet("/api/exchange/balance/list", { symbol });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangeBalanceChart(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string) || "BTC";
  const data = await coinglassGet("/api/exchange/balance/chart", { symbol });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetSpotCoinsMarkets(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const page = (args?.page as number) || 1;
  const per_page = (args?.per_page as number) || 50;
  const data = await coinglassGet("/api/spot/coins-markets", { page, per_page });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetSpotPriceHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  const data = await coinglassGet("/api/spot/price/history", { exchange, symbol, interval, limit });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetOptionsOiHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string) || "BTC";
  const unit = (args?.unit as string) || "USD";
  const range = (args?.range as string) || "1h";
  const data = await coinglassGet("/api/option/exchange-oi-history", { symbol, unit, range });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};
const verifyContextAuth = createContextMiddleware();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "coinglass-intelligence",
    version: "1.0.0",
    tier1Tools: TOOLS.filter(t => t.description.startsWith("🧠")).map(t => t.name),
    tier2Tools: TOOLS.filter(t => t.description.startsWith("📊")).map(t => t.name),
    totalTools: TOOLS.length,
  });
});

app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { transports[id] = transport; console.log(`Session: ${id}`); },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await server.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) await transport.handleRequest(req, res);
  else res.status(400).json({ error: "Invalid session" });
});

app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) await transport.handleRequest(req, res);
  else res.status(400).json({ error: "Invalid session" });
});

const port = Number(process.env.PORT || 4005);
app.listen(port, () => {
  console.log("\n🚀 Coinglass Intelligence MCP Server v1.0.0");
  console.log(`   Comprehensive crypto derivatives intelligence\n`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🧠 TIER 1 - INTELLIGENCE TOOLS (${TOOLS.filter(t => t.description.startsWith("🧠")).length}):`);
  TOOLS.filter(t => t.description.startsWith("🧠")).forEach(t => console.log(`   • ${t.name}`));
  console.log(`\n📊 TIER 2 - RAW DATA TOOLS (${TOOLS.filter(t => t.description.startsWith("📊")).length}):`);
  TOOLS.filter(t => t.description.startsWith("📊")).forEach(t => console.log(`   • ${t.name}`));
  console.log("");
});

