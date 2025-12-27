/**
 * Hummingbot Market Intelligence MCP Server
 *
 * A PUBLIC MARKET DATA MCP server powered by Hummingbot API.
 * Provides access to real-time market data, liquidity analysis, and DEX quotes.
 *
 * SCOPE: Public market data only - NO user account data, NO trading operations
 *
 * Features:
 * - Multi-exchange price data (40+ CEX/DEX connectors)
 * - Order book analysis with VWAP and slippage estimation
 * - Funding rate analysis for perpetuals
 * - DEX swap quotes (Jupiter, 0x, etc.)
 * - CLMM pool liquidity analysis (Meteora, Raydium)
 *
 * Architecture:
 * - Runs on the SAME server as Hummingbot API (localhost:8000)
 * - Uses Basic Auth with HB_USERNAME and HB_PASSWORD env vars
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type CallToolRequest,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";

// ============================================================================
// CONFIGURATION
// ============================================================================

const HUMMINGBOT_API_BASE_URL = process.env.HUMMINGBOT_API_URL || "http://localhost:8000";
const HB_USERNAME = process.env.HB_USERNAME || "admin";
const HB_PASSWORD = process.env.HB_PASSWORD || "admin";

// ============================================================================
// API HELPER FUNCTIONS
// ============================================================================

function getBasicAuthHeader(): string {
  const credentials = Buffer.from(`${HB_USERNAME}:${HB_PASSWORD}`).toString("base64");
  return `Basic ${credentials}`;
}

async function hbFetch<T>(
  endpoint: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    params?: Record<string, string>;
  } = {}
): Promise<T> {
  const { method = "GET", body, params } = options;
  
  let url = `${HUMMINGBOT_API_BASE_URL}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }
  
  const response = await fetch(url, {
    method,
    headers: {
      "Authorization": getBasicAuthHeader(),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Hummingbot API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  return response.json() as T;
}

// ============================================================================
// RESPONSE HELPERS
// ============================================================================

function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

// ============================================================================
// EXCHANGE CONFIGURATIONS
// ============================================================================

const TOP_SPOT_EXCHANGES = ["binance", "bybit", "okx", "kucoin", "gate_io"];
const TOP_PERP_EXCHANGES = ["binance_perpetual", "bybit_perpetual", "hyperliquid_perpetual", "okx_perpetual", "gate_io_perpetual"];

const TOOLS = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 🧠 GIGA-BRAIN TIER: User-centric intelligence tools
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "find_best_execution",
    description: `🧠 GIGA-BRAIN: "Where should I buy/sell X amount of Y?"

Compares execution across 5 major exchanges (Binance, Bybit, OKX, KuCoin, Gate.io) to find:
- Best price for your exact trade size
- Slippage at each exchange
- Ranked recommendations

Example: "Where should I buy 10 ETH?" → Returns ranked exchanges by effective price.

Perfect for: Large orders, best execution, exchange comparison.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        base_asset: {
          type: "string",
          description: "Asset to buy/sell (e.g., 'ETH', 'BTC', 'SOL')",
        },
        quote_asset: {
          type: "string",
          description: "Quote currency (default: 'USDT')",
          default: "USDT",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "BUY or SELL",
        },
        amount: {
          type: "number",
          description: "Amount in BASE asset (e.g., 10 for 10 ETH)",
        },
      },
      required: ["base_asset", "side", "amount"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "object" },
        recommendations: { type: "array", items: { type: "object" } },
        bestExchange: { type: "string" },
        worstExchange: { type: "string" },
        savingsVsWorst: { type: "object" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "compare_swap_routes",
    description: `🧠 GIGA-BRAIN: "Should I swap on DEX or CEX?"

Compares DEX (Jupiter/Solana) vs CEX (Binance) prices for the same trade:
- Price difference percentage
- Which venue is cheaper
- Potential savings

Example: "Best way to swap 1000 USDC to SOL?" → Shows DEX vs CEX comparison.

Perfect for: Route optimization, DEX vs CEX decisions, arbitrage hunting.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        base_asset: {
          type: "string",
          description: "Asset to receive (e.g., 'SOL', 'ETH')",
        },
        quote_asset: {
          type: "string",
          description: "Asset to spend (e.g., 'USDC', 'USDT')",
        },
        amount: {
          type: "number",
          description: "Amount of BASE to receive",
        },
      },
      required: ["base_asset", "quote_asset", "amount"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "object" },
        dex: { type: "object" },
        cex: { type: "object" },
        comparison: { type: "object" },
        recommendation: { type: "string" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "scan_funding_opportunities",
    description: `🧠 GIGA-BRAIN: "What funding rate opportunities exist right now?"

Scans funding rates across multiple perpetual pairs and exchanges to find:
- Extreme positive funding (shorts get paid)
- Extreme negative funding (longs get paid)
- Cross-exchange funding arbitrage opportunities

Example: "Any funding rate opportunities?" → Shows top opportunities sorted by rate.

Perfect for: Funding arbitrage, market sentiment overview, position timing.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        pairs: {
          type: "array",
          items: { type: "string" },
          description: "Pairs to scan (default: ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'])",
        },
        exchanges: {
          type: "array",
          items: { type: "string" },
          description: "Perpetual exchanges to scan",
        },
      },
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        scannedPairs: { type: "number" },
        opportunities: { type: "array", items: { type: "object" } },
        topLongOpportunity: { type: "object", description: "Best long opportunity or {found: false} if none" },
        topShortOpportunity: { type: "object", description: "Best short opportunity or {found: false} if none" },
        marketSentiment: { type: "string" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "find_yield_pools",
    description: `🧠 GIGA-BRAIN: "Where can I earn yield on my SOL/USDC?"

Searches Meteora DLMM pools for the best yield opportunities:
- Top pools by APY
- TVL and volume data
- Fee earnings potential

Example: "Best yield for SOL?" → Returns top pools sorted by APY.

Perfect for: Yield farming, LP research, DeFi opportunities.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string",
          description: "Token to find pools for (e.g., 'SOL', 'USDC', 'JUP')",
        },
        min_tvl: {
          type: "number",
          description: "Minimum TVL in USD (default: 10000)",
          default: 10000,
        },
        limit: {
          type: "number",
          description: "Max pools to return (default: 10)",
          default: 10,
        },
      },
      required: ["token"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        token: { type: "string" },
        poolsFound: { type: "number" },
        topPools: { type: "array", items: { type: "object" } },
        bestApy: { type: "object" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "find_arbitrage",
    description: `🧠 GIGA-BRAIN: "Any price differences I can exploit?"

Compares prices of the same asset across multiple exchanges to find arbitrage:
- Price differences between exchanges
- Potential profit percentage
- Best buy/sell venues

Example: "Any BTC arbitrage?" → Shows price spreads across exchanges.

Perfect for: Arbitrage hunting, cross-exchange trading, price discovery.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        base_asset: {
          type: "string",
          description: "Asset to check (e.g., 'BTC', 'ETH', 'SOL')",
        },
        quote_asset: {
          type: "string",
          description: "Quote currency (default: 'USDT')",
          default: "USDT",
        },
      },
      required: ["base_asset"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        pair: { type: "string" },
        prices: { type: "array", items: { type: "object" } },
        arbitrage: { type: "object" },
        recommendation: { type: "string" },
        timestamp: { type: "string" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 1: INTELLIGENCE TOOLS - Technical analysis tools
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "analyze_trade_impact",
    description: `🧠 INTELLIGENCE: Calculate exact price impact and VWAP for a trade.

Uses real order book data to compute:
- Exact execution price for your trade size
- VWAP (Volume Weighted Average Price)
- Price impact / slippage percentage
- Whether sufficient liquidity exists

Perfect for: Pre-trade analysis, optimal execution planning, large order sizing.

Supported exchanges: binance, kucoin, okx, bybit, hyperliquid, gate_io, coinbase_advanced_trade, and 40+ more.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector (e.g., 'binance', 'hyperliquid_perpetual', 'bybit')",
        },
        trading_pair: {
          type: "string",
          description: "Trading pair (e.g., 'BTC-USDT', 'ETH-USDC')",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "Trade side - BUY walks the asks, SELL walks the bids",
        },
        amount: {
          type: "number",
          description: "Trade amount in BASE token (e.g., 1.5 for 1.5 BTC)",
        },
      },
      required: ["connector_name", "trading_pair", "side", "amount"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tradingPair: { type: "string" },
        side: { type: "string" },
        requestedAmount: { type: "number", description: "Requested trade amount" },
        vwap: { type: "number", description: "Volume Weighted Average Price for the trade" },
        priceImpactPct: { type: "number", description: "Price impact percentage vs mid price" },
        totalQuoteVolume: { type: "number", description: "Total quote currency needed/received" },
        midPrice: { type: "number", description: "Current mid price for reference" },
        spread: { type: "object", properties: { absolute: { type: "number" }, percentage: { type: "number" } } },
        sufficientLiquidity: { type: "boolean" },
        timestamp: { type: "string", format: "date-time" },
      },
    },
  },

  {
    name: "analyze_market_depth",
    description: `🧠 INTELLIGENCE: Deep analysis of order book liquidity at multiple trade sizes.

Analyzes how the order book would handle trades of various sizes:
- Slippage at $1K, $10K, $50K, $100K trade sizes
- Bid/ask depth in quote currency
- Spread analysis
- Liquidity warnings

Perfect for: Market making decisions, large order planning, liquidity assessment.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector",
        },
        trading_pair: {
          type: "string",
          description: "Trading pair",
        },
        trade_sizes_usd: {
          type: "array",
          items: { type: "number" },
          description: "USD amounts to analyze (default: [1000, 10000, 50000, 100000])",
        },
      },
      required: ["connector_name", "trading_pair"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tradingPair: { type: "string" },
        connector: { type: "string" },
        midPrice: { type: "number" },
        spread: { type: "object" },
        depth: { type: "object", properties: { bidDepthUsd: { type: "number" }, askDepthUsd: { type: "number" } } },
        impactAnalysis: { type: "array", items: { type: "object" } },
        liquidityGrade: { type: "string", description: "A/B/C/D/F based on depth and spread" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "analyze_funding_sentiment",
    description: `🧠 INTELLIGENCE: Analyze perpetual futures funding rate for market sentiment.

Returns:
- Current funding rate with annualized projection
- Sentiment interpretation (Extremely Bullish/Bearish, etc.)
- Mark vs Index price comparison
- Next funding time

Perfect for: Funding arbitrage, sentiment analysis, position timing.

Supported connectors: binance_perpetual, bybit_perpetual, hyperliquid_perpetual, okx_perpetual, gate_io_perpetual, kucoin_perpetual, dydx_v4_perpetual.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Perpetual futures connector (e.g., 'binance_perpetual', 'hyperliquid_perpetual')",
        },
        trading_pair: {
          type: "string",
          description: "Perpetual trading pair (e.g., 'BTC-USDT', 'ETH-USD')",
        },
      },
      required: ["connector_name", "trading_pair"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tradingPair: { type: "string" },
        connector: { type: "string" },
        fundingRate: { type: "number", description: "Current funding rate (decimal)" },
        fundingRatePct: { type: "number", description: "Funding rate as percentage" },
        annualizedRatePct: { type: "number", description: "Projected annual rate" },
        sentiment: { type: "string", enum: ["Extremely Bullish", "Bullish", "Neutral", "Bearish", "Extremely Bearish"] },
        sentimentExplanation: { type: "string" },
        markPrice: { type: "number" },
        indexPrice: { type: "number" },
        markIndexPremiumPct: { type: "number" },
        nextFundingTime: { type: "string" },
        hoursUntilFunding: { type: "number" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "get_dex_swap_quote",
    description: `🔄 DEX: Get a swap quote from decentralized exchanges via aggregators.

Returns:
- Expected output amount
- Price and price impact
- Gas estimate
- Slippage settings

Supported DEXs:
- Jupiter (Solana): SOL, USDC, tokens on Solana
- 0x Protocol (EVM): ETH, Base, Polygon, Arbitrum, etc.

Perfect for: DEX trading analysis, route comparison, gas estimation.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector: {
          type: "string",
          enum: ["jupiter", "0x"],
          description: "DEX aggregator to use",
        },
        network: {
          type: "string",
          description: "Network ID (e.g., 'solana-mainnet-beta', 'ethereum-mainnet', 'base-mainnet')",
        },
        trading_pair: {
          type: "string",
          description: "Token pair in BASE-QUOTE format (e.g., 'SOL-USDC', 'ETH-USDT')",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "BUY = get base token, SELL = sell base token",
        },
        amount: {
          type: "number",
          description: "Amount to swap (BUY: base amount to receive, SELL: base amount to sell)",
        },
        slippage_pct: {
          type: "number",
          description: "Max slippage percentage (default: 1.0)",
          default: 1.0,
        },
      },
      required: ["connector", "network", "trading_pair", "side", "amount"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        base: { type: "string" },
        quote: { type: "string" },
        side: { type: "string" },
        price: { type: "number" },
        amountIn: { type: "number", description: "Input amount" },
        amountOut: { type: "number", description: "Expected output amount" },
        slippagePct: { type: "number" },
        gasEstimate: { type: "number" },
        connector: { type: "string" },
        network: { type: "string" },
        timestamp: { type: "string" },
      },
    },
  },

  {
    name: "get_clmm_pool_info",
    description: `🌊 DeFi: Get detailed CLMM (Concentrated Liquidity) pool information.

Returns:
- Current pool price
- Total liquidity (base + quote tokens)
- Fee tier
- Active bin (for DLMM)
- Liquidity distribution

Supported protocols:
- Meteora (Solana DLMM)
- Raydium (Solana CLMM)

Perfect for: LP analysis, yield farming research, liquidity provision planning.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector: {
          type: "string",
          enum: ["meteora", "raydium"],
          description: "CLMM protocol",
        },
        network: {
          type: "string",
          description: "Network (e.g., 'solana-mainnet-beta')",
          default: "solana-mainnet-beta",
        },
        pool_address: {
          type: "string",
          description: "Pool contract address",
        },
      },
      required: ["connector", "pool_address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        price: { type: "number" },
        baseTokenAddress: { type: "string" },
        quoteTokenAddress: { type: "string" },
        baseTokenAmount: { type: "number" },
        quoteTokenAmount: { type: "number" },
        totalValueLocked: { type: "number", description: "Estimated TVL in quote token" },
        feePct: { type: "number" },
        dynamicFeePct: { type: "number" },
        binStep: { type: "number", description: "Meteora DLMM bin step" },
        activeBinId: { type: "number" },
        timestamp: { type: "string" },
      },
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER 2: RAW DATA TOOLS - Direct market data access
  // ═══════════════════════════════════════════════════════════════════════════

  {
    name: "get_prices",
    description: `📊 Get current prices for multiple trading pairs on an exchange.

Fast batch price lookup for portfolio valuation or price comparison.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector",
        },
        trading_pairs: {
          type: "array",
          items: { type: "string" },
          description: "Array of trading pairs (e.g., ['BTC-USDT', 'ETH-USDT', 'SOL-USDT'])",
        },
      },
      required: ["connector_name", "trading_pairs"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        prices: { type: "object", additionalProperties: { type: "number" } },
        connector: { type: "string" },
        fetchedAt: { type: "string" },
      },
    },
  },

  {
    name: "get_market_candles",
    description: `📈 Get real-time OHLCV candlestick data for technical analysis.

Returns recent candles with open, high, low, close, volume data.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector (e.g., 'binance', 'kucoin')",
        },
        trading_pair: {
          type: "string",
          description: "Trading pair (e.g., 'BTC-USDT')",
        },
        interval: {
          type: "string",
          description: "Candle interval: 1m, 3m, 5m, 15m, 30m, 1h, 4h, 1d",
          default: "1h",
        },
        max_records: {
          type: "number",
          description: "Number of candles to return (max 500)",
          default: 100,
        },
      },
      required: ["connector_name", "trading_pair"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        candles: { type: "array", items: { type: "object" } },
        tradingPair: { type: "string" },
        connector: { type: "string" },
        interval: { type: "string" },
        fetchedAt: { type: "string" },
      },
    },
  },

  {
    name: "get_historical_candles",
    description: `📈 Get historical OHLCV data for a specific time range.

Useful for backtesting analysis or historical price research.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector",
        },
        trading_pair: {
          type: "string",
          description: "Trading pair",
        },
        interval: {
          type: "string",
          description: "Candle interval",
          default: "1h",
        },
        start_time: {
          type: "number",
          description: "Start time in SECONDS since epoch (Unix timestamp)",
        },
        end_time: {
          type: "number",
          description: "End time in SECONDS since epoch (Unix timestamp)",
        },
      },
      required: ["connector_name", "trading_pair", "start_time", "end_time"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        candles: { type: "array", items: { type: "object" } },
        tradingPair: { type: "string" },
        connector: { type: "string" },
        interval: { type: "string" },
        fetchedAt: { type: "string" },
      },
    },
  },

  {
    name: "get_order_book",
    description: `📖 Get raw order book snapshot with bids and asks.

Returns top N price levels from the order book.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Exchange connector",
        },
        trading_pair: {
          type: "string",
          description: "Trading pair",
        },
        depth: {
          type: "number",
          description: "Number of price levels (1-1000, default: 20)",
          default: 20,
        },
      },
      required: ["connector_name", "trading_pair"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tradingPair: { type: "string" },
        bids: { type: "array", items: { type: "object", properties: { price: { type: "number" }, amount: { type: "number" } } } },
        asks: { type: "array", items: { type: "object", properties: { price: { type: "number" }, amount: { type: "number" } } } },
        timestamp: { type: "number" },
        fetchedAt: { type: "string" },
      },
    },
  },

  {
    name: "get_funding_rates",
    description: `📉 Get raw funding rate data for perpetual futures.

Returns current funding rate, mark/index prices, and next funding time.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        connector_name: {
          type: "string",
          description: "Perpetual futures connector",
        },
        trading_pair: {
          type: "string",
          description: "Perpetual trading pair",
        },
      },
      required: ["connector_name", "trading_pair"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tradingPair: { type: "string" },
        fundingRate: { type: "number" },
        nextFundingTime: { type: "number" },
        markPrice: { type: "number" },
        indexPrice: { type: "number" },
        fetchedAt: { type: "string" },
      },
    },
  },

  {
    name: "get_connectors",
    description: `📋 List all supported exchange connectors.

Returns categorized list of spot, perpetual, and DEX connectors available.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        connectors: { type: "array", items: { type: "string" } },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
    },
  },
];

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_asset_volume?: number;
  n_trades?: number;
}

interface OrderBookLevel {
  price: number;
  amount: number;
}

interface OrderBookData {
  trading_pair: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

interface OrderBookQueryResult {
  trading_pair: string;
  is_buy: boolean;
  query_volume?: number;
  result_price?: number;
  result_volume?: number;
  result_quote_volume?: number;
  average_price?: number;
  timestamp: number;
}

interface FundingInfoResponse {
  trading_pair: string;
  funding_rate: number | null;
  next_funding_time: number | null;
  mark_price: number | null;
  index_price: number | null;
}

interface SwapQuoteResponse {
  base: string;
  quote: string;
  price: string;
  amount: string;
  amount_in?: string;
  amount_out?: string;
  slippage_pct: string;
  gas_estimate?: string;
}

interface CLMMPoolInfoResponse {
  address: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  price: string;
  baseTokenAmount: string;
  quoteTokenAmount: string;
  feePct: string;
  dynamicFeePct?: string;
  binStep?: number;
  activeBinId?: number;
}

// ============================================================================
// TOOL IMPLEMENTATIONS
// ============================================================================

async function analyzeTradeImpact(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const connectorName = args.connector_name as string;
    const tradingPair = args.trading_pair as string;
    const side = args.side as string;
    const amount = args.amount as number;
    const isBuy = side.toUpperCase() === "BUY";

    // Get VWAP for the specified volume
    const vwapResult = await hbFetch<OrderBookQueryResult>("/market-data/order-book/vwap-for-volume", {
      method: "POST",
      body: {
        connector_name: connectorName,
        trading_pair: tradingPair,
        is_buy: isBuy,
        volume: amount,
      },
    });

    // Also get order book for spread info
    const orderBook = await hbFetch<OrderBookData>("/market-data/order-book", {
      method: "POST",
      body: {
        connector_name: connectorName,
        trading_pair: tradingPair,
        depth: 5,
      },
    });

    const bestBid = orderBook.bids[0]?.price || 0;
    const bestAsk = orderBook.asks[0]?.price || 0;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = midPrice > 0 ? (spread / midPrice) * 100 : 0;

    const vwap = vwapResult.average_price || vwapResult.result_price || midPrice;
    const priceImpact = isBuy 
      ? ((vwap - midPrice) / midPrice) * 100 
      : ((midPrice - vwap) / midPrice) * 100;

    return successResult({
      tradingPair,
      connector: connectorName,
      side: side.toUpperCase(),
      requestedAmount: amount,
      vwap: Number(vwap.toFixed(8)),
      priceImpactPct: Number(priceImpact.toFixed(4)),
      totalQuoteVolume: Number((vwapResult.result_quote_volume || amount * vwap).toFixed(2)),
      midPrice: Number(midPrice.toFixed(8)),
      spread: {
        absolute: Number(spread.toFixed(8)),
        percentage: Number(spreadPct.toFixed(4)),
      },
      sufficientLiquidity: vwapResult.result_volume !== null && vwapResult.result_volume !== undefined,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Trade impact analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function analyzeMarketDepth(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const connectorName = args.connector_name as string;
    const tradingPair = args.trading_pair as string;
    const tradeSizesUsd = (args.trade_sizes_usd as number[]) || [1000, 10000, 50000, 100000];

    // Get order book
    const orderBook = await hbFetch<OrderBookData>("/market-data/order-book", {
      method: "POST",
      body: {
        connector_name: connectorName,
        trading_pair: tradingPair,
        depth: 100,
      },
    });

    if (!orderBook.bids?.length || !orderBook.asks?.length) {
      return errorResult("No order book data available");
    }

    const bestBid = orderBook.bids[0].price;
    const bestAsk = orderBook.asks[0].price;
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadPct = (spread / midPrice) * 100;

    // Calculate depth
    const bidDepthUsd = orderBook.bids.reduce((sum, level) => sum + level.price * level.amount, 0);
    const askDepthUsd = orderBook.asks.reduce((sum, level) => sum + level.price * level.amount, 0);

    // Analyze impact at each trade size
    const impactAnalysis = await Promise.all(
      tradeSizesUsd.map(async (sizeUsd) => {
        const baseAmount = sizeUsd / midPrice;
        
        try {
          // Get VWAP for buy and sell
          const [buyVwap, sellVwap] = await Promise.all([
            hbFetch<OrderBookQueryResult>("/market-data/order-book/vwap-for-volume", {
              method: "POST",
              body: { connector_name: connectorName, trading_pair: tradingPair, is_buy: true, volume: baseAmount },
            }),
            hbFetch<OrderBookQueryResult>("/market-data/order-book/vwap-for-volume", {
              method: "POST",
              body: { connector_name: connectorName, trading_pair: tradingPair, is_buy: false, volume: baseAmount },
            }),
          ]);

          const buyPrice = buyVwap.average_price || buyVwap.result_price || bestAsk;
          const sellPrice = sellVwap.average_price || sellVwap.result_price || bestBid;

          const buyImpact = ((buyPrice - midPrice) / midPrice) * 100;
          const sellImpact = ((midPrice - sellPrice) / midPrice) * 100;

          return {
            sizeUsd,
            baseAmount: Number(baseAmount.toFixed(6)),
            buyImpactPct: Number(buyImpact.toFixed(4)),
            sellImpactPct: Number(sellImpact.toFixed(4)),
            buyVwap: Number(buyPrice.toFixed(8)),
            sellVwap: Number(sellPrice.toFixed(8)),
            hasBuyLiquidity: buyVwap.result_volume !== null,
            hasSellLiquidity: sellVwap.result_volume !== null,
          };
        } catch {
          return {
            sizeUsd,
            baseAmount: Number(baseAmount.toFixed(6)),
            buyImpactPct: null,
            sellImpactPct: null,
            error: "Insufficient data",
          };
        }
      })
    );

    // Calculate liquidity grade
    let liquidityGrade = "A";
    if (spreadPct > 0.5) liquidityGrade = "B";
    if (spreadPct > 1.0 || bidDepthUsd < 50000) liquidityGrade = "C";
    if (spreadPct > 2.0 || bidDepthUsd < 10000) liquidityGrade = "D";
    if (spreadPct > 5.0 || bidDepthUsd < 1000) liquidityGrade = "F";

    return successResult({
      tradingPair,
      connector: connectorName,
      midPrice: Number(midPrice.toFixed(8)),
      spread: {
        absolute: Number(spread.toFixed(8)),
        percentage: Number(spreadPct.toFixed(4)),
      },
      depth: {
        bidDepthUsd: Number(bidDepthUsd.toFixed(2)),
        askDepthUsd: Number(askDepthUsd.toFixed(2)),
        bidLevels: orderBook.bids.length,
        askLevels: orderBook.asks.length,
      },
      impactAnalysis,
      liquidityGrade,
      liquidityGradeExplanation: {
        A: "Excellent - tight spread, deep books",
        B: "Good - moderate spread/depth",
        C: "Fair - wider spread or shallow books",
        D: "Poor - wide spread and/or low depth",
        F: "Very Poor - illiquid market",
      }[liquidityGrade],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Market depth analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function analyzeFundingSentiment(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const connectorName = args.connector_name as string;
    const tradingPair = args.trading_pair as string;

    const funding = await hbFetch<FundingInfoResponse>("/market-data/funding-info", {
      method: "POST",
      body: {
        connector_name: connectorName,
        trading_pair: tradingPair,
      },
    });

    const fundingRate = funding.funding_rate || 0;
    const fundingRatePct = fundingRate * 100;
    // Most perps have 8-hour funding = 3x per day = 1095x per year
    const annualizedRate = fundingRatePct * 3 * 365;

    // Determine sentiment
    let sentiment: string;
    let sentimentExplanation: string;

    if (fundingRatePct > 0.1) {
      sentiment = "Extremely Bullish";
      sentimentExplanation = "Very high positive funding - longs paying shorts heavily. Market may be overleveraged long.";
    } else if (fundingRatePct > 0.03) {
      sentiment = "Bullish";
      sentimentExplanation = "Positive funding - more long demand. Longs pay shorts to hold positions.";
    } else if (fundingRatePct > -0.03) {
      sentiment = "Neutral";
      sentimentExplanation = "Funding near zero - balanced long/short demand.";
    } else if (fundingRatePct > -0.1) {
      sentiment = "Bearish";
      sentimentExplanation = "Negative funding - more short demand. Shorts pay longs to hold positions.";
    } else {
      sentiment = "Extremely Bearish";
      sentimentExplanation = "Very high negative funding - shorts paying longs heavily. Market may be overleveraged short.";
    }

    const markPrice = funding.mark_price || 0;
    const indexPrice = funding.index_price || 0;
    const premiumPct = indexPrice > 0 ? ((markPrice - indexPrice) / indexPrice) * 100 : 0;

    // Calculate time until next funding
    const nextFundingMs = funding.next_funding_time || 0;
    const now = Date.now();
    const hoursUntilFunding = nextFundingMs > now ? (nextFundingMs - now) / (1000 * 60 * 60) : 0;

    return successResult({
      tradingPair,
      connector: connectorName,
      fundingRate: Number(fundingRate.toFixed(8)),
      fundingRatePct: Number(fundingRatePct.toFixed(4)),
      annualizedRatePct: Number(annualizedRate.toFixed(2)),
      sentiment,
      sentimentExplanation,
      markPrice: Number((markPrice || 0).toFixed(8)),
      indexPrice: Number((indexPrice || 0).toFixed(8)),
      markIndexPremiumPct: Number(premiumPct.toFixed(4)),
      nextFundingTime: nextFundingMs ? new Date(nextFundingMs).toISOString() : null,
      hoursUntilFunding: Number(hoursUntilFunding.toFixed(2)),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Funding analysis failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function getDexSwapQuote(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const connector = args.connector as string;
    const network = args.network as string;
    const tradingPair = args.trading_pair as string;
    const side = args.side as string;
    const amount = args.amount as number;
    const slippagePct = (args.slippage_pct as number) || 1.0;

    const quote = await hbFetch<SwapQuoteResponse>("/gateway/swap/quote", {
      method: "POST",
      body: {
        connector,
        network,
        trading_pair: tradingPair,
        side: side.toUpperCase(),
        amount,
        slippage_pct: slippagePct,
      },
    });

    return successResult({
      base: quote.base,
      quote: quote.quote,
      side: side.toUpperCase(),
      price: Number(quote.price),
      amountIn: Number(quote.amount_in || amount),
      amountOut: Number(quote.amount_out || 0),
      slippagePct: Number(quote.slippage_pct),
      gasEstimate: quote.gas_estimate ? Number(quote.gas_estimate) : null,
      connector,
      network,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Swap quote failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function getClmmPoolInfo(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const connector = args.connector as string;
    const network = (args.network as string) || "solana-mainnet-beta";
    const poolAddress = args.pool_address as string;

    const pool = await hbFetch<CLMMPoolInfoResponse>("/gateway/clmm/pool-info", {
      params: {
        connector,
        network,
        pool_address: poolAddress,
      },
    });

    const baseAmount = Number(pool.baseTokenAmount);
    const quoteAmount = Number(pool.quoteTokenAmount);
    const price = Number(pool.price);
    const tvl = quoteAmount + (baseAmount * price);

    return successResult({
      address: pool.address,
      price: Number(pool.price),
      baseTokenAddress: pool.baseTokenAddress,
      quoteTokenAddress: pool.quoteTokenAddress,
      baseTokenAmount: baseAmount,
      quoteTokenAmount: quoteAmount,
      totalValueLocked: Number(tvl.toFixed(2)),
      feePct: Number(pool.feePct),
      dynamicFeePct: pool.dynamicFeePct ? Number(pool.dynamicFeePct) : null,
      binStep: pool.binStep || null,
      activeBinId: pool.activeBinId || null,
      connector,
      network,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Pool info failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// GIGA-BRAIN TOOL IMPLEMENTATIONS
// ============================================================================

async function findBestExecution(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const baseAsset = (args.base_asset as string).toUpperCase();
    const quoteAsset = ((args.quote_asset as string) || "USDT").toUpperCase();
    const side = (args.side as string).toUpperCase();
    const amount = args.amount as number;
    const tradingPair = `${baseAsset}-${quoteAsset}`;
    const isBuy = side === "BUY";

    // Query all exchanges in parallel
    const exchangeResults = await Promise.allSettled(
      TOP_SPOT_EXCHANGES.map(async (exchange) => {
        try {
          const vwap = await hbFetch<OrderBookQueryResult>("/market-data/order-book/vwap-for-volume", {
            method: "POST",
            body: {
              connector_name: exchange,
              trading_pair: tradingPair,
              is_buy: isBuy,
              volume: amount,
            },
          });

          const orderBook = await hbFetch<OrderBookData>("/market-data/order-book", {
            method: "POST",
            body: { connector_name: exchange, trading_pair: tradingPair, depth: 5 },
          });

          const midPrice = (orderBook.bids[0]?.price + orderBook.asks[0]?.price) / 2;
          const effectivePrice = vwap.average_price || vwap.result_price || midPrice;
          const slippage = isBuy
            ? ((effectivePrice - midPrice) / midPrice) * 100
            : ((midPrice - effectivePrice) / midPrice) * 100;

          return {
            exchange,
            effectivePrice: Number(effectivePrice.toFixed(8)),
            midPrice: Number(midPrice.toFixed(8)),
            slippagePct: Number(slippage.toFixed(4)),
            totalCost: Number((amount * effectivePrice).toFixed(2)),
            available: true,
          };
        } catch (e) {
          return { exchange, available: false, error: (e as Error).message.slice(0, 50) };
        }
      })
    );

    // Process results
    const results = exchangeResults
      .filter((r): r is PromiseFulfilledResult<{ exchange: string; effectivePrice: number; midPrice: number; slippagePct: number; totalCost: number; available: boolean }> => 
        r.status === "fulfilled" && r.value.available)
      .map(r => r.value)
      .sort((a, b) => isBuy ? a.effectivePrice - b.effectivePrice : b.effectivePrice - a.effectivePrice);

    if (results.length === 0) {
      return errorResult(`No exchanges have liquidity for ${tradingPair}`);
    }

    const best = results[0];
    const worst = results[results.length - 1];
    const savingsPerUnit = isBuy ? worst.effectivePrice - best.effectivePrice : best.effectivePrice - worst.effectivePrice;

    return successResult({
      query: { baseAsset, quoteAsset, side, amount, tradingPair },
      recommendations: results.map((r, i) => ({
        rank: i + 1,
        exchange: r.exchange,
        effectivePrice: r.effectivePrice,
        slippagePct: r.slippagePct,
        totalCost: r.totalCost,
        savingsVsBest: i === 0 ? 0 : Number((Math.abs(r.effectivePrice - best.effectivePrice) * amount).toFixed(2)),
      })),
      bestExchange: best.exchange,
      worstExchange: worst.exchange,
      savingsVsWorst: {
        perUnit: Number(savingsPerUnit.toFixed(8)),
        total: Number((savingsPerUnit * amount).toFixed(2)),
        percentage: Number((savingsPerUnit / worst.effectivePrice * 100).toFixed(4)),
      },
      exchangesChecked: TOP_SPOT_EXCHANGES.length,
      exchangesWithLiquidity: results.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Best execution search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function compareSwapRoutes(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const baseAsset = (args.base_asset as string).toUpperCase();
    const quoteAsset = (args.quote_asset as string).toUpperCase();
    const amount = args.amount as number;

    // Map common assets to Solana format for Jupiter
    const solanaBase = baseAsset === "SOL" ? "SOL" : baseAsset;
    const solanaQuote = quoteAsset === "USDC" ? "USDC" : quoteAsset === "USDT" ? "USDT" : quoteAsset;
    const solanaPair = `${solanaBase}-${solanaQuote}`;

    // CEX format
    const cexPair = `${baseAsset}-${quoteAsset === "USDC" ? "USDT" : quoteAsset}`;

    // Get DEX quote (Jupiter)
    let dexResult: { price: number; amountIn: number; available: boolean; error?: string } = { price: 0, amountIn: 0, available: false };
    try {
      const jupiterQuote = await hbFetch<SwapQuoteResponse>("/gateway/swap/quote", {
        method: "POST",
        body: {
          connector: "jupiter",
          network: "solana-mainnet-beta",
          trading_pair: solanaPair,
          side: "BUY",
          amount,
          slippage_pct: 1.0,
        },
      });
      dexResult = {
        price: Number(jupiterQuote.price),
        amountIn: Number(jupiterQuote.amount_in || 0),
        available: true,
      };
    } catch (e) {
      dexResult = { price: 0, amountIn: 0, available: false, error: (e as Error).message.slice(0, 50) };
    }

    // Get CEX quote (Binance)
    let cexResult: { price: number; amountIn: number; available: boolean; error?: string } = { price: 0, amountIn: 0, available: false };
    try {
      const vwap = await hbFetch<OrderBookQueryResult>("/market-data/order-book/vwap-for-volume", {
        method: "POST",
        body: {
          connector_name: "binance",
          trading_pair: cexPair,
          is_buy: true,
          volume: amount,
        },
      });
      const effectivePrice = vwap.average_price || vwap.result_price || 0;
      cexResult = {
        price: effectivePrice,
        amountIn: Number((amount * effectivePrice).toFixed(2)),
        available: effectivePrice > 0,
      };
    } catch (e) {
      cexResult = { price: 0, amountIn: 0, available: false, error: (e as Error).message.slice(0, 50) };
    }

    // Compare
    let comparison: Record<string, unknown> = {};
    let recommendation = "";

    if (dexResult.available && cexResult.available) {
      const priceDiff = dexResult.price - cexResult.price;
      const priceDiffPct = (priceDiff / cexResult.price) * 100;
      const costDiff = dexResult.amountIn - cexResult.amountIn;
      
      comparison = {
        priceDifferencePct: Number(priceDiffPct.toFixed(4)),
        costDifference: Number(costDiff.toFixed(2)),
        cheaperVenue: priceDiff < 0 ? "DEX (Jupiter)" : "CEX (Binance)",
        savings: Number(Math.abs(costDiff).toFixed(2)),
      };

      recommendation = Math.abs(priceDiffPct) < 0.1
        ? "Prices are nearly identical - use whichever is more convenient"
        : priceDiff < 0
          ? `DEX (Jupiter) is ${Math.abs(priceDiffPct).toFixed(2)}% cheaper - save $${Math.abs(costDiff).toFixed(2)}`
          : `CEX (Binance) is ${Math.abs(priceDiffPct).toFixed(2)}% cheaper - save $${Math.abs(costDiff).toFixed(2)}`;
    } else if (dexResult.available) {
      recommendation = "Only DEX (Jupiter) has liquidity - use Jupiter";
    } else if (cexResult.available) {
      recommendation = "Only CEX (Binance) has liquidity - use Binance";
    } else {
      recommendation = "Neither venue has liquidity for this pair";
    }

    return successResult({
      query: { baseAsset, quoteAsset, amount },
      dex: {
        venue: "Jupiter (Solana)",
        pair: solanaPair,
        available: dexResult.available,
        price: dexResult.available ? dexResult.price : null,
        totalCost: dexResult.available ? dexResult.amountIn : null,
        error: dexResult.error,
      },
      cex: {
        venue: "Binance",
        pair: cexPair,
        available: cexResult.available,
        price: cexResult.available ? cexResult.price : null,
        totalCost: cexResult.available ? cexResult.amountIn : null,
        error: cexResult.error,
      },
      comparison,
      recommendation,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Swap route comparison failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function scanFundingOpportunities(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const pairs = (args.pairs as string[]) || ["BTC-USDT", "ETH-USDT", "SOL-USDT", "DOGE-USDT", "XRP-USDT"];
    const exchanges = (args.exchanges as string[]) || TOP_PERP_EXCHANGES;

    // Scan all pairs on all exchanges
    const scanResults = await Promise.allSettled(
      pairs.flatMap(pair =>
        exchanges.map(async exchange => {
          try {
            // Some exchanges use different pair formats
            let adjustedPair = pair;
            if (exchange === "hyperliquid_perpetual") {
              adjustedPair = pair.replace("-USDT", "-USD");
            }

            const funding = await hbFetch<FundingInfoResponse>("/market-data/funding-info", {
              method: "POST",
              body: { connector_name: exchange, trading_pair: adjustedPair },
            });

            const rate = funding.funding_rate || 0;
            const ratePct = rate * 100;
            const annualized = ratePct * 3 * 365;

            return {
              pair,
              exchange,
              fundingRate: rate,
              fundingRatePct: Number(ratePct.toFixed(4)),
              annualizedPct: Number(annualized.toFixed(2)),
              markPrice: funding.mark_price,
              sentiment: ratePct > 0.05 ? "Bullish" : ratePct < -0.05 ? "Bearish" : "Neutral",
              available: true,
            };
          } catch {
            return { pair, exchange, available: false };
          }
        })
      )
    );

    // Filter and sort results
    const validResults = scanResults
      .filter((r): r is PromiseFulfilledResult<{ pair: string; exchange: string; fundingRate: number; fundingRatePct: number; annualizedPct: number; markPrice: number | null; sentiment: string; available: boolean }> => 
        r.status === "fulfilled" && r.value.available)
      .map(r => r.value);

    // Sort by absolute funding rate
    const sortedByRate = [...validResults].sort((a, b) => Math.abs(b.fundingRatePct) - Math.abs(a.fundingRatePct));

    // Find best opportunities
    const longOpportunities = validResults.filter(r => r.fundingRatePct < -0.01).sort((a, b) => a.fundingRatePct - b.fundingRatePct);
    const shortOpportunities = validResults.filter(r => r.fundingRatePct > 0.01).sort((a, b) => b.fundingRatePct - a.fundingRatePct);

    // Overall market sentiment
    const avgFunding = validResults.length > 0
      ? validResults.reduce((sum, r) => sum + r.fundingRatePct, 0) / validResults.length
      : 0;
    const marketSentiment = avgFunding > 0.02 ? "Bullish (longs paying)" : avgFunding < -0.02 ? "Bearish (shorts paying)" : "Neutral";

    return successResult({
      scannedPairs: pairs.length,
      scannedExchanges: exchanges.length,
      resultsFound: validResults.length,
      opportunities: sortedByRate.slice(0, 15).map(r => ({
        pair: r.pair,
        exchange: r.exchange,
        fundingRatePct: r.fundingRatePct,
        annualizedPct: r.annualizedPct,
        opportunity: r.fundingRatePct > 0.03 
          ? `🔥 Short opportunity - earn ${r.annualizedPct}% APR` 
          : r.fundingRatePct < -0.03
            ? `🔥 Long opportunity - earn ${Math.abs(r.annualizedPct)}% APR`
            : "Normal",
      })),
      topLongOpportunity: longOpportunities[0] ? {
        found: true,
        pair: longOpportunities[0].pair,
        exchange: longOpportunities[0].exchange,
        fundingRatePct: longOpportunities[0].fundingRatePct,
        annualizedPct: longOpportunities[0].annualizedPct,
        reason: "Negative funding - longs get paid",
      } : { found: false, reason: "No significant long opportunities found" },
      topShortOpportunity: shortOpportunities[0] ? {
        found: true,
        pair: shortOpportunities[0].pair,
        exchange: shortOpportunities[0].exchange,
        fundingRatePct: shortOpportunities[0].fundingRatePct,
        annualizedPct: shortOpportunities[0].annualizedPct,
        reason: "Positive funding - shorts get paid",
      } : { found: false, reason: "No significant short opportunities found" },
      marketSentiment,
      averageFundingPct: Number(avgFunding.toFixed(4)),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Funding scan failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

interface MeteoraPool {
  address: string;
  name: string;
  trading_pair: string;
  current_price: string;
  liquidity: string;
  apr: string;
  apy: string;
  volume_24h: string;
  fees_24h: string;
  base_fee_percentage: string;
  bin_step: number;
  is_verified: boolean;
}

async function findYieldPools(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const token = (args.token as string).toUpperCase();
    const minTvl = (args.min_tvl as number) || 10000;
    const limit = (args.limit as number) || 10;

    // Fetch Meteora pools
    const poolsResponse = await hbFetch<{ pools: MeteoraPool[]; total: number }>("/gateway/clmm/pools", {
      params: {
        connector: "meteora",
        network: "solana-mainnet-beta",
      },
    });

    // Filter pools containing the token
    const relevantPools = poolsResponse.pools
      .filter(p => {
        const pair = p.trading_pair || p.name || "";
        return pair.includes(token) && Number(p.liquidity) >= minTvl && p.is_verified;
      })
      .map(p => ({
        address: p.address,
        pair: p.trading_pair || p.name,
        price: Number(p.current_price),
        tvl: Number(p.liquidity),
        apr: Number(p.apr) * 100, // Convert to percentage
        apy: Number(p.apy),
        volume24h: Number(p.volume_24h),
        fees24h: Number(p.fees_24h),
        feeRate: Number(p.base_fee_percentage),
        binStep: p.bin_step,
      }))
      .sort((a, b) => b.apy - a.apy)
      .slice(0, limit);

    if (relevantPools.length === 0) {
      return successResult({
        token,
        poolsFound: 0,
        message: `No verified pools found for ${token} with TVL >= $${minTvl.toLocaleString()}`,
        timestamp: new Date().toISOString(),
      });
    }

    const bestPool = relevantPools[0];

    return successResult({
      token,
      poolsFound: relevantPools.length,
      topPools: relevantPools.map((p, i) => ({
        rank: i + 1,
        pair: p.pair,
        apy: `${p.apy.toFixed(2)}%`,
        apr: `${p.apr.toFixed(2)}%`,
        tvl: `$${p.tvl.toLocaleString()}`,
        volume24h: `$${p.volume24h.toLocaleString()}`,
        fees24h: `$${p.fees24h.toFixed(2)}`,
        feeRate: `${p.feeRate}%`,
        address: p.address,
      })),
      bestApy: {
        pair: bestPool.pair,
        apy: `${bestPool.apy.toFixed(2)}%`,
        tvl: `$${bestPool.tvl.toLocaleString()}`,
        address: bestPool.address,
      },
      protocol: "Meteora DLMM",
      network: "Solana",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Yield pool search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function findArbitrage(args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    const baseAsset = (args.base_asset as string).toUpperCase();
    const quoteAsset = ((args.quote_asset as string) || "USDT").toUpperCase();
    const tradingPair = `${baseAsset}-${quoteAsset}`;

    // Get prices from all exchanges
    const priceResults = await Promise.allSettled(
      TOP_SPOT_EXCHANGES.map(async exchange => {
        try {
          const result = await hbFetch<{ prices: Record<string, number> }>("/market-data/prices", {
            method: "POST",
            body: {
              connector_name: exchange,
              trading_pairs: [tradingPair],
            },
          });
          const price = result.prices?.[tradingPair];
          return { exchange, price: price || 0, available: price !== undefined && price > 0 };
        } catch {
          return { exchange, price: 0, available: false };
        }
      })
    );

    const validPrices = priceResults
      .filter((r): r is PromiseFulfilledResult<{ exchange: string; price: number; available: boolean }> => 
        r.status === "fulfilled" && r.value.available)
      .map(r => r.value)
      .sort((a, b) => a.price - b.price);

    if (validPrices.length < 2) {
      return errorResult(`Need at least 2 exchanges with prices for ${tradingPair}`);
    }

    const lowest = validPrices[0];
    const highest = validPrices[validPrices.length - 1];
    const spread = highest.price - lowest.price;
    const spreadPct = (spread / lowest.price) * 100;

    // Calculate potential profit (assuming 0.1% fee per trade)
    const feesPct = 0.2; // 0.1% buy + 0.1% sell
    const netProfitPct = spreadPct - feesPct;

    let recommendation = "";
    if (netProfitPct > 0.5) {
      recommendation = `🔥 ARBITRAGE OPPORTUNITY: Buy on ${lowest.exchange}, sell on ${highest.exchange} for ~${netProfitPct.toFixed(2)}% profit after fees`;
    } else if (netProfitPct > 0) {
      recommendation = `Small arbitrage possible (${netProfitPct.toFixed(2)}% after fees) - may not be worth gas/transfer costs`;
    } else {
      recommendation = "No profitable arbitrage after fees";
    }

    return successResult({
      pair: tradingPair,
      prices: validPrices.map(p => ({
        exchange: p.exchange,
        price: Number(p.price.toFixed(8)),
      })),
      arbitrage: {
        lowestPrice: { exchange: lowest.exchange, price: Number(lowest.price.toFixed(8)) },
        highestPrice: { exchange: highest.exchange, price: Number(highest.price.toFixed(8)) },
        spreadAbsolute: Number(spread.toFixed(8)),
        spreadPct: Number(spreadPct.toFixed(4)),
        estimatedFeesPct: feesPct,
        netProfitPct: Number(netProfitPct.toFixed(4)),
        profitPer1000Usd: Number((10 * netProfitPct).toFixed(2)),
      },
      recommendation,
      exchangesChecked: TOP_SPOT_EXCHANGES.length,
      exchangesWithPrice: validPrices.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Arbitrage search failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "hummingbot-market-intel", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        // GIGA-BRAIN Tools
        case "find_best_execution":
          return await findBestExecution(args || {});

        case "compare_swap_routes":
          return await compareSwapRoutes(args || {});

        case "scan_funding_opportunities":
          return await scanFundingOpportunities(args || {});

        case "find_yield_pools":
          return await findYieldPools(args || {});

        case "find_arbitrage":
          return await findArbitrage(args || {});

        // TIER 1: Intelligence Tools
        case "analyze_trade_impact":
          return await analyzeTradeImpact(args || {});

        case "analyze_market_depth":
          return await analyzeMarketDepth(args || {});

        case "analyze_funding_sentiment":
          return await analyzeFundingSentiment(args || {});

        case "get_dex_swap_quote":
          return await getDexSwapQuote(args || {});

        case "get_clmm_pool_info":
          return await getClmmPoolInfo(args || {});

        // TIER 2: Raw Data Tools
        case "get_prices": {
          const connectorName = args?.connector_name as string;
          const tradingPairs = args?.trading_pairs as string[];
          
          const result = await hbFetch<{ prices: Record<string, number> }>("/market-data/prices", {
            method: "POST",
            body: {
              connector_name: connectorName,
              trading_pairs: tradingPairs,
            },
          });

          return successResult({
            prices: result.prices || {},
            connector: connectorName,
            pairCount: Object.keys(result.prices || {}).length,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_market_candles": {
          const candles = await hbFetch<CandleData[]>("/market-data/candles", {
            method: "POST",
            body: {
              connector_name: args?.connector_name,
              trading_pair: args?.trading_pair,
              interval: args?.interval || "1h",
              max_records: args?.max_records || 100,
            },
          });
          return successResult({
            candles: candles.map(c => ({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })),
            tradingPair: args?.trading_pair as string,
            connector: args?.connector_name as string,
            interval: (args?.interval as string) || "1h",
            candleCount: candles.length,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_historical_candles": {
          const candles = await hbFetch<CandleData[]>("/market-data/historical-candles", {
            method: "POST",
            body: {
              connector_name: args?.connector_name,
              trading_pair: args?.trading_pair,
              interval: args?.interval || "1h",
              start_time: args?.start_time,
              end_time: args?.end_time,
            },
          });
          return successResult({
            candles: candles.map(c => ({
              timestamp: c.timestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
            })),
            tradingPair: args?.trading_pair as string,
            connector: args?.connector_name as string,
            interval: (args?.interval as string) || "1h",
            candleCount: candles.length,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_order_book": {
          const orderBook = await hbFetch<OrderBookData>("/market-data/order-book", {
            method: "POST",
            body: {
              connector_name: args?.connector_name,
              trading_pair: args?.trading_pair,
              depth: args?.depth || 20,
            },
          });
          return successResult({
            tradingPair: orderBook.trading_pair,
            bids: orderBook.bids,
            asks: orderBook.asks,
            timestamp: orderBook.timestamp,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_funding_rates": {
          const funding = await hbFetch<FundingInfoResponse>("/market-data/funding-info", {
            method: "POST",
            body: {
              connector_name: args?.connector_name,
              trading_pair: args?.trading_pair,
            },
          });
          return successResult({
            tradingPair: funding.trading_pair,
            fundingRate: funding.funding_rate,
            nextFundingTime: funding.next_funding_time,
            markPrice: funding.mark_price,
            indexPrice: funding.index_price,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_connectors": {
          const connectors = await hbFetch<string[]>("/connectors/");
          return successResult({
            connectors,
            count: connectors.length,
            fetchedAt: new Date().toISOString(),
          });
        }

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Unknown error");
    }
  }
);

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

// Auth middleware using @ctxprotocol/sdk
const verifyContextAuth = createContextMiddleware();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "hummingbot-market-intel",
    version: "3.0.0",
    scope: "Public Market Data + Multi-Exchange Intelligence",
    hummingbotApiUrl: HUMMINGBOT_API_BASE_URL,
    toolCount: TOOLS.length,
    gigaBrainTools: ["find_best_execution", "compare_swap_routes", "scan_funding_opportunities", "find_yield_pools", "find_arbitrage"],
    tools: TOOLS.map(t => t.name),
  });
});

// Streamable HTTP endpoint
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

const port = Number(process.env.PORT || 4009);
app.listen(port, () => {
  console.log(`\n🧠 Hummingbot Market Intelligence MCP Server v3.0.0`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📊 Scope: Multi-Exchange Intelligence + DeFi`);
  console.log(`📡 Hummingbot API: ${HUMMINGBOT_API_BASE_URL}`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`\n🛠️  Tools (${TOOLS.length} total):`);
  console.log(`   🧠 GIGA-BRAIN: find_best_execution, compare_swap_routes, scan_funding_opportunities, find_yield_pools, find_arbitrage`);
  console.log(`   📊 Intelligence: analyze_trade_impact, analyze_market_depth, analyze_funding_sentiment, get_dex_swap_quote, get_clmm_pool_info`);
  console.log(`   📈 Raw Data: get_prices, get_market_candles, get_historical_candles, get_order_book, get_funding_rates, get_connectors\n`);
});
