/**
 * Binance Alpha Detection MCP Server v1.0.0
 *
 * A "giga-brained" MCP server for Binance that goes beyond dashboards
 * to provide actual alpha detection and trading intelligence.
 *
 * TIER 1: INTELLIGENCE LAYER (Alpha Detection)
 * - CVD Divergence Scanner
 * - Smart Money Flow Analysis
 * - Squeeze Probability Calculator
 * - Volatility Anomaly Detection
 * - Funding Arbitrage Scanner
 *
 * TIER 2: RAW DATA LAYER (Fallback for custom analysis)
 * - Historical Klines, Orderbook, Trades, Ticker, Exchange Info
 *
 * Context Protocol compliant with outputSchema and structuredContent.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";

// ============================================================================
// BINANCE API CONFIGURATION
// ============================================================================

const BINANCE_SPOT_API = "https://api.binance.com";
const BINANCE_FUTURES_API = "https://fapi.binance.com";

// Top assets for market-wide scans
const TOP_ASSETS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "MATICUSDT", "LTCUSDT", "SHIBUSDT", "ATOMUSDT", "UNIUSDT",
  "XLMUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
];

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ==================== TIER 1: INTELLIGENCE LAYER ====================

  {
    name: "scan_cvd_divergences",
    description:
      "🧠 ALPHA TOOL: Scans for CVD (Cumulative Volume Delta) divergences. Detects when Price makes Higher Highs but CVD makes Lower Highs (bearish divergence) or Price makes Lower Lows but CVD makes Higher Lows (bullish divergence). Processes thousands of trades to identify potential reversals BEFORE they happen.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: 'Symbols to scan (e.g., ["BTCUSDT", "ETHUSDT"]). Defaults to top 20 assets.',
        },
        timeframe: {
          type: "string",
          enum: ["1h", "4h", "1d"],
          description: "Timeframe for divergence detection (default: 4h)",
        },
        lookbackPeriods: {
          type: "number",
          description: "Number of periods to analyze (default: 20)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        divergences: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              type: { type: "string", enum: ["bullish", "bearish"] },
              strength: { type: "string", enum: ["weak", "moderate", "strong"] },
              priceAction: { type: "string" },
              cvdAction: { type: "string" },
              confidence: { type: "number" },
              recommendation: { type: "string" },
            },
          },
        },
        scannedSymbols: { type: "number" },
        divergencesFound: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["divergences", "scannedSymbols", "divergencesFound"],
    },
  },

  {
    name: "analyze_smart_money_flow",
    description:
      "🧠 ALPHA TOOL: Analyzes Smart Money (trades >$100k) vs Retail (trades <$1k) flow. Detects Distribution (whales selling while retail buys) and Accumulation (whales buying while retail sells). Answers: 'Who is on the other side of the trade?'",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Trading pair (e.g., "BTCUSDT")',
        },
        smartMoneyThreshold: {
          type: "number",
          description: "USD threshold for 'Smart Money' trades (default: $100,000)",
        },
        retailThreshold: {
          type: "number",
          description: "USD threshold for 'Retail' trades (default: $1,000)",
        },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        smartMoneyFlow: {
          type: "object",
          properties: {
            netFlow: { type: "number" },
            buyVolume: { type: "number" },
            sellVolume: { type: "number" },
            tradeCount: { type: "number" },
            avgTradeSize: { type: "number" },
          },
        },
        retailFlow: {
          type: "object",
          properties: {
            netFlow: { type: "number" },
            buyVolume: { type: "number" },
            sellVolume: { type: "number" },
            tradeCount: { type: "number" },
            avgTradeSize: { type: "number" },
          },
        },
        interpretation: {
          type: "object",
          properties: {
            phase: { type: "string", enum: ["accumulation", "distribution", "neutral", "retail_fomo", "retail_panic"] },
            description: { type: "string" },
            confidence: { type: "number" },
          },
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "smartMoneyFlow", "retailFlow", "interpretation"],
    },
  },

  {
    name: "calculate_squeeze_probability",
    description:
      "🧠 ALPHA TOOL: Calculates the probability of a Short or Long squeeze based on: (1) Open Interest build-up, (2) Funding Rate extremes, (3) Price stagnation. Identifies coins PRIMED for explosive moves.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Futures trading pair (e.g., "BTCUSDT")',
        },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        squeezeProbability: {
          type: "object",
          properties: {
            shortSqueeze: { type: "number", description: "0-100 probability" },
            longSqueeze: { type: "number", description: "0-100 probability" },
            dominant: { type: "string", enum: ["short_squeeze", "long_squeeze", "neutral"] },
          },
        },
        factors: {
          type: "object",
          properties: {
            openInterestChange24h: { type: "number" },
            fundingRate: { type: "number" },
            fundingRatePercentile: { type: "number" },
            priceChange24h: { type: "number" },
            priceVolatility: { type: "number" },
          },
        },
        signals: {
          type: "array",
          items: { type: "string" },
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "squeezeProbability", "factors", "signals"],
    },
  },

  {
    name: "scan_volatility_anomalies",
    description:
      "🧠 ALPHA TOOL: Scans top assets for statistically significant (Z-Score > 2) volume or volatility anomalies. Detects breakouts BEFORE they become obvious. Answers: 'Which coin is experiencing a 3-sigma event right now?'",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Symbols to scan (defaults to top 20)",
        },
        zScoreThreshold: {
          type: "number",
          description: "Z-Score threshold for anomaly detection (default: 2.0)",
        },
        lookbackDays: {
          type: "number",
          description: "Days of history for baseline calculation (default: 30)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        anomalies: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              volumeZScore: { type: "number" },
              volatilityZScore: { type: "number" },
              currentVolume: { type: "number" },
              avgVolume30d: { type: "number" },
              currentVolatility: { type: "number" },
              avgVolatility30d: { type: "number" },
              anomalyType: { type: "string", enum: ["volume_spike", "volatility_spike", "both"] },
              significance: { type: "string", enum: ["notable", "significant", "extreme"] },
            },
          },
        },
        scannedSymbols: { type: "number" },
        anomaliesFound: { type: "number" },
        marketContext: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["anomalies", "scannedSymbols", "anomaliesFound"],
    },
  },

  {
    name: "find_funding_arbitrage",
    description:
      "🧠 ALPHA TOOL: Scans all perpetual contracts for the highest annualized funding arbitrage opportunities. Calculates: (1) Current funding APY, (2) Basis spread, (3) Historical funding consistency. Answers: 'Where can I earn yield from funding?'",
    inputSchema: {
      type: "object" as const,
      properties: {
        minAnnualizedYield: {
          type: "number",
          description: "Minimum annualized yield to include (default: 10%)",
        },
        topN: {
          type: "number",
          description: "Number of top opportunities to return (default: 10)",
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
              symbol: { type: "string" },
              currentFundingRate: { type: "number" },
              annualizedYield: { type: "number" },
              basisSpread: { type: "number" },
              direction: { type: "string", enum: ["short_perp", "long_perp"] },
              consistency: { type: "number", description: "% of time funding was in same direction" },
              volume24h: { type: "number" },
              riskLevel: { type: "string", enum: ["low", "medium", "high"] },
            },
          },
        },
        marketStats: {
          type: "object",
          properties: {
            avgFundingRate: { type: "number" },
            positiveFundingCount: { type: "number" },
            negativeFundingCount: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["opportunities", "marketStats"],
    },
  },

  // ==================== TIER 2: RAW DATA LAYER ====================

  {
    name: "get_historical_klines",
    description:
      "📊 RAW DATA: Get historical OHLCV candlestick data for charting and custom analysis. Essential building block for technical analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: 'Trading pair (e.g., "BTCUSDT")' },
        interval: {
          type: "string",
          enum: ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"],
          description: "Candlestick interval",
        },
        limit: { type: "number", description: "Number of candles (default: 100, max: 1000)" },
        startTime: { type: "number", description: "Start time in ms (optional)" },
        endTime: { type: "number", description: "End time in ms (optional)" },
      },
      required: ["symbol", "interval"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        interval: { type: "string" },
        candles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              openTime: { type: "number" },
              open: { type: "string" },
              high: { type: "string" },
              low: { type: "string" },
              close: { type: "string" },
              volume: { type: "string" },
              closeTime: { type: "number" },
              quoteVolume: { type: "string" },
              trades: { type: "number" },
              takerBuyBaseVolume: { type: "string" },
              takerBuyQuoteVolume: { type: "string" },
            },
          },
        },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "interval", "candles", "count"],
    },
  },

  {
    name: "get_orderbook_depth",
    description:
      "📊 RAW DATA: Get order book depth to see bid/ask walls and liquidity distribution.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: 'Trading pair (e.g., "BTCUSDT")' },
        limit: {
          type: "number",
          enum: [5, 10, 20, 50, 100, 500, 1000, 5000],
          description: "Depth limit (default: 100)",
        },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        lastUpdateId: { type: "number" },
        bids: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        asks: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        bidTotal: { type: "number" },
        askTotal: { type: "number" },
        spreadBps: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "bids", "asks"],
    },
  },

  {
    name: "get_recent_trades",
    description:
      "📊 RAW DATA: Get recent trades (the tape) to see actual executed transactions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: 'Trading pair (e.g., "BTCUSDT")' },
        limit: { type: "number", description: "Number of trades (default: 500, max: 1000)" },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        trades: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              price: { type: "string" },
              qty: { type: "string" },
              quoteQty: { type: "string" },
              time: { type: "number" },
              isBuyerMaker: { type: "boolean" },
            },
          },
        },
        count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "trades", "count"],
    },
  },

  {
    name: "get_ticker_24hr",
    description:
      "📊 RAW DATA: Get 24-hour ticker statistics including price change, volume, and trading activity.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: 'Trading pair (e.g., "BTCUSDT"). If omitted, returns all tickers.',
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tickers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              priceChange: { type: "string" },
              priceChangePercent: { type: "string" },
              weightedAvgPrice: { type: "string" },
              lastPrice: { type: "string" },
              volume: { type: "string" },
              quoteVolume: { type: "string" },
              openPrice: { type: "string" },
              highPrice: { type: "string" },
              lowPrice: { type: "string" },
              count: { type: "number" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["tickers"],
    },
  },

  {
    name: "get_exchange_info",
    description:
      "📊 RAW DATA: Get exchange trading rules, symbol info, and rate limits.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Specific symbol to get info for (optional)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        timezone: { type: "string" },
        serverTime: { type: "number" },
        symbols: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              status: { type: "string" },
              baseAsset: { type: "string" },
              quoteAsset: { type: "string" },
              filters: { type: "array" },
            },
          },
        },
        symbolCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["symbols", "symbolCount"],
    },
  },
];

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "binance-alpha", version: "1.0.0" },
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
        case "scan_cvd_divergences":
          return await handleScanCvdDivergences(args);
        case "analyze_smart_money_flow":
          return await handleAnalyzeSmartMoneyFlow(args);
        case "calculate_squeeze_probability":
          return await handleCalculateSqueezeProbability(args);
        case "scan_volatility_anomalies":
          return await handleScanVolatilityAnomalies(args);
        case "find_funding_arbitrage":
          return await handleFindFundingArbitrage(args);

        // Tier 2: Raw Data Tools
        case "get_historical_klines":
          return await handleGetHistoricalKlines(args);
        case "get_orderbook_depth":
          return await handleGetOrderbookDepth(args);
        case "get_recent_trades":
          return await handleGetRecentTrades(args);
        case "get_ticker_24hr":
          return await handleGetTicker24hr(args);
        case "get_exchange_info":
          return await handleGetExchangeInfo(args);

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
// BINANCE API HELPERS
// ============================================================================

async function binanceGet(endpoint: string, baseUrl: string = BINANCE_SPOT_API): Promise<unknown> {
  const url = `${baseUrl}${endpoint}`;
  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Binance API error (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

// ============================================================================
// TIER 2: RAW DATA HANDLERS
// ============================================================================

async function handleGetHistoricalKlines(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string;
  const interval = args?.interval as string;
  const limit = Math.min((args?.limit as number) || 100, 1000);
  const startTime = args?.startTime as number | undefined;
  const endTime = args?.endTime as number | undefined;

  if (!symbol) return errorResult("symbol is required");
  if (!interval) return errorResult("interval is required");

  let endpoint = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  if (startTime) endpoint += `&startTime=${startTime}`;
  if (endTime) endpoint += `&endTime=${endTime}`;

  const data = (await binanceGet(endpoint)) as unknown[][];

  const candles = data.map((k) => ({
    openTime: k[0] as number,
    open: k[1] as string,
    high: k[2] as string,
    low: k[3] as string,
    close: k[4] as string,
    volume: k[5] as string,
    closeTime: k[6] as number,
    quoteVolume: k[7] as string,
    trades: k[8] as number,
    takerBuyBaseVolume: k[9] as string,
    takerBuyQuoteVolume: k[10] as string,
  }));

  return successResult({
    symbol,
    interval,
    candles,
    count: candles.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOrderbookDepth(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string;
  const limit = (args?.limit as number) || 100;

  if (!symbol) return errorResult("symbol is required");

  const data = (await binanceGet(`/api/v3/depth?symbol=${symbol}&limit=${limit}`)) as {
    lastUpdateId: number;
    bids: string[][];
    asks: string[][];
  };

  const bidTotal = data.bids.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);
  const askTotal = data.asks.reduce((sum, [, qty]) => sum + parseFloat(qty), 0);

  const bestBid = parseFloat(data.bids[0]?.[0] || "0");
  const bestAsk = parseFloat(data.asks[0]?.[0] || "0");
  const midPrice = (bestBid + bestAsk) / 2;
  const spreadBps = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 10000 : 0;

  return successResult({
    symbol,
    lastUpdateId: data.lastUpdateId,
    bids: data.bids,
    asks: data.asks,
    bidTotal,
    askTotal,
    spreadBps: Number(spreadBps.toFixed(2)),
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetRecentTrades(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string;
  const limit = Math.min((args?.limit as number) || 500, 1000);

  if (!symbol) return errorResult("symbol is required");

  const data = (await binanceGet(`/api/v3/trades?symbol=${symbol}&limit=${limit}`)) as Array<{
    id: number;
    price: string;
    qty: string;
    quoteQty: string;
    time: number;
    isBuyerMaker: boolean;
  }>;

  return successResult({
    symbol,
    trades: data,
    count: data.length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetTicker24hr(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string | undefined;

  const endpoint = symbol ? `/api/v3/ticker/24hr?symbol=${symbol}` : "/api/v3/ticker/24hr";
  const data = await binanceGet(endpoint);

  const tickers = Array.isArray(data) ? data : [data];

  return successResult({
    tickers,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetExchangeInfo(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string | undefined;

  const endpoint = symbol ? `/api/v3/exchangeInfo?symbol=${symbol}` : "/api/v3/exchangeInfo";
  const data = (await binanceGet(endpoint)) as {
    timezone: string;
    serverTime: number;
    symbols: Array<{
      symbol: string;
      status: string;
      baseAsset: string;
      quoteAsset: string;
      filters: unknown[];
    }>;
  };

  return successResult({
    timezone: data.timezone,
    serverTime: data.serverTime,
    symbols: data.symbols.map((s) => ({
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      filters: s.filters,
    })),
    symbolCount: data.symbols.length,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// TIER 1: INTELLIGENCE HANDLERS
// ============================================================================

/**
 * CVD DIVERGENCE SCANNER
 *
 * Logic:
 * 1. Fetch recent trades for each symbol
 * 2. Calculate Cumulative Volume Delta (Buy Volume - Sell Volume)
 * 3. Identify price highs/lows and CVD highs/lows
 * 4. Detect divergences: Price HH + CVD LH = Bearish, Price LL + CVD HL = Bullish
 */
