/**
 * Hyperliquid Ultimate MCP Server v2.0
 *
 * A standard MCP server built with @modelcontextprotocol/sdk.
 * The world's most comprehensive Hyperliquid MCP server.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
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
import type { HyperliquidContext } from "@ctxprotocol/sdk";

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (standard MCP feature, required by Context)
//
// See: https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema
// ============================================================================

const TOOLS = [
  // ==================== ORDERBOOK & LIQUIDITY ====================
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "midPrice", "bids", "asks", "totalBidLiquidity", "totalAskLiquidity"],
    },
  },

  {
    name: "calculate_price_impact",
    description:
      "Calculate the price impact of selling or buying a specific amount. Simulates execution through the orderbook, estimates TWAP duration for minimal impact, and provides absorption analysis. CRITICAL for analyzing large order flows.",
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "side", "orderSize", "canAbsorb", "absorption", "volumeContext"],
    },
  },

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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "markPrice", "fundingRate", "openInterest", "volume24h"],
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
        fetchedAt: { type: "string" },
      },
      required: ["markets", "count"],
    },
  },

  // ==================== FUNDING ANALYSIS ====================
  {
    name: "get_funding_analysis",
    description:
      "Get comprehensive funding rate analysis including current rates, predicted rates across venues (Binance, Bybit, Hyperliquid), and arbitrage opportunities.",
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "currentFunding"],
    },
  },

  // ==================== STAKING & DELEGATION ====================
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
        fetchedAt: { type: "string" },
      },
      required: ["stakingMechanics", "note"],
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
        fetchedAt: { type: "string" },
      },
      required: ["address", "delegations", "totalDelegated"],
    },
  },

  // ==================== OPEN INTEREST ANALYSIS ====================
  {
    name: "get_open_interest_analysis",
    description:
      "Analyze open interest for a coin: current OI, OI changes, long/short ratio estimation, and OI caps.",
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
        liquidationRisk: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "openInterest", "openInterestUsd"],
    },
  },

  // ==================== HISTORICAL DATA ====================
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "interval", "candles"],
    },
  },

  // ==================== RECENT TRADES ====================
  {
    name: "get_recent_trades",
    description: "Get recent trades with whale detection. Identifies large trades and calculates buy/sell pressure.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string", description: 'Coin symbol (e.g., "HYPE")' },
        whaleThresholdUsd: { type: "number", description: "USD threshold for whale trades (default: $100,000)" },
      },
      required: ["coin"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        coin: { type: "string" },
        trades: { type: "array" },
        whaleTrades: { type: "array" },
        summary: { type: "object" },
        fetchedAt: { type: "string" },
      },
      required: ["coin", "trades", "summary"],
    },
  },

  // ==================== COMPREHENSIVE ANALYSIS ====================
  {
    name: "analyze_large_order",
    description:
      "COMPREHENSIVE analysis for large order scenarios (like team unlocks, whale sells). Combines orderbook depth, volume context, funding sentiment, and OI analysis.",
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "orderSummary", "marketImpact", "executionRecommendation", "conclusion"],
    },
  },

  // ==================== ADDITIONAL TOOLS ====================
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
        fetchedAt: { type: "string" },
      },
      required: ["marketsAtCap", "count"],
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
        fetchedAt: { type: "string" },
      },
      required: ["apr", "tvl"],
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
        fetchedAt: { type: "string" },
      },
      required: ["coin", "fundingHistory", "summary"],
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
        fetchedAt: { type: "string" },
      },
      required: ["totalVolume24h", "totalOpenInterest", "marketCount"],
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
        fetchedAt: { type: "string" },
      },
      required: ["dailyVolumes", "summary"],
    },
  },

  // ==================== PORTFOLIO ANALYSIS ====================
  {
    name: "analyze_my_positions",
    description:
      "Analyze your Hyperliquid perpetual positions with risk assessment, P&L breakdown, " +
      "liquidation warnings, and personalized recommendations. Requires portfolio context.",
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
        overallRecommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "totalPositions", "portfolioSummary", "positionAnalyses"],
    },
  },
];

// ============================================================================
// MCP SERVER SETUP (Standard @modelcontextprotocol/sdk pattern)
// ============================================================================

const server = new Server(
  { name: "hyperliquid-ultimate", version: "2.0.0" },
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
        case "analyze_my_positions":
          return await handleAnalyzeMyPositions(args);
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

  return successResult({
    ...impact,
    volumeContext: {
      orderAsPercentOfDailyVolume: Number(orderAsPercentOfVolume.toFixed(2)),
      volume24h,
      estimatedTwapDuration: twapDuration,
      twapImpactEstimate: twapImpact,
    },
    hiddenLiquidityNote: "Visible book capacity is limited. Professional market makers use TWAP/algorithmic execution to minimize impact.",
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

  return successResult({ markets, count: markets.length, fetchedAt: new Date().toISOString() });
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

  return successResult({
    coin,
    currentFunding: {
      rate: fundingRate,
      annualized: Number(annualized.toFixed(2)),
      sentiment: fundingRate > 0 ? "bullish (longs pay shorts)" : fundingRate < 0 ? "bearish (shorts pay longs)" : "neutral",
    },
    predictedFundings: predictions,
    fundingArbitrage: arbitrageOpportunity,
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

  return successResult({ address, delegations: parsed, totalDelegated, fetchedAt: new Date().toISOString() });
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

  return successResult({
    coin,
    openInterest,
    openInterestUsd: oiUsd,
    oiToVolumeRatio: Number(oiToVolumeRatio.toFixed(2)),
    fundingImpliedBias: fundingBias,
    atOpenInterestCap: atCap,
    liquidationRisk,
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

  return successResult({
    coin,
    trades: parsed,
    whaleTrades,
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
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketsAtOiCap(): Promise<CallToolResult> {
  const markets = await fetchPerpsAtOiCap();
  return successResult({
    marketsAtCap: markets,
    count: markets.length,
    note: "Markets at OI cap have limited capacity for new positions.",
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
      overallRecommendation: "You have no active Hyperliquid positions to analyze.",
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
    overallRecommendation,
    fetchedAt: new Date().toISOString(),
  });
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
  return hyperliquidPost({ type: "perpsAtOpenInterestCaps" }) as Promise<string[]>;
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
// EXPRESS SERVER (Standard MCP pattern)
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "hyperliquid-ultimate",
    version: "2.0.0",
    tools: TOOLS.map((t) => t.name),
    description: "The world's most comprehensive Hyperliquid MCP server",
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

const port = Number(process.env.PORT || 4002);
app.listen(port, () => {
  console.log("\n🚀 Hyperliquid Ultimate MCP Server v2.0.0");
  console.log(`   The world's most comprehensive Hyperliquid MCP\n`);
  console.log(`📡 SSE endpoint: http://localhost:${port}/sse`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🛠️  Available tools (${TOOLS.length}):`);
  for (const tool of TOOLS) {
    console.log(`   • ${tool.name}`);
  }
  console.log("");
});
