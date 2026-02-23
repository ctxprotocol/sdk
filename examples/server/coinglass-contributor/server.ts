/**
 * Coinglass MCP Server v1.4.0
 * 
 * Comprehensive crypto derivatives intelligence from Coinglass API.
 * 
 * ⚠️ API TIER: Hobbyist
 * Many endpoints require Professional tier or above and have been disabled.
 * See: https://coinglass.com/pricing
 * 
 * TIER 1: INTELLIGENCE LAYER (7 tools - Hobbyist compatible)
 * - analyze_market_sentiment - Cross-market sentiment analysis  
 * - get_btc_valuation_score - Multi-indicator BTC valuation
 * - get_market_overview - Market overview with available data
 * - analyze_hobby_market_regime - Multi-signal macro regime for Hobby tier
 * - analyze_exchange_balance_pressure - Coin-level exchange flow pressure
 * - scan_oi_divergence - Scan for OI vs sentiment divergences across coins
 * - get_oi_batch - Batch OI data for multiple coins in one call
 * 
 * TIER 2: RAW DATA LAYER (20 tools - Hobbyist compatible)
 * Access to Coinglass API endpoints available on this Hobby-tier key
 * 
 * DISABLED (Require Professional+):
 * - find_funding_arbitrage, detect_liquidation_risk, analyze_smart_money
 * - scan_volume_anomalies, calculate_squeeze_probability
 * - Most historical/aggregated data endpoints
 * 
 * RATE LIMITING & CACHING:
 * - Server-side rate limiter prevents exceeding upstream API quotas
 * - TTL cache for frequently-accessed data (Fear & Greed, supported coins, etc.)
 * - Batch endpoints reduce call count for multi-coin queries
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
import express, { type Request, type RequestHandler, type Response } from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";

const COINGLASS_API = "https://open-api-v4.coinglass.com";
const API_KEY = process.env.COINGLASS_API_KEY || "";
const SERVER_VERSION = "1.4.0";
const CONTEXT_AUTH_ENABLED = process.env.CONTEXT_AUTH_ENABLED !== "false";

const COINGLASS_PLAN = (process.env.COINGLASS_PLAN ?? "hobbyist").trim().toLowerCase();
const DEFAULT_COINGLASS_RATE_LIMIT = 60;
const MIN_COINGLASS_RATE_LIMIT = 1;
const MAX_COINGLASS_RATE_LIMIT = 600;
const DEFAULT_ANALYZE_COIN_LIMIT = 10;
const DEFAULT_SCAN_COIN_LIMIT = 20;
const MAX_DYNAMIC_COIN_LOOKUP_PAGE_SIZE = 120;
const MAJOR_COIN_SYMBOL_FALLBACK = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "TRX",
  "TON",
  "SUI",
  "DOT",
  "MATIC",
  "LTC",
  "BCH",
  "APT",
  "ARB",
  "OP",
  "ATOM",
] as const;
const PROFESSIONAL_OR_HIGHER_PLANS = new Set(["professional", "pro", "enterprise", "institutional"]);
const HOBBY_ALLOWED_ENDPOINTS = new Set([
  "/api/index/fear-greed-history",
  "/api/index/stock-flow",
  "/api/bull-market-peak-indicator",
  "/api/index/ahr999",
  "/api/index/bitcoin/rainbow-chart",
  "/api/index/bitcoin/bubble-index",
  "/api/index/puell-multiple",
  "/api/futures/supported-coins",
  "/api/futures/supported-exchanges",
  "/api/futures/supported-exchange-pairs",
  "/api/futures/coins-markets",
  "/api/futures/pairs-markets",
  "/api/futures/funding-rate/exchange-list",
  "/api/futures/open-interest/exchange-list",
  "/api/futures/liquidation/exchange-list",
  "/api/futures/liquidation/coin-list",
  "/api/etf/bitcoin/list",
  "/api/etf/bitcoin/net-assets/history",
  "/api/exchange/balance/list",
  "/api/exchange/balance/chart",
  "/api/spot/supported-coins",
]);
const COINGLASS_RATE_LIMIT_PER_MINUTE = getConfiguredRateLimitPerMinute();
const COINGLASS_RATE_LIMIT_COOLDOWN_MS = Math.ceil(
  60_000 / COINGLASS_RATE_LIMIT_PER_MINUTE
);
const BULK_FIRST_TOOLS = new Set([
  "analyze_market_sentiment",
  "scan_oi_divergence",
  "get_oi_batch",
]);
const TOOL_BATCH_HINTS: Record<string, string[]> = {
  get_oi_by_exchange: ["get_oi_batch"],
  get_futures_pairs_markets: ["scan_oi_divergence", "analyze_market_sentiment"],
};

type ToolRateLimitMetadata = {
  maxRequestsPerMinute: number;
  maxConcurrency: number;
  cooldownMs: number;
  supportsBulk: boolean;
  recommendedBatchTools: string[];
  notes: string;
};

class PlanUpgradeRequiredError extends Error {
  endpoint: string;

  constructor(endpoint: string, message: string) {
    super(message);
    this.name = "PlanUpgradeRequiredError";
    this.endpoint = endpoint;
  }
}

const PLAN_UPGRADE_PATTERN = /upgrade\s+plan|professional|subscription/i;
const API_ACCESS_PROBE_TTL_MS = 60_000;
const API_ACCESS_PROBES: Array<{ endpoint: string; params?: Record<string, string | number> }> = [
  { endpoint: "/api/futures/supported-coins" },
  { endpoint: "/api/futures/open-interest/exchange-list", params: { symbol: "BTC" } },
  { endpoint: "/api/index/fear-greed-history" },
  { endpoint: "/api/exchange/balance/list", params: { symbol: "BTC" } },
  { endpoint: "/api/futures/funding-rate/exchange-list" },
];
let apiAccessProbeCache:
  | { checkedAt: number; accessible: true }
  | { checkedAt: number; accessible: false; reason: string; endpoint: string }
  | null = null;

function isPlanUpgradeMessage(message: string): boolean {
  return PLAN_UPGRADE_PATTERN.test(message);
}

function isPlanUpgradeError(error: unknown): error is PlanUpgradeRequiredError {
  return error instanceof PlanUpgradeRequiredError;
}

function isHobbyConstrainedPlan(plan: string): boolean {
  return !PROFESSIONAL_OR_HIGHER_PLANS.has(plan);
}

function getConfiguredRateLimitPerMinute(): number {
  const rawRateLimit = process.env.COINGLASS_RATE_LIMIT;
  if (!rawRateLimit) {
    return DEFAULT_COINGLASS_RATE_LIMIT;
  }

  const parsedRateLimit = Number.parseInt(rawRateLimit, 10);
  if (!Number.isFinite(parsedRateLimit)) {
    return DEFAULT_COINGLASS_RATE_LIMIT;
  }

  return Math.min(
    MAX_COINGLASS_RATE_LIMIT,
    Math.max(MIN_COINGLASS_RATE_LIMIT, parsedRateLimit)
  );
}

function assertEndpointAllowedForConfiguredPlan(endpoint: string): void {
  if (!isHobbyConstrainedPlan(COINGLASS_PLAN)) {
    return;
  }

  if (HOBBY_ALLOWED_ENDPOINTS.has(endpoint)) {
    return;
  }

  console.warn("[coinglass-plan] blocked_endpoint", {
    endpoint,
    plan: COINGLASS_PLAN,
  });

  throw new Error(
    `Endpoint ${endpoint} is disabled for COINGLASS_PLAN=${COINGLASS_PLAN}. Upgrade plan or update allowlist explicitly.`
  );
}

// ============================================================================
// RATE LIMITER - Token bucket to prevent exceeding upstream API quotas
// ============================================================================

class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;

  constructor(maxRequestsPerMinute: number) {
    this.maxTokens = maxRequestsPerMinute;
    this.tokens = maxRequestsPerMinute;
    this.refillRate = maxRequestsPerMinute / 60_000;
    this.lastRefill = Date.now();
  }

  async acquire(scope: string): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRate);
    console.warn("[coinglass-rate] wait", {
      scope,
      waitMs,
      maxRequestsPerMinute: this.maxTokens,
      cooldownMs: Math.ceil(60_000 / this.maxTokens),
    });
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

const apiRateLimiter = new RateLimiter(COINGLASS_RATE_LIMIT_PER_MINUTE);

// ============================================================================
// CACHE - TTL-based in-memory cache for frequently-accessed data
// ============================================================================

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class TtlCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }
}

const cache = new TtlCache();
const CACHE_TTL_SHORT = 30_000;
const CACHE_TTL_MEDIUM = 120_000;
const CACHE_TTL_LONG = 300_000;

function buildToolRateLimitMetadata(toolName: string): ToolRateLimitMetadata {
  const recommendedBatchTools = TOOL_BATCH_HINTS[toolName] ?? [];
  return {
    maxRequestsPerMinute: COINGLASS_RATE_LIMIT_PER_MINUTE,
    maxConcurrency: 1,
    cooldownMs: COINGLASS_RATE_LIMIT_COOLDOWN_MS,
    supportsBulk: BULK_FIRST_TOOLS.has(toolName),
    recommendedBatchTools,
    notes: `Coinglass ${COINGLASS_PLAN} tier quota. Prefer batch/snapshot tools before per-symbol fan-out loops.`,
  };
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ============================================================================
  // TIER 1: INTELLIGENCE LAYER (Hobbyist-compatible tools only)
  // ============================================================================

  // ============================================================================
  // DISABLED - REQUIRES PROFESSIONAL TIER OR ABOVE
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "calculate_squeeze_probability",
  //   description: "🧠 INTELLIGENCE: Calculate short/long squeeze probability by analyzing funding rates, OI, liquidations, and long/short ratios. Identifies coins PRIMED for explosive moves.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string", description: "Coin symbol (e.g., BTC, ETH)" },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       squeezeProbability: { type: "object" },
  //       factors: { type: "object" },
  //       signals: { type: "array", items: { type: "string" } },
  //       recommendation: { type: "string" },
  //       confidence: { type: "number" },
  //       dataSources: { type: "array", items: { type: "string" } },
  //       dataFreshness: { type: "string" },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["symbol", "squeezeProbability", "confidence"],
  //   },
  // },
  // ============================================================================

  {
    name: "analyze_market_sentiment",
    description: "🧠 INTELLIGENCE: Analyze broad market sentiment using Fear & Greed plus bull-market indicators. Designed for Hobbyist tier where per-coin long/short and funding detail may be unavailable.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Optional coin symbols for reporting context. If omitted, server resolves a dynamic major-coin set using available live market data." },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        overallSentiment: { type: "string" },
        sentimentScore: { type: "number" },
        fearGreedIndex: { type: "object" },
        bullMarketIndicators: { type: "object" },
        analyzedCoins: { type: "array", items: { type: "string" } },
        supportsLongShortThresholdCheck: { type: "boolean" },
        fundingBias: { type: "object" },
        longShortRatio: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        limitations: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: [
        "overallSentiment",
        "sentimentScore",
        "fearGreedIndex",
        "recommendation",
        "confidence",
        "fetchedAt",
      ],
    },
  },
  // ============================================================================
  // DISABLED - find_funding_arbitrage - REQUIRES PROFESSIONAL TIER
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "find_funding_arbitrage",
  //   description: "🧠 INTELLIGENCE: Find the best funding rate arbitrage opportunities across all perpetual contracts with risk assessment.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       minApr: { type: "number", description: "Minimum annualized yield % (default: 20)" },
  //       limit: { type: "number", description: "Max results (default: 15)" },
  //     },
  //     required: [],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       opportunities: { type: "array" },
  //       marketStats: { type: "object" },
  //       confidence: { type: "number" },
  //       dataSources: { type: "array", items: { type: "string" } },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["opportunities"],
  //   },
  // },
  // ============================================================================

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
  // ============================================================================
  // DISABLED - detect_liquidation_risk - REQUIRES PROFESSIONAL TIER
  // Uses: liquidation/aggregated-history, openInterest/exchange-list (OI works but liquidation doesn't)
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "detect_liquidation_risk",
  //   description: "🧠 INTELLIGENCE: Detect liquidation cascade risk by analyzing OI concentration, recent liquidations, and leverage levels.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string", description: "Coin symbol (e.g., BTC)" },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       riskLevel: { type: "string" },
  //       riskScore: { type: "number" },
  //       liquidationData: { type: "object" },
  //       oiData: { type: "object" },
  //       recommendation: { type: "string" },
  //       confidence: { type: "number" },
  //       dataSources: { type: "array", items: { type: "string" } },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["symbol", "riskLevel", "riskScore", "confidence"],
  //   },
  // },
  // ============================================================================

  // ============================================================================
  // DISABLED - analyze_smart_money - REQUIRES PROFESSIONAL TIER
  // Uses: top-long-short-position-ratio/history, top-long-short-account-ratio/history, taker-buy-sell-volume/history
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "analyze_smart_money",
  //   description: "🧠 INTELLIGENCE: Analyze top trader positioning vs retail using top trader position/account ratios and taker buy/sell volume.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string", description: "Trading pair (e.g., BTCUSDT)" },
  //       exchange: { type: "string", description: "Exchange (default: Binance)" },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       topTraderPosition: { type: "object" },
  //       topTraderAccount: { type: "object" },
  //       takerFlow: { type: "object" },
  //       interpretation: { type: "string" },
  //       recommendation: { type: "string" },
  //       confidence: { type: "number" },
  //       dataSources: { type: "array", items: { type: "string" } },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["symbol", "interpretation", "confidence"],
  //   },
  // },
  // ============================================================================

  // ============================================================================
  // DISABLED - scan_volume_anomalies - REQUIRES PROFESSIONAL TIER
  // Uses: spot/coins-markets
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "scan_volume_anomalies",
  //   description: "🧠 INTELLIGENCE: Scan for unusual volume activity across coins comparing current vs historical averages.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       threshold: { type: "number", description: "Volume multiplier threshold (default: 2x)" },
  //     },
  //     required: [],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       anomalies: { type: "array" },
  //       scannedCoins: { type: "number" },
  //       anomaliesFound: { type: "number" },
  //       marketContext: { type: "string" },
  //       dataSources: { type: "array", items: { type: "string" } },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["anomalies", "scannedCoins"],
  //   },
  // },
  // ============================================================================

  {
    name: "get_market_overview",
    description: "🧠 INTELLIGENCE: Get a macro market snapshot (BTC price proxy, Fear & Greed, bull indicators, ETF flow, exchange BTC flow) with explicit Hobbyist-tier limitations.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        btcPrice: { type: "number" },
        btcPriceFormatted: { type: "string" },
        fearGreedIndex: { type: "object" },
        marketSentiment: { type: "string" },
        bullMarketIndicators: { type: "object" },
        etfData: { type: "object" },
        exchangeData: { type: "object" },
        limitations: { type: "string" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["btcPrice", "fearGreedIndex", "marketSentiment", "fetchedAt"],
    },
  },

  {
    name: "scan_oi_divergence",
    description: "🧠 INTELLIGENCE: Scan top coins for OI vs sentiment divergences using OI-change plus Fear & Greed regime. On Hobbyist tier this is a proxy signal and does not directly verify 80%+ long/short thresholds.",
    inputSchema: {
      type: "object" as const,
      properties: {
        coins: { type: "array", items: { type: "string" }, description: "Coins to scan. If omitted, server resolves a dynamic major-coin set using available live market data (max 20)." },
        oi_change_threshold: { type: "number", description: "Minimum absolute OI change % (1h) to flag (default: 0.5)" },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        longTraps: { type: "array", description: "Coins where OI falling but longs may be trapped", items: { type: "object", properties: { symbol: { type: "string" }, oi_change_1h: { type: "number" }, oi_change_4h: { type: "number" }, oi_change_24h: { type: "number" }, total_oi_usd: { type: "number" }, signal_strength: { type: "string" } } } },
        shortSqueezes: { type: "array", description: "Coins where OI rising into bearish sentiment", items: { type: "object" } },
        scannedCoins: { type: "number" },
        marketSentiment: { type: "object" },
        summary: { type: "object" },
        supportsLongShortThresholdCheck: { type: "boolean" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        limitations: { type: "string" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: [
        "longTraps",
        "shortSqueezes",
        "scannedCoins",
        "supportsLongShortThresholdCheck",
      ],
    },
  },

  {
    name: "get_oi_batch",
    description: "🧠 INTELLIGENCE: Get open interest data for MULTIPLE coins in a single call. Returns OI breakdown and change percentages for each coin. Use this instead of calling get_oi_by_exchange in a loop. Max 15 coins per call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "Coin symbols to fetch OI for (max 15 valid symbols). Non-string/empty values are ignored." },
      },
      required: ["symbols"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        results: { type: "array", items: { type: "object", properties: { symbol: { type: "string" }, total_oi_usd: { type: "number" }, oi_change_1h: { type: "number" }, oi_change_4h: { type: "number" }, oi_change_24h: { type: "number" }, exchange_count: { type: "number" } } } },
        count: { type: "number" },
        requested_count: { type: "number" },
        accepted_count: { type: "number" },
        dropped_count: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["results", "count"],
    },
  },
  {
    name: "analyze_hobby_market_regime",
    description: "🧠 INTELLIGENCE: Composite Hobby-tier market regime using Fear & Greed, AHR999, Stock-to-Flow, ETF flows, and Bull Market Peak indicators.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        regime: { type: "string" },
        regimeScore: { type: "number" },
        fearGreed: { type: "object" },
        valuation: { type: "object" },
        etfFlow: { type: "object" },
        bullMarketIndicators: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["regime", "regimeScore", "recommendation", "fetchedAt"],
    },
  },
  {
    name: "analyze_exchange_balance_pressure",
    description: "🧠 INTELLIGENCE: Coin-level exchange flow pressure by combining exchange balances and open-interest context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string", description: "Optional coin symbol. If omitted, server resolves the highest-OI coin dynamically." },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        pressure: { type: "string" },
        pressureScore: { type: "number" },
        exchangeFlow: { type: "object" },
        openInterestContext: { type: "object" },
        recommendation: { type: "string" },
        confidence: { type: "number" },
        dataSources: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "pressure", "pressureScore", "exchangeFlow", "recommendation", "fetchedAt"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Futures (Hobbyist-compatible)
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
    description: "📊 RAW: Get supported trading pairs for futures exchanges. Response is a map of exchange names to arrays of instrument objects with snake_case properties: instrument_id, base_asset, quote_asset.",
    inputSchema: { type: "object" as const, properties: { exchange: { type: "string" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "object" } }, required: ["data"] },
  },
  {
    name: "get_futures_pairs_markets",
    description: "📊 RAW: Get detailed market data for a coin's futures trading pairs. Response properties use snake_case: exchange_name, symbol, base_asset, price, open_interest_usd, volume_usd, funding_rate. If symbol is omitted, server resolves a default active major coin using live market data.",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Optional coin symbol (e.g., BTC)." } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_funding_rates",
    description: "📊 RAW: Get current funding rates for a coin across all exchanges. Response properties use snake_case. Each item has: symbol, stablecoin_margin_list (array of {exchange, funding_rate, next_funding_time}), token_margin_list (array of {exchange, funding_rate, next_funding_time}).",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_oi_by_exchange",
    description: "📊 RAW: Get open interest breakdown by exchange for a coin. Response properties use snake_case: exchange, symbol, open_interest_usd, open_interest_quantity, open_interest_by_stable_coin_margin, open_interest_quantity_by_coin_margin, open_interest_quantity_by_stable_coin_margin, open_interest_change_percent_5m/_15m/_30m/_1h/_4h/_24h. If symbol is omitted, server resolves a default active major coin using live market data.",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Optional coin symbol." } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_futures_liquidation_exchanges",
    description: "📊 RAW: Get futures exchanges supported by liquidation endpoints.",
    inputSchema: {
      type: "object" as const,
      properties: {
        range: {
          type: "string",
          description: "Range window for liquidation snapshots (e.g., 1h, 4h, 24h).",
          enum: ["1h", "4h", "24h"],
          default: "24h",
          examples: ["1h", "24h"],
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: { range: { type: "string" }, data: { type: "array", items: { type: "object" } }, count: { type: "number" }, fetchedAt: { type: "string" } },
      required: ["range", "data", "count"],
    },
  },
  {
    name: "get_futures_liquidation_coins",
    description: "📊 RAW: Get coins supported by liquidation endpoints.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: { data: { type: "array", items: { type: "object" } }, count: { type: "number" }, fetchedAt: { type: "string" } },
      required: ["data", "count"],
    },
  },

  // ============================================================================
  // DISABLED - PREMIUM ENDPOINTS (kept for later re-enable)
  // Current hobby key returns "Upgrade plan" for these endpoints.
  // ============================================================================
  // {
  //   name: "get_whale_index_history",
  //   description: "📊 RAW: Get whale index history for a coin.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 24 },
  //     },
  //     required: [],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       interval: { type: "string" },
  //       limit: { type: "number" },
  //       data: { type: "array", items: { type: "object" } },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["symbol", "data"],
  //   },
  // },
  // {
  //   name: "get_futures_liquidation_orders",
  //   description: "📊 RAW: Get recent futures liquidation order stream snapshot.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       range: { type: "string", default: "24h" },
  //     },
  //     required: [],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       range: { type: "string" },
  //       data: { type: "array", items: { type: "object" } },
  //       count: { type: "number" },
  //       fetchedAt: { type: "string" },
  //     },
  //     required: ["range", "data", "count"],
  //   },
  // },
  // {
  //   name: "get_rsi_list",
  //   description: "📊 RAW: Get RSI values for futures coins across supported timeframes.",
  //   inputSchema: { type: "object" as const, properties: {}, required: [] },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: { data: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } },
  //     required: ["data"],
  //   },
  // },
  // {
  //   name: "get_indicator_ma",
  //   description: "📊 RAW: Get Moving Average indicator history for a futures pair.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       window: { type: "number", default: 20 },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: { data: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } },
  //     required: ["data"],
  //   },
  // },
  // {
  //   name: "get_indicator_boll",
  //   description: "📊 RAW: Get Bollinger Bands indicator history for a futures pair.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       window: { type: "number", default: 20 },
  //       mult: { type: "number", default: 2 },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: { data: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } },
  //     required: ["data"],
  //   },
  // },

  // ============================================================================
  // DISABLED - REQUIRES PROFESSIONAL TIER OR ABOVE
  // TODO: Uncomment when API key upgraded to Professional
  // ============================================================================
  // {
  //   name: "get_futures_coins_markets",
  //   description: "📊 RAW: Get futures market data for all coins (OI, volume, funding, liquidations)",
  //   inputSchema: { type: "object" as const, properties: {}, required: [] },
  //   outputSchema: { type: "object" as const, properties: { markets: { type: "array" } }, required: ["markets"] },
  // },
  // {
  //   name: "get_price_history",
  //   description: "📊 RAW: Get OHLCV price history for a futures pair",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string", description: "Trading pair (e.g., BTCUSDT)" },
  //       interval: { type: "string", enum: ["1h", "4h", "12h", "1d", "1w"], default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_funding_rate_history",
  //   description: "📊 RAW: Get historical funding rate OHLC data",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_funding_arbitrage_list",
  //   description: "📊 RAW: Get funding rate arbitrage opportunities list",
  //   inputSchema: { type: "object" as const, properties: {}, required: [] },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_oi_history",
  //   description: "📊 RAW: Get aggregated open interest history (stablecoin margin)",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_oi_coin_margin_history",
  //   description: "📊 RAW: Get aggregated open interest history (coin margin)",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       exchanges: { type: "string", default: "Binance,OKX,Bybit" },
  //       interval: { type: "string", default: "1d" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_liquidation_history",
  //   description: "📊 RAW: Get liquidation history for a trading pair",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_aggregated_liquidations",
  //   description: "📊 RAW: Get aggregated liquidation history across exchanges",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_global_long_short_ratio",
  //   description: "📊 RAW: Get global long/short account ratio history",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_top_trader_position_ratio",
  //   description: "📊 RAW: Get top trader long/short position ratio history",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_top_trader_account_ratio",
  //   description: "📊 RAW: Get top trader long/short account ratio history",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_taker_buy_sell_volume",
  //   description: "📊 RAW: Get taker buy/sell volume history for a pair",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_aggregated_taker_volume",
  //   description: "📊 RAW: Get aggregated taker buy/sell volume across exchanges",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string" },
  //       exchange_list: { type: "string", default: "Binance,OKX,Bybit" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_cvd_history",
  //   description: "📊 RAW: Get Cumulative Volume Delta (CVD) history",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_volume_footprint",
  //   description: "📊 RAW: Get volume footprint chart data (buy/sell at price levels)",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_rsi_list",
  //   description: "📊 RAW: Get RSI values for all coins across timeframes",
  //   inputSchema: { type: "object" as const, properties: {}, required: [] },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_indicator_ma",
  //   description: "📊 RAW: Get Moving Average indicator data",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       window: { type: "number", default: 20 },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // {
  //   name: "get_indicator_boll",
  //   description: "📊 RAW: Get Bollinger Bands indicator data",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       window: { type: "number", default: 20 },
  //       mult: { type: "number", default: 2 },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // ============================================================================

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Indices (Hobbyist-compatible)
  // ============================================================================
  {
    name: "get_ahr999_index",
    description: "📊 RAW: Get AHR999 index (BTC accumulation indicator). Response items use snake_case: ahr999_value (number), date, price.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_rainbow_chart",
    description: "📊 RAW: Get Bitcoin Rainbow Chart data. Response properties use snake_case.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_fear_greed_index",
    description: "📊 RAW: Get Crypto Fear & Greed Index history. Response is an object (NOT an array) with snake_case properties: data_list (array of index values 0-100), price_list (array of BTC prices), time_list (array of timestamps). Last element in each array is the most recent.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        data: {
          type: "object",
          properties: {
            data_list: { type: "array", items: { type: "number" } },
            price_list: { type: "array", items: { type: "number" } },
            time_list: { type: "array", items: { type: "number" } },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["data"],
    },
  },
  {
    name: "get_stock_flow_index",
    description: "📊 RAW: Get Bitcoin stock-to-flow model index history.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } }, required: ["data"] },
  },
  {
    name: "get_bubble_index",
    description: "📊 RAW: Get Bitcoin Bubble Index data. Response items use snake_case: bubble_index (number), date, price.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_puell_multiple",
    description: "📊 RAW: Get Puell Multiple indicator. Response items use snake_case: puell_multiple (number), date, price.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  // ============================================================================
  // DISABLED - REQUIRES PROFESSIONAL TIER
  // ============================================================================
  // {
  //   name: "get_btc_vs_m2",
  //   description: "📊 RAW: Get Bitcoin vs Global M2 Supply growth data",
  //   inputSchema: { type: "object" as const, properties: {}, required: [] },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  {
    name: "get_bull_market_indicators",
    description: "📊 RAW: Get Bull Market Peak Indicators. Response items use snake_case: indicator_name, current_value, target_value, hit_status (boolean).",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - ETF
  // ============================================================================
  {
    name: "get_btc_etf_netflow",
    description: "📊 RAW: Get Bitcoin ETF net assets/flow history. Response properties use snake_case: net_assets_usd, change_usd, date.",
    inputSchema: { type: "object" as const, properties: { ticker: { type: "string", description: "ETF ticker (e.g., GBTC, IBIT)" } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_btc_etf_list",
    description: "📊 RAW: Get supported Bitcoin ETF tickers and metadata.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array", items: { type: "object" } }, count: { type: "number" }, fetchedAt: { type: "string" } }, required: ["data", "count"] },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Exchange
  // ============================================================================
  {
    name: "get_exchange_balance",
    description: "📊 RAW: Get exchange balance list for a coin. Response properties use snake_case: exchange_name, total_balance, balance_change_1d, balance_change_percent_1d, balance_change_7d, balance_change_percent_7d, balance_change_30d, balance_change_percent_30d.",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Optional coin symbol. If omitted, server resolves a default active major coin using live market data." } }, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  },
  {
    name: "get_exchange_balance_chart",
    description: "📊 RAW: Get historical exchange balance chart. Response is a nested object (not array) with snake_case properties: time_list (array of timestamps), data_map (object mapping exchange names to {balance_list: number[]}), price_list (array of prices).",
    inputSchema: { type: "object" as const, properties: { symbol: { type: "string", description: "Optional coin symbol. If omitted, server resolves a default active major coin using live market data." } }, required: [] },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        data: {
          type: "object",
          properties: {
            time_list: { type: "array", items: { type: "number" } },
            price_list: { type: "array", items: { type: "number" } },
            data_map: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  balance_list: { type: "array", items: { type: "number" } },
                },
              },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "data"],
    },
  },

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Spot
  // ============================================================================
  {
    name: "get_spot_supported_coins",
    description: "📊 RAW: Get spot coins supported by Coinglass.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
    outputSchema: { type: "object" as const, properties: { data: { type: "array", items: { type: "object" } }, count: { type: "number" }, fetchedAt: { type: "string" } }, required: ["data", "count"] },
  },
  // {
  //   name: "get_spot_price_history",
  //   description: "📊 RAW: Get spot price OHLCV history.",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       exchange: { type: "string", default: "Binance" },
  //       symbol: { type: "string" },
  //       interval: { type: "string", default: "1h" },
  //       limit: { type: "number", default: 100 },
  //     },
  //     required: ["symbol"],
  //   },
  //   outputSchema: {
  //     type: "object" as const,
  //     properties: { data: { type: "array", items: { type: "object" } }, fetchedAt: { type: "string" } },
  //     required: ["data"],
  //   },
  // },
  // ============================================================================

  // ============================================================================
  // TIER 2: RAW DATA LAYER - Options
  // DISABLED - REQUIRES PROFESSIONAL TIER
  // ============================================================================
  // {
  //   name: "get_options_oi_history",
  //   description: "📊 RAW: Get options open interest history by exchange",
  //   inputSchema: {
  //     type: "object" as const,
  //     properties: {
  //       symbol: { type: "string", default: "BTC" },
  //       unit: { type: "string", default: "USD" },
  //       range: { type: "string", default: "1h" },
  //     },
  //     required: [],
  //   },
  //   outputSchema: { type: "object" as const, properties: { data: { type: "array" } }, required: ["data"] },
  // },
  // ============================================================================
];

const DEFAULT_EXECUTE_PRICE_USD = "0.001";
const UNPRICED_EXECUTE_METHODS = new Set(["get_spot_supported_coins"]);

const TOOLS_WITH_METADATA = TOOLS.map((tool) => {
  const existingMeta =
    "_meta" in tool && typeof tool._meta === "object" && tool._meta !== null
      ? (tool._meta as Record<string, unknown>)
      : {};
  const existingPricing =
    "pricing" in existingMeta &&
    typeof existingMeta.pricing === "object" &&
    existingMeta.pricing !== null
      ? { ...(existingMeta.pricing as Record<string, unknown>) }
      : {};

  if (UNPRICED_EXECUTE_METHODS.has(tool.name)) {
    delete existingPricing.executeUsd;
  } else if (
    !("executeUsd" in existingPricing) ||
    typeof existingPricing.executeUsd !== "string"
  ) {
    existingPricing.executeUsd = DEFAULT_EXECUTE_PRICE_USD;
  }

  return {
    ...tool,
    _meta: {
      ...existingMeta,
      pricing: existingPricing,
      rateLimit: buildToolRateLimitMetadata(tool.name),
    },
  };
});

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "coinglass-intelligence", version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

console.log("[coinglass-config] startup", {
  version: SERVER_VERSION,
  plan: COINGLASS_PLAN,
  contextAuthEnabled: CONTEXT_AUTH_ENABLED,
  maxRequestsPerMinute: COINGLASS_RATE_LIMIT_PER_MINUTE,
  cooldownMs: COINGLASS_RATE_LIMIT_COOLDOWN_MS,
  toolCount: TOOLS_WITH_METADATA.length,
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS_WITH_METADATA,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;
  try {
    await assertCoinglassApiAccessible();

    switch (name) {
      // Tier 1 Intelligence Tools (Hobbyist-compatible)
      case "analyze_market_sentiment": return await handleAnalyzeMarketSentiment(args);
      case "get_btc_valuation_score": return await handleGetBtcValuationScore();
      case "get_market_overview": return await handleGetMarketOverview();
      case "scan_oi_divergence": return await handleScanOiDivergence(args);
      case "get_oi_batch": return await handleGetOiBatch(args);
      case "analyze_hobby_market_regime": return await handleAnalyzeHobbyMarketRegime();
      case "analyze_exchange_balance_pressure": return await handleAnalyzeExchangeBalancePressure(args);

      // Tier 2 Raw Tools (Hobbyist-compatible)
      case "get_supported_coins": return await handleGetSupportedCoins();
      case "get_supported_exchanges": return await handleGetSupportedExchanges();
      case "get_exchange_pairs": return await handleGetExchangePairs(args);
      case "get_futures_pairs_markets": return await handleGetFuturesPairsMarkets(args);
      case "get_funding_rates": return await handleGetFundingRates(args);
      case "get_oi_by_exchange": return await handleGetOiByExchange(args);
      case "get_futures_liquidation_exchanges": return await handleGetFuturesLiquidationExchanges(args);
      case "get_futures_liquidation_coins": return await handleGetFuturesLiquidationCoins();
      case "get_ahr999_index": return await handleGetAhr999Index();
      case "get_rainbow_chart": return await handleGetRainbowChart();
      case "get_fear_greed_index": return await handleGetFearGreedIndex();
      case "get_stock_flow_index": return await handleGetStockFlowIndex();
      case "get_bubble_index": return await handleGetBubbleIndex();
      case "get_puell_multiple": return await handleGetPuellMultiple();
      case "get_bull_market_indicators": return await handleGetBullMarketIndicators();
      case "get_btc_etf_netflow": return await handleGetBtcEtfNetflow(args);
      case "get_btc_etf_list": return await handleGetBtcEtfList();
      case "get_exchange_balance": return await handleGetExchangeBalance(args);
      case "get_exchange_balance_chart": return await handleGetExchangeBalanceChart(args);
      case "get_spot_supported_coins": return await handleGetSpotSupportedCoins();
      // Disabled tools (premium endpoints) are intentionally not exposed on Hobby tier
      // to prevent marketplace planners from calling tools that return Upgrade plan.
      // case "get_whale_index_history": return await handleGetWhaleIndexHistory(args);
      // case "get_futures_liquidation_orders": return await handleGetFuturesLiquidationOrders(args);
      // case "get_rsi_list": return await handleGetRsiList();
      // case "get_indicator_ma": return await handleGetIndicatorMa(args);
      // case "get_indicator_boll": return await handleGetIndicatorBoll(args);
      // case "get_spot_price_history": return await handleGetSpotPriceHistory(args);

      // ============================================================================
      // DISABLED HANDLERS - Require Professional tier
      // case "calculate_squeeze_probability": return await handleCalculateSqueezeProbability(args);
      // case "find_funding_arbitrage": return await handleFindFundingArbitrage(args);
      // case "detect_liquidation_risk": return await handleDetectLiquidationRisk(args);
      // case "analyze_smart_money": return await handleAnalyzeSmartMoney(args);
      // case "scan_volume_anomalies": return await handleScanVolumeAnomalies(args);
      // case "get_futures_coins_markets": return await handleGetFuturesCoinsMarkets();
      // case "get_price_history": return await handleGetPriceHistory(args);
      // case "get_funding_rate_history": return await handleGetFundingRateHistory(args);
      // case "get_funding_arbitrage_list": return await handleGetFundingArbitrageList();
      // case "get_oi_history": return await handleGetOiHistory(args);
      // case "get_oi_coin_margin_history": return await handleGetOiCoinMarginHistory(args);
      // case "get_liquidation_history": return await handleGetLiquidationHistory(args);
      // case "get_aggregated_liquidations": return await handleGetAggregatedLiquidations(args);
      // case "get_global_long_short_ratio": return await handleGetGlobalLongShortRatio(args);
      // case "get_top_trader_position_ratio": return await handleGetTopTraderPositionRatio(args);
      // case "get_top_trader_account_ratio": return await handleGetTopTraderAccountRatio(args);
      // case "get_taker_buy_sell_volume": return await handleGetTakerBuySellVolume(args);
      // case "get_aggregated_taker_volume": return await handleGetAggregatedTakerVolume(args);
      // case "get_cvd_history": return await handleGetCvdHistory(args);
      // case "get_volume_footprint": return await handleGetVolumeFootprint(args);
      // case "get_btc_vs_m2": return await handleGetBtcVsM2();
      // case "get_spot_coins_markets": return await handleGetSpotCoinsMarkets(args);
      // case "get_options_oi_history": return await handleGetOptionsOiHistory(args);
      // ============================================================================

      default: return errorResult(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (isPlanUpgradeError(error)) {
      return planUpgradeResult(name, error);
    }
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

function planUpgradeResult(toolName: string, error: PlanUpgradeRequiredError): CallToolResult {
  return successResult({
    error: "PLAN_UPGRADE_REQUIRED",
    tool: toolName,
    endpoint: error.endpoint,
    message: error.message,
    configuredPlan: COINGLASS_PLAN,
    suggestion:
      "Use an API key with access to this endpoint set, or upgrade your Coinglass plan before retrying.",
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// API HELPERS
// ============================================================================

async function coinglassGet(endpoint: string, params: Record<string, string | number> = {}, cacheTtl?: number): Promise<unknown> {
  assertEndpointAllowedForConfiguredPlan(endpoint);

  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;

  if (cacheTtl) {
    const cached = cache.get<unknown>(cacheKey);
    if (cached !== undefined) return cached;
  }

  await apiRateLimiter.acquire(endpoint);

  const url = new URL(`${COINGLASS_API}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    headers: { "accept": "application/json", "CG-API-KEY": API_KEY },
  });
  if (!res.ok) {
    const responseText = await res.text();
    console.error("[coinglass-api] http_error", {
      endpoint,
      status: res.status,
      retryAfter: res.headers.get("retry-after"),
      keyMaxLimit: res.headers.get("api-key-max-limit"),
      keyLimitRemaining: res.headers.get("api-key-limit-remaining"),
      params,
      responsePreview: responseText.slice(0, 180),
    });
    if (isPlanUpgradeMessage(responseText)) {
      throw new PlanUpgradeRequiredError(
        endpoint,
        `Coinglass endpoint requires a higher plan: ${endpoint}`
      );
    }
    throw new Error(`Coinglass API error (${res.status}): ${responseText}`);
  }
  const json = await res.json() as { code: string; msg?: string; data?: unknown };
  if (json.code !== "0") {
    console.error("[coinglass-api] upstream_error_code", {
      endpoint,
      code: json.code,
      message: json.msg ?? "Unknown",
      params,
    });
    if (json.msg && isPlanUpgradeMessage(json.msg)) {
      throw new PlanUpgradeRequiredError(
        endpoint,
        `Coinglass endpoint requires a higher plan: ${endpoint}`
      );
    }
    throw new Error(`Coinglass error: ${json.msg || "Unknown"}`);
  }

  if (cacheTtl) {
    cache.set(cacheKey, json.data, cacheTtl);
  }

  return json.data;
}

async function assertCoinglassApiAccessible(): Promise<void> {
  const now = Date.now();
  if (apiAccessProbeCache && now - apiAccessProbeCache.checkedAt < API_ACCESS_PROBE_TTL_MS) {
    if (apiAccessProbeCache.accessible) {
      return;
    }
    throw new PlanUpgradeRequiredError(
      apiAccessProbeCache.endpoint,
      apiAccessProbeCache.reason
    );
  }

  let latestPlanUpgradeError: PlanUpgradeRequiredError | null = null;
  let latestNonPlanError: Error | null = null;

  for (const probe of API_ACCESS_PROBES) {
    try {
      await coinglassGet(probe.endpoint, probe.params ?? {});
      apiAccessProbeCache = { checkedAt: Date.now(), accessible: true };
      return;
    } catch (error) {
      if (isPlanUpgradeError(error)) {
        latestPlanUpgradeError = error;
        continue;
      }
      latestNonPlanError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  if (latestNonPlanError) {
    throw latestNonPlanError;
  }

  if (latestPlanUpgradeError) {
    apiAccessProbeCache = {
      checkedAt: Date.now(),
      accessible: false,
      endpoint: latestPlanUpgradeError.endpoint,
      reason:
        "Current COINGLASS_API_KEY cannot access tested endpoints (upstream returned 'Upgrade plan').",
    };
    throw new PlanUpgradeRequiredError(
      latestPlanUpgradeError.endpoint,
      apiAccessProbeCache.reason
    );
  }
}

type CoinMarketsRow = {
  symbol?: string;
  open_interest_usd?: number;
  market_cap_usd?: number;
  current_price?: number;
};

function normalizeCoinSymbols(input: unknown[], max: number): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const value of input) {
    const rawSymbol =
      typeof value === "string"
        ? value
        : typeof value === "object" &&
            value !== null &&
            typeof (value as { symbol?: unknown }).symbol === "string"
          ? (value as { symbol: string }).symbol
          : undefined;
    if (!rawSymbol) {
      continue;
    }
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    normalized.push(symbol);
    if (normalized.length >= max) {
      break;
    }
  }

  return normalized;
}

async function getTopCoinsByOpenInterest(limit: number): Promise<string[]> {
  const boundedLimit = Math.max(1, Math.min(limit, DEFAULT_SCAN_COIN_LIMIT));

  try {
    const perPage = Math.min(
      Math.max(boundedLimit * 4, 40),
      MAX_DYNAMIC_COIN_LOOKUP_PAGE_SIZE
    );
    const marketsData = await coinglassGet(
      "/api/futures/coins-markets",
      { page: 1, per_page: perPage },
      CACHE_TTL_SHORT
    );
    const markets = Array.isArray(marketsData)
      ? (marketsData as CoinMarketsRow[])
      : [];

    const rankedSymbols = markets
      .filter((row) => typeof row.symbol === "string" && row.symbol.trim().length > 0)
      .sort(
        (a, b) =>
          (b.open_interest_usd ?? 0) - (a.open_interest_usd ?? 0)
      )
      .map((row) => row.symbol as string);

    const normalized = normalizeCoinSymbols(rankedSymbols, boundedLimit);
    if (normalized.length > 0) {
      return normalized;
    }
  } catch (error) {
    console.warn("[coinglass-data] dynamic_coin_lookup_fallback", {
      reason: error instanceof Error ? error.message : "unknown_error",
      fallback: "/api/futures/supported-coins",
    });
    // Fall back to supported coins when market ranking is unavailable.
  }

  const supportedData = await coinglassGet(
    "/api/futures/supported-coins",
    {},
    CACHE_TTL_LONG
  ).catch(() => []);
  const supportedCoins = Array.isArray(supportedData)
    ? supportedData
    : [];
  const supportedSymbols = normalizeCoinSymbols(supportedCoins, 4_000);
  if (supportedSymbols.length === 0) {
    return [...MAJOR_COIN_SYMBOL_FALLBACK].slice(0, boundedLimit);
  }

  const supportedSet = new Set(supportedSymbols);
  const majorFallback = MAJOR_COIN_SYMBOL_FALLBACK
    .filter((symbol) => supportedSet.has(symbol))
    .slice(0, boundedLimit);
  if (majorFallback.length > 0) {
    return majorFallback;
  }

  return supportedSymbols.slice(0, boundedLimit);
}

async function resolveDynamicSymbol(symbolInput: unknown): Promise<string> {
  if (typeof symbolInput === "string" && symbolInput.trim().length > 0) {
    return symbolInput.trim().toUpperCase();
  }

  const dynamicTopCoins = await getTopCoinsByOpenInterest(1);
  if (dynamicTopCoins.length > 0) {
    return dynamicTopCoins[0];
  }

  throw new Error(
    "Unable to resolve default symbol from live market data. Provide a symbol explicitly."
  );
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function getLatestRow(data: unknown): Record<string, unknown> | null {
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }
  const latest = data[data.length - 1];
  if (typeof latest === "object" && latest !== null) {
    return latest as Record<string, unknown>;
  }
  return null;
}

function pickNumericValue(row: Record<string, unknown> | null, keys: string[]): number | null {
  if (!row) {
    return null;
  }
  for (const key of keys) {
    const candidate = toFiniteNumber(row[key]);
    if (candidate !== null) {
      return candidate;
    }
  }
  return null;
}

// ============================================================================
// TIER 1: INTELLIGENCE HANDLERS
// ============================================================================

async function handleCalculateSqueezeProbability(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";

  const [fearGreedData, bullIndicators, exchangeBalance] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/bull-market-peak-indicator", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/exchange/balance/list", { symbol }, CACHE_TTL_SHORT).catch(() => []),
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
  const requestedCoins = Array.isArray(args?.coins)
    ? normalizeCoinSymbols(args.coins as unknown[], DEFAULT_SCAN_COIN_LIMIT)
    : [];
  const coins =
    requestedCoins.length > 0
      ? requestedCoins
      : await getTopCoinsByOpenInterest(DEFAULT_ANALYZE_COIN_LIMIT);

  const [fearGreed, bullIndicators] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM).catch(
      () => null
    ),
    coinglassGet("/api/bull-market-peak-indicator", {}, CACHE_TTL_MEDIUM).catch(
      () => []
    ),
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

  const hobbyistConstraintReason =
    "Hobbyist tier in this server configuration does not provide direct per-coin long/short ratio and funding-bias metrics.";

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
    supportsLongShortThresholdCheck: false,
    fundingBias: {
      available: false,
      data: [],
      reason: hobbyistConstraintReason,
    },
    longShortRatio: {
      available: false,
      data: [],
      thresholdCheckSupported: false,
      reason: hobbyistConstraintReason,
    },
    recommendation,
    confidence: 0.8,
    dataSources: ["fear-greed-history", "bull-market-peak-indicator"],
    limitations:
      "Hobbyist tier: direct funding-bias and long/short ratio checks are unavailable in this server configuration. Sentiment is based on Fear & Greed + bull indicators.",
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
    coinglassGet("/api/index/ahr999", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/index/bitcoin/rainbow-chart", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/index/bitcoin/bubble-index", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/index/puell-multiple", {}, CACHE_TTL_MEDIUM).catch(() => null),
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
    coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/bull-market-peak-indicator", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/etf/bitcoin/net-assets/history", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/exchange/balance/list", { symbol: "BTC" }, CACHE_TTL_SHORT).catch(() => []),
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
    limitations: "⚠️ Hobbyist tier: advanced liquidation heatmaps, long/short account ratios, and several historical analytics remain Professional+.",
    dataSources: ["fear-greed-history", "bull-market-peak-indicator", "etf/bitcoin/net-assets/history", "exchange/balance/list"],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeHobbyMarketRegime(): Promise<CallToolResult> {
  const [fearGreedData, ahr999Data, stockFlowData, bullIndicatorsData, etfData] = await Promise.all([
    coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM).catch(() => null),
    coinglassGet("/api/index/ahr999", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/index/stock-flow", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/bull-market-peak-indicator", {}, CACHE_TTL_MEDIUM).catch(() => []),
    coinglassGet("/api/etf/bitcoin/net-assets/history", {}, CACHE_TTL_MEDIUM).catch(() => []),
  ]);

  const fearGreed = fearGreedData as { data_list?: number[]; price_list?: number[] } | null;
  const fearGreedValue =
    fearGreed?.data_list && fearGreed.data_list.length > 0
      ? fearGreed.data_list[fearGreed.data_list.length - 1]
      : 50;
  const btcPrice =
    fearGreed?.price_list && fearGreed.price_list.length > 0
      ? fearGreed.price_list[fearGreed.price_list.length - 1]
      : null;

  const latestAhr = getLatestRow(ahr999Data);
  const ahr999Value = pickNumericValue(latestAhr, ["ahr999_value", "ahr999", "value"]);

  const latestStockFlow = getLatestRow(stockFlowData);
  const stockFlowValue = pickNumericValue(latestStockFlow, [
    "stock_flow",
    "stock_to_flow",
    "stock_flow_index",
    "value",
  ]);
  const stockFlowModelPrice = pickNumericValue(latestStockFlow, [
    "model_price",
    "stock_flow_price",
    "stock_to_flow_price",
    "s2f_price",
  ]);

  const bullIndicators = Array.isArray(bullIndicatorsData)
    ? (bullIndicatorsData as Array<{ hit_status?: boolean }>)
    : [];
  const triggeredCount = bullIndicators.filter((row) => row.hit_status === true).length;
  const totalBullIndicators = bullIndicators.length;

  const latestEtf = getLatestRow(etfData);
  const etfDailyChangeUsd = pickNumericValue(latestEtf, ["change_usd", "change"]);
  const etfNetAssetsUsd = pickNumericValue(latestEtf, ["net_assets_usd", "net_assets"]);

  let regimeScore = 50;
  if (fearGreedValue >= 80) regimeScore += 20;
  else if (fearGreedValue >= 60) regimeScore += 10;
  else if (fearGreedValue <= 20) regimeScore -= 20;
  else if (fearGreedValue <= 40) regimeScore -= 10;

  if (ahr999Value !== null) {
    if (ahr999Value < 0.45) regimeScore -= 15;
    else if (ahr999Value < 1.2) regimeScore -= 8;
    else if (ahr999Value > 4) regimeScore += 15;
  }

  const bullHitRatio =
    totalBullIndicators > 0 ? triggeredCount / totalBullIndicators : 0;
  if (bullHitRatio >= 0.6) regimeScore += 15;
  else if (bullHitRatio >= 0.35) regimeScore += 8;

  if (etfDailyChangeUsd !== null) {
    if (etfDailyChangeUsd >= 200_000_000) regimeScore += 10;
    else if (etfDailyChangeUsd <= -200_000_000) regimeScore -= 10;
  }

  let stockFlowPremiumPercent: number | null = null;
  if (btcPrice !== null && stockFlowModelPrice !== null && stockFlowModelPrice > 0) {
    stockFlowPremiumPercent = ((btcPrice / stockFlowModelPrice) - 1) * 100;
    if (stockFlowPremiumPercent >= 25) regimeScore += 10;
    else if (stockFlowPremiumPercent <= -20) regimeScore -= 10;
  }

  regimeScore = Math.max(0, Math.min(100, Math.round(regimeScore)));

  let regime = "neutral";
  let recommendation = "No strong directional edge. Keep position sizing balanced.";
  if (regimeScore >= 80) {
    regime = "euphoric_overheat";
    recommendation = "Risk is elevated. Consider de-risking and tighter risk controls.";
  } else if (regimeScore >= 65) {
    regime = "risk_on";
    recommendation = "Momentum regime is favorable, but avoid overleveraging into strength.";
  } else if (regimeScore <= 20) {
    regime = "capitulation";
    recommendation = "Deep fear regime. Historically favorable for gradual accumulation.";
  } else if (regimeScore <= 35) {
    regime = "accumulation";
    recommendation = "Weak sentiment but improving valuation context; DCA-style entries are reasonable.";
  }

  const availableSignals = [
    ahr999Value !== null,
    stockFlowValue !== null || stockFlowModelPrice !== null,
    totalBullIndicators > 0,
    etfDailyChangeUsd !== null,
  ].filter(Boolean).length;
  const confidence =
    availableSignals >= 4 ? 0.85 : availableSignals >= 3 ? 0.75 : 0.65;

  return successResult({
    regime,
    regimeScore,
    fearGreed: {
      value: fearGreedValue,
      sentiment:
        fearGreedValue >= 75
          ? "Extreme Greed"
          : fearGreedValue >= 55
            ? "Greed"
            : fearGreedValue >= 45
              ? "Neutral"
              : fearGreedValue >= 25
                ? "Fear"
                : "Extreme Fear",
      btcPrice,
    },
    valuation: {
      ahr999Value,
      stockFlowValue,
      stockFlowModelPrice,
      stockFlowPremiumPercent,
    },
    etfFlow: {
      dailyChangeUsd: etfDailyChangeUsd,
      netAssetsUsd: etfNetAssetsUsd,
    },
    bullMarketIndicators: {
      triggeredCount,
      totalCount: totalBullIndicators,
      hitRatio: totalBullIndicators > 0 ? Number(bullHitRatio.toFixed(2)) : null,
    },
    recommendation,
    confidence,
    dataSources: [
      "index/fear-greed-history",
      "index/ahr999",
      "index/stock-flow",
      "bull-market-peak-indicator",
      "etf/bitcoin/net-assets/history",
    ],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeExchangeBalancePressure(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  const [exchangeBalanceData, openInterestData] = await Promise.all([
    coinglassGet("/api/exchange/balance/list", { symbol }, CACHE_TTL_SHORT).catch(() => []),
    coinglassGet("/api/futures/open-interest/exchange-list", { symbol }, CACHE_TTL_SHORT).catch(() => []),
  ]);

  const balances = Array.isArray(exchangeBalanceData)
    ? exchangeBalanceData as Array<Record<string, unknown>>
    : [];
  const openInterestRows = Array.isArray(openInterestData)
    ? openInterestData as Array<Record<string, unknown>>
    : [];

  let totalBalance = 0;
  let netFlow1d = 0;
  let netFlow7d = 0;
  let netFlow30d = 0;
  let topExchangeBalance = 0;
  let topExchangeName = "unknown";

  for (const row of balances) {
    const balance = toFiniteNumber(row.total_balance) ?? 0;
    const change1d = toFiniteNumber(row.balance_change_1d) ?? 0;
    const change7d = toFiniteNumber(row.balance_change_7d) ?? 0;
    const change30d = toFiniteNumber(row.balance_change_30d) ?? 0;
    totalBalance += balance;
    netFlow1d += change1d;
    netFlow7d += change7d;
    netFlow30d += change30d;
    if (balance > topExchangeBalance) {
      topExchangeBalance = balance;
      topExchangeName = typeof row.exchange_name === "string" ? row.exchange_name : "unknown";
    }
  }

  const allRow = openInterestRows.find((row) => row.exchange === "All");
  const openInterestUsd = toFiniteNumber(allRow?.open_interest_usd) ?? 0;

  const flowToOiRatioPercent =
    openInterestUsd > 0 ? (netFlow1d / openInterestUsd) * 100 : null;
  const topExchangeConcentrationPercent =
    totalBalance > 0 ? (topExchangeBalance / totalBalance) * 100 : 0;

  let pressureScore = 0;
  if (netFlow1d > 0) pressureScore += 35;
  else if (netFlow1d < 0) pressureScore -= 35;

  if (flowToOiRatioPercent !== null) {
    if (flowToOiRatioPercent >= 1) pressureScore += 20;
    else if (flowToOiRatioPercent >= 0.3) pressureScore += 10;
    else if (flowToOiRatioPercent <= -1) pressureScore -= 20;
    else if (flowToOiRatioPercent <= -0.3) pressureScore -= 10;
  }

  if (topExchangeConcentrationPercent >= 35) {
    pressureScore += netFlow1d >= 0 ? 8 : -8;
  }
  pressureScore = Math.max(-100, Math.min(100, Math.round(pressureScore)));

  let pressure = "neutral";
  let recommendation =
    "Exchange flow is mixed. Wait for clearer directional balance/inflow confirmation.";
  if (pressureScore >= 25) {
    pressure = "bearish_distribution_pressure";
    recommendation =
      "Net inflows to exchanges suggest potential sell pressure. Favor tighter risk controls.";
  } else if (pressureScore <= -25) {
    pressure = "bullish_accumulation_pressure";
    recommendation =
      "Net outflows from exchanges suggest accumulation. Pullbacks may be buyable in trend.";
  }

  const confidence = balances.length >= 8 ? 0.8 : balances.length >= 4 ? 0.72 : 0.62;

  return successResult({
    symbol,
    pressure,
    pressureScore,
    exchangeFlow: {
      netFlow1d,
      netFlow7d,
      netFlow30d,
      totalBalance,
      topExchange: topExchangeName,
      topExchangeConcentrationPercent: Number(topExchangeConcentrationPercent.toFixed(2)),
    },
    openInterestContext: {
      openInterestUsd,
      flowToOiRatioPercent:
        flowToOiRatioPercent === null ? null : Number(flowToOiRatioPercent.toFixed(4)),
    },
    recommendation,
    confidence,
    dataSources: ["exchange/balance/list", "futures/open-interest/exchange-list"],
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// SCAN & BATCH INTELLIGENCE HANDLERS
// ============================================================================

async function handleScanOiDivergence(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const oiChangeThreshold = (args?.oi_change_threshold as number) || 0.5;
  const requestedCoins = Array.isArray(args?.coins)
    ? normalizeCoinSymbols(args.coins as unknown[], DEFAULT_SCAN_COIN_LIMIT)
    : [];

  const targetCoins =
    requestedCoins.length > 0
      ? requestedCoins
      : await getTopCoinsByOpenInterest(DEFAULT_SCAN_COIN_LIMIT);

  const fearGreed = await coinglassGet(
    "/api/index/fear-greed-history",
    {},
    CACHE_TTL_MEDIUM
  ).catch(() => null);

  let fgValue = 50;
  let fgSentiment = "Neutral";
  const fgData = fearGreed as { data_list?: number[] } | null;
  if (fgData?.data_list && fgData.data_list.length > 0) {
    fgValue = fgData.data_list.at(-1) ?? 50;
    fgSentiment = fgValue >= 75 ? "Extreme Greed" : fgValue >= 55 ? "Greed" : fgValue >= 45 ? "Neutral" : fgValue >= 25 ? "Fear" : "Extreme Fear";
  }

  const BATCH_SIZE = 10;
  const oiResults: Array<{
    symbol: string;
    totalOiUsd: number;
    oiChange1h: number;
    oiChange4h: number;
    oiChange24h: number;
    exchanges: number;
  }> = [];

  for (let i = 0; i < targetCoins.length; i += BATCH_SIZE) {
    const batch = targetCoins.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const data = await coinglassGet("/api/futures/open-interest/exchange-list", { symbol }, CACHE_TTL_SHORT);
          const exchanges = Array.isArray(data) ? data : [];
          const all = exchanges.find((e: { exchange?: string }) => e.exchange === "All") as {
            open_interest_usd?: number;
            open_interest_change_percent_1h?: number;
            open_interest_change_percent_4h?: number;
            open_interest_change_percent_24h?: number;
          } | undefined;
          return {
            symbol,
            totalOiUsd: all?.open_interest_usd ?? 0,
            oiChange1h: all?.open_interest_change_percent_1h ?? 0,
            oiChange4h: all?.open_interest_change_percent_4h ?? 0,
            oiChange24h: all?.open_interest_change_percent_24h ?? 0,
            exchanges: exchanges.length - 1,
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) oiResults.push(r);
    }
  }

  const isFearful = fgValue < 45;
  const isGreedy = fgValue > 55;

  const longTraps = oiResults
    .filter((r) => {
      const oiFalling = r.oiChange1h < -oiChangeThreshold || r.oiChange4h < -oiChangeThreshold * 2;
      return oiFalling && isGreedy;
    })
    .map((r) => ({
      symbol: r.symbol,
      oi_change_1h: r.oiChange1h,
      oi_change_4h: r.oiChange4h,
      oi_change_24h: r.oiChange24h,
      total_oi_usd: r.totalOiUsd,
      signal_strength: Math.abs(r.oiChange1h) > 2 ? "strong" : Math.abs(r.oiChange1h) > 1 ? "moderate" : "weak",
      reason: `OI declining (${r.oiChange1h.toFixed(2)}% 1h) while market sentiment is ${fgSentiment} (${fgValue}) - longs may be getting liquidated`,
    }))
    .sort((a, b) => a.oi_change_1h - b.oi_change_1h);

  const shortSqueezes = oiResults
    .filter((r) => {
      const oiRising = r.oiChange1h > oiChangeThreshold || r.oiChange4h > oiChangeThreshold * 2;
      return oiRising && isFearful;
    })
    .map((r) => ({
      symbol: r.symbol,
      oi_change_1h: r.oiChange1h,
      oi_change_4h: r.oiChange4h,
      oi_change_24h: r.oiChange24h,
      total_oi_usd: r.totalOiUsd,
      signal_strength: r.oiChange1h > 2 ? "strong" : r.oiChange1h > 1 ? "moderate" : "weak",
      reason: `OI increasing (${r.oiChange1h.toFixed(2)}% 1h) while market sentiment is ${fgSentiment} (${fgValue}) - new shorts may be squeezed`,
    }))
    .sort((a, b) => b.oi_change_1h - a.oi_change_1h);

  const oiFallingCoins = oiResults.filter((r) => r.oiChange1h < -oiChangeThreshold);
  const oiRisingCoins = oiResults.filter((r) => r.oiChange1h > oiChangeThreshold);

  let recommendation: string;
  if (longTraps.length > 3) {
    recommendation = `Multiple potential long traps detected (${longTraps.length} coins). OI falling in greedy market suggests longs being liquidated. Consider defensive positioning.`;
  } else if (shortSqueezes.length > 3) {
    recommendation = `Multiple potential short squeezes brewing (${shortSqueezes.length} coins). OI rising in fearful market suggests shorts may get squeezed.`;
  } else if (longTraps.length > 0 || shortSqueezes.length > 0) {
    recommendation = `Some divergences found: ${longTraps.length} potential long trap(s), ${shortSqueezes.length} potential short squeeze(s). Monitor these coins closely.`;
  } else {
    recommendation = `No significant OI-sentiment divergences found across ${oiResults.length} coins. Market positioning appears consistent with sentiment.`;
  }

  return successResult({
    longTraps,
    shortSqueezes,
    scannedCoins: oiResults.length,
    marketSentiment: {
      fearGreedIndex: fgValue,
      sentiment: fgSentiment,
      marketBias: isGreedy ? "bullish_bias" : isFearful ? "bearish_bias" : "neutral",
    },
    summary: {
      coinsWithFallingOi: oiFallingCoins.length,
      coinsWithRisingOi: oiRisingCoins.length,
      coinsStable: oiResults.length - oiFallingCoins.length - oiRisingCoins.length,
    },
    supportsLongShortThresholdCheck: false,
    recommendation,
    confidence: oiResults.length >= 20 ? 0.8 : oiResults.length >= 10 ? 0.7 : 0.6,
    limitations: "Hobbyist tier: Long/short ratio data not available. Divergence based on OI changes + Fear & Greed sentiment.",
    dataSources: ["open-interest/exchange-list", "fear-greed-history", "bull-market-peak-indicator"],
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetOiBatch(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const rawSymbols = Array.isArray(args?.symbols) ? args.symbols : [];

  if (rawSymbols.length === 0) {
    return errorResult("symbols array is required and must not be empty");
  }

  const targetSymbols = normalizeCoinSymbols(rawSymbols as unknown[], 15);
  if (targetSymbols.length === 0) {
    return errorResult(
      "symbols must include at least one valid non-empty string (e.g., ['BTC', 'ETH'])"
    );
  }

  const droppedCount = Math.max(0, rawSymbols.length - targetSymbols.length);
  if (droppedCount > 0) {
    console.warn("[coinglass-oi-batch] dropped_invalid_symbols", {
      requested: rawSymbols.length,
      accepted: targetSymbols.length,
      dropped: droppedCount,
    });
  }

  const BATCH_SIZE = 8;
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < targetSymbols.length; i += BATCH_SIZE) {
    const batch = targetSymbols.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const data = await coinglassGet("/api/futures/open-interest/exchange-list", { symbol }, CACHE_TTL_SHORT);
          const exchanges = Array.isArray(data) ? data : [];
          const all = exchanges.find((e: { exchange?: string }) => e.exchange === "All") as {
            open_interest_usd?: number;
            open_interest_quantity?: number;
            open_interest_change_percent_1h?: number;
            open_interest_change_percent_4h?: number;
            open_interest_change_percent_24h?: number;
          } | undefined;
          return {
            symbol,
            total_oi_usd: all?.open_interest_usd ?? 0,
            total_oi_quantity: all?.open_interest_quantity ?? 0,
            oi_change_1h: all?.open_interest_change_percent_1h ?? 0,
            oi_change_4h: all?.open_interest_change_percent_4h ?? 0,
            oi_change_24h: all?.open_interest_change_percent_24h ?? 0,
            exchange_count: exchanges.length - 1,
          };
        } catch {
          return { symbol, error: "Failed to fetch OI data", total_oi_usd: 0 };
        }
      })
    );
    results.push(...batchResults);
  }

  return successResult({
    results,
    count: results.length,
    requested_count: rawSymbols.length,
    accepted_count: targetSymbols.length,
    dropped_count: droppedCount,
    fetchedAt: new Date().toISOString(),
  });
}

// ============================================================================
// TIER 2: RAW DATA HANDLERS
// ============================================================================

async function handleGetSupportedCoins(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/supported-coins", {}, CACHE_TTL_LONG);
  const coins = Array.isArray(data) ? data : [];
  return successResult({ coins, count: coins.length, fetchedAt: new Date().toISOString() });
}

async function handleGetSupportedExchanges(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/supported-exchanges", {}, CACHE_TTL_LONG);
  const exchanges = Array.isArray(data) ? data : [];
  return successResult({ exchanges, count: exchanges.length, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangePairs(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = args?.exchange as string | undefined;
  const params: Record<string, string | number> = {};
  if (exchange) params.exchange = exchange;
  const data = await coinglassGet("/api/futures/supported-exchange-pairs", params, CACHE_TTL_LONG);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesCoinsMarkets(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/coins-markets");
  return successResult({ markets: data, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesPairsMarkets(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  const data = await coinglassGet("/api/futures/pairs-markets", { symbol }, CACHE_TTL_SHORT);
  return successResult({ symbol, data, fetchedAt: new Date().toISOString() });
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
  const symbol =
    typeof args?.symbol === "string" && args.symbol.trim().length > 0
      ? args.symbol.trim().toUpperCase()
      : undefined;
  // NOTE: Use v4 kebab-case endpoint path - works on Hobbyist tier
  const data = await coinglassGet("/api/futures/funding-rate/exchange-list", {}, CACHE_TTL_SHORT);
  
  // Filter by symbol if provided
  const allData = Array.isArray(data) ? data : [];
  const filtered = symbol
    ? allData.filter((d: { symbol?: string }) => d.symbol === symbol)
    : allData;
  
  return successResult({ 
    symbol: symbol || "ALL",
    data: filtered.length > 0 ? filtered : allData,
    count: filtered.length > 0 ? filtered.length : allData.length,
    fetchedAt: new Date().toISOString() 
  });
}

async function handleGetFundingRateHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  try {
    const data = await coinglassGet("/api/futures/fundingRate/ohlc-history", { exchange, symbol, interval, limit });
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Funding rate history requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "Use 'get_fear_greed_index' or 'get_bull_market_indicators' for available market timing data",
        symbol,
        exchange,
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function handleGetFundingArbitrageList(): Promise<CallToolResult> {
  try {
    const data = await coinglassGet("/api/futures/fundingRate/arbitrage");
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Funding arbitrage data requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "For market opportunities, use 'get_bull_market_indicators' to see market cycle positioning",
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function handleGetOiByExchange(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  // NOTE: Use v4 kebab-case endpoint path - works on Hobbyist tier
  const data = await coinglassGet("/api/futures/open-interest/exchange-list", { symbol }, CACHE_TTL_SHORT);
  return successResult({ symbol, data, fetchedAt: new Date().toISOString() });
}

async function handleGetWhaleIndexHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 24;
  const data = await coinglassGet("/api/futures/whale-index/history", {
    symbol,
    interval,
    limit,
  });
  return successResult({ symbol, interval, limit, data, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesLiquidationExchanges(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const range = (args?.range as string) || "24h";
  const data = await coinglassGet(
    "/api/futures/liquidation/exchange-list",
    { range },
    CACHE_TTL_MEDIUM
  );
  const rows = Array.isArray(data) ? data : [];
  return successResult({ range, data: rows, count: rows.length, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesLiquidationCoins(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/futures/liquidation/coin-list", {}, CACHE_TTL_MEDIUM);
  const rows = Array.isArray(data) ? data : [];
  return successResult({ data: rows, count: rows.length, fetchedAt: new Date().toISOString() });
}

async function handleGetFuturesLiquidationOrders(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const range = (args?.range as string) || "24h";
  const data = await coinglassGet("/api/futures/liquidation/order", { range });
  const rows = Array.isArray(data) ? data : [];
  return successResult({ range, data: rows, count: rows.length, fetchedAt: new Date().toISOString() });
}

async function handleGetOiHistory(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchange_list = (args?.exchange_list as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  try {
    const data = await coinglassGet("/api/futures/open-interest/aggregated-stablecoin-history", { symbol, exchange_list, interval, limit });
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found") || errMsg.includes("400")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Open Interest history requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "Use 'get_exchange_balance_chart' for historical exchange holdings data",
        symbol,
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
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
  try {
    const data = await coinglassGet("/api/futures/liquidation/history", { exchange, symbol, interval, limit });
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found") || errMsg.includes("500")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Liquidation history requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "Use 'get_fear_greed_index' (fear indicates recent liquidations) or 'get_bull_market_indicators' for market stress signals",
        symbol,
        exchange,
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function handleGetAggregatedLiquidations(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = (args?.symbol as string)?.toUpperCase() || "BTC";
  const exchange_list = (args?.exchange_list as string) || "Binance,OKX,Bybit";
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  try {
    const data = await coinglassGet("/api/futures/liquidation/aggregated-history", { exchange_list, symbol, interval, limit });
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found") || errMsg.includes("500")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Aggregated liquidation data requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "Monitor 'get_fear_greed_index' - Extreme Fear often follows mass liquidation events",
        symbol,
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
}

async function handleGetGlobalLongShortRatio(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const exchange = (args?.exchange as string) || "Binance";
  const symbol = args?.symbol as string;
  const interval = (args?.interval as string) || "1h";
  const limit = (args?.limit as number) || 100;
  if (!symbol) return errorResult("symbol is required");
  try {
    const data = await coinglassGet("/api/futures/globalLongShortAccountRatio/history", { exchange, symbol, interval, limit });
    return successResult({ data, fetchedAt: new Date().toISOString() });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes("404") || errMsg.includes("Not Found")) {
      return successResult({
        error: "PLAN_UPGRADE_REQUIRED",
        message: "Long/Short ratio data requires Coinglass Professional tier or above. Current plan: Hobbyist",
        suggestion: "Use 'get_exchange_balance' to see if institutions are accumulating (outflows) or distributing (inflows)",
        symbol,
        exchange,
        fetchedAt: new Date().toISOString(),
      });
    }
    throw error;
  }
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
  const data = await coinglassGet("/api/futures/indicators/rsi");
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
  const data = await coinglassGet("/api/index/ahr999", {}, CACHE_TTL_MEDIUM);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetRainbowChart(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/bitcoin/rainbow-chart", {}, CACHE_TTL_LONG);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetFearGreedIndex(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/fear-greed-history", {}, CACHE_TTL_MEDIUM);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetStockFlowIndex(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/stock-flow", {}, CACHE_TTL_LONG);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBubbleIndex(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/bitcoin/bubble-index", {}, CACHE_TTL_MEDIUM);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetPuellMultiple(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/index/puell-multiple", {}, CACHE_TTL_MEDIUM);
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
  const data = await coinglassGet("/api/bull-market-peak-indicator", {}, CACHE_TTL_MEDIUM);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBtcEtfNetflow(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const ticker = args?.ticker as string | undefined;
  const params: Record<string, string | number> = {};
  if (ticker) params.ticker = ticker;
  const data = await coinglassGet("/api/etf/bitcoin/net-assets/history", params, CACHE_TTL_MEDIUM);
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetBtcEtfList(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/etf/bitcoin/list", {}, CACHE_TTL_MEDIUM);
  const rows = Array.isArray(data) ? data : [];
  return successResult({ data: rows, count: rows.length, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangeBalance(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  const data = await coinglassGet("/api/exchange/balance/list", { symbol }, CACHE_TTL_SHORT);
  return successResult({ symbol, data, fetchedAt: new Date().toISOString() });
}

async function handleGetExchangeBalanceChart(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const symbol = await resolveDynamicSymbol(args?.symbol);
  const data = await coinglassGet("/api/exchange/balance/chart", { symbol }, CACHE_TTL_MEDIUM);
  return successResult({ symbol, data, fetchedAt: new Date().toISOString() });
}

async function handleGetSpotCoinsMarkets(args: Record<string, unknown> | undefined): Promise<CallToolResult> {
  const page = (args?.page as number) || 1;
  const per_page = (args?.per_page as number) || 50;
  const data = await coinglassGet("/api/spot/coins-markets", { page, per_page });
  return successResult({ data, fetchedAt: new Date().toISOString() });
}

async function handleGetSpotSupportedCoins(): Promise<CallToolResult> {
  const data = await coinglassGet("/api/spot/supported-coins", {}, CACHE_TTL_MEDIUM);
  const rows = Array.isArray(data) ? data : [];
  return successResult({ data: rows, count: rows.length, fetchedAt: new Date().toISOString() });
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
const mcpAuthMiddleware: RequestHandler = CONTEXT_AUTH_ENABLED
  ? verifyContextAuth
  : (_req: Request, _res: Response, next: () => void) => {
      next();
    };

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "coinglass-intelligence",
    version: SERVER_VERSION,
    contextAuthEnabled: CONTEXT_AUTH_ENABLED,
    configuredPlan: COINGLASS_PLAN,
    endpointPolicy: isHobbyConstrainedPlan(COINGLASS_PLAN)
      ? "hobby-allowlist"
      : "professional",
    apiAccessProbe:
      apiAccessProbeCache === null
        ? { status: "unknown" }
        : apiAccessProbeCache.accessible
          ? { status: "ok", checkedAt: new Date(apiAccessProbeCache.checkedAt).toISOString() }
          : {
              status: "blocked",
              endpoint: apiAccessProbeCache.endpoint,
              reason: apiAccessProbeCache.reason,
              checkedAt: new Date(apiAccessProbeCache.checkedAt).toISOString(),
            },
    tier1Tools: TOOLS.filter(t => t.description.startsWith("🧠")).map(t => t.name),
    tier2Tools: TOOLS.filter(t => t.description.startsWith("📊")).map(t => t.name),
    totalTools: TOOLS.length,
  });
});

app.post("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => { transports[id] = transport; console.log(`Session: ${id}`); },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await server.connect(transport);
  } else {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid session" }, id: null });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) await transport.handleRequest(req, res);
  else res.status(400).json({ error: "Invalid session" });
});

app.delete("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) await transport.handleRequest(req, res);
  else res.status(400).json({ error: "Invalid session" });
});

const port = Number(process.env.PORT || 4005);
app.listen(port, () => {
  console.log(`\n🚀 Coinglass Intelligence MCP Server v${SERVER_VERSION}`);
  console.log(`   Crypto derivatives intelligence (${COINGLASS_PLAN} tier)\n`);
  console.log(
    CONTEXT_AUTH_ENABLED
      ? "🔒 Context Protocol Security Enabled"
      : "🧪 Context Protocol Security Disabled (CONTEXT_AUTH_ENABLED=false)"
  );
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  if (isHobbyConstrainedPlan(COINGLASS_PLAN)) {
    console.log(
      `⚠️  API TIER: ${COINGLASS_PLAN} - Hobby allowlist guard is active; higher-tier endpoints are blocked.`
    );
    console.log(`   Upgrade at: https://coinglass.com/pricing\n`);
  } else {
    console.log(`✅ API TIER: ${COINGLASS_PLAN} - hobby endpoint guard disabled\n`);
  }
  console.log(`🧠 TIER 1 - INTELLIGENCE TOOLS (${TOOLS.filter(t => t.description.startsWith("🧠")).length}):`);
  TOOLS.filter(t => t.description.startsWith("🧠")).forEach(t => console.log(`   • ${t.name}`));
  console.log(`\n📊 TIER 2 - RAW DATA TOOLS (${TOOLS.filter(t => t.description.startsWith("📊")).length}):`);
  TOOLS.filter(t => t.description.startsWith("📊")).forEach(t => console.log(`   • ${t.name}`));
  console.log("");
});