async function handleScanCvdDivergences(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbols = (args?.symbols as string[]) || TOP_ASSETS.slice(0, 10);
  const timeframe = (args?.timeframe as string) || "4h";
  const lookbackPeriods = (args?.lookbackPeriods as number) || 20;

  const divergences: Array<{
    symbol: string;
    type: "bullish" | "bearish";
    strength: "weak" | "moderate" | "strong";
    priceAction: string;
    cvdAction: string;
    confidence: number;
    recommendation: string;
  }> = [];

  // Convert timeframe to interval
  const interval = timeframe;

  for (const symbol of symbols) {
    try {
      // Fetch klines for price data
      const klines = (await binanceGet(
        `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${lookbackPeriods + 10}`
      )) as unknown[][];

      // Fetch recent trades to calculate CVD
      const trades = (await binanceGet(`/api/v3/trades?symbol=${symbol}&limit=1000`)) as Array<{
        price: string;
        qty: string;
        isBuyerMaker: boolean;
      }>;

      if (klines.length < lookbackPeriods || trades.length < 100) continue;

      // Calculate CVD from trades
      let cvd = 0;
      const cvdValues: number[] = [];
      const chunkSize = Math.floor(trades.length / lookbackPeriods);

      for (let i = 0; i < lookbackPeriods; i++) {
        const chunk = trades.slice(i * chunkSize, (i + 1) * chunkSize);
        for (const trade of chunk) {
          const volume = parseFloat(trade.qty);
          // isBuyerMaker = true means the trade was a sell (taker sold)
          cvd += trade.isBuyerMaker ? -volume : volume;
        }
        cvdValues.push(cvd);
      }

      // Extract price closes
      const closes = klines.slice(-lookbackPeriods).map((k) => parseFloat(k[4] as string));

      // Find local highs and lows (simple peak detection)
      const priceHighs = findLocalExtremes(closes, "high");
      const priceLows = findLocalExtremes(closes, "low");
      const cvdHighs = findLocalExtremes(cvdValues, "high");
      const cvdLows = findLocalExtremes(cvdValues, "low");

      // Check for bearish divergence: Price Higher High + CVD Lower High
      if (priceHighs.length >= 2 && cvdHighs.length >= 2) {
        const priceHH = closes[priceHighs[priceHighs.length - 1]] > closes[priceHighs[priceHighs.length - 2]];
        const cvdLH = cvdValues[cvdHighs[cvdHighs.length - 1]] < cvdValues[cvdHighs[cvdHighs.length - 2]];

        if (priceHH && cvdLH) {
          const strength = calculateDivergenceStrength(closes, cvdValues, priceHighs, cvdHighs);
          divergences.push({
            symbol,
            type: "bearish",
            strength,
            priceAction: "Higher High",
            cvdAction: "Lower High",
            confidence: strength === "strong" ? 0.85 : strength === "moderate" ? 0.7 : 0.55,
            recommendation: `Bearish divergence detected. Price making new highs but buying pressure (CVD) is declining. Consider reducing longs or initiating shorts.`,
          });
        }
      }

      // Check for bullish divergence: Price Lower Low + CVD Higher Low
      if (priceLows.length >= 2 && cvdLows.length >= 2) {
        const priceLL = closes[priceLows[priceLows.length - 1]] < closes[priceLows[priceLows.length - 2]];
        const cvdHL = cvdValues[cvdLows[cvdLows.length - 1]] > cvdValues[cvdLows[cvdLows.length - 2]];

        if (priceLL && cvdHL) {
          const strength = calculateDivergenceStrength(closes, cvdValues, priceLows, cvdLows);
          divergences.push({
            symbol,
            type: "bullish",
            strength,
            priceAction: "Lower Low",
            cvdAction: "Higher Low",
            confidence: strength === "strong" ? 0.85 : strength === "moderate" ? 0.7 : 0.55,
            recommendation: `Bullish divergence detected. Price making new lows but selling pressure is decreasing. Potential reversal setup for longs.`,
          });
        }
      }
    } catch {
      // Skip symbols that fail
      continue;
    }
  }

  // Sort by confidence
  divergences.sort((a, b) => b.confidence - a.confidence);

  return successResult({
    divergences,
    scannedSymbols: symbols.length,
    divergencesFound: divergences.length,
    methodology: "CVD calculated from recent 1000 trades, divergences detected by comparing price and volume delta extremes",
    fetchedAt: new Date().toISOString(),
  });
}

function findLocalExtremes(values: number[], type: "high" | "low"): number[] {
  const extremes: number[] = [];
  for (let i = 2; i < values.length - 2; i++) {
    if (type === "high") {
      if (values[i] > values[i - 1] && values[i] > values[i - 2] && values[i] > values[i + 1] && values[i] > values[i + 2]) {
        extremes.push(i);
      }
    } else {
      if (values[i] < values[i - 1] && values[i] < values[i - 2] && values[i] < values[i + 1] && values[i] < values[i + 2]) {
        extremes.push(i);
      }
    }
  }
  return extremes;
}

function calculateDivergenceStrength(
  prices: number[],
  cvd: number[],
  priceExtremes: number[],
  cvdExtremes: number[]
): "weak" | "moderate" | "strong" {
  if (priceExtremes.length < 2 || cvdExtremes.length < 2) return "weak";

  const priceDiff = Math.abs(prices[priceExtremes[priceExtremes.length - 1]] - prices[priceExtremes[priceExtremes.length - 2]]);
  const cvdDiff = Math.abs(cvd[cvdExtremes[cvdExtremes.length - 1]] - cvd[cvdExtremes[cvdExtremes.length - 2]]);

  const priceChangePercent = (priceDiff / prices[priceExtremes[priceExtremes.length - 2]]) * 100;
  const cvdChangePercent = (cvdDiff / Math.abs(cvd[cvdExtremes[cvdExtremes.length - 2]] || 1)) * 100;

  if (priceChangePercent > 3 && cvdChangePercent > 20) return "strong";
  if (priceChangePercent > 1.5 && cvdChangePercent > 10) return "moderate";
  return "weak";
}

/**
 * SMART MONEY FLOW ANALYZER
 *
 * Logic:
 * 1. Fetch recent trades
 * 2. Segment by size: Smart Money (>$100k), Retail (<$1k)
 * 3. Calculate net flow for each segment
 * 4. Identify accumulation/distribution patterns
 */
async function handleAnalyzeSmartMoneyFlow(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string;
  const smartMoneyThreshold = (args?.smartMoneyThreshold as number) || 100000;
  const retailThreshold = (args?.retailThreshold as number) || 1000;

  if (!symbol) return errorResult("symbol is required");

  // Fetch recent trades
  const trades = (await binanceGet(`/api/v3/trades?symbol=${symbol}&limit=1000`)) as Array<{
    price: string;
    qty: string;
    quoteQty: string;
    isBuyerMaker: boolean;
    time: number;
  }>;

  let smartBuyVol = 0, smartSellVol = 0, smartBuyCount = 0, smartSellCount = 0;
  let retailBuyVol = 0, retailSellVol = 0, retailBuyCount = 0, retailSellCount = 0;

  for (const trade of trades) {
    const notional = parseFloat(trade.quoteQty);
    const isSell = trade.isBuyerMaker; // isBuyerMaker = taker was selling

    if (notional >= smartMoneyThreshold) {
      if (isSell) {
        smartSellVol += notional;
        smartSellCount++;
      } else {
        smartBuyVol += notional;
        smartBuyCount++;
      }
    } else if (notional <= retailThreshold) {
      if (isSell) {
        retailSellVol += notional;
        retailSellCount++;
      } else {
        retailBuyVol += notional;
        retailBuyCount++;
      }
    }
  }

  const smartNetFlow = smartBuyVol - smartSellVol;
  const retailNetFlow = retailBuyVol - retailSellVol;

  // Determine market phase
  let phase: "accumulation" | "distribution" | "neutral" | "retail_fomo" | "retail_panic";
  let description: string;
  let confidence: number;

  if (smartNetFlow > 0 && retailNetFlow < 0) {
    phase = "accumulation";
    description = "Smart money buying while retail sells. Classic accumulation pattern - institutions are building positions.";
    confidence = 0.8;
  } else if (smartNetFlow < 0 && retailNetFlow > 0) {
    phase = "distribution";
    description = "Smart money selling while retail buys. Distribution pattern - institutions are exiting to retail buyers.";
    confidence = 0.8;
  } else if (smartNetFlow > 0 && retailNetFlow > 0 && retailNetFlow > smartNetFlow * 2) {
    phase = "retail_fomo";
    description = "Both buying but retail dominates. FOMO phase - potential blow-off top incoming.";
    confidence = 0.65;
  } else if (smartNetFlow < 0 && retailNetFlow < 0 && retailNetFlow < smartNetFlow * 2) {
    phase = "retail_panic";
    description = "Both selling but retail panic dominates. Capitulation phase - potential bottom forming.";
    confidence = 0.65;
  } else {
    phase = "neutral";
    description = "Mixed signals. No clear accumulation or distribution pattern.";
    confidence = 0.4;
  }

  const recommendation =
    phase === "accumulation"
      ? "Consider following smart money - look for long entries on pullbacks."
      : phase === "distribution"
        ? "Exercise caution - smart money is exiting. Consider reducing exposure."
        : phase === "retail_fomo"
          ? "Late stage rally. Tighten stops, consider taking profits."
          : phase === "retail_panic"
            ? "Potential capitulation. Watch for reversal signals for contrarian longs."
            : "Wait for clearer signals before taking action.";

  return successResult({
    symbol,
    smartMoneyFlow: {
      netFlow: smartNetFlow,
      buyVolume: smartBuyVol,
      sellVolume: smartSellVol,
      tradeCount: smartBuyCount + smartSellCount,
      avgTradeSize: (smartBuyCount + smartSellCount) > 0 ? (smartBuyVol + smartSellVol) / (smartBuyCount + smartSellCount) : 0,
    },
    retailFlow: {
      netFlow: retailNetFlow,
      buyVolume: retailBuyVol,
      sellVolume: retailSellVol,
      tradeCount: retailBuyCount + retailSellCount,
      avgTradeSize: (retailBuyCount + retailSellCount) > 0 ? (retailBuyVol + retailSellVol) / (retailBuyCount + retailSellCount) : 0,
    },
    interpretation: {
      phase,
      description,
      confidence,
    },
    thresholds: {
      smartMoney: `>$${smartMoneyThreshold.toLocaleString()}`,
      retail: `<$${retailThreshold.toLocaleString()}`,
    },
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * SQUEEZE PROBABILITY CALCULATOR
 *
 * Logic:
 * 1. Fetch funding rate (extreme = squeeze setup)
 * 2. Fetch open interest changes (rising OI + stagnant price = compression)
 * 3. Calculate price volatility (low vol = energy building)
 * 4. Combine into squeeze probability score
 */
async function handleCalculateSqueezeProbability(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = args?.symbol as string;

  if (!symbol) return errorResult("symbol is required");

  // Fetch mark price and funding rate from futures API
  const markPriceData = (await binanceGet(`/fapi/v1/premiumIndex?symbol=${symbol}`, BINANCE_FUTURES_API)) as {
    symbol: string;
    markPrice: string;
    indexPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
  };

  // Fetch current open interest
  const oiData = (await binanceGet(`/fapi/v1/openInterest?symbol=${symbol}`, BINANCE_FUTURES_API)) as {
    openInterest: string;
  };

  // Fetch 24hr ticker for price change
  const ticker = (await binanceGet(`/fapi/v1/ticker/24hr?symbol=${symbol}`, BINANCE_FUTURES_API)) as {
    priceChangePercent: string;
    volume: string;
  };

  // Fetch recent klines for volatility calculation
  const klines = (await binanceGet(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=24`, BINANCE_FUTURES_API)) as unknown[][];

  const fundingRate = parseFloat(markPriceData.lastFundingRate);
  const priceChange24h = parseFloat(ticker.priceChangePercent);

  // Calculate hourly volatility
  const returns = klines.slice(1).map((k, i) => {
    const prevClose = parseFloat(klines[i][4] as string);
    const currClose = parseFloat(k[4] as string);
    return ((currClose - prevClose) / prevClose) * 100;
  });
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const volatility = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);

  // Calculate squeeze probabilities
  const signals: string[] = [];
  let shortSqueezeProb = 0;
  let longSqueezeProb = 0;

  // Factor 1: Funding Rate
  // Extreme negative funding = shorts paying = potential short squeeze
  // Extreme positive funding = longs paying = potential long squeeze
  if (fundingRate < -0.0005) {
    shortSqueezeProb += 30;
    signals.push(`Extreme negative funding (${(fundingRate * 100).toFixed(4)}%) - shorts are paying heavily`);
  } else if (fundingRate < -0.0002) {
    shortSqueezeProb += 15;
    signals.push(`Negative funding indicates short bias`);
  } else if (fundingRate > 0.0005) {
    longSqueezeProb += 30;
    signals.push(`Extreme positive funding (${(fundingRate * 100).toFixed(4)}%) - longs are paying heavily`);
  } else if (fundingRate > 0.0002) {
    longSqueezeProb += 15;
    signals.push(`Positive funding indicates long bias`);
  }

  // Factor 2: Price Stagnation + OI Build
  // Low volatility = energy compression
  if (volatility < 0.5 && Math.abs(priceChange24h) < 2) {
    shortSqueezeProb += 20;
    longSqueezeProb += 20;
    signals.push(`Low volatility (${volatility.toFixed(2)}%) with price consolidation - energy building`);
  }

  // Factor 3: Funding Rate Percentile (approximate)
  // Using absolute value comparison against typical ranges
  const fundingPercentile = Math.min(100, Math.abs(fundingRate) / 0.001 * 100);
  if (fundingPercentile > 80) {
    if (fundingRate < 0) shortSqueezeProb += 25;
    else longSqueezeProb += 25;
    signals.push(`Funding rate in ${fundingPercentile.toFixed(0)}th percentile (extreme)`);
  } else if (fundingPercentile > 60) {
    if (fundingRate < 0) shortSqueezeProb += 10;
    else longSqueezeProb += 10;
    signals.push(`Funding rate elevated (${fundingPercentile.toFixed(0)}th percentile)`);
  }

  // Cap probabilities at 95%
  shortSqueezeProb = Math.min(95, shortSqueezeProb);
  longSqueezeProb = Math.min(95, longSqueezeProb);

  const dominant =
    shortSqueezeProb > longSqueezeProb + 10
      ? "short_squeeze"
      : longSqueezeProb > shortSqueezeProb + 10
        ? "long_squeeze"
        : "neutral";

  const recommendation =
    dominant === "short_squeeze"
      ? `High short squeeze probability (${shortSqueezeProb}%). Consider long positions with tight stops. Watch for sudden upward moves.`
      : dominant === "long_squeeze"
        ? `High long squeeze probability (${longSqueezeProb}%). Consider short positions with tight stops. Watch for sudden downward moves.`
        : `No clear squeeze setup. Both sides relatively balanced.`;

  return successResult({
    symbol,
    squeezeProbability: {
      shortSqueeze: shortSqueezeProb,
      longSqueeze: longSqueezeProb,
      dominant,
    },
    factors: {
      fundingRate,
      fundingRateAnnualized: fundingRate * 3 * 365 * 100, // 3 funding periods per day
      fundingRatePercentile: fundingPercentile,
      priceChange24h,
      priceVolatility: volatility,
      openInterest: parseFloat(oiData.openInterest),
    },
    signals,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * VOLATILITY ANOMALY SCANNER
 *
 * Logic:
 * 1. Fetch 30 days of daily data for each asset
 * 2. Calculate mean and std dev of volume and volatility
 * 3. Calculate Z-Score of current values
 * 4. Flag assets with Z-Score > threshold
 */
async function handleScanVolatilityAnomalies(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbols = (args?.symbols as string[]) || TOP_ASSETS;
  const zScoreThreshold = (args?.zScoreThreshold as number) || 2.0;
  const lookbackDays = Math.min((args?.lookbackDays as number) || 30, 90);

  const anomalies: Array<{
    symbol: string;
    volumeZScore: number;
    volatilityZScore: number;
    currentVolume: number;
    avgVolume30d: number;
    currentVolatility: number;
    avgVolatility30d: number;
    anomalyType: "volume_spike" | "volatility_spike" | "both";
    significance: "notable" | "significant" | "extreme";
  }> = [];

  for (const symbol of symbols) {
    try {
      // Fetch daily klines
      const klines = (await binanceGet(
        `/api/v3/klines?symbol=${symbol}&interval=1d&limit=${lookbackDays + 1}`
      )) as unknown[][];

      if (klines.length < lookbackDays) continue;

      // Calculate daily volumes and volatilities
      const volumes = klines.map((k) => parseFloat(k[5] as string) * parseFloat(k[4] as string)); // volume * close
      const volatilities = klines.map((k) => {
        const high = parseFloat(k[2] as string);
        const low = parseFloat(k[3] as string);
        const close = parseFloat(k[4] as string);
        return ((high - low) / close) * 100; // Daily range as %
      });

      // Current values (last candle)
      const currentVolume = volumes[volumes.length - 1];
      const currentVolatility = volatilities[volatilities.length - 1];

      // Historical values (excluding current)
      const histVolumes = volumes.slice(0, -1);
      const histVolatilities = volatilities.slice(0, -1);

      // Calculate statistics
      const avgVolume = histVolumes.reduce((a, b) => a + b, 0) / histVolumes.length;
      const stdVolume = Math.sqrt(histVolumes.reduce((sum, v) => sum + Math.pow(v - avgVolume, 2), 0) / histVolumes.length);

      const avgVolatility = histVolatilities.reduce((a, b) => a + b, 0) / histVolatilities.length;
      const stdVolatility = Math.sqrt(histVolatilities.reduce((sum, v) => sum + Math.pow(v - avgVolatility, 2), 0) / histVolatilities.length);

      // Calculate Z-Scores
      const volumeZScore = stdVolume > 0 ? (currentVolume - avgVolume) / stdVolume : 0;
      const volatilityZScore = stdVolatility > 0 ? (currentVolatility - avgVolatility) / stdVolatility : 0;

      // Check for anomalies
      const isVolumeAnomaly = volumeZScore > zScoreThreshold;
      const isVolatilityAnomaly = volatilityZScore > zScoreThreshold;

      if (isVolumeAnomaly || isVolatilityAnomaly) {
        const maxZ = Math.max(volumeZScore, volatilityZScore);
        anomalies.push({
          symbol,
          volumeZScore: Number(volumeZScore.toFixed(2)),
          volatilityZScore: Number(volatilityZScore.toFixed(2)),
          currentVolume,
          avgVolume30d: avgVolume,
          currentVolatility,
          avgVolatility30d: avgVolatility,
          anomalyType: isVolumeAnomaly && isVolatilityAnomaly ? "both" : isVolumeAnomaly ? "volume_spike" : "volatility_spike",
          significance: maxZ > 3 ? "extreme" : maxZ > 2.5 ? "significant" : "notable",
        });
      }
    } catch {
      continue;
    }
  }

  // Sort by max Z-Score
  anomalies.sort((a, b) => Math.max(b.volumeZScore, b.volatilityZScore) - Math.max(a.volumeZScore, a.volatilityZScore));

  const extremeCount = anomalies.filter((a) => a.significance === "extreme").length;
  const marketContext =
    extremeCount >= 3
      ? "HIGH ALERT: Multiple extreme anomalies detected. Potential market-wide event or regime change."
      : extremeCount >= 1
        ? "Notable: Some extreme anomalies present. Monitor for breakouts."
        : anomalies.length > 0
          ? "Moderate: Some statistical anomalies detected. Normal market activity with pockets of unusual behavior."
          : "Quiet: No significant anomalies. Market in consolidation.";

  return successResult({
    anomalies,
    scannedSymbols: symbols.length,
    anomaliesFound: anomalies.length,
    zScoreThreshold,
    lookbackDays,
    marketContext,
    fetchedAt: new Date().toISOString(),
  });
}

/**
 * FUNDING ARBITRAGE SCANNER
 *
 * Logic:
 * 1. Fetch funding rates for all perpetual contracts
 * 2. Calculate annualized yields
 * 3. Identify highest positive (short perp) and negative (long perp) opportunities
 * 4. Factor in volume for execution feasibility
 */
async function handleFindFundingArbitrage(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const minAnnualizedYield = (args?.minAnnualizedYield as number) || 10;
  const topN = (args?.topN as number) || 10;

  // Fetch all mark prices (includes funding rates)
  const markPrices = (await binanceGet("/fapi/v1/premiumIndex", BINANCE_FUTURES_API)) as Array<{
    symbol: string;
    markPrice: string;
    indexPrice: string;
    lastFundingRate: string;
  }>;

  // Fetch 24hr tickers for volume
  const tickers = (await binanceGet("/fapi/v1/ticker/24hr", BINANCE_FUTURES_API)) as Array<{
    symbol: string;
    volume: string;
    quoteVolume: string;
  }>;

  const tickerMap = new Map(tickers.map((t) => [t.symbol, t]));

  const opportunities: Array<{
    symbol: string;
    currentFundingRate: number;
    annualizedYield: number;
    basisSpread: number;
    direction: "short_perp" | "long_perp";
    volume24h: number;
    riskLevel: "low" | "medium" | "high";
  }> = [];

  let totalPositive = 0;
  let totalNegative = 0;
  let sumFunding = 0;

  for (const mp of markPrices) {
    const fundingRate = parseFloat(mp.lastFundingRate);
    const markPrice = parseFloat(mp.markPrice);
    const indexPrice = parseFloat(mp.indexPrice);

    if (isNaN(fundingRate) || fundingRate === 0) continue;

    // Annualized: 3 funding periods per day * 365 days
    const annualized = fundingRate * 3 * 365 * 100;
    const absAnnualized = Math.abs(annualized);

    sumFunding += fundingRate;
    if (fundingRate > 0) totalPositive++;
    else totalNegative++;

    if (absAnnualized < minAnnualizedYield) continue;

    const ticker = tickerMap.get(mp.symbol);
    const volume24h = ticker ? parseFloat(ticker.quoteVolume) : 0;

    // Basis spread = (mark - index) / index * 100
    const basisSpread = ((markPrice - indexPrice) / indexPrice) * 100;

    // Direction: Positive funding = longs pay shorts = short perp to collect
    const direction = fundingRate > 0 ? "short_perp" : "long_perp";

    // Risk based on volume (higher volume = lower risk)
    const riskLevel = volume24h > 100_000_000 ? "low" : volume24h > 10_000_000 ? "medium" : "high";

    opportunities.push({
      symbol: mp.symbol,
      currentFundingRate: fundingRate,
      annualizedYield: absAnnualized,
      basisSpread,
      direction,
      volume24h,
      riskLevel,
    });
  }

  // Sort by annualized yield descending
  opportunities.sort((a, b) => b.annualizedYield - a.annualizedYield);

  const topOpportunities = opportunities.slice(0, topN);

  // Add consistency estimate (simplified - in production would use historical funding)
  const enhancedOpportunities = topOpportunities.map((o) => ({
    ...o,
    consistency: o.riskLevel === "low" ? 75 : o.riskLevel === "medium" ? 60 : 45, // Estimated % of time funding stays same direction
  }));

  return successResult({
    opportunities: enhancedOpportunities,
    marketStats: {
      avgFundingRate: sumFunding / markPrices.length,
      positiveFundingCount: totalPositive,
      negativeFundingCount: totalNegative,
      totalPerpetuals: markPrices.length,
    },
    filters: {
      minAnnualizedYield: `${minAnnualizedYield}%`,
      topN,
    },
    note: "Positive funding = longs pay shorts (short perp to collect). Negative = shorts pay longs (long perp to collect). Consistency is estimated.",
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// EXPRESS SERVER
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "binance-alpha",
    version: "1.0.0",
    tier1Tools: TOOLS.filter((t) => t.name.startsWith("scan_") || t.name.startsWith("analyze_") || t.name.startsWith("calculate_") || t.name.startsWith("find_")).map((t) => t.name),
    tier2Tools: TOOLS.filter((t) => t.name.startsWith("get_")).map((t) => t.name),
    description: "Binance Alpha Detection MCP - CVD Divergences, Smart Money Flow, Squeeze Probability, Volatility Anomalies, Funding Arbitrage",
  });
});

app.get("/sse", async (_req: Request, res: Response) => {
  console.log("New SSE connection established");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`SSE connection closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).json({ error: "No transport found for sessionId" });
  }
});

const port = Number(process.env.PORT || 4003);
app.listen(port, () => {
  console.log("\n🚀 Binance Alpha Detection MCP Server v1.0.0");
  console.log(`   Giga-brained alpha detection for Binance\n`);
  console.log(`📡 SSE endpoint: http://localhost:${port}/sse`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🧠 TIER 1 - INTELLIGENCE TOOLS (Alpha Detection):`);
  TOOLS.filter((t) => !t.name.startsWith("get_")).forEach((tool) => {
    console.log(`   • ${tool.name}`);
  });
  console.log(`\n📊 TIER 2 - RAW DATA TOOLS (Fallback):`);
  TOOLS.filter((t) => t.name.startsWith("get_")).forEach((tool) => {
    console.log(`   • ${tool.name}`);
  });
  console.log("");
});



