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

type UpstreamKey = "gamma" | "clob" | "data";

type UpstreamRatePlan = {
  maxRequestsPerMinute: number;
  cooldownMs: number;
};

type ToolRateLimitMetadata = {
  maxRequestsPerMinute: number;
  maxConcurrency: number;
  cooldownMs: number;
  supportsBulk: boolean;
  recommendedBatchTools: string[];
  notes: string;
};

type ToolSurface = "answer" | "execute" | "both";
type ToolLatencyClass = "instant" | "fast" | "slow" | "streaming";

function getConfiguredInteger(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;

  return Math.min(max, Math.max(min, parsed));
}

const POLYMARKET_RETRY_ATTEMPTS = getConfiguredInteger(
  "POLYMARKET_RETRY_ATTEMPTS",
  3,
  1,
  5
);
const POLYMARKET_RETRY_BASE_BACKOFF_MS = getConfiguredInteger(
  "POLYMARKET_RETRY_BASE_BACKOFF_MS",
  450,
  100,
  5_000
);
const POLYMARKET_DEFAULT_EXECUTE_USD =
  process.env.POLYMARKET_DEFAULT_EXECUTE_USD?.trim() || "0.001";

const UPSTREAM_RATE_PLANS: Record<UpstreamKey, UpstreamRatePlan> = {
  gamma: {
    maxRequestsPerMinute: getConfiguredInteger(
      "POLYMARKET_GAMMA_RATE_LIMIT",
      180,
      1,
      2_000
    ),
    cooldownMs: 0,
  },
  clob: {
    maxRequestsPerMinute: getConfiguredInteger(
      "POLYMARKET_CLOB_RATE_LIMIT",
      240,
      1,
      2_000
    ),
    cooldownMs: 0,
  },
  data: {
    maxRequestsPerMinute: getConfiguredInteger(
      "POLYMARKET_DATA_RATE_LIMIT",
      120,
      1,
      2_000
    ),
    cooldownMs: 0,
  },
};

for (const plan of Object.values(UPSTREAM_RATE_PLANS)) {
  plan.cooldownMs = Math.ceil(60_000 / plan.maxRequestsPerMinute);
}

const nextAllowedRequestByUpstream = new Map<UpstreamKey, number>();
const rateLockByUpstream = new Map<UpstreamKey, Promise<void>>();

const HEAVY_ANALYSIS_TOOLS = new Set([
  "analyze_top_holders",
  "analyze_event_whale_breakdown",
  "find_trading_opportunities",
  "find_arbitrage_opportunities",
  "get_top_holders",
]);

const UPSTREAM_TIMEOUT_MS = {
  default: 15_000,
  heavy: 45_000,
} as const;

type UpstreamTimeoutProfile = keyof typeof UPSTREAM_TIMEOUT_MS;

const BULK_FIRST_TOOLS = new Set([
  "find_moderate_probability_bets",
  "get_bets_by_probability",
  "discover_trending_markets",
  "get_top_markets",
  "search_markets",
  "get_event_outcomes",
  "get_batch_orderbooks",
]);

const TOOL_BATCH_HINTS: Record<string, string[]> = {
  analyze_top_holders: ["search_markets", "discover_trending_markets"],
  analyze_event_whale_breakdown: ["discover_trending_markets"],
  get_top_holders: ["search_markets", "discover_trending_markets"],
  find_trading_opportunities: ["find_moderate_probability_bets", "get_bets_by_probability"],
  get_event_outcomes: ["get_batch_orderbooks"],
  get_event_by_slug: ["get_batch_orderbooks"],
};

function buildToolRateLimitMetadata(toolName: string): ToolRateLimitMetadata {
  const heavy = HEAVY_ANALYSIS_TOOLS.has(toolName);
  return {
    maxRequestsPerMinute: heavy ? 60 : 120,
    maxConcurrency: 1,
    cooldownMs: heavy ? 1_500 : 500,
    supportsBulk: BULK_FIRST_TOOLS.has(toolName),
    recommendedBatchTools: TOOL_BATCH_HINTS[toolName] ?? [],
    notes: heavy
      ? "Heavy Polymarket workflow. Call this tool alone and prefer narrower scopes first."
      : "Prefer batch/snapshot tools before fan-out loops when possible.",
  };
}

function resolveExecutePricingMeta(
  existingMeta: Record<string, unknown>
): Record<string, unknown> {
  const existingPricing =
    "pricing" in existingMeta &&
    typeof existingMeta.pricing === "object" &&
    existingMeta.pricing !== null
      ? ({ ...(existingMeta.pricing as Record<string, unknown>) } as Record<
          string,
          unknown
        >)
      : {};

  const currentExecuteUsd =
    typeof existingPricing.executeUsd === "string"
      ? existingPricing.executeUsd.trim()
      : undefined;

  if (currentExecuteUsd) {
    existingPricing.executeUsd = currentExecuteUsd;
    return existingPricing;
  }

  existingPricing.executeUsd = POLYMARKET_DEFAULT_EXECUTE_USD;
  return existingPricing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveUpstreamTimeoutMs(
  timeoutMsOrProfile?: number | UpstreamTimeoutProfile
): number {
  if (typeof timeoutMsOrProfile === "number") {
    return timeoutMsOrProfile;
  }

  return UPSTREAM_TIMEOUT_MS[timeoutMsOrProfile ?? "default"];
}

async function withUpstreamRateLock<T>(
  upstream: UpstreamKey,
  work: () => Promise<T>
): Promise<T> {
  const previous = rateLockByUpstream.get(upstream) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  rateLockByUpstream.set(upstream, previous.then(() => current));
  await previous;

  try {
    return await work();
  } finally {
    release();
    if (rateLockByUpstream.get(upstream) === current) {
      rateLockByUpstream.delete(upstream);
    }
  }
}

async function reserveRateSlot(upstream: UpstreamKey, endpoint: string): Promise<void> {
  await withUpstreamRateLock(upstream, async () => {
    const plan = UPSTREAM_RATE_PLANS[upstream];
    const now = Date.now();
    const nextAllowedAt = nextAllowedRequestByUpstream.get(upstream) ?? 0;
    const waitMs = Math.max(0, nextAllowedAt - now);

    if (waitMs > 0) {
      console.log("[polymarket-rate] wait", {
        upstream,
        endpoint: endpoint.slice(0, 120),
        waitMs,
        cooldownMs: plan.cooldownMs,
        maxRequestsPerMinute: plan.maxRequestsPerMinute,
      });
      await sleep(waitMs);
    }

    nextAllowedRequestByUpstream.set(upstream, Date.now() + plan.cooldownMs);
  });
}

function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const dateMs = Date.parse(retryAfter);
  if (Number.isNaN(dateMs)) {
    return null;
  }

  return Math.max(0, dateMs - Date.now());
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

class UpstreamHttpError extends Error {
  status: number;
  retryable: boolean;

  constructor(params: {
    upstream: UpstreamKey;
    status: number;
    bodySnippet: string;
    retryable: boolean;
  }) {
    const { upstream, status, bodySnippet, retryable } = params;
    super(`${upstream.toUpperCase()} API error (${status}): ${bodySnippet}`);
    this.name = "UpstreamHttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

function computeBackoffMs(attempt: number): number {
  const exponential = POLYMARKET_RETRY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * 200);
  return exponential + jitter;
}

async function fetchJsonWithPolicy(options: {
  upstream: UpstreamKey;
  endpoint: string;
  init?: RequestInit;
  timeoutMs?: number | UpstreamTimeoutProfile;
}): Promise<unknown> {
  const { upstream, endpoint, init } = options;
  const timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs);
  const baseUrl =
    upstream === "gamma"
      ? GAMMA_API_URL
      : upstream === "clob"
        ? CLOB_API_URL
        : DATA_API_URL;
  const url = `${baseUrl}${endpoint}`;

  for (let attempt = 1; attempt <= POLYMARKET_RETRY_ATTEMPTS; attempt++) {
    await reserveRateSlot(upstream, endpoint);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.ok) {
        return response.json();
      }

      const responseText = await response.text();
      const retryAfterMs = parseRetryAfterMs(response.headers);
      const retryable = isRetryableStatus(response.status);

      if (retryable && attempt < POLYMARKET_RETRY_ATTEMPTS) {
        const waitMs = retryAfterMs ?? computeBackoffMs(attempt);
        console.warn("[polymarket-api] retry", {
          upstream,
          endpoint: endpoint.slice(0, 120),
          attempt,
          status: response.status,
          waitMs,
          retryAfterMs,
        });
        await sleep(waitMs);
        continue;
      }

      throw new UpstreamHttpError({
        upstream,
        status: response.status,
        bodySnippet: responseText.slice(0, 200),
        retryable,
      });
    } catch (error) {
      const isAbortError = error instanceof Error && error.name === "AbortError";
      const isHttpError = error instanceof UpstreamHttpError;
      if (isHttpError && !error.retryable) {
        throw error;
      }
      const canRetry = attempt < POLYMARKET_RETRY_ATTEMPTS;

      if (canRetry) {
        const waitMs = computeBackoffMs(attempt);
        console.warn("[polymarket-api] transport_retry", {
          upstream,
          endpoint: endpoint.slice(0, 120),
          attempt,
          waitMs,
          reason: isAbortError
            ? `timeout (${timeoutMs}ms)`
            : error instanceof Error
              ? error.message
              : String(error),
        });
        await sleep(waitMs);
        continue;
      }

      if (isAbortError) {
        throw new Error(
          `${upstream.toUpperCase()} API timeout after ${timeoutMs}ms for ${endpoint}`
        );
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw new Error(
    `${upstream.toUpperCase()} API failed after ${POLYMARKET_RETRY_ATTEMPTS} attempts`
  );
}

function normalizeHeaders(headersInit: HeadersInit | undefined): Record<string, string> {
  if (!headersInit) {
    return {};
  }

  if (headersInit instanceof Headers) {
    const normalized: Record<string, string> = {};
    headersInit.forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }

  if (Array.isArray(headersInit)) {
    const normalized: Record<string, string> = {};
    for (const [key, value] of headersInit) {
      normalized[key] = value;
    }
    return normalized;
  }

  return { ...headersInit };
}

// ============================================================================
// POLYMARKET EIP-712 CONSTANTS FOR ORDER SIGNING
// Based on @polymarket/order-utils (clob-order-utils)
// ============================================================================

// Polymarket CTF Exchange contracts on Polygon (chain ID 137)
const POLYMARKET_CONTRACTS = {
  CTF_EXCHANGE: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", // Regular exchange
  NEG_RISK_EXCHANGE: "0xC5d563A36AE78145C45a50134d48A1215220f80a", // Negative risk exchange
  COLLATERAL: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e
  CONDITIONAL_TOKENS: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", // CTF
};

// EIP-712 Domain for Polymarket CTF Exchange
const POLYMARKET_ORDER_DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "1",
  chainId: 137, // Polygon Mainnet
  verifyingContract: POLYMARKET_CONTRACTS.CTF_EXCHANGE,
};

// EIP-712 Domain for Polymarket Negative Risk Exchange
const POLYMARKET_NEG_RISK_ORDER_DOMAIN = {
  name: "Polymarket CTF Exchange",
  version: "1",
  chainId: 137, // Polygon Mainnet
  verifyingContract: POLYMARKET_CONTRACTS.NEG_RISK_EXCHANGE,
};

// EIP-712 Types for Polymarket Orders
// From @polymarket/order-utils ORDER_STRUCTURE
const POLYMARKET_ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};

// Polymarket Signature Types
const enum PolymarketSignatureType {
  EOA = 0, // Direct EOA signing
  POLY_PROXY = 1, // Magic.link email proxy
  POLY_GNOSIS_SAFE = 2, // Browser wallet (MetaMask, Phantom) with proxy
}

// Polymarket Order Sides
const enum PolymarketSide {
  BUY = 0,
  SELL = 1,
}

// Collateral token decimals (USDC.e has 6 decimals)
const COLLATERAL_DECIMALS = 6;

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (required by Context)
// - _meta.contextRequirements: Context types needed for portfolio tools (MCP spec)
// - _meta.rateLimit: Planner/runtime pacing hints for agentic loops
//
// NOTE: _meta is part of the MCP spec for arbitrary tool metadata.
// The Context platform reads _meta.contextRequirements for context injection
// and _meta.rateLimit hints for pacing behavior.
// ============================================================================

const TOOLS = [
  // ==================== TIER 1: INTELLIGENCE TOOLS ====================

  {
    name: "analyze_market_liquidity",
    description:
      'Analyze market liquidity and calculate "Whale Cost" - simulates the slippage for selling $1k, $5k, and $10k positions. Answers: "Can I exit this position if I put $X in?" Merges direct + synthetic liquidity from both YES and NO orderbooks for accurate depth.\n\n⏱️ PERFORMANCE: Makes 3 CLOB API calls (~3-5s). Safe to call in parallel with 1-2 other lightweight tools, but avoid calling alongside find_trading_opportunities or analyze_top_holders.',
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
            bestBid: { type: "number" },
            bestAsk: { type: "number" },
            spreadCents: { type: "number" },
            spreadBps: { type: "number" },
            // Backward-compat aliases
            absolute: { type: "number" },
            percentage: { type: "number" },
            bps: { type: "number" },
          },
        },
        depth: {
          type: "object",
          properties: {
            bidDepthUsd: { type: "number" },
            askDepthUsd: { type: "number" },
            totalDepthUsd: { type: "number" },
            note: { type: "string" },
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
      required: [
        "market",
        "tokenId",
        "currentPrice",
        "spread",
        "whaleCost",
        "liquidityScore",
      ],
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
              impliedProbability: {
                type: "number",
                description: "Implied probability in decimal form (0.0-1.0)",
              },
              impliedProbabilityPercent: {
                type: "number",
                description: "Implied probability in percent form (0-100)",
              },
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
          description: "Vig-adjusted true probabilities in decimal form (0.0-1.0)",
        },
        trueProbabilitiesPercent: {
          type: "object",
          description: "Vig-adjusted true probabilities in percent form (0-100)",
        },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["conditionId", "outcomes", "marketEfficiency"],
    },
  },

  {
    name: "analyze_whale_flow",
    description: `Track recent trading activity by analyzing trade sizes. Buckets trades into Small (<$50), Medium ($50-$500), and Whale (>$1000), then calculates net directional flow.

⚠️ IMPORTANT: This analyzes RECENT TRADES (last N hours). May return zero data if no trades occurred in the time window.

USE THIS FOR: "What's happening RIGHT NOW?", "Recent whale trades?", "Trading activity in the last 24h?"

USE analyze_top_holders INSTEAD FOR: "Who are the biggest holders?", "What are whales betting on?", "Which side do smart money players favor?"`,
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "The market condition ID",
        },
        slug: {
          type: "string",
          description: "Event or market slug (alternative to conditionId)",
        },
        marketQuery: {
          type: "string",
          description:
            "Natural-language market reference (e.g., 'Fed rate decision'). Use when conditionId/slug is unknown.",
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
    description: `🐋 WHALE POSITIONS: Find who holds the largest positions and WHAT SIDE (YES/NO) they're betting on.

⚠️ IMPORTANT: For MULTI-OUTCOME events (tournaments, elections with multiple candidates), use analyze_event_whale_breakdown instead! This tool only shows YES/NO for ONE market, not which specific outcome (player/candidate) whales favor.

Returns:
- yesWhales[]: Top holders betting YES (with shares, positionValue, convictionScore, name if public)
- noWhales[]: Top holders betting NO (with shares, positionValue, convictionScore, name if public)
- smartMoneySignal: Which side whales favor (YES/NO/NEUTRAL)
- totalUniqueHolders: Total holders found via deep fetching

🔥 DEEP FETCHING: We work around Polymarket's 20-holder API limit by querying holder tiers from $1M (ultra-whales) down to $1, then deduplicating addresses. This captures the full spectrum and typically returns 50-100+ unique holders.

CONVICTIONSCORES: "extreme" (>$10k), "high" ($5k-$10k), "moderate" ($1k-$5k), "low" (<$1k)

USE THIS FOR: Single-outcome markets like "Will Bitcoin hit $100k?" or "Will Trump win?"
USE analyze_event_whale_breakdown FOR: "Which player are whales betting on in Australian Open?"
USE analyze_whale_flow FOR: "Recent trades?", "Trading activity in last 24h?"

⏱️ PERFORMANCE: This tool performs deep fetching in paced batches. It typically takes ~8-15s.
⚠️ Call this tool ALONE (not in parallel with other heavy tools like find_trading_opportunities or analyze_market_liquidity) to avoid timeouts.
If you need multiple analyses, call them SEQUENTIALLY, not with Promise.all().`,
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
        marketQuery: {
          type: "string",
          description:
            "Natural-language market title/query (e.g., 'Bitcoin above $100k'). The server resolves this to the best matching market across ACTIVE and RESOLVED markets when conditionId/slug are not provided.",
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
    name: "analyze_event_whale_breakdown",
    description: `🐋 MULTI-OUTCOME WHALE ANALYSIS: For events with multiple outcomes (like "Australian Open Winner"), shows WHICH SPECIFIC OUTCOME whales are betting on.

⚠️ USE THIS for multi-outcome events like sports tournaments, elections with multiple candidates, etc.
⚠️ analyze_top_holders only shows YES/NO for ONE market. This tool shows whale positions ACROSS ALL outcomes in an event.

Example: For "Australian Open Winner" event with 20+ player markets:
- Returns: "Whales have $100k on Sinner, $50k on Djokovic, $30k on Alcaraz..."
- NOT just: "Whales have $X on YES, $Y on NO" (which is meaningless without knowing WHICH player)

DATA FLOW: discover_trending_markets → slug → analyze_event_whale_breakdown

Returns:
- eventTitle: The event name
- totalMarketsAnalyzed: How many outcome markets were checked
- whalesByOutcome[]: Sorted by total whale value, showing which outcomes have biggest whale positions
- topWhaleOutcome: The outcome with most whale money`,
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The EVENT slug (e.g., '2026-mens-australian-open-winner'). Required.",
        },
        maxOutcomes: {
          type: "number",
          description: "Maximum number of outcomes/markets to analyze (default: 10, max: 20). Higher = slower but more thorough.",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        eventTitle: { type: "string" },
        eventSlug: { type: "string" },
        totalMarketsInEvent: { type: "number" },
        totalMarketsAnalyzed: { type: "number" },
        whalesByOutcome: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              outcome: { type: "string", description: "The specific outcome (e.g., 'Sinner', 'Djokovic')" },
              conditionId: { type: "string" },
              currentPrice: { type: "number", description: "Current YES price (implied probability)" },
              totalWhaleValue: { type: "number", description: "Total $ value of whale positions on this outcome" },
              topWhalePosition: { type: "number", description: "Largest single whale position" },
              whaleCount: { type: "number", description: "Number of whale-sized positions" },
              convictionLevel: { type: "string", enum: ["extreme", "high", "moderate", "low"] },
            },
          },
        },
        topWhaleOutcome: {
          type: "object",
          properties: {
            outcome: { type: "string" },
            totalValue: { type: "number" },
            confidence: { type: "string" },
          },
        },
        smartMoneyConsensus: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["eventTitle", "whalesByOutcome", "topWhaleOutcome"],
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

⚠️ FOR SIMPLER QUERIES: If user wants 'likely bets', 'safer bets', or 'bets that will probably win' → use find_moderate_probability_bets instead. For filtering by probability like 'coinflip bets' or 'unlikely bets' → use get_bets_by_probability instead.

⏱️ PERFORMANCE: This tool scans many markets. Use the 'depth' parameter to control how many markets are scanned:
- "shallow" (~500 markets, ~5s) - Quick scan for fast answers or when called alongside other tools
- "medium" (~1000 markets, ~10s) - Good balance, DEFAULT for most queries
- "deep" (~2000+ markets, ~20s) - Maximum coverage. Use when user specifically asks for thorough/comprehensive analysis, or when initial results are insufficient
⚠️ Call this tool ALONE (not in parallel with other heavy tools) when using "deep" depth to avoid timeouts.`,
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
        depth: {
          type: "string",
          enum: ["shallow", "medium", "deep"],
          description: "How many markets to scan. 'shallow' (~500, fast), 'medium' (~1000, default), 'deep' (~2000+, thorough). Use 'deep' for comprehensive analysis but call this tool ALONE to avoid timeouts.",
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
    name: "build_high_conviction_workflow",
    description:
      `Run an end-to-end high-conviction workflow in ONE call: discover trending markets, validate rules, check efficiency, analyze liquidity, and return top tradable setups with explicit risks.

This is the recommended tool when users ask for a multi-step workflow like:
"discover trending markets → validate rules → check efficiency → top setups with risks."

Why use this:
- Avoids brittle multi-call orchestration in client-generated code
- Executes analysis sequentially and safely on the server
- Returns normalized setup cards with entry guidance and risk factors

⏱️ PERFORMANCE: Runs several analyses sequentially (~10-25s depending on candidateCount and whale options).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        category: {
          type: "string",
          description: "Optional category filter (politics, crypto, sports, etc.)",
        },
        candidateCount: {
          type: "number",
          description: "How many trending markets to analyze before ranking (default: 6, max: 10)",
        },
        topSetups: {
          type: "number",
          description: "How many final setups to return (default: 3, max: 5)",
        },
        includeWhaleFlow: {
          type: "boolean",
          description: "Include recent trade-flow sentiment checks for shortlisted setups (default: false)",
        },
        hoursBack: {
          type: "number",
          description: "Trade-flow lookback window in hours when includeWhaleFlow=true (default: 24)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        workflowSummary: {
          type: "object",
          properties: {
            strategy: { type: "string" },
            category: { type: "string" },
            discoveredMarkets: { type: "number" },
            analyzedMarkets: { type: "number" },
            topSetupsReturned: { type: "number" },
          },
        },
        topSetups: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              market: { type: "string" },
              url: { type: "string", format: "uri" },
              conditionId: { type: "string" },
              slug: { type: "string" },
              score: { type: "number" },
              signal: { type: "string" },
              currentPrice: { type: "number" },
              entryPlan: { type: "object" },
              checks: { type: "object" },
              whaleInsights: { type: "object" },
              risks: { type: "array", items: { type: "string" } },
            },
          },
        },
        analysisNotes: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["workflowSummary", "topSetups"],
    },
  },

  {
    name: "find_moderate_probability_bets",
    description:
      `🎯 BEST TOOL for 'likely bets', 'safer bets', or 'bets that will probably win'. Finds prediction market bets priced 40-75¢ (40-75% implied probability) with good liquidity. Returns 1.3-2.5x if correct. USE THIS instead of find_trading_opportunities when user wants higher probability outcomes.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent additional markets or URLs. Each result includes a real 'url' field - use ONLY those URLs.

⏱️ PERFORMANCE: Scans ~50 events (~5-8s). Safe to call alone or alongside lightweight tools like check_market_efficiency.`,
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
    description: `Find the hottest markets on Polymarket right now. Shows volume spikes, unusual activity, and which markets are seeing the most action.

CATEGORY FILTER: Use category="sports" for ONLY sports markets, "crypto" for crypto, "politics" for political markets, etc.
Supported aliases: sports (includes nfl, nba, mlb, tennis, mma, golf, hockey), crypto (bitcoin, ethereum, defi), politics (elections), pop-culture (movies, entertainment), science (tech, ai, space), business (economics, finance).

💡 TIP: For exact categories, call get_all_tags first to see available Polymarket tags, then use browse_by_tag for precise filtering.

🐋 WHALE ANALYSIS - CHOOSE THE RIGHT TOOL:
- For MULTI-OUTCOME events (tournaments, elections): Use slug → analyze_event_whale_breakdown
  Shows: "Whales have $100k on Sinner, $50k on Djokovic..."
- For SINGLE-OUTCOME markets (yes/no questions): Use conditionId → analyze_top_holders
  Shows: "Whales have $X on YES, $Y on NO"

DATA FLOWS:
- Multi-outcome: discover_trending_markets → slug → analyze_event_whale_breakdown
- Single-outcome: discover_trending_markets → conditionId → analyze_top_holders`,
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
    name: "get_top_markets",
    description:
      `📊 Get the highest volume/liquidity markets on Polymarket.

Default behavior is LIVE/NOW: only active, tradeable markets are returned (excludes ended and near-resolved markets unless explicitly included).
      
Sorting options (mirrors Polymarket UI):
- total_volume: ALL-TIME volume (e.g., $507M) - USE THIS for "biggest markets" questions
- volume: 24-hour trading volume (e.g., $9M) - USE THIS for "most active today" questions  
- recent_activity: alias of volume (best match for "recent activity" wording)
- liquidity: Deepest orderbooks
- trending: Most popular (default)
- newest: Recently created markets  
- ending_soon: Markets closing soon
- competitive: 50/50 contested markets
- includeNearResolved: Include very high/low probability markets (>95% YES or <5% YES). Default false.
- includeEnded: Include markets whose endDate has already passed. Default false.

USE THIS for questions like:
- "What are the highest volume markets?" → sortBy: "total_volume"
- "What's most active right now?" → sortBy: "volume"
- "Show me the most liquid markets" → sortBy: "liquidity"

Returns BOTH total volume AND 24h volume for each market, plus direct Polymarket URLs.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sortBy: {
          type: "string",
          enum: ["total_volume", "volume", "recent_activity", "liquidity", "trending", "newest", "ending_soon", "competitive"],
          description: "How to sort: 'total_volume' for all-time biggest markets, 'volume'/'recent_activity' for 24h active markets (default: total_volume)",
        },
        category: {
          type: "string",
          description: "Filter by category (politics, crypto, sports, etc.). Uses tag-aware client-side matching for reliable results.",
        },
        minTotalVolume: {
          type: "number",
          description: "Minimum ALL-TIME volume in USD (e.g., 10000000 for $10M+). Use this to find only major markets.",
        },
        maxTotalVolume: {
          type: "number",
          description: "Maximum ALL-TIME volume in USD. Use with minTotalVolume to find mid-tier markets.",
        },
        minLiquidity: {
          type: "number",
          description: "Minimum liquidity in USD. Higher = better exit options.",
        },
        endDateBefore: {
          type: "string",
          description: "Only markets ending before this date (ISO format: 2026-02-01). Great for 'ending this week/month'.",
        },
        endDateAfter: {
          type: "string",
          description: "Only markets ending after this date (ISO format). Excludes markets ending too soon.",
        },
        includeNearResolved: {
          type: "boolean",
          description:
            "Include near-resolved markets (>95% YES or <5% YES). Default false; set true to include one-sided markets.",
        },
        includeEnded: {
          type: "boolean",
          description:
            "Include markets whose endDate is in the past. Default false to keep results focused on currently live opportunities.",
        },
        offset: {
          type: "number",
          description: "Skip first N results for pagination. Use to go DEEPER (e.g., offset=50 for results 51-100).",
        },
        limit: {
          type: "number",
          description: "Number of markets to return (default: 15, max: 100)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        sortedBy: { type: "string" },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              title: { type: "string" },
              url: { type: "string", format: "uri", description: "Direct Polymarket URL - ALWAYS provided" },
              slug: { type: "string" },
              conditionId: { type: "string" },
              currentPrice: { type: "number", description: "YES price (0-1)" },
              volume24h: { type: "number", description: "24h trading volume in USD" },
              totalVolume: { type: "number", description: "All-time volume" },
              liquidity: { type: "number", description: "Current liquidity in USD" },
              endDate: { type: "string" },
              category: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
        pagination: {
          type: "object",
          properties: {
            offset: { type: "number" },
            returned: { type: "number" },
            hasMore: { type: "boolean" },
            nextOffset: { type: "number" },
            scannedToOffset: { type: "number" },
            pagesScanned: { type: "number" },
          },
        },
        searchExhausted: {
          type: "boolean",
          description:
            "True when the API has no further rows to scan and fewer than requested results were returned.",
        },
        filtersApplied: { type: "object" },
        fetchedAt: { type: "string" },
      },
      required: ["sortedBy", "markets"],
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
        noResultsReason: {
          type: "string",
          description:
            "Present when there are no analyzable positions (e.g., no_active_positions).",
        },
        searchExhausted: {
          type: "boolean",
          description:
            "True when there are no additional positions to analyze for this wallet context.",
        },
        fetchedAt: { type: "string" },
      },
      required: ["walletAddress", "totalPositions", "portfolioSummary", "positionAnalyses"],
    },
  },

  // ==================== TRADING TOOLS (REDIRECT) ====================
  // NOTE: Direct trading via Context is not supported for Polymarket due to their 
  // centralized orderbook requiring API key authentication. Users are redirected
  // to the Polymarket UI to complete trades.

  {
    name: "place_polymarket_order",
    description: `Prepare an order for Polymarket prediction markets and provide a direct link to execute.

Due to Polymarket's centralized orderbook (CLOB) requiring API key authentication that cannot be delegated,
trading must be completed on polymarket.com. This tool will:
1. Analyze current market prices
2. Calculate optimal order parameters  
3. Provide a direct link to the market where you can place the order

Use cases:
- "Buy $10 of YES on Trump winning" → Provides link and suggested order
- "Sell my NO position" → Calculates position value and links to market`,
    
    // Requires Polymarket portfolio context to get market details
    _meta: {
      contextRequirements: ["polymarket"],
    },

    inputSchema: {
      type: "object" as const,
      properties: {
        portfolio: {
          type: "object",
          description: "Your Polymarket portfolio context (injected by the Context app)",
        },
        conditionId: {
          type: "string",
          description: "The market condition ID (hex string). Can be obtained from search_markets or other market tools.",
        },
        slug: {
          type: "string",
          description: "The market slug (e.g., 'will-trump-win-2024'). Alternative to conditionId.",
        },
        outcome: {
          type: "string",
          enum: ["YES", "NO"],
          description: "Which outcome to trade (YES or NO token)",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "BUY to purchase shares, SELL to sell shares you own",
        },
        amount: {
          type: "number",
          description: "For BUY: dollar amount to spend. For SELL: number of shares to sell.",
        },
        price: {
          type: "number",
          description: "Suggested limit price (0.01-0.99). Optional - will calculate market price if not provided.",
        },
      },
      required: ["outcome", "side", "amount"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        status: { type: "string", enum: ["external_action_required"] },
        message: { type: "string" },
        tradingLink: { type: "string" },
        suggestedOrder: {
          type: "object",
          properties: {
            market: { type: "string" },
            outcome: { type: "string" },
            side: { type: "string" },
            amount: { type: "number" },
            suggestedPrice: { type: "number" },
            estimatedShares: { type: "number" },
            currentBestBid: { type: "number" },
            currentBestAsk: { type: "number" },
          },
        },
        reason: { type: "string" },
      },
    },
  },

  // ==================== CROSS-PLATFORM INTEROPERABILITY ====================

  {
    name: "polymarket_crossref_kalshi",
    description: `[POLYMARKET SERVER] Search Kalshi for markets equivalent to a Polymarket market.

This tool belongs to the POLYMARKET MCP server. Use it when you have a Polymarket market 
and want to find the corresponding market on Kalshi for comparison.

⚠️ Call this tool with POLYMARKET's toolId, not Kalshi's.

USE THIS when you have a Polymarket market and want to find the same on Kalshi for:
  - Price comparison / arbitrage detection
  - Cross-platform probability analysis
  - Finding additional liquidity

WORKFLOW:
  1. You have a Polymarket market (from get_event_by_slug or search_markets)
  2. Call: polymarket_crossref_kalshi({ keywords: "tariffs revenue 2025" })
  3. Returns matching Kalshi markets with prices

EXAMPLE INPUT:
  { "keywords": "tariffs revenue 2025" }

EXAMPLE OUTPUT:
  {
    "searchedFor": { "keywords": "tariffs revenue 2025", "polymarketSlug": null },
    "kalshiResults": [
      { 
        "title": "Will tariffs generate...", 
        "ticker": "KXTARIFFS", 
        "yesPrice": 31, 
        "matchScore": 0.67,
        "rules": "If tariffs generate more than X by Y, then..."
      }
    ],
    "hint": "Found 1 potential matches on Kalshi...",
    "fetchedAt": "2025-01-10T..."
  }

NEXT STEPS after finding match:
  - ⚠️ CRITICAL: Compare the 'rules' field with Polymarket rules to ensure YES/NO mean the same thing!
  - Use Kalshi MCP tools (get_event, get_market) with the 'ticker' for deeper analysis
  - Compare yesPrice: Kalshi uses cents (31 = 31%), Polymarket uses decimals (0.31 = 31%)

⚠️ IMPORTANT: Always compare resolution rules before calculating arbitrage! Markets may define YES/NO differently.

⚠️ API LIMITATION: Kalshi's API does NOT support server-side text search. This tool fetches recent markets and filters client-side. For best results:
  - Use specific keywords from the market title
  - Works best for popular/high-volume markets
  - May miss less popular markets not in the first batch

⚠️ Kalshi has NO sports markets. For sports, use Odds API instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "The Polymarket market title to search for on Kalshi",
        },
        keywords: {
          type: "string",
          description: "Keywords to search (e.g., 'supreme court tariffs trump'). More specific = better results.",
        },
        polymarketSlug: {
          type: "string",
          description: "Optional: The Polymarket slug (for reference in results)",
        },
        limit: {
          type: "number",
          description: "Max results (default: 10)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        searchedFor: {
          type: "object",
          properties: {
            keywords: { type: "string" },
            polymarketSlug: { type: "string" },
          },
        },
        kalshiResults: {
          type: "array",
          description: "Matching Kalshi markets. Use 'ticker' with Kalshi's get_market tool for details.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Kalshi market title" },
              ticker: { type: "string", description: "Use this with Kalshi's get_market or get_event tools" },
              eventTicker: { type: "string" },
              yesPrice: { type: "number", description: "Current YES price in cents (29 = 29%)" },
              volume24h: { type: "number" },
              url: { type: "string", description: "Direct Kalshi URL" },
              matchScore: { type: "number", description: "Keyword match score (higher = better match)" },
              rules: { type: "string", description: "Full resolution rules text" },
              yesOutcomeMeans: { type: "string", description: "⚠️ CRITICAL: What does buying YES mean? Compare with Polymarket!" },
              noOutcomeMeans: { type: "string", description: "⚠️ CRITICAL: What does buying NO mean? Compare with Polymarket!" },
            },
          },
        },
        hint: { type: "string" },
        comparisonNote: { type: "string", description: "⚠️ MUST READ: Step-by-step guide for comparing outcomes across platforms" },
        searchExhausted: {
          type: "boolean",
          description:
            "True when no sufficiently matching Kalshi markets were found in the scanned window.",
        },
        noResultsReason: {
          type: "string",
          description:
            "Machine-readable reason when kalshiResults is empty (e.g., no_kalshi_match_found, kalshi_unavailable).",
        },
        sourcesTried: {
          type: "array",
          description: "Kalshi API hosts tried during lookup.",
          items: { type: "string" },
        },
        fetchedAt: { type: "string" },
      },
      required: ["kalshiResults"],
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
    name: "search_and_get_outcomes",
    description: `🔍 SEARCH + GET OUTCOMES in ONE CALL. Finds a market and returns all its outcomes immediately.

✅ Uses Polymarket's official /public-search API for reliable server-side text search.

⚠️ USE THIS INSTEAD OF: search_markets → get_event_outcomes (which requires chaining calls)

This tool:
1. Searches for the most relevant market matching your query (using /public-search API)
2. Automatically fetches all outcomes for that market
3. Returns everything in one response

⚠️ VERIFY THE RETURNED MARKET: Always check that eventTitle matches your intent!
If the returned market doesn't match (e.g., got a division market instead of championship),
try a different query with the correct terminology.

PERFECT FOR CROSS-PLATFORM COMPARISON:
  - Sports championships → Returns all teams with their Polymarket prices
  - Political elections → Returns all candidates with prices
  - Any multi-outcome event → Returns all possibilities

INPUT: Natural language query describing the market you want
OUTPUT: All outcomes with prices, ready for comparison`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Natural language search query (e.g., 'NBA Champion', 'Super Bowl Winner', 'Presidential Election')",
        },
        category: {
          type: "string",
          enum: ["sports", "politics", "crypto", "pop-culture", "science", "business"],
          description: "Optional category to narrow search",
        },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        eventTitle: { type: "string" },
        eventSlug: { type: "string" },
        eventUrl: { type: "string" },
        totalVolume: { type: "number" },
        totalOutcomes: { type: "number" },
        outcomes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Team/candidate/outcome name" },
              price: { type: "number", description: "Current YES price (0-1, treat as probability)" },
              pricePercent: { type: "string" },
              volume: { type: "number" },
              conditionId: { type: "string" },
              tokenId: {
                type: "string",
                description:
                  "Primary YES token ID for this outcome. Use directly with get_batch_orderbooks/get_orderbook/get_prices.",
              },
            },
          },
        },
        searchQuery: { type: "string" },
        searchMethod: { type: "string", enum: ["public-search", "events-fallback"], description: "Which search method was used" },
        matchConfidence: { type: "string", enum: ["exact", "high", "medium", "low"] },
        fetchedAt: { type: "string" },
      },
      required: ["eventTitle", "outcomes"],
    },
  },

  {
    name: "get_event_outcomes",
    description: `📊 Get ALL outcomes in a multi-outcome event with their individual volumes.

⚠️ PREFER search_and_get_outcomes if you don't have a slug! That tool searches AND returns outcomes in one call.

Works for ANY multi-outcome market:
- Political: "Which candidate has the highest volume?" (returns all real candidates)
- Sports: "Show all teams and their betting volumes" (returns all teams)
- Awards: "NBA MVP", "NFL MVP" (returns all PLAYERS)
- Crypto: "What Bitcoin price targets are most traded?" (returns all price brackets)

PERFECT FOR questions about:
- Individual outcome volumes within an event
- Top N most traded outcomes
- Complete breakdown of all options
- Comparing volumes across outcomes

⚠️ CROSS-PLATFORM COMPARISON NOTE:
For PLAYER AWARD markets (MVP, DPOY, etc.), Polymarket is often the ONLY source!
Traditional sportsbook APIs (The Odds API) typically only have TEAM championship futures.

✅ Can compare across platforms: "NBA Champion" (both have TEAMS)
❌ Cannot compare: "NBA MVP" (Polymarket has PLAYERS, Odds API doesn't have MVP)

NOTE: Automatically filters out placeholder entries (e.g., "Person A", "Person AB") that Polymarket 
uses as reserved slots for future outcomes. Only ACTIVE outcomes returned.

Includes tokenId per outcome so you can call get_batch_orderbooks immediately without extra lookup.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "The event slug (e.g., 'democratic-presidential-nominee-2028')",
        },
        sortBy: {
          type: "string",
          enum: ["volume", "price", "name"],
          description: "How to sort outcomes: 'volume' (default), 'price' (probability), or 'name' (alphabetical)",
        },
        limit: {
          type: "number",
          description: "Max outcomes to return (default: all). Use for 'top 10' type questions.",
        },
        includeInactive: {
          type: "boolean",
          description: "Include placeholder/inactive outcomes with zero volume (default: false). Rarely needed.",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        eventTitle: { type: "string" },
        eventSlug: { type: "string" },
        totalVolume: { type: "number", description: "Total event volume" },
        totalOutcomes: { type: "number", description: "Total number of outcomes in this event" },
        returnedOutcomes: { type: "number", description: "Number returned (may be limited)" },
        sortedBy: { type: "string" },
        outcomes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              rank: { type: "number" },
              name: { type: "string", description: "Outcome name (e.g., 'Gavin Newsom', 'Chiefs', '$100K-$110K')" },
              volume: { type: "number", description: "Individual trading volume for this outcome" },
              price: { type: "number", description: "Current price (0-1, represents probability)" },
              pricePercent: { type: "string", description: "Price as percentage (e.g., '34.0%')" },
              conditionId: { type: "string" },
              tokenId: {
                type: "string",
                description:
                  "Primary YES token ID for this outcome. Use directly with get_batch_orderbooks/get_orderbook/get_prices.",
              },
            },
          },
        },
        url: { type: "string", description: "Direct Polymarket URL" },
        fetchedAt: { type: "string" },
      },
      required: ["eventTitle", "outcomes"],
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

  // ==================== NEW BATCH/PARAMETER TOOLS ====================
  {
    name: "get_batch_orderbooks",
    description: `Get orderbooks for MULTIPLE tokens in a single request. Much faster than calling get_orderbook multiple times.

USE THIS when comparing prices across multiple markets or scanning for arbitrage.
Ideal for event-wide depth/spread snapshots after get_event_outcomes.

Returns bids/asks arrays for each token with best prices and depth.
Supports up to 150 token IDs per call.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenIds: {
          type: "array",
          items: { type: "string" },
          maxItems: 150,
          description: "Array of token IDs to get orderbooks for (max 150)",
        },
      },
      required: ["tokenIds"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        orderbooks: {
          type: "object",
          description: "Map of token_id to orderbook data",
          additionalProperties: {
            type: "object",
            properties: {
              bestBid: { type: "number" },
              bestAsk: { type: "number" },
              midpoint: { type: "number" },
              spread: { type: "number" },
              bidDepth: { type: "number", description: "Total size at best bid" },
              askDepth: { type: "number", description: "Total size at best ask" },
              bids: { type: "array", description: "Top 5 bids" },
              asks: { type: "array", description: "Top 5 asks" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["orderbooks"],
    },
  },

  {
    name: "get_market_parameters",
    description: `Get trading parameters for a market: tick size, fee rate, and negative risk setting.

- tick_size: Minimum price increment (e.g., 0.01 = 1 cent)
- fee_rate_bps: Trading fee in basis points (e.g., 100 = 1%)
- neg_risk: Whether market uses negative risk model`,
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenId: {
          type: "string",
          description: "Token ID to get parameters for",
        },
      },
      required: ["tokenId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        tokenId: { type: "string" },
        tickSize: { type: "string", description: "Minimum price increment" },
        feeRateBps: { type: "number", description: "Fee rate in basis points" },
        negRisk: { type: "boolean", description: "Whether market uses negative risk" },
        minOrderSize: { type: "number", description: "Minimum order size" },
        fetchedAt: { type: "string" },
      },
      required: ["tokenId", "tickSize"],
    },
  },

  {
    name: "get_midpoints",
    description: `Get midpoint prices for multiple tokens at once. Midpoint = (best_bid + best_ask) / 2.

Faster than fetching full orderbooks when you only need the mid price.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of token IDs (max 50)",
        },
      },
      required: ["tokenIds"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        midpoints: {
          type: "object",
          description: "Map of token_id to midpoint price (0-1 scale)",
          additionalProperties: { type: "number" },
        },
        fetchedAt: { type: "string" },
      },
      required: ["midpoints"],
    },
  },

  {
    name: "get_spreads",
    description: `Get bid-ask spreads for multiple tokens at once. Spread = best_ask - best_bid.

Useful for identifying liquid vs illiquid markets. Wide spreads (>0.05) indicate low liquidity.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        tokenIds: {
          type: "array",
          items: { type: "string" },
          description: "Array of token IDs (max 50)",
        },
      },
      required: ["tokenIds"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        spreads: {
          type: "object",
          description: "Map of token_id to spread info",
          additionalProperties: {
            type: "object",
            properties: {
              spread: { type: "number", description: "Absolute spread (ask - bid)" },
              spreadPercent: { type: "number", description: "Spread as % of midpoint" },
              bestBid: { type: "number" },
              bestAsk: { type: "number" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["spreads"],
    },
  },
  // ==================== END NEW BATCH/PARAMETER TOOLS ====================

  {
    name: "search_markets",
    description: `Search for Polymarket prediction markets by keyword or category.

✅ Uses Polymarket's official /public-search API for reliable server-side text search.

MARKET STATUS:
- LIVE markets: Still trading, outcome not yet determined
- RESOLVED markets: Already finished, for historical reference only

By default, only LIVE markets are returned. Use status='resolved' for finished markets.

⚠️ Always verify the returned results match your intent by checking the title field.

Each result includes:
- url: Direct link to the market (always use this, never construct URLs)
- slug: Use with get_event_by_slug for detailed market data
- status: Either "live" or "resolved"`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (searches title and description). Natural language queries work well (e.g., 'supreme court trump tariffs').",
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
    name: "get_user_activity",
    description:
      "Get on-chain user activity from the Polymarket Data API. Useful for tracking trade flow, side bias (BUY/SELL), and recent wallet behavior.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: "The wallet address to inspect",
        },
        limit: {
          type: "number",
          description: "Maximum activities to return (default: 100, max: 500)",
        },
        offset: {
          type: "number",
          description: "Pagination offset (default: 0)",
        },
        conditionId: {
          type: "string",
          description: "Optional market conditionId filter",
        },
        side: {
          type: "string",
          enum: ["BUY", "SELL"],
          description: "Optional trade side filter",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional activity type filter (TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, MAKER_REBATE)",
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        activity: {
          type: "array",
          items: {
            type: "object",
            properties: {
              timestamp: { type: "string" },
              type: { type: "string" },
              side: { type: "string" },
              conditionId: { type: "string" },
              marketTitle: { type: "string" },
              outcome: { type: "string" },
              size: { type: "number" },
              usdcSize: { type: "number" },
              price: { type: "number" },
              transactionHash: { type: "string" },
            },
          },
        },
        summary: {
          type: "object",
          properties: {
            total: { type: "number" },
            buyCount: { type: "number" },
            sellCount: { type: "number" },
            totalUsdcFlow: { type: "number" },
            byType: { type: "object" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["address", "activity", "summary"],
    },
  },

  {
    name: "get_user_total_value",
    description:
      "Get total marked-to-market value of a user's positions from Polymarket Data API /value.",
    inputSchema: {
      type: "object" as const,
      properties: {
        address: {
          type: "string",
          description: "The wallet address to inspect",
        },
        conditionIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of conditionIds to scope valuation",
        },
      },
      required: ["address"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        address: { type: "string" },
        totalValue: { type: "number" },
        conditionIds: {
          type: "array",
          items: { type: "string" },
        },
        fetchedAt: { type: "string" },
      },
      required: ["address", "totalValue"],
    },
  },

  {
    name: "get_market_open_interest",
    description:
      "Get open interest from Polymarket Data API /oi for one or more conditionIds.",
    inputSchema: {
      type: "object" as const,
      properties: {
        conditionId: {
          type: "string",
          description: "Single conditionId",
        },
        conditionIds: {
          type: "array",
          items: { type: "string" },
          description: "Multiple conditionIds",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        openInterest: {
          type: "array",
          items: {
            type: "object",
            properties: {
              conditionId: { type: "string" },
              value: { type: "number" },
            },
          },
        },
        totalOpenInterest: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["openInterest", "totalOpenInterest"],
    },
  },

  {
    name: "get_event_live_volume",
    description:
      "Get real-time event-level volume breakdown from Polymarket Data API /live-volume.",
    inputSchema: {
      type: "object" as const,
      properties: {
        eventId: {
          type: "number",
          description: "Polymarket event id",
        },
      },
      required: ["eventId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        eventId: { type: "number" },
        total: { type: "number" },
        markets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              market: { type: "string" },
              value: { type: "number" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["eventId", "total", "markets"],
    },
  },

  {
    name: "get_top_holders",
    description: `Get the top holders (biggest positions) for a specific market. Shows who the whales are, their position sizes, and implied conviction. Essential for smart money analysis.

DEEP FETCHING (default=true): Polymarket API caps at 20 holders per call with NO pagination. To work around this, we query 10 minBalance thresholds [$1M, $100k, $10k, $5k, $2k, $1k, $500, $100, $10, $1] in paced batches and deduplicate results. This captures everything from ultra-whales ($1M+) down to small positions, returning 50-100+ unique holders instead of just 20.

Set deepFetch=false for faster but shallower results (20 per side max).

⏱️ PERFORMANCE: With deepFetch=true, this runs 10 holder-tier queries in paced batches and typically takes ~8-15s.
⚠️ Call ALONE (not in parallel with other heavy tools) when deepFetch=true to avoid timeouts.`,
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
          description: "Number of top holders to return per outcome (default: 50 with deepFetch, 20 without)",
        },
        deepFetch: {
          type: "boolean",
          description: "Use multi-tier fetching to get more holders (default: true). Set to false for faster but limited results.",
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

const TOOLS_WITH_METADATA = TOOLS.map((tool) => {
  const existingMeta =
    "_meta" in tool && typeof tool._meta === "object" && tool._meta !== null
      ? (tool._meta as Record<string, unknown>)
      : {};
  const latencyClass: ToolLatencyClass = HEAVY_ANALYSIS_TOOLS.has(tool.name)
    ? "slow"
    : "instant";
  const surface: ToolSurface = "both";
  const queryEligible = true;
  const pricing = resolveExecutePricingMeta(existingMeta);

  return {
    ...tool,
    _meta: {
      ...existingMeta,
      surface,
      queryEligible,
      latencyClass,
      pricing,
      rateLimit: buildToolRateLimitMetadata(tool.name),
    },
  };
});

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "polymarket-intelligence", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS_WITH_METADATA,
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
        case "analyze_event_whale_breakdown":
          return await handleAnalyzeEventWhaleBreakdown(args);
        case "find_correlated_markets":
          return await handleFindCorrelatedMarkets(args);
        case "check_market_rules":
          return await handleCheckMarketRules(args);
        case "find_arbitrage_opportunities":
          return await handleFindArbitrageOpportunities(args);
        case "find_trading_opportunities":
          return await handleFindTradingOpportunities(args);
        case "build_high_conviction_workflow":
          return await handleBuildHighConvictionWorkflow(args);
        case "find_moderate_probability_bets":
          return await handleFindModerateProbabilityBets(args);
        case "get_bets_by_probability":
          return await handleGetBetsByProbability(args);
        case "discover_trending_markets":
          return await handleDiscoverTrendingMarkets(args);
        case "get_top_markets":
          return await handleGetTopMarkets(args);
        case "analyze_my_positions":
          return await handleAnalyzeMyPositions(args);

        // Trading Tools (Redirect to Polymarket UI)
        case "place_polymarket_order":
          return await handlePlacePolymarketOrder(args);

        // Cross-Platform Interoperability
        case "polymarket_crossref_kalshi":
        case "search_on_kalshi": // Backward compatibility alias
          return await handleSearchOnKalshi(args);

        // Tier 2: Raw Data Tools
        case "get_events":
          return await handleGetEvents(args);
        case "get_event_by_slug":
          return await handleGetEventBySlug(args);
        case "search_and_get_outcomes":
          return await handleSearchAndGetOutcomes(args);
        case "get_event_outcomes":
          return await handleGetEventOutcomes(args);
        case "get_orderbook":
          return await handleGetOrderbook(args);
        case "get_prices":
          return await handleGetPrices(args);
        case "get_price_history":
          return await handleGetPriceHistory(args);
        case "get_batch_orderbooks":
          return await handleGetBatchOrderbooks(args);
        case "get_market_parameters":
          return await handleGetMarketParameters(args);
        case "get_midpoints":
          return await handleGetMidpoints(args);
        case "get_spreads":
          return await handleGetSpreads(args);
        case "search_markets":
          return await handleSearchMarkets(args);
        case "get_market_trades":
          return await handleGetMarketTrades(args);
        case "get_user_positions":
          return await handleGetUserPositions(args);
        case "get_user_activity":
          return await handleGetUserActivity(args);
        case "get_user_total_value":
          return await handleGetUserTotalValue(args);
        case "get_market_open_interest":
          return await handleGetMarketOpenInterest(args);
        case "get_event_live_volume":
          return await handleGetEventLiveVolume(args);
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

/**
 * Generate a Polymarket URL - ALWAYS returns a valid URL
 * Uses slug if available, falls back to conditionId
 */
function getPolymarketUrl(slug?: string, conditionId?: string): string {
  if (slug) {
    return `https://polymarket.com/event/${slug}`;
  }
  if (conditionId) {
    return `https://polymarket.com/event/${conditionId}`;
  }
  return "https://polymarket.com/markets";
}

type ResolvedMarketReference = {
  conditionId: string;
  marketTitle: string;
  slug?: string;
};

type MarketResolveCandidate = {
  conditionId?: string;
  marketTitle: string;
  slug?: string;
  eventSlug?: string;
  score: number;
  closed: boolean;
  volume: number;
  source: string;
};

const MARKET_QUERY_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "is",
  "are",
  "will",
  "be",
  "by",
  "market",
  "polymarket",
  "who",
  "what",
  "when",
  "where",
]);

function normalizeMarketQueryText(value: string): string {
  return value
    .toLowerCase()
    .replace(/,/g, "")
    .replace(/[^a-z0-9$\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractMarketQueryTokens(value: string): string[] {
  const normalized = normalizeMarketQueryText(value);
  if (!normalized) {
    return [];
  }

  const tokens = normalized
    .split(" ")
    .map((token) => token.replace(/^\$+/, ""))
    .filter(
      (token) =>
        token.length >= 3 && !MARKET_QUERY_STOP_WORDS.has(token)
    );

  return Array.from(new Set(tokens));
}

function extractPriceTargets(value: string): number[] {
  const normalized = value.toLowerCase().replace(/,/g, "");
  const targets = new Set<number>();

  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*k\b/g)) {
    const raw = Number(match[1]);
    if (Number.isFinite(raw) && raw > 0) {
      targets.add(Math.round(raw * 1000));
    }
  }

  for (const match of normalized.matchAll(/\$(\d+(?:\.\d+)?)/g)) {
    const raw = Number(match[1]);
    if (Number.isFinite(raw) && raw >= 1000) {
      targets.add(Math.round(raw));
    }
  }

  for (const match of normalized.matchAll(/\b\d{4,}\b/g)) {
    const raw = Number(match[0]);
    if (Number.isFinite(raw) && raw >= 1000) {
      targets.add(Math.round(raw));
    }
  }

  return Array.from(targets).sort((a, b) => a - b);
}

function scoreMarketCandidate(params: {
  queryText: string;
  queryTokens: string[];
  queryTargets: number[];
  candidateText: string;
}): number {
  const { queryText, queryTokens, queryTargets, candidateText } = params;
  const normalizedCandidateText = normalizeMarketQueryText(candidateText);
  if (!normalizedCandidateText) {
    return 0;
  }

  let score = 0;

  if (normalizedCandidateText.includes(queryText)) {
    score += 420;
  }

  let tokenMatches = 0;
  for (const token of queryTokens) {
    if (normalizedCandidateText.includes(token)) {
      tokenMatches += 1;
    }
  }
  score += tokenMatches * 22;

  if (queryText.includes("above") || queryText.includes("over")) {
    if (
      normalizedCandidateText.includes("above") ||
      normalizedCandidateText.includes("over")
    ) {
      score += 35;
    }
  }

  if (queryText.includes("below") || queryText.includes("under")) {
    if (
      normalizedCandidateText.includes("below") ||
      normalizedCandidateText.includes("under")
    ) {
      score += 35;
    }
  }

  if (queryTargets.length > 0) {
    const candidateTargets = extractPriceTargets(normalizedCandidateText);
    let targetOverlap = 0;
    for (const queryTarget of queryTargets) {
      const hasTargetMatch = candidateTargets.some((candidateTarget) => {
        const tolerance = Math.max(1000, Math.round(queryTarget * 0.02));
        return Math.abs(candidateTarget - queryTarget) <= tolerance;
      });
      if (hasTargetMatch) {
        targetOverlap += 1;
      }
    }

    if (targetOverlap > 0) {
      score += targetOverlap * 240;
    } else {
      score -= 180;
    }
  }

  return score;
}

function pickBestMarketCandidate(
  candidates: MarketResolveCandidate[]
): MarketResolveCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const sorted = [...candidates].sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.volume !== a.volume) {
      return b.volume - a.volume;
    }
    return a.marketTitle.localeCompare(b.marketTitle);
  });

  return sorted[0] ?? null;
}

async function resolveCandidateConditionId(
  candidate: MarketResolveCandidate | null
): Promise<ResolvedMarketReference | null> {
  if (!candidate) {
    return null;
  }

  if (candidate.conditionId) {
    return {
      conditionId: candidate.conditionId,
      marketTitle: candidate.marketTitle,
      slug: candidate.slug,
    };
  }

  if (candidate.slug) {
    try {
      const markets = (await fetchGamma(
        `/markets?slug=${encodeURIComponent(candidate.slug)}&limit=1`,
        8_000
      )) as GammaMarket[];
      if (Array.isArray(markets) && markets.length > 0 && markets[0].conditionId) {
        return {
          conditionId: markets[0].conditionId,
          marketTitle:
            markets[0].question || markets[0].title || candidate.marketTitle,
          slug: markets[0].slug || candidate.slug,
        };
      }
    } catch {
      // Keep resolving through event slug fallback.
    }
  }

  if (candidate.eventSlug) {
    try {
      const event = (await fetchGamma(
        `/events/slug/${encodeURIComponent(candidate.eventSlug)}`,
        8_000
      )) as GammaEvent;
      const markets = Array.isArray(event?.markets) ? event.markets : [];
      const matched = markets.find((market) => {
        if (!market.conditionId) {
          return false;
        }

        if (candidate.slug && market.slug === candidate.slug) {
          return true;
        }

        const normalizedMarketTitle = normalizeMarketQueryText(
          `${market.question || ""} ${market.title || ""}`
        );
        const normalizedCandidateTitle = normalizeMarketQueryText(
          candidate.marketTitle
        );
        return (
          normalizedCandidateTitle.length > 0 &&
          normalizedMarketTitle.includes(normalizedCandidateTitle)
        );
      });

      if (matched?.conditionId) {
        return {
          conditionId: matched.conditionId,
          marketTitle:
            matched.question || matched.title || candidate.marketTitle,
          slug: matched.slug || candidate.slug || candidate.eventSlug,
        };
      }
    } catch {
      // Final failure handled by caller.
    }
  }

  return null;
}

async function resolveMarketReference(options: {
  conditionId?: string;
  slug?: string;
  marketQuery?: string;
}): Promise<ResolvedMarketReference | null> {
  const { conditionId, slug, marketQuery } = options;

  if (conditionId) {
    return {
      conditionId,
      marketTitle: conditionId,
      slug,
    };
  }

  if (slug) {
    try {
      const event = (await fetchGamma(`/events/slug/${slug}`, 8_000)) as GammaEvent;
      const market = event?.markets?.[0];
      if (market?.conditionId) {
        return {
          conditionId: market.conditionId,
          marketTitle: market.question || event.title || slug,
          slug: market.slug || slug,
        };
      }
    } catch {
      // Fallback to market-by-slug lookup.
    }

    try {
      const markets = (await fetchGamma(
        `/markets?slug=${encodeURIComponent(slug)}&limit=1`,
        8_000
      )) as GammaMarket[];
      if (Array.isArray(markets) && markets.length > 0 && markets[0].conditionId) {
        return {
          conditionId: markets[0].conditionId,
          marketTitle: markets[0].question || markets[0].title || slug,
          slug: markets[0].slug || slug,
        };
      }
    } catch {
      // Keep looking via marketQuery fallback below.
    }
  }

  if (marketQuery) {
    const trimmedQuery = marketQuery.trim();
    const encoded = encodeURIComponent(trimmedQuery);
    const normalizedQuery = normalizeMarketQueryText(trimmedQuery);
    if (encoded.length === 0 || normalizedQuery.length === 0) {
      return null;
    }

    const queryTokens = extractMarketQueryTokens(trimmedQuery);
    const queryTargets = extractPriceTargets(trimmedQuery);
    const strictThreshold = queryTargets.length > 0 ? 120 : 70;
    const fallbackThreshold = queryTargets.length > 0 ? 80 : 50;

    const tryPublicSearch = async (params: {
      phase: string;
      eventsStatus: "active" | "closed";
      includeClosed: boolean;
    }): Promise<MarketResolveCandidate | null> => {
      try {
        const path = `/public-search?q=${encoded}&limit_per_type=20&search_tags=false&search_profiles=false&optimized=true&events_status=${params.eventsStatus}${params.includeClosed ? "&keep_closed_markets=1" : ""}`;
        const search = (await fetchJsonWithPolicy({
          upstream: "gamma",
          endpoint: path,
          timeoutMs: 10_000,
          init: {
            headers: {
              Accept: "application/json",
              "User-Agent": "Polymarket-MCP-Server/1.0",
            },
          },
        })) as { events?: GammaEvent[] };
        const events = Array.isArray(search?.events) ? search.events : [];
        const candidates: MarketResolveCandidate[] = [];

        for (const event of events) {
          for (const market of event.markets ?? []) {
            if (!market.conditionId && !market.slug && !event.slug) {
              continue;
            }

            const candidateText = `${event.title || ""} ${market.question || ""} ${market.title || ""}`;
            const score = scoreMarketCandidate({
              queryText: normalizedQuery,
              queryTokens,
              queryTargets,
              candidateText,
            });

            candidates.push({
              conditionId: market.conditionId,
              marketTitle: market.question || market.title || event.title || trimmedQuery,
              slug: market.slug || event.slug,
              eventSlug: event.slug,
              score,
              closed: event.closed === true || market.closed === true,
              volume: Number(event.volume || market.volume || 0),
              source: params.phase,
            });
          }
        }

        const best = pickBestMarketCandidate(candidates);
        console.info("[polymarket-resolve] phase", {
          query: trimmedQuery.slice(0, 120),
          phase: params.phase,
          candidates: candidates.length,
          bestScore: best?.score ?? null,
          selectedConditionId: best?.conditionId ?? null,
        });
        return best;
      } catch (error) {
        console.warn("[polymarket-resolve] phase_failed", {
          query: trimmedQuery.slice(0, 120),
          phase: params.phase,
          error:
            error instanceof Error
              ? error.message.slice(0, 160)
              : String(error).slice(0, 160),
        });
        return null;
      }
    };

    const activeBest = await tryPublicSearch({
      phase: "public-search-active",
      eventsStatus: "active",
      includeClosed: false,
    });
    if (activeBest && activeBest.score >= strictThreshold) {
      const resolvedFromActive = await resolveCandidateConditionId(activeBest);
      if (resolvedFromActive) {
        return resolvedFromActive;
      }
    }

    const resolvedBest = await tryPublicSearch({
      phase: "public-search-closed",
      eventsStatus: "closed",
      includeClosed: true,
    });
    if (resolvedBest && resolvedBest.score >= strictThreshold) {
      const resolvedFromClosed = await resolveCandidateConditionId(resolvedBest);
      if (resolvedFromClosed) {
        return resolvedFromClosed;
      }
    }

    const searchFallbackBest = pickBestMarketCandidate(
      [activeBest, resolvedBest].filter(
        (candidate): candidate is MarketResolveCandidate => candidate !== null
      )
    );
    if (searchFallbackBest && searchFallbackBest.score >= fallbackThreshold) {
      const resolvedFromSearchFallback =
        await resolveCandidateConditionId(searchFallbackBest);
      if (resolvedFromSearchFallback) {
        return resolvedFromSearchFallback;
      }
    }

    const tryMarketsList = async (params: {
      phase: string;
      closed: boolean;
    }): Promise<MarketResolveCandidate | null> => {
      try {
        const markets = (await fetchGamma(
          `/markets?limit=80&closed=${params.closed ? "true" : "false"}&order=volume24hr&ascending=false`,
          10_000
        )) as GammaMarket[];

        const candidates: MarketResolveCandidate[] = [];
        for (const market of Array.isArray(markets) ? markets : []) {
          if (!market.conditionId) {
            continue;
          }

          const candidateText = `${market.question || ""} ${market.title || ""}`;
          const score = scoreMarketCandidate({
            queryText: normalizedQuery,
            queryTokens,
            queryTargets,
            candidateText,
          });

          candidates.push({
            conditionId: market.conditionId,
            marketTitle: market.question || market.title || trimmedQuery,
            slug: market.slug,
            score,
            closed: params.closed,
            volume: Number(market.volume || market.volume24hr || 0),
            source: params.phase,
          });
        }

        const best = pickBestMarketCandidate(candidates);
        console.info("[polymarket-resolve] phase", {
          query: trimmedQuery.slice(0, 120),
          phase: params.phase,
          candidates: candidates.length,
          bestScore: best?.score ?? null,
          selectedConditionId: best?.conditionId ?? null,
        });
        return best;
      } catch (error) {
        console.warn("[polymarket-resolve] phase_failed", {
          query: trimmedQuery.slice(0, 120),
          phase: params.phase,
          error:
            error instanceof Error
              ? error.message.slice(0, 160)
              : String(error).slice(0, 160),
        });
        return null;
      }
    };

    const liveListBest = await tryMarketsList({
      phase: "markets-list-live",
      closed: false,
    });
    if (liveListBest && liveListBest.score >= strictThreshold) {
      const resolvedFromLiveList =
        await resolveCandidateConditionId(liveListBest);
      if (resolvedFromLiveList) {
        return resolvedFromLiveList;
      }
    }

    const resolvedListBest = await tryMarketsList({
      phase: "markets-list-closed",
      closed: true,
    });
    if (resolvedListBest && resolvedListBest.score >= strictThreshold) {
      const resolvedFromClosedList =
        await resolveCandidateConditionId(resolvedListBest);
      if (resolvedFromClosedList) {
        return resolvedFromClosedList;
      }
    }

    const finalBest = pickBestMarketCandidate(
      [liveListBest, resolvedListBest].filter(
        (candidate): candidate is MarketResolveCandidate => candidate !== null
      )
    );
    if (finalBest && finalBest.score >= fallbackThreshold) {
      const resolvedFromFinal = await resolveCandidateConditionId(finalBest);
      if (resolvedFromFinal) {
        return resolvedFromFinal;
      }
    }

    console.warn("[polymarket-resolve] unresolved_query", {
      query: trimmedQuery.slice(0, 120),
      queryTokens,
      queryTargets,
    });
  }

  return null;
}

async function fetchGamma(
  endpoint: string,
  timeoutMs?: number | UpstreamTimeoutProfile
): Promise<unknown> {
  return fetchJsonWithPolicy({
    upstream: "gamma",
    endpoint,
    timeoutMs,
  });
}

async function fetchClob(
  endpoint: string,
  options?: RequestInit,
  timeoutMs?: number | UpstreamTimeoutProfile
): Promise<unknown> {
  const headers = normalizeHeaders(options?.headers);

  return fetchJsonWithPolicy({
    upstream: "clob",
    endpoint,
    timeoutMs,
    init: {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    },
  });
}

async function fetchClobPost(
  endpoint: string,
  body: unknown,
  timeoutMs?: number | UpstreamTimeoutProfile
): Promise<unknown> {
  return fetchClob(endpoint, {
    method: "POST",
    body: JSON.stringify(body),
  }, timeoutMs);
}

async function fetchDataApi(
  endpoint: string,
  timeoutMs?: number | UpstreamTimeoutProfile
): Promise<unknown> {
  return fetchJsonWithPolicy({
    upstream: "data",
    endpoint,
    timeoutMs,
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

  // PERF: Resolve token IDs first, then fetch both orderbooks in parallel.
  // Previously this was 5 sequential calls (market → yesBook → market again → noBook → prices).
  // Now it's: 1 market call → 2 parallel book calls + 1 price call = 2 round-trips total.
  if (conditionId) {
    const market = (await fetchClob(`/markets/${conditionId}`, undefined, 8000)) as ClobMarket;
    yesTokenId = market.tokens?.[0]?.token_id || tokenId;
    noTokenId = market.tokens?.[1]?.token_id || "";
  }

  if (!yesTokenId) {
    return errorResult("Could not resolve token ID");
  }

  // Fetch both orderbooks in parallel (+ price) instead of sequentially.
  // NOTE: Some Gamma markets don't have an active CLOB orderbook (or are paused),
  // which manifests as a 404 from /book. In that case we return a best-effort
  // response instead of failing the entire tool call.
  const [yesOrderbook, noOrderbook] = (await Promise.all([
    fetchClob(`/book?token_id=${yesTokenId}`, undefined, 8000)
      .then((r) => r as OrderbookResponse)
      .catch(() => null),
    noTokenId
      ? fetchClob(`/book?token_id=${noTokenId}`, undefined, 8000)
          .then((r) => r as OrderbookResponse)
          .catch(() => null)
      : Promise.resolve(null),
  ])) as [OrderbookResponse | null, OrderbookResponse | null];

  if (!yesOrderbook) {
    let fallbackMarketTitle = conditionId || yesTokenId;
    let fallbackPrice = 0.5;
    let fallbackLiquidity = 0;

    try {
      if (conditionId) {
        const gammaMarkets = (await fetchGamma(
          `/markets?condition_ids=${conditionId}&limit=1`,
          8000
        )) as GammaMarket[];
        if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
          const m = gammaMarkets[0];
          fallbackMarketTitle = m.question || m.title || fallbackMarketTitle;
          fallbackLiquidity = Number(m.liquidity || 0);
          const gammaPrices = parseJsonArray(m.outcomePrices);
          const yesPrice = parseFloat(gammaPrices[0]) || 0;
          if (yesPrice > 0 && yesPrice < 1) {
            fallbackPrice = yesPrice;
          }
        }
      }
    } catch {
      // Ignore Gamma fallback failures
    }

    const noBookWhaleCost = {
      sell1k: {
        amountFilled: 0,
        avgPrice: 0,
        worstPrice: 0,
        slippagePercent: 100,
        canFill: false,
      },
      sell5k: {
        amountFilled: 0,
        avgPrice: 0,
        worstPrice: 0,
        slippagePercent: 100,
        canFill: false,
      },
      sell10k: {
        amountFilled: 0,
        avgPrice: 0,
        worstPrice: 0,
        slippagePercent: 100,
        canFill: false,
      },
    };

    return successResult({
      market: fallbackMarketTitle,
      tokenId: yesTokenId,
      currentPrice: Number(fallbackPrice.toFixed(4)),
      spread: {
        bestBid: Number(fallbackPrice.toFixed(4)),
        bestAsk: Number(fallbackPrice.toFixed(4)),
        spreadCents: 0,
        spreadBps: 0,
        // Backward-compat aliases
        absolute: 0,
        percentage: 0,
        bps: 0,
      },
      depth: {
        bidDepthUsd: Number((fallbackLiquidity * 0.5).toFixed(2)),
        askDepthUsd: Number((fallbackLiquidity * 0.5).toFixed(2)),
        totalDepthUsd: Number(fallbackLiquidity.toFixed(2)),
        note: "CLOB orderbook unavailable; Gamma liquidity used as rough proxy",
      },
      whaleCost: noBookWhaleCost,
      liquidityScore: "illiquid",
      recommendation:
        "CLOB orderbook unavailable (market may be paused or not tradeable on the orderbook). Treat execution/exit risk as high.",
      fetchedAt: new Date().toISOString(),
    });
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
    // Query by conditionId - use Gamma /markets?condition_ids= for direct lookup
    // and CLOB API in parallel for token data. This replaces the old approach of
    // brute-force searching through 100+50 events which caused MCP timeouts.
    const [gammaMarkets, clobMarket] = await Promise.all([
      fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000)
        .then(r => r as GammaMarket[])
        .catch(() => [] as GammaMarket[]),
      fetchClob(`/markets/${conditionId}`, undefined, 8000)
        .then(r => r as ClobMarket)
        .catch(() => null),
    ]);

    if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
      market = gammaMarkets[0];
    }

    // If Gamma didn't find it, build minimal market from CLOB data
    if (!market && clobMarket && clobMarket.condition_id) {
      const tokenIds = clobMarket.tokens?.map(t => t.token_id) || [];
      market = {
        conditionId: conditionId,
        question: `Market ${conditionId.slice(0, 10)}...`,
        clobTokenIds: tokenIds,
      };
    }

    if (!market) {
      return errorResult(`Market not found for conditionId: ${conditionId}`);
    }
  }

  // Get prices for all outcome tokens
  const outcomes: Array<{
    name: string;
    tokenId: string;
    price: number;
    impliedProbability: number;
    impliedProbabilityPercent: number;
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
      {
        name: "YES",
        tokenId: yesToken,
        price: yesPrice,
        impliedProbability: Number(yesPrice.toFixed(4)),
        impliedProbabilityPercent: Number((yesPrice * 100).toFixed(2)),
      },
      {
        name: "NO",
        tokenId: noToken,
        price: noPrice,
        impliedProbability: Number(noPrice.toFixed(4)),
        impliedProbabilityPercent: Number((noPrice * 100).toFixed(2)),
      }
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
  const trueProbabilitiesPercent: Record<string, number> = {};
  const probabilityDenominator = sumOfOutcomes > 0 ? sumOfOutcomes : 1;
  for (const outcome of outcomes) {
    const decimalProbability = outcome.price / probabilityDenominator;
    trueProbabilities[outcome.name] = Number(decimalProbability.toFixed(4));
    trueProbabilitiesPercent[outcome.name] = Number((decimalProbability * 100).toFixed(2));
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
    trueProbabilitiesPercent,
    recommendation,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeWhaleFlow(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionIdInput =
    typeof args?.conditionId === "string" ? args.conditionId : undefined;
  const slug = typeof args?.slug === "string" ? args.slug : undefined;
  const marketQuery =
    typeof args?.marketQuery === "string" ? args.marketQuery : undefined;
  const tokenId = args?.tokenId as string;
  const hoursBack = (args?.hoursBack as number) || 24;
  let conditionId = conditionIdInput;
  let marketLabel =
    marketQuery?.trim() || slug || conditionIdInput || tokenId || "unknown-market";

  if (!conditionId && !tokenId) {
    const resolved = await resolveMarketReference({
      conditionId: conditionIdInput,
      slug,
      marketQuery,
    });
    if (!resolved?.conditionId) {
      return errorResult(
        "Provide one of conditionId, tokenId, slug, or marketQuery. Could not resolve a market from the provided reference."
      );
    }
    conditionId = resolved.conditionId;
    marketLabel = resolved.marketTitle || resolved.conditionId;
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
      market: marketLabel,
      conditionId: conditionId || null,
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
    market: marketLabel,
    conditionId: conditionId || null,
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
    sourceEvent = (await fetchGamma(`/events/slug/${slug}`, 8000)) as GammaEvent;
  } else {
    // Use Gamma /markets?condition_ids= for direct market lookup
    // PERF: Replaces brute-force search through 100+50 events
    try {
      const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000)) as GammaMarket[];
      if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
        const m = gammaMarkets[0];
        // Construct a minimal event-like object from market data
        sourceEvent = {
          title: m.question || m.title,
          category: (m as Record<string, unknown>).category as string | undefined,
          markets: [m],
        } as GammaEvent;
      }
    } catch {
      // Fall through to error
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
    event = (await fetchGamma(`/events/slug/${slug}`, 8000)) as GammaEvent;
  } else {
    // Use Gamma /markets?condition_ids= for direct market lookup
    // PERF: Replaces brute-force search through 100+50 events
    try {
      const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000)) as GammaMarket[];
      if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
        const m = gammaMarkets[0];
        // Construct event-like object from market data (has description, resolutionSource, etc.)
        event = {
          title: m.question || m.title,
          description: m.description,
          resolutionSource: (m as Record<string, unknown>).resolutionSource as string | undefined,
          endDate: (m as Record<string, unknown>).endDate as string | undefined,
          markets: [m],
        } as GammaEvent;
      }
    } catch {
      return errorResult(`Market not found for conditionId: ${conditionId}`);
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

  const events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];

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

  // Depth-tiered fetching: controls how many events (and thus markets) are scanned.
  // The tool description instructs AI clients to use appropriate depth and avoid
  // calling this in parallel with other heavy tools when using "deep".
  const depth = (args?.depth as string) || "medium";
  const depthConfig = {
    shallow: { vol: 25, liq: 25, new: 15, timeout: 8000 },  // ~500 markets, ~5s
    medium:  { vol: 50, liq: 50, new: 25, timeout: 12000 },  // ~1000 markets, ~10s
    deep:    { vol: 100, liq: 100, new: 50, timeout: 20000 }, // ~2000+ markets, ~20s
  }[depth] || { vol: 50, liq: 50, new: 25, timeout: 12000 };

  const [volumeEvents, liquidityEvents, newEvents] = await Promise.all([
    fetchGamma(`/events?closed=false&limit=${depthConfig.vol}&order=volume24hr&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout) as Promise<GammaEvent[]>,
    fetchGamma(`/events?closed=false&limit=${depthConfig.liq}&order=liquidity&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout) as Promise<GammaEvent[]>,
    fetchGamma(`/events?closed=false&limit=${depthConfig.new}&order=startDate&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout) as Promise<GammaEvent[]>,
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
            url: getPolymarketUrl(eventSlug, market.conditionId),
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
                url: getPolymarketUrl(eventSlug, market.conditionId),
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

type WorkflowCandidate = {
  title: string;
  slug: string;
  conditionId: string;
  url: string;
  currentPrice: number;
  trendScore: number;
  volume24h: number;
  liquidity: number;
  signal: string;
  whyTrending: string;
};

function workflowToNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function workflowToBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  const numericValue = workflowToNumber(value, fallback);
  const rounded = Math.floor(numericValue);
  return Math.min(max, Math.max(min, rounded));
}

function workflowClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function workflowObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function workflowObjectArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry)
  );
}

function workflowStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function workflowGetErrorMessage(result: CallToolResult): string {
  const firstContent = result.content[0];
  if (!firstContent || firstContent.type !== "text" || typeof firstContent.text !== "string") {
    return "Unknown tool failure";
  }

  try {
    const parsed = JSON.parse(firstContent.text) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error.length > 0) {
      return parsed.error;
    }
  } catch {
    // Not JSON, fall through to plain text
  }

  return firstContent.text;
}

function workflowExtractToolData(
  result: CallToolResult,
  toolName: string
): Record<string, unknown> {
  if (result.isError) {
    throw new Error(`${toolName} failed: ${workflowGetErrorMessage(result)}`);
  }

  if (
    result.structuredContent &&
    typeof result.structuredContent === "object" &&
    !Array.isArray(result.structuredContent)
  ) {
    return result.structuredContent as Record<string, unknown>;
  }

  const firstContent = result.content[0];
  if (firstContent && firstContent.type === "text" && typeof firstContent.text === "string") {
    try {
      const parsed = JSON.parse(firstContent.text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Non-JSON response
    }
  }

  return {};
}

function workflowNormalizeProbability(value: unknown): number | null {
  const numericValue = workflowToNumber(value, Number.NaN);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }
  if (numericValue <= 1) {
    return numericValue;
  }
  if (numericValue <= 100) {
    return numericValue / 100;
  }
  return null;
}

function workflowLiquidityPoints(liquidityScore: string): number {
  switch (liquidityScore) {
    case "excellent":
      return 22;
    case "good":
      return 16;
    case "moderate":
      return 10;
    case "poor":
      return 2;
    case "illiquid":
      // Treat "no usable orderbook" as strongly non-tradeable.
      return -12;
    default:
      return 6;
  }
}

function workflowRulePoints(status: "pass" | "caution" | "fail"): number {
  switch (status) {
    case "pass":
      return 18;
    case "caution":
      return 10;
    case "fail":
      // A rules failure should dominate the score: this is existential risk.
      return -10;
    default:
      return 0;
  }
}

async function handleBuildHighConvictionWorkflow(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const category = typeof args?.category === "string" ? args.category.trim() : "";
  const candidateCount = workflowToBoundedInteger(args?.candidateCount, 6, 3, 10);
  const topSetupsLimit = workflowToBoundedInteger(args?.topSetups, 3, 1, 5);
  const includeWhaleFlow = args?.includeWhaleFlow === true;
  const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
  const analysisNotes: string[] = [];

  try {
    const discoveryInput: Record<string, unknown> = {
      sortBy: "volume",
      limit: Math.max(candidateCount * 2, 10),
    };
    if (category.length > 0) {
      discoveryInput.category = category;
    }

    const discoveryData = workflowExtractToolData(
      await handleDiscoverTrendingMarkets(discoveryInput),
      "discover_trending_markets"
    );

    const discoveredMarkets = workflowObjectArray(discoveryData.trendingMarkets);
    const candidates = discoveredMarkets
      .map((market): WorkflowCandidate => {
        const conditionId = typeof market.conditionId === "string" ? market.conditionId : "";
        const slug = typeof market.slug === "string" ? market.slug : "";
        const title = typeof market.title === "string" ? market.title : "Unknown market";
        const url = typeof market.url === "string" && market.url.length > 0
          ? market.url
          : getPolymarketUrl(slug, conditionId);

        return {
          title,
          slug,
          conditionId,
          url,
          currentPrice: workflowToNumber(market.currentPrice, 0.5),
          trendScore: workflowToNumber(market.trendScore, 0),
          volume24h: workflowToNumber(market.volume24h, 0),
          liquidity: workflowToNumber(market.liquidity, 0),
          signal: typeof market.signal === "string" ? market.signal : "No trend signal",
          whyTrending: typeof market.whyTrending === "string" ? market.whyTrending : "No trend context",
        };
      })
      .filter((market) => market.conditionId.length > 0 || market.slug.length > 0)
      .slice(0, candidateCount);

    if (candidates.length === 0) {
      return successResult({
        workflowSummary: {
          strategy: "high-conviction-sequential",
          category: category || "all",
          discoveredMarkets: discoveredMarkets.length,
          analyzedMarkets: 0,
          topSetupsReturned: 0,
        },
        topSetups: [],
        analysisNotes: [
          "No candidate markets were discovered with valid identifiers. Try a different category or increase candidateCount.",
        ],
        fetchedAt: new Date().toISOString(),
      });
    }

    const scoredSetups: Array<Record<string, unknown> & { internalScore: number }> = [];

    for (const candidate of candidates) {
      const risks: string[] = [];
      let marketPriceYes = workflowClamp(candidate.currentPrice, 0.01, 0.99);
      let ruleStatus: "pass" | "caution" | "fail" = "caution";
      let ruleRiskCount = 0;
      let rulesAmbiguityCount = 0;
      let rulesSummaryText = "Read market criteria before sizing.";
      let efficiencyLabel = "unknown";
      let vigBps = 0;
      let spreadCents = 0;
      let slippage5kPercent = 0;
      let liquidityScore = "unknown";
      let edgePercent = 0;
      let whaleSentiment = "neutral";
      let whaleNetVolume = 0;
      let whaleDivergence = "Whale flow not requested";
      let trueProbYes: number | null = null;

      try {
        const rulesInput: Record<string, unknown> = {};
        if (candidate.slug.length > 0) {
          rulesInput.slug = candidate.slug;
        } else {
          rulesInput.conditionId = candidate.conditionId;
        }
        const rulesData = workflowExtractToolData(
          await handleCheckMarketRules(rulesInput),
          "check_market_rules"
        );

        const ruleFactors = workflowStringArray(rulesData.riskFactors);
        const rulesSummary = workflowObject(rulesData.rulesSummary);
        const ambiguities = workflowStringArray(rulesSummary.ambiguities);
        const gotchas = workflowStringArray(rulesSummary.potentialGotchas);
        const resolvesYesIf =
          typeof rulesSummary.resolvesYesIf === "string" ? rulesSummary.resolvesYesIf : "";

        rulesAmbiguityCount = ambiguities.length;
        ruleRiskCount = ruleFactors.length + gotchas.length;
        rulesSummaryText = resolvesYesIf.length > 0
          ? `YES resolves if: ${resolvesYesIf}`
          : "Resolution criteria available; review full market description.";

        risks.push(...ruleFactors, ...ambiguities.map((item) => `Ambiguity: ${item}`));

        const resolutionSource =
          typeof rulesData.resolutionSource === "string" ? rulesData.resolutionSource : "";
        if (resolutionSource === "Not specified") {
          risks.push("Resolution source is not clearly specified.");
        }

        if (rulesAmbiguityCount >= 3 || ruleRiskCount >= 6) {
          ruleStatus = "fail";
        } else if (rulesAmbiguityCount > 0 || ruleRiskCount >= 2) {
          ruleStatus = "caution";
        } else {
          ruleStatus = "pass";
        }
      } catch (error) {
        risks.push("Could not complete automated rule validation.");
        ruleStatus = "fail";
        analysisNotes.push(
          `Rules check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      try {
        const efficiencyInput: Record<string, unknown> = {};
        if (candidate.conditionId.length > 0) {
          efficiencyInput.conditionId = candidate.conditionId;
        }
        if (candidate.slug.length > 0) {
          efficiencyInput.slug = candidate.slug;
        }

        const efficiencyData = workflowExtractToolData(
          await handleCheckMarketEfficiency(efficiencyInput),
          "check_market_efficiency"
        );

        const marketEfficiency = workflowObject(efficiencyData.marketEfficiency);
        efficiencyLabel =
          typeof marketEfficiency.efficiency === "string" ? marketEfficiency.efficiency : "unknown";
        vigBps = Math.abs(workflowToNumber(marketEfficiency.vigBps, 0));

        const outcomes = workflowObjectArray(efficiencyData.outcomes);
        for (const outcome of outcomes) {
          const outcomeName = typeof outcome.name === "string" ? outcome.name.toUpperCase() : "";
          if (outcomeName === "YES") {
            marketPriceYes = workflowClamp(workflowToNumber(outcome.price, marketPriceYes), 0.01, 0.99);
          }
        }

        const trueProbabilities = workflowObject(efficiencyData.trueProbabilities);
        trueProbYes = workflowNormalizeProbability(trueProbabilities.YES);
        if (trueProbYes !== null) {
          edgePercent = (trueProbYes - marketPriceYes) * 100;
        }

        if (vigBps > 250) {
          risks.push(`High vig (${vigBps.toFixed(1)} bps) can erase edge.`);
        } else if (vigBps > 120) {
          risks.push(`Moderate vig (${vigBps.toFixed(1)} bps) requires better entry price.`);
        }
      } catch (error) {
        risks.push("Could not verify market efficiency/vig.");
        analysisNotes.push(
          `Efficiency check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      try {
        const liquidityInput: Record<string, unknown> = {};
        if (candidate.conditionId.length > 0) {
          liquidityInput.conditionId = candidate.conditionId;
        }
        const liquidityData = workflowExtractToolData(
          await handleAnalyzeMarketLiquidity(liquidityInput),
          "analyze_market_liquidity"
        );

        liquidityScore =
          typeof liquidityData.liquidityScore === "string" ? liquidityData.liquidityScore : "unknown";
        const spread = workflowObject(liquidityData.spread);
        spreadCents = workflowToNumber(
          spread.spreadCents,
          workflowToNumber(spread.absolute, 0)
        );

        const whaleCost = workflowObject(liquidityData.whaleCost);
        const sell5k = workflowObject(whaleCost.sell5k);
        slippage5kPercent = workflowToNumber(sell5k.slippagePercent, 0);

        if (liquidityScore === "illiquid" || slippage5kPercent > 12) {
          risks.push("Exit risk is high for medium-sized positions.");
        }
        if (spreadCents > 3) {
          risks.push(`Wide spread (${spreadCents.toFixed(1)} cents) hurts execution.`);
        }
      } catch (error) {
        risks.push("Could not verify orderbook depth/slippage.");
        analysisNotes.push(
          `Liquidity check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }

      if (includeWhaleFlow) {
        try {
          const whaleData = workflowExtractToolData(
            await handleAnalyzeWhaleFlow({
              conditionId: candidate.conditionId,
              hoursBack,
            }),
            "analyze_whale_flow"
          );
          const whaleActivity = workflowObject(whaleData.whaleActivity);
          whaleSentiment =
            typeof whaleActivity.sentiment === "string" ? whaleActivity.sentiment : "neutral";
          whaleNetVolume = workflowToNumber(whaleActivity.netWhaleVolume, 0);
          whaleDivergence =
            typeof whaleData.divergence === "string" ? whaleData.divergence : "No divergence data";
        } catch (error) {
          whaleSentiment = "neutral";
          whaleDivergence = "Whale flow unavailable";
          analysisNotes.push(
            `Whale-flow check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`
          );
        }
      }

      let suggestedSide: "YES" | "NO";
      if (edgePercent > 2) {
        suggestedSide = "YES";
      } else if (edgePercent < -2) {
        suggestedSide = "NO";
      } else if (whaleSentiment === "bullish") {
        suggestedSide = "YES";
      } else if (whaleSentiment === "bearish") {
        suggestedSide = "NO";
      } else {
        suggestedSide = marketPriceYes <= 0.5 ? "YES" : "NO";
      }

      const sideMarketPrice = suggestedSide === "YES" ? marketPriceYes : 1 - marketPriceYes;
      const sideFairPrice = trueProbYes !== null
        ? suggestedSide === "YES"
          ? trueProbYes
          : 1 - trueProbYes
        : sideMarketPrice;
      const sideEdgePercent = (sideFairPrice - sideMarketPrice) * 100;

      const rulePoints = workflowRulePoints(ruleStatus);
      const liquidityPoints = workflowLiquidityPoints(liquidityScore);
      const efficiencyPoints = Math.max(0, 20 - Math.min(vigBps, 400) / 20);
      const trendPoints = Math.min(20, candidate.trendScore * 0.25);
      let edgePoints = Math.max(0, Math.min(16, Math.abs(sideEdgePercent) * 2));
      if (ruleStatus === "fail" || liquidityScore === "illiquid") {
        edgePoints = Math.min(edgePoints, 4);
      }
      let whalePoints = 0;
      if (includeWhaleFlow) {
        const sideAligned =
          (suggestedSide === "YES" && whaleSentiment === "bullish") ||
          (suggestedSide === "NO" && whaleSentiment === "bearish");
        if (sideAligned) {
          whalePoints = 6;
        } else if (whaleSentiment === "neutral") {
          whalePoints = 0;
        } else {
          whalePoints = -4;
          risks.push("Whale flow currently leans against this side.");
        }
      }

      const rawScore =
        trendPoints + rulePoints + liquidityPoints + efficiencyPoints + edgePoints + whalePoints;
      const normalizedScore = workflowClamp(rawScore, 1, 99);

      const tradabilityReasons: string[] = [];
      if (ruleStatus === "fail") {
        tradabilityReasons.push("Resolution criteria too ambiguous");
      }
      if (liquidityScore === "illiquid") {
        tradabilityReasons.push("No executable orderbook depth");
      }
      if (slippage5kPercent > 12) {
        tradabilityReasons.push("Estimated $5k exit slippage is too high");
      }
      if (spreadCents > 5) {
        tradabilityReasons.push("Bid/ask spread is too wide");
      }
      const isTradable = tradabilityReasons.length === 0;

      const riskList = Array.from(
        new Set(risks.filter((risk) => risk.length > 0))
      ).slice(0, 8);

      const takeProfitPrice = workflowClamp(sideMarketPrice + 0.08, 0.05, 0.98);
      const invalidationPrice = workflowClamp(sideMarketPrice - 0.06, 0.01, 0.95);
      const sizeGuidance =
        liquidityScore === "excellent" || liquidityScore === "good"
          ? "Normal sizing acceptable; use limit orders for better fills."
          : "Use smaller sizing and patient limit orders to control slippage.";

      const edgeLabel = sideEdgePercent >= 0
        ? `${sideEdgePercent.toFixed(2)}% model edge`
        : `${Math.abs(sideEdgePercent).toFixed(2)}% model deficit`;

      scoredSetups.push({
        rank: 0,
        market: candidate.title,
        url: candidate.url,
        conditionId: candidate.conditionId,
        slug: candidate.slug,
        score: Number(normalizedScore.toFixed(1)),
        signal: `${suggestedSide} setup: ${edgeLabel}, ${liquidityScore} liquidity, ${efficiencyLabel} pricing`,
        currentPrice: Number(marketPriceYes.toFixed(4)),
        entryPlan: {
          suggestedSide,
          sideEntryPrice: Number(sideMarketPrice.toFixed(4)),
          sideFairPrice: Number(sideFairPrice.toFixed(4)),
          edgePercent: Number(sideEdgePercent.toFixed(2)),
          takeProfitPrice: Number(takeProfitPrice.toFixed(4)),
          invalidationPrice: Number(invalidationPrice.toFixed(4)),
          sizingGuidance: sizeGuidance,
          executionNote: `Spread ${spreadCents.toFixed(1)}c, est. $5k exit slippage ${slippage5kPercent.toFixed(1)}%.`,
        },
        checks: {
          rules: {
            status: ruleStatus,
            riskFactorCount: ruleRiskCount,
            ambiguityCount: rulesAmbiguityCount,
            summary: rulesSummaryText,
          },
          efficiency: {
            status: efficiencyLabel,
            vigBps: Number(vigBps.toFixed(1)),
            sideEdgePercent: Number(sideEdgePercent.toFixed(2)),
          },
          liquidity: {
            status: liquidityScore,
            spreadCents: Number(spreadCents.toFixed(2)),
            slippage5kPercent: Number(slippage5kPercent.toFixed(2)),
          },
          tradability: {
            isTradable,
            reasons: tradabilityReasons,
          },
        },
        whaleInsights: {
          enabled: includeWhaleFlow,
          sentiment: whaleSentiment,
          netVolume: Number(whaleNetVolume.toFixed(2)),
          divergence: whaleDivergence,
        },
        risks: riskList,
        isTradable,
        internalScore: normalizedScore,
      });
    }

    scoredSetups.sort((left, right) => right.internalScore - left.internalScore);
    const tradableSetups = scoredSetups.filter(
      (setup) => setup.isTradable === true
    );
    const nonTradableSetups = scoredSetups.filter(
      (setup) => setup.isTradable !== true
    );
    const selectedSetups = [...tradableSetups, ...nonTradableSetups].slice(
      0,
      topSetupsLimit
    );
    const selectedTradableCount = selectedSetups.filter(
      (setup) => setup.isTradable === true
    ).length;
    const topSetups = selectedSetups.map((setup, index) => {
      const { internalScore, ...visibleSetup } = setup;
      return {
        ...visibleSetup,
        rank: index + 1,
      };
    });

    if (topSetups.length === 0) {
      analysisNotes.push(
        "No setups were retained after scoring. Try reducing strictness by lowering candidateCount or disabling whale checks."
      );
    }
    if (tradableSetups.length === 0 && scoredSetups.length > 0) {
      analysisNotes.push(
        "No fully tradeable setups met execution/rules thresholds; returned best available setups with explicit cautions."
      );
    }
    if (selectedTradableCount > 0 && selectedTradableCount < topSetupsLimit) {
      analysisNotes.push(
        `Only ${selectedTradableCount}/${topSetupsLimit} setups met tradability thresholds. Consider increasing candidateCount (max 10) or switching category for more liquid markets.`
      );
    }

    return successResult({
      workflowSummary: {
        strategy: "high-conviction-sequential",
        category: category || "all",
        discoveredMarkets: discoveredMarkets.length,
        analyzedMarkets: candidates.length,
        topSetupsReturned: topSetups.length,
      },
      topSetups,
      analysisNotes,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `build_high_conviction_workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
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
  // PERF: Reduced from limit=150 to limit=50 to avoid MCP transport timeouts.
  // 50 events ordered by liquidity still covers the most liquid/tradeable markets.
  let endpoint = `/events?closed=false&limit=50&order=liquidity&ascending=false`;
  if (category && category !== "all") {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];

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
          url: getPolymarketUrl(eventSlug, market.conditionId),
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
  // PERF: Reduced from limit=100 to limit=50 to avoid MCP transport timeouts
  let endpoint = `/events?closed=false&limit=50&order=liquidity&ascending=false`;
  if (category && category !== "all") {
    endpoint += `&category=${category}`;
  }

  const events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];

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
          url: getPolymarketUrl(eventSlug, market.conditionId),
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
          url: getPolymarketUrl(eventSlug, market.conditionId),
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

  // Map sortBy to API order parameter - respect user's choice
  let orderParam: string;
  switch (sortBy) {
    case "liquidity":
      orderParam = "liquidity";
      break;
    case "price_change":
      orderParam = "volume24hr"; // Use volume as proxy for price activity
      break;
    case "volume":
    default:
      orderParam = "volume24hr";
      break;
  }

  // IMPORTANT: The Gamma API's ?category= parameter is BROKEN and returns wrong results.
  // Instead, we fetch more events and filter CLIENT-SIDE by checking the tags array.
  // PERF: Capped at 50 events max to avoid MCP transport timeouts (was up to 200).
  const fetchLimit = category ? Math.min(Math.max(limit * 5, 50), 50) : Math.min(Math.max(limit * 2, 30), 50);
  const endpoint = `/events?closed=false&limit=${fetchLimit}&order=${orderParam}&ascending=false`;

  let events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];

  // Apply client-side category filtering if category is specified
  if (category) {
    const categoryLower = category.toLowerCase();
    const categoryAliases: Record<string, string[]> = {
      'politics': ['politics', 'elections', 'political'],
      'sports': ['sports', 'nfl', 'nba', 'mlb', 'soccer', 'football', 'basketball', 'baseball', 'tennis', 'mma', 'ufc', 'boxing', 'golf', 'hockey', 'nhl'],
      'crypto': ['crypto', 'bitcoin', 'ethereum', 'cryptocurrency', 'defi'],
      'pop-culture': ['pop-culture', 'culture', 'movies', 'entertainment', 'hollywood', 'music', 'awards'],
      'science': ['science', 'tech', 'technology', 'ai', 'space'],
      'business': ['business', 'economics', 'finance', 'fed', 'interest-rates'],
    };
    const matchingSlugs = categoryAliases[categoryLower] || [categoryLower];

    events = events.filter((e) => {
      if (!e.tags || !Array.isArray(e.tags)) return false;
      return e.tags.some((tag: { slug?: string; label?: string }) => {
        const tagSlug = (tag.slug || '').toLowerCase();
        const tagLabel = (tag.label || '').toLowerCase();
        return matchingSlugs.some(s => tagSlug === s || tagLabel === s || tagSlug.includes(s) || tagLabel.includes(s));
      });
    });
  }

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
    
    // Skip low activity markets or near-resolved markets (for meaningful whale analysis)
    if (volume24h < 1000 || liquidity < 1000) continue;
    
    // Skip near-resolved markets (>95% or <5%) - no meaningful position building
    const gammaPricesPrecheck = parseJsonArray(market.outcomePrices);
    const yesPricePrecheck = parseFloat(gammaPricesPrecheck[0]) || 0.5;
    if (yesPricePrecheck > 0.95 || yesPricePrecheck < 0.05) {
      continue; // Near-resolved, skip for whale analysis
    }
    
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
      url: getPolymarketUrl(eventSlug, market.conditionId),
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
 * Get top markets sorted by volume, liquidity, etc. - mirrors Polymarket UI filters
 * This is the GO-TO tool for "highest volume markets" type questions.
 */
async function handleGetTopMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sortBy = (args?.sortBy as string) || "total_volume"; // Default to total volume (biggest markets)
  const category = args?.category as string;
  const minTotalVolume = args?.minTotalVolume as number | undefined;
  const maxTotalVolume = args?.maxTotalVolume as number | undefined;
  const minLiquidity = args?.minLiquidity as number | undefined;
  const endDateBefore = args?.endDateBefore as string | undefined;
  const endDateAfter = args?.endDateAfter as string | undefined;
  const includeNearResolved = (args?.includeNearResolved as boolean) ?? false;
  const includeEnded = (args?.includeEnded as boolean) ?? false;
  const offset = Math.max((args?.offset as number) || 0, 0);
  const limit = Math.min(Math.max((args?.limit as number) || 15, 1), 100);
  const nowMs = Date.now();

  // Map sortBy to API order parameter
  let orderParam: string;
  let ascending = false;
  
  switch (sortBy) {
    case "total_volume":
      orderParam = "volume"; // ALL-TIME total volume (e.g., $507M)
      break;
    case "recent_activity":
    case "volume":
      orderParam = "volume24hr"; // 24h volume - for "most active today"
      break;
    case "liquidity":
      orderParam = "liquidity";
      break;
    case "trending":
      orderParam = "volume"; // Total volume as proxy for trending
      break;
    case "newest":
      orderParam = "startDate";
      ascending = false; // Newest first = descending startDate
      break;
    case "ending_soon":
      orderParam = "endDate";
      ascending = true; // Closest end date first
      break;
    case "competitive":
      orderParam = "competitive"; // Polymarket's competitive score
      break;
    default:
      orderParam = "volume"; // Default to total volume
  }

  const markets: Array<{
    rank: number;
    title: string;
    url: string;
    slug: string;
    conditionId: string;
    currentPrice: number;
    volume24h: number;
    totalVolume: number;
    liquidity: number;
    endDate: string;
    category: string;
  }> = [];
  const seenMarketKeys = new Set<string>();
  const pageSize = category
    ? Math.min(Math.max(limit * 10, 50), 100)
    : Math.min(Math.max(limit * 2, 20), 100);
  const maxPagesToScan = category ? 6 : 4;
  const categoryLower = category?.toLowerCase().trim();
  const categoryAliases: Record<string, string[]> = {
    politics: ["politics", "elections", "political"],
    sports: [
      "sports",
      "nfl",
      "nba",
      "mlb",
      "soccer",
      "football",
      "basketball",
      "baseball",
      "tennis",
      "mma",
      "ufc",
      "boxing",
      "golf",
      "hockey",
      "nhl",
    ],
    crypto: ["crypto", "bitcoin", "ethereum", "cryptocurrency", "defi"],
    "pop-culture": ["pop-culture", "culture", "movies", "entertainment", "hollywood", "music", "awards"],
    science: ["science", "tech", "technology", "ai", "space"],
    business: ["business", "economics", "finance", "fed", "interest-rates"],
  };
  const categoryMatchers = categoryLower
    ? (categoryAliases[categoryLower] || [categoryLower]).map((value) => value.toLowerCase())
    : [];
  let scanOffset = offset;
  let pagesScanned = 0;
  let lastRawBatchSize = 0;

  while (pagesScanned < maxPagesToScan && markets.length < limit) {
    // Build endpoint with all filters - these are applied SERVER-SIDE by Polymarket API
    let endpoint = `/events?active=true&closed=false&limit=${pageSize}&offset=${scanOffset}&order=${orderParam}&ascending=${ascending}`;

    // Volume filters (server-side filtering for efficiency)
    // Note: /events endpoint uses volume_min/max (not volume_num_min/max)
    if (minTotalVolume !== undefined) {
      endpoint += `&volume_min=${minTotalVolume}`;
    }
    if (maxTotalVolume !== undefined) {
      endpoint += `&volume_max=${maxTotalVolume}`;
    }

    // Liquidity filter
    // Note: /events endpoint uses liquidity_min/max (not liquidity_num_min/max)
    if (minLiquidity !== undefined) {
      endpoint += `&liquidity_min=${minLiquidity}`;
    }

    // Date filters
    if (endDateBefore) {
      endpoint += `&end_date_max=${endDateBefore}`;
    }
    if (endDateAfter) {
      endpoint += `&end_date_min=${endDateAfter}`;
    }

    const events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];
    pagesScanned += 1;
    lastRawBatchSize = events.length;

    if (events.length === 0) {
      break;
    }

    for (const event of events) {
      if (categoryMatchers.length > 0) {
        const normalizedCategory = (event.category || "").toLowerCase();
        const hasCategoryMatch =
          categoryMatchers.some((matcher) => normalizedCategory.includes(matcher)) ||
          (event.tags || []).some((tag: { slug?: string; label?: string }) => {
            const tagSlug = (tag.slug || "").toLowerCase();
            const tagLabel = (tag.label || "").toLowerCase();
            return categoryMatchers.some(
              (matcher) =>
                tagSlug === matcher ||
                tagLabel === matcher ||
                tagSlug.includes(matcher) ||
                tagLabel.includes(matcher)
            );
          });

        if (!hasCategoryMatch) {
          continue;
        }
      }

      const market = event.markets?.[0];
      if (!market) continue;

      // Keep default behavior focused on currently tradable/live markets.
      if (event.active === false || event.closed === true) {
        continue;
      }
      if (market.active === false || market.closed === true || market.acceptingOrders === false) {
        continue;
      }
      if ((market.umaResolutionStatus || "").toLowerCase() === "resolved") {
        continue;
      }

      const volume24h = Number(event.volume24hr || market.volume24hr || 0);
      const totalVolume = Number(event.volume || market.volume || 0);
      const liquidity = Number(event.liquidity || market.liquidity || 0);
      const marketEndDate = event.endDate || event.endDateIso || "";

      if (!includeEnded && marketEndDate) {
        const endMs = Date.parse(marketEndDate);
        if (Number.isFinite(endMs) && endMs <= nowMs) {
          continue;
        }
      }

      const gammaPrices = parseJsonArray(market.outcomePrices);
      const yesPrice = parseFloat(gammaPrices[0]) || 0.5;

      if (!includeNearResolved && (yesPrice > 0.95 || yesPrice < 0.05)) {
        continue;
      }

      // For competitive sort, only include markets between 35-65%
      if (sortBy === "competitive" && (yesPrice < 0.35 || yesPrice > 0.65)) continue;

      const eventSlug = event.slug || "";
      const conditionId = market.conditionId || event.id || "";
      const dedupeKey = conditionId || `${eventSlug}:${event.title || market.question || "unknown"}`;
      if (seenMarketKeys.has(dedupeKey)) {
        continue;
      }
      seenMarketKeys.add(dedupeKey);
      const normalizedCategoryForOutput =
        categoryLower && categoryLower.length > 0
          ? categoryLower
          : (event.category || "other");

      // ALWAYS provide a URL - use slug if available, otherwise construct from conditionId
      const url = eventSlug
        ? `https://polymarket.com/event/${eventSlug}`
        : (conditionId ? `https://polymarket.com/event/${conditionId}` : "");

      markets.push({
        rank: 0,
        title: event.title || market.question || "Unknown",
        url,
        slug: eventSlug,
        conditionId,
        currentPrice: yesPrice,
        volume24h,
        totalVolume,
        liquidity,
        endDate: marketEndDate,
        category: normalizedCategoryForOutput,
      });

      if (markets.length >= limit) {
        break;
      }
    }

    scanOffset += events.length;

    // Fewer rows than requested means we've exhausted this sorted slice.
    if (events.length < pageSize) {
      break;
    }
  }

  // For "ending_soon", sort by end date ascending (closest first)
  if (sortBy === "ending_soon") {
    markets.sort((a, b) => {
      const dateA = new Date(a.endDate).getTime() || Infinity;
      const dateB = new Date(b.endDate).getTime() || Infinity;
      return dateA - dateB;
    });
  }

  // Assign ranks and limit
  const finalMarkets = markets.slice(0, limit);
  finalMarkets.forEach((m, idx) => {
    m.rank = idx + 1;
  });

  // Generate summary based on sortBy
  const topTotalVol = finalMarkets[0]?.totalVolume || 0;
  const topVol24h = finalMarkets[0]?.volume24h || 0;
  const combinedTotalVol = finalMarkets.reduce((sum, m) => sum + m.totalVolume, 0);
  
  // Format volume as human-readable (e.g., $507M, $6.2M)
  const formatVol = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(1)}M`;
  
  let summary: string;
  switch (sortBy) {
    case "total_volume":
      summary = `Top ${finalMarkets.length} markets by ALL-TIME volume. #1: ${formatVol(topTotalVol)}. Combined: ${formatVol(combinedTotalVol)}.`;
      break;
    case "volume":
    case "recent_activity":
      summary = `Top ${finalMarkets.length} markets by 24h volume. #1: ${formatVol(topVol24h)} today.`;
      break;
    case "liquidity":
      summary = `Top ${finalMarkets.length} markets by liquidity depth.`;
      break;
    case "trending":
      summary = `Top ${finalMarkets.length} trending markets by total volume.`;
      break;
    case "newest":
      summary = `${finalMarkets.length} newest markets on Polymarket.`;
      break;
    case "ending_soon":
      summary = `${finalMarkets.length} markets ending soonest.`;
      break;
    case "competitive":
      summary = `${finalMarkets.length} most contested markets (40-60% range).`;
      break;
    default:
      summary = `Top ${finalMarkets.length} markets.`;
  }

  // Add pagination info
  const paginationInfo = offset > 0 ? ` (showing results ${offset + 1}-${offset + finalMarkets.length})` : "";
  const hasMore = lastRawBatchSize === pageSize;
  
  return successResult({
    sortedBy: sortBy,
    markets: finalMarkets,
    summary: summary + paginationInfo,
    pagination: {
      offset,
      returned: finalMarkets.length,
      hasMore,
      nextOffset: scanOffset,
      scannedToOffset: scanOffset,
      pagesScanned,
    },
    searchExhausted: !hasMore && finalMarkets.length < limit,
    filtersApplied: {
      minTotalVolume,
      maxTotalVolume,
      minLiquidity,
      endDateBefore,
      endDateAfter,
      category,
      includeNearResolved,
      includeEnded,
    },
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
      noResultsReason: "no_active_positions",
      searchExhausted: true,
      fetchedAt: new Date().toISOString(),
    });
  }

  // Filter to focus market if specified
  const positionsToAnalyze = focusMarket
    ? portfolio.positions.filter((p: PolymarketPosition) => p.conditionId === focusMarket)
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
// TRADING HANDLERS (REDIRECT TO POLYMARKET UI)
// ============================================================================

/**
 * Handle place_polymarket_order - Analyze market and provide redirect to Polymarket UI.
 * 
 * Polymarket's CLOB API requires API key authentication (derived from wallet signatures)
 * which cannot be delegated through the handshake architecture. Instead, we:
 * 1. Analyze current market prices
 * 2. Calculate optimal order parameters  
 * 3. Provide a direct link to complete the trade on polymarket.com
 */
async function handlePlacePolymarketOrder(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string | undefined;
  const slug = args?.slug as string | undefined;
  const outcome = args?.outcome as "YES" | "NO";
  const side = args?.side as "BUY" | "SELL";
  const amount = args?.amount as number;
  const price = args?.price as number | undefined;

  // Validate required fields
  if (!outcome || !side || !amount) {
    return errorResult("Missing required fields: outcome, side, and amount are required");
  }

  if (!["YES", "NO"].includes(outcome)) {
    return errorResult("Outcome must be 'YES' or 'NO'");
  }

  if (!["BUY", "SELL"].includes(side)) {
    return errorResult("Side must be 'BUY' or 'SELL'");
  }

  if (amount <= 0) {
    return errorResult("Amount must be greater than 0");
  }

  // Resolve market by conditionId or slug
  let marketConditionId = conditionId;
  let marketData: GammaEvent | undefined;

  if (!marketConditionId && slug) {
    try {
      marketData = await fetchGamma(`/events/slug/${slug}`) as GammaEvent;
      const firstMarket = marketData?.markets?.[0];
      marketConditionId = firstMarket?.conditionId;
    } catch {
      return errorResult(`Market not found for slug: ${slug}`);
    }
  }

  if (!marketConditionId) {
    return errorResult("Either conditionId or slug is required to identify the market");
  }

  // Fetch market details from CLOB
  let clobMarket: ClobMarket;
  try {
    clobMarket = await fetchClob(`/markets/${marketConditionId}`) as ClobMarket;
  } catch {
    return errorResult(`Market not found: ${marketConditionId}`);
  }

  // Get token ID for the selected outcome
  const tokens = clobMarket.tokens || [];
  const targetToken = tokens.find(t => t.outcome?.toUpperCase() === outcome);
  if (!targetToken || !targetToken.token_id) {
    return errorResult(`Could not find ${outcome} token for market ${marketConditionId}`);
  }
  const tokenId = targetToken.token_id;

  // Get market title if we don't have it
  // PERF: Use direct /markets?condition_ids= instead of fetching 100 events
  if (!marketData) {
    try {
      const gammaMarkets = await fetchGamma(`/markets?condition_ids=${marketConditionId}&limit=1`, 5000) as GammaMarket[];
      if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
        // Create a minimal event-like object with the market data
        marketData = { title: gammaMarkets[0].question, slug: gammaMarkets[0].slug } as GammaEvent;
      }
    } catch {
      // Non-critical, continue without title
    }
  }
  const marketTitle = marketData?.title || `Market ${marketConditionId.slice(0, 10)}...`;
  const marketSlug = marketData?.slug || slug || conditionId;

  // Fetch orderbook to calculate suggested price
  let suggestedPrice = price;
  let currentBestBid = 0;
  let currentBestAsk = 1;

  try {
    const orderbook = await fetchClob(`/book?token_id=${tokenId}`) as OrderbookResponse;
    const bids = orderbook?.bids || [];
    const asks = orderbook?.asks || [];

    if (bids.length > 0) {
      currentBestBid = parseFloat(bids[0].price);
    }
    if (asks.length > 0) {
      currentBestAsk = parseFloat(asks[0].price);
    }

    // Calculate suggested price if not provided
    if (!suggestedPrice) {
      if (side === "BUY") {
        suggestedPrice = Math.min(currentBestAsk * 1.02, 0.99);
      } else {
        suggestedPrice = Math.max(currentBestBid * 0.98, 0.01);
      }
    }
  } catch (error) {
    console.error("[polymarket] Failed to fetch orderbook:", error);
    // Default to market midpoint
    suggestedPrice = price || 0.50;
  }

  // Calculate estimated shares
  const estimatedShares = side === "BUY" 
    ? amount / suggestedPrice 
    : amount;

  // Build the trading link
  const tradingLink = `https://polymarket.com/event/${marketSlug}`;

  // Build suggested order details
  const suggestedOrder = {
    market: marketTitle,
    outcome,
    side,
    amount,
    suggestedPrice,
    estimatedShares,
    currentBestBid,
    currentBestAsk,
  };

  // Build response message
  const sideLabel = side === "BUY" ? "buy" : "sell";
  const responseMessage = `To ${sideLabel} ${outcome} shares on "${marketTitle}", please complete the order on Polymarket directly.

**Why can't Context execute this trade?**
Polymarket uses a centralized orderbook (CLOB) that requires API key authentication. These API keys must be derived from your wallet signature on polymarket.com and cannot be delegated.

**Your suggested order:**
- Outcome: ${outcome}
- Side: ${side}
- Amount: $${amount}
- Suggested Price: $${suggestedPrice.toFixed(2)} (${(suggestedPrice * 100).toFixed(1)}¢)
- Estimated Shares: ${estimatedShares.toFixed(2)}
- Current Best Bid: $${currentBestBid.toFixed(2)}
- Current Best Ask: $${currentBestAsk.toFixed(2)}`;

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "external_action_required",
          message: responseMessage,
          tradingLink,
          suggestedOrder,
          reason: "Polymarket CLOB requires API key authentication that cannot be delegated through wallet signatures alone. Orders must be placed directly on polymarket.com.",
          dataSources: [GAMMA_API_URL, CLOB_API_URL],
          dataFreshness: "real-time",
          fetchedAt: new Date().toISOString(),
        }, null, 2),
      },
    ],
    structuredContent: {
      status: "external_action_required",
      message: responseMessage,
      tradingLink,
      suggestedOrder,
      reason: "Polymarket CLOB requires API key authentication that cannot be delegated through wallet signatures alone. Orders must be placed directly on polymarket.com.",
    },
  };
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

// Helper function to extract YES/NO outcome meanings from Kalshi resolution rules
function extractKalshiOutcomeMeanings(rules: string, marketTitle: string): { yesOutcomeMeans: string; noOutcomeMeans: string } {
  const rulesLower = rules.toLowerCase();
  const titleLower = marketTitle.toLowerCase();
  
  // Default fallback based on title
  let yesOutcomeMeans = `The event described in "${marketTitle}" occurs`;
  let noOutcomeMeans = `The event described in "${marketTitle}" does NOT occur`;
  
  // Pattern 1: "resolve to Yes if..." / "resolves Yes if..."
  const yesIfMatch = rules.match(/resolves?\s+(?:to\s+)?["']?yes["']?\s+if\s+([^.]+)/i);
  const noIfMatch = rules.match(/resolves?\s+(?:to\s+)?["']?no["']?\s+if\s+([^.]+)/i);
  
  if (yesIfMatch) {
    yesOutcomeMeans = yesIfMatch[1].trim().replace(/[,;]$/, '');
    yesOutcomeMeans = yesOutcomeMeans.charAt(0).toUpperCase() + yesOutcomeMeans.slice(1);
  }
  if (noIfMatch) {
    noOutcomeMeans = noIfMatch[1].trim().replace(/[,;]$/, '');
    noOutcomeMeans = noOutcomeMeans.charAt(0).toUpperCase() + noOutcomeMeans.slice(1);
  }
  
  // Pattern 2: Look for "in favor of" patterns
  if (rulesLower.includes('in favor of') || titleLower.includes('in favor of')) {
    const favorMatch = rules.match(/in\s+favor\s+of\s+([^,.']+)/i);
    if (favorMatch) {
      const subject = favorMatch[1].trim();
      yesOutcomeMeans = `Ruling/decision is IN FAVOR OF ${subject}`;
      noOutcomeMeans = `Ruling/decision is AGAINST ${subject}`;
    }
  }
  
  // Pattern 3: "reverses, vacates, or otherwise overturns" - legal patterns (Kalshi style)
  if (rulesLower.includes('reverses') || rulesLower.includes('overturns') || rulesLower.includes('vacates')) {
    yesOutcomeMeans = 'Court rules IN FAVOR of the party seeking to overturn (Trump wins tariffs case)';
    noOutcomeMeans = 'Court rules AGAINST the party seeking to overturn (Trump loses tariffs case)';
  }
  
  // Pattern 4: Look for "If X, then Yes" patterns
  const ifThenMatch = rules.match(/if\s+([^,]+),\s+(?:the\s+)?market\s+(?:will\s+)?resolves?\s+(?:to\s+)?yes/i);
  if (ifThenMatch && !yesIfMatch) {
    yesOutcomeMeans = ifThenMatch[1].trim();
    yesOutcomeMeans = yesOutcomeMeans.charAt(0).toUpperCase() + yesOutcomeMeans.slice(1);
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

// Cross-platform search on Kalshi
async function handleSearchOnKalshi(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const title = args?.title as string | undefined;
  const keywords = args?.keywords as string | undefined;
  const polymarketSlug = args?.polymarketSlug as string | undefined;
  const limit = Math.min((args?.limit as number) || 10, 25);

  // Build search query from title or keywords
  let searchQuery = keywords || '';
  if (!searchQuery && title) {
    // Extract meaningful keywords from title
    const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'this', 'that', 'with', 'from', 'as', 'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'but', 'if', 'than', 'so', 'just']);
    searchQuery = title.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 6)
      .join(' ');
  }

  if (!searchQuery) {
    return errorResult("Either 'title' or 'keywords' is required to search Kalshi.");
  }

  try {
    const fetchKalshiJson = async <T>(url: string, timeoutMs = 8000): Promise<T> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": "Polymarket-MCP-Server/1.0",
          },
        });

        if (!response.ok) {
          throw new Error(`Kalshi API error: ${response.status} ${response.statusText}`);
        }

        return (await response.json()) as T;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    // Note: Kalshi API doesn't support server-side text search, so we fetch markets and filter client-side.
    // Try both known hosts; deployments can differ by region/environment.
    const kalshiUrls = [
      `https://api.elections.kalshi.com/trade-api/v2/markets?limit=${limit * 5}&status=open`,
      `https://api.kalshi.com/trade-api/v2/markets?limit=${limit * 5}&status=open`,
    ];
    const sourcesTried: string[] = [];
    let data: {
      markets?: Array<{
        ticker: string;
        event_ticker: string;
        title?: string;
        subtitle?: string;
        yes_sub_title?: string;
        yes_ask?: number;
        last_price?: number;
        volume_24h?: number;
      }>;
    } | null = null;

    for (const kalshiUrl of kalshiUrls) {
      sourcesTried.push(kalshiUrl.includes("api.elections.kalshi.com") ? "api.elections.kalshi.com" : "api.kalshi.com");
      try {
        data = await fetchKalshiJson<{
          markets?: Array<{
            ticker: string;
            event_ticker: string;
            title?: string;
            subtitle?: string;
            yes_sub_title?: string;
            yes_ask?: number;
            last_price?: number;
            volume_24h?: number;
          }>;
        }>(kalshiUrl, 8000);
        if (Array.isArray(data?.markets)) {
          break;
        }
      } catch {
        // Try next host.
      }
    }

    if (!data || !Array.isArray(data.markets)) {
      return successResult({
        searchedFor: {
          keywords: searchQuery,
          polymarketSlug: polymarketSlug || null,
        },
        kalshiResults: [],
        hint: "Kalshi lookup is temporarily unavailable. Try again shortly or refine keywords.",
        comparisonNote: null,
        searchExhausted: true,
        noResultsReason: "kalshi_unavailable",
        sourcesTried,
        fetchedAt: new Date().toISOString(),
      });
    }

    const markets = data.markets || [];

    // Score and filter results based on keyword matching
    const queryWords = searchQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    const scoredResults = markets.map(market => {
      const marketTitle = market.title || market.yes_sub_title || market.ticker;
      const searchText = (marketTitle + ' ' + (market.subtitle || '')).toLowerCase();
      
      // Count matching keywords
      let matchCount = 0;
      for (const word of queryWords) {
        if (searchText.includes(word)) {
          matchCount++;
        }
      }
      const matchScore = queryWords.length > 0 ? matchCount / queryWords.length : 0;

      const yesPrice = market.yes_ask || market.last_price || 0;
      
      // Generate slug from event ticker for URL
      const slug = market.event_ticker?.toLowerCase() || market.ticker?.toLowerCase();

      return {
        title: marketTitle,
        ticker: market.ticker,
        eventTicker: market.event_ticker,
        yesPrice: Math.round(yesPrice),
        volume24h: market.volume_24h || 0,
        url: `https://kalshi.com/markets/${slug}`,
        matchScore: Math.round(matchScore * 100) / 100,
        rules: '', // Will be fetched below for top matches
        yesOutcomeMeans: '', // Will be computed after fetching rules
        noOutcomeMeans: '',  // Will be computed after fetching rules
      };
    })
    .filter(r => r.matchScore > 0.2) // At least 20% keyword match
    .sort((a, b) => b.matchScore - a.matchScore || b.volume24h - a.volume24h)
    .slice(0, limit);

    // Fetch rules for top matches (rules_primary is only in individual market endpoint)
    // This is critical for cross-platform comparison!
    const topMatches = scoredResults.slice(0, 5); // Fetch rules for top 5
    await Promise.allSettled(topMatches.map(async (result) => {
      try {
        const marketUrl = `https://api.elections.kalshi.com/trade-api/v2/markets/${result.ticker}`;
        try {
          sourcesTried.push("api.elections.kalshi.com");
          const marketData = await fetchKalshiJson<{ market?: { rules_primary?: string; rules_secondary?: string } }>(marketUrl, 5000);
          const rules = marketData.market?.rules_secondary || marketData.market?.rules_primary || '';
          result.rules = rules;
          // Extract outcome meanings
          const { yesOutcomeMeans, noOutcomeMeans } = extractKalshiOutcomeMeanings(rules, result.title);
          result.yesOutcomeMeans = yesOutcomeMeans;
          result.noOutcomeMeans = noOutcomeMeans;
        } catch {
          const fallbackUrl = `https://api.kalshi.com/trade-api/v2/markets/${result.ticker}`;
          sourcesTried.push("api.kalshi.com");
          const marketData = await fetchKalshiJson<{ market?: { rules_primary?: string; rules_secondary?: string } }>(fallbackUrl, 5000);
          const rules = marketData.market?.rules_secondary || marketData.market?.rules_primary || "";
          result.rules = rules;
          const { yesOutcomeMeans, noOutcomeMeans } = extractKalshiOutcomeMeanings(rules, result.title);
          result.yesOutcomeMeans = yesOutcomeMeans;
          result.noOutcomeMeans = noOutcomeMeans;
        }
      } catch {
        // Ignore individual fetch failures
      }
    }));

    const hint = scoredResults.length > 0
      ? `Found ${scoredResults.length} potential matches on Kalshi. ⚠️ CRITICAL: Check 'yesOutcomeMeans' and 'noOutcomeMeans' to ensure you're comparing equivalent outcomes!`
      : `No strong matches found on Kalshi for "${searchQuery}". Try different keywords. Note: Kalshi has NO sports markets.`;

    // Build comparison guidance
    const comparisonNote = scoredResults.length > 0 
      ? `⚠️ CROSS-PLATFORM COMPARISON GUIDE:
1. Kalshi prices are in cents (29 = 29%), Polymarket prices are decimals (0.29 = 29%)
2. READ 'yesOutcomeMeans' for each market - they may be INVERTED!
3. Example: If Kalshi YES means "Court rules IN FAVOR" and Polymarket YES means "Court rules AGAINST", then Kalshi YES ≈ Polymarket NO
4. Only compare prices AFTER confirming outcomes align!`
      : null;

    return successResult({
      searchedFor: {
        keywords: searchQuery,
        polymarketSlug: polymarketSlug || null,
      },
      kalshiResults: scoredResults,
      hint,
      comparisonNote,
      searchExhausted: scoredResults.length === 0,
      noResultsReason: scoredResults.length === 0 ? "no_kalshi_match_found" : undefined,
      sourcesTried: [...new Set(sourcesTried)],
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to search Kalshi: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
  const events = (await fetchGamma(endpoint, 10000)) as GammaEvent[];

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

/**
 * Search for a market AND return its outcomes in one call.
 * Avoids the chained search → get_event_outcomes flow that's error-prone.
 * 
 * Uses /public-search endpoint for reliable server-side text search.
 */
async function handleSearchAndGetOutcomes(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const query = args?.query as string;
  const category = args?.category as string | undefined;

  if (!query) {
    return errorResult("query is required - provide a search term like 'NBA Champion' or 'Super Bowl Winner'");
  }

  try {
    interface GammaEventResult {
      id?: string;
      title?: string;
      slug?: string;
      conditionId?: string;
      volume?: string | number;
      liquidity?: string | number;
      outcomes?: string;
      outcomePrices?: string;
      endDate?: string;
      closed?: boolean;
      markets?: GammaMarket[];
    }

    let searchResults: GammaEventResult[] = [];
    let searchMethod = "public-search";

    // PRIMARY: Use /public-search endpoint for server-side text search
    // This is the official Polymarket search API - no auth/cookies required
    try {
      const searchUrl = `https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(query)}&limit_per_type=20&events_status=active`;
      const searchResponse = await fetch(searchUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Polymarket-MCP-Server/1.0' },
      });
      
      if (searchResponse.ok) {
        const searchData = await searchResponse.json() as { 
          events?: GammaEventResult[]; 
        };
        
        if (searchData.events && searchData.events.length > 0) {
          searchResults = searchData.events;
        }
      }
    } catch (err) {
      console.error('Public search failed, falling back to events listing:', err);
    }

    // FALLBACK: Use /events endpoint with client-side filtering if search fails
    if (searchResults.length === 0) {
      searchMethod = "events-fallback";
      const eventParams = new URLSearchParams({
        active: "true",
        closed: "false",
        limit: "50",
      });
      
      // Add tag filter if category provided
      if (category) {
        eventParams.set("tag", category);
      }

      const events = (await fetchGamma(`/events?${eventParams.toString()}`)) as GammaEventResult[];
      
      if (Array.isArray(events) && events.length > 0) {
        // Filter events by query terms client-side
        const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
        searchResults = events.filter(event => {
          const title = (event.title || "").toLowerCase();
          const matchedTerms = queryTerms.filter(term => title.includes(term));
          return matchedTerms.length >= Math.ceil(queryTerms.length * 0.5);
        });
      }
    }

    if (searchResults.length === 0) {
      return errorResult(`No markets found for query: "${query}". Try a different search term or check spelling.`);
    }

    // Find the best match - prefer exact title matches, then highest volume
    let bestMatch = searchResults[0];
    let matchConfidence: "exact" | "high" | "medium" | "low" = "medium";

    const queryLower = query.toLowerCase();
    for (const result of searchResults) {
      const titleLower = (result.title || "").toLowerCase();
      
      // Exact match
      if (titleLower === queryLower || titleLower.includes(queryLower)) {
        bestMatch = result;
        matchConfidence = "exact";
        break;
      }
      
      // Check for key terms
      const queryTerms = queryLower.split(/\s+/);
      const matchedTerms = queryTerms.filter(term => titleLower.includes(term));
      if (matchedTerms.length >= queryTerms.length * 0.7) {
        bestMatch = result;
        matchConfidence = "high";
      }
    }

    const slug = bestMatch.slug;
    if (!slug) {
      return errorResult(`Found market "${bestMatch.title}" but it has no slug for fetching outcomes.`);
    }

    // Step 2: Fetch the event with all its outcomes
    const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;

    if (!event) {
      return errorResult(`Could not fetch event details for slug: ${slug}`);
    }

    const markets = event.markets || [];
    if (markets.length === 0) {
      return errorResult(`Event "${event.title}" has no markets/outcomes.`);
    }

    // Parse outcomes
    const outcomes = markets
      .filter(m => {
        // Filter out placeholder entries
        const name = m.groupItemTitle || m.question || "";
        const isPlaceholder = /^(Person|Team|Option)\s*[A-Z]{1,2}$/i.test(name);
        const hasVolume = Number(m.volume || 0) > 0 || Number(m.liquidity || 0) > 0;
        return !isPlaceholder && (hasVolume || markets.length <= 5);
      })
      .map(m => {
        // Get YES price
        let price = 0.5;
        if (m.outcomePrices) {
          try {
            const pricesStr = typeof m.outcomePrices === "string" 
              ? m.outcomePrices 
              : JSON.stringify(m.outcomePrices);
            const prices = JSON.parse(pricesStr);
            if (Array.isArray(prices) && prices.length > 0) {
              price = Number(prices[0]) || 0.5;
            }
          } catch {
            // Use default
          }
        }

        const tokenIds = Array.isArray(m.tokens)
          ? m.tokens
              .map((token) => token.token_id)
              .filter(
                (tokenId): tokenId is string =>
                  typeof tokenId === "string" && tokenId.trim().length > 0
              )
          : parseJsonArray(m.clobTokenIds);
        const tokenId = tokenIds[0] || "";

        return {
          name: m.groupItemTitle || m.question || "Unknown",
          price: Number(price.toFixed(4)),
          pricePercent: `${(price * 100).toFixed(1)}%`,
          volume: Number(m.volume || 0),
          conditionId: m.conditionId || "",
          tokenId,
        };
      })
      .sort((a, b) => b.price - a.price); // Sort by price (probability) descending

    const totalVolume = outcomes.reduce((sum, o) => sum + o.volume, 0);

    return successResult({
      eventTitle: event.title || slug,
      eventSlug: slug,
      eventUrl: `https://polymarket.com/event/${slug}`,
      totalVolume,
      totalOutcomes: outcomes.length,
      outcomes,
      searchQuery: query,
      searchMethod,
      matchConfidence,
      note: matchConfidence === "exact" 
        ? "Found exact match for your search query."
        : matchConfidence === "high"
        ? "Found high-confidence match. Verify this is the market you wanted."
        : "Best match found. If this isn't the right market, try a different query.",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Search and get outcomes failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Get all outcomes/candidates in a multi-outcome event with individual volumes
 * Perfect for "which candidate has the highest volume" type questions
 */
async function handleGetEventOutcomes(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  const sortBy = (args?.sortBy as string) || "volume";
  const limit = args?.limit as number | undefined;
  const includeInactive = (args?.includeInactive as boolean) || false;

  if (!slug) {
    return errorResult("slug is required. Example: 'democratic-presidential-nominee-2028'");
  }

  const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;

  if (!event) {
    return errorResult(`Event not found: ${slug}`);
  }

  if (!event.markets || event.markets.length === 0) {
    return errorResult(`Event has no markets/outcomes: ${slug}`);
  }

  // Extract and transform all outcomes
  let outcomes = event.markets.map((m) => {
    const prices = parseJsonArray(m.outcomePrices);
    const yesPrice = prices[0] ? parseFloat(prices[0]) : 0;
    const tokenIds = Array.isArray(m.tokens)
      ? m.tokens
          .map((token) => token.token_id)
          .filter(
            (tokenId): tokenId is string =>
              typeof tokenId === "string" && tokenId.trim().length > 0
          )
      : parseJsonArray(m.clobTokenIds);
    const tokenId = tokenIds[0] || "";
    // Volume can be string or number from API
    const volume = typeof m.volume === 'string' ? parseFloat(m.volume) : (m.volume || 0);
    
    // Use groupItemTitle for multi-outcome events (e.g., "Gavin Newsom")
    // Fall back to question for binary events
    const name = m.groupItemTitle || m.question || "Unknown";

    return {
      rank: 0,
      name,
      volume,
      price: yesPrice,
      pricePercent: `${(yesPrice * 100).toFixed(1)}%`,
      conditionId: m.conditionId || "",
      tokenId,
    };
  });

  // Track raw count before filtering
  const rawOutcomeCount = outcomes.length;

  // Filter out placeholder entries that Polymarket uses for future candidates
  // These have names like "Person A", "Person AB", "Person BZ", "Other" and typically have 0 volume
  // Skip filtering if includeInactive is true (for advanced users who need raw data)
  if (!includeInactive) {
    const placeholderPattern = /^Person [A-Z]{1,2}$/;
    outcomes = outcomes.filter((o) => {
      // Remove placeholder "Person X" entries
      if (placeholderPattern.test(o.name)) {
        return false;
      }
      // Remove "Other" entries with no trading activity
      if (o.name === "Other" && o.volume === 0) {
        return false;
      }
      // Remove "Unknown" entries with no activity
      if (o.name === "Unknown" && o.volume === 0) {
        return false;
      }
      return true;
    });
  }

  const filteredCount = rawOutcomeCount - outcomes.length;

  // Sort based on sortBy parameter
  switch (sortBy) {
    case "volume":
      outcomes.sort((a, b) => b.volume - a.volume);
      break;
    case "price":
      outcomes.sort((a, b) => b.price - a.price);
      break;
    case "name":
      outcomes.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      outcomes.sort((a, b) => b.volume - a.volume);
  }

  // Apply limit if specified
  const totalOutcomes = outcomes.length;
  if (limit && limit > 0) {
    outcomes = outcomes.slice(0, limit);
  }

  // Assign ranks
  outcomes.forEach((o, idx) => {
    o.rank = idx + 1;
  });

  return successResult({
    eventTitle: event.title,
    eventSlug: event.slug,
    totalVolume: event.volume,
    totalOutcomes,
    returnedOutcomes: outcomes.length,
    filteredPlaceholders: filteredCount,
    sortedBy: sortBy,
    outcomes,
    url: `https://polymarket.com/event/${event.slug}`,
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

  let orderbook: OrderbookResponse;
  try {
    // Fetch direct orderbook for this token
    orderbook = (await fetchClob(`/book?token_id=${tokenId}`)) as OrderbookResponse;
  } catch (error) {
    return successResult({
      market: "",
      assetId: tokenId,
      view: "raw",
      warning:
        "No orderbook currently available for this token (likely resolved, inactive, or not quoting on CLOB).",
      bids: [],
      asks: [],
      bestBid: 0,
      bestAsk: 1,
      midPrice: 0.5,
      spread: 1,
      fetchedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : String(error).slice(0, 200),
    });
  }

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

// ==================== NEW BATCH/PARAMETER HANDLERS ====================

async function handleGetBatchOrderbooks(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenIds = args?.tokenIds as string[];

  if (!tokenIds || tokenIds.length === 0) {
    return errorResult("tokenIds array is required");
  }

  if (tokenIds.length > 150) {
    return errorResult("Maximum 150 tokens per batch request");
  }

  const orderbooks: Record<string, {
    bestBid: number;
    bestAsk: number;
    midpoint: number;
    spread: number;
    bidDepth: number;
    askDepth: number;
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
  }> = {};

  // Fetch orderbooks in parallel (batches of 5 to respect rate limits)
  const batchSize = 5;
  for (let i = 0; i < tokenIds.length; i += batchSize) {
    const batch = tokenIds.slice(i, i + batchSize);
    
    await Promise.all(
      batch.map(async (tokenId) => {
        try {
          const orderbook = (await fetchClob(`/book?token_id=${tokenId}`)) as OrderbookResponse;
          const bids = orderbook.bids || [];
          const asks = orderbook.asks || [];
          
          const bestBid = bids.length > 0 ? Number(bids[0].price) : 0;
          const bestAsk = asks.length > 0 ? Number(asks[0].price) : 1;
          const midpoint = (bestBid + bestAsk) / 2;
          const spread = bestAsk - bestBid;
          
          // Calculate depth at best price
          const bidDepth = bids.length > 0 ? Number(bids[0].size) : 0;
          const askDepth = asks.length > 0 ? Number(asks[0].size) : 0;

          orderbooks[tokenId] = {
            bestBid: Number(bestBid.toFixed(4)),
            bestAsk: Number(bestAsk.toFixed(4)),
            midpoint: Number(midpoint.toFixed(4)),
            spread: Number(spread.toFixed(4)),
            bidDepth: Math.round(bidDepth),
            askDepth: Math.round(askDepth),
            bids: bids.slice(0, 5).map(b => ({ price: Number(b.price), size: Number(b.size) })),
            asks: asks.slice(0, 5).map(a => ({ price: Number(a.price), size: Number(a.size) })),
          };
        } catch {
          orderbooks[tokenId] = {
            bestBid: 0,
            bestAsk: 1,
            midpoint: 0.5,
            spread: 1,
            bidDepth: 0,
            askDepth: 0,
            bids: [],
            asks: [],
          };
        }
      })
    );
  }

  return successResult({
    orderbooks,
    count: Object.keys(orderbooks).length,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetMarketParameters(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenId = args?.tokenId as string;

  if (!tokenId) {
    return errorResult("tokenId is required");
  }

  try {
    // Get orderbook which includes tick_size and neg_risk
    const orderbook = (await fetchClob(`/book?token_id=${tokenId}`)) as OrderbookResponse & {
      tick_size?: string;
      neg_risk?: boolean;
      min_tick_size?: string;
    };

    // Try to get market info for fee rate
    let feeRateBps = 0;
    let minOrderSize = 1;
    
    if (orderbook.market) {
      try {
        const market = (await fetchClob(`/markets/${orderbook.market}`)) as ClobMarket & {
          maker_base_fee?: number;
          taker_base_fee?: number;
          min_order_size?: number;
        };
        feeRateBps = (market.taker_base_fee || 0) * 100; // Convert to bps
        minOrderSize = market.min_order_size || 1;
      } catch {
        // Continue with defaults
      }
    }

    return successResult({
      tokenId,
      tickSize: orderbook.tick_size || orderbook.min_tick_size || "0.01",
      feeRateBps,
      negRisk: orderbook.neg_risk || false,
      minOrderSize,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return successResult({
      tokenId,
      tickSize: "0.01",
      feeRateBps: 0,
      negRisk: false,
      minOrderSize: 1,
      warning:
        "Could not read live CLOB parameters for this token (likely resolved, inactive, or not quoting). Returned conservative defaults.",
      fetchedAt: new Date().toISOString(),
      error:
        error instanceof Error
          ? error.message.slice(0, 200)
          : String(error).slice(0, 200),
    });
  }
}

async function handleGetMidpoints(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenIds = args?.tokenIds as string[];

  if (!tokenIds || tokenIds.length === 0) {
    return errorResult("tokenIds array is required");
  }

  if (tokenIds.length > 50) {
    return errorResult("Maximum 50 tokens per request");
  }

  const midpoints: Record<string, number> = {};

  try {
    // Use batch prices endpoint
    const buyResp = (await fetchClobPost("/prices", 
      tokenIds.map(id => ({ token_id: id, side: "BUY" }))
    )) as Record<string, { BUY?: string } | string>;

    const sellResp = (await fetchClobPost("/prices",
      tokenIds.map(id => ({ token_id: id, side: "SELL" }))
    )) as Record<string, { SELL?: string } | string>;

    for (const tokenId of tokenIds) {
      const buyData = buyResp[tokenId];
      const sellData = sellResp[tokenId];
      
      const buy = buyData 
        ? (typeof buyData === "object" && buyData.BUY ? Number(buyData.BUY) : Number(buyData))
        : 0;
      const sell = sellData
        ? (typeof sellData === "object" && sellData.SELL ? Number(sellData.SELL) : Number(sellData))
        : 0;
      
      const mid = (buy + sell) / 2 || buy || sell;
      midpoints[tokenId] = Number(mid.toFixed(4));
    }
  } catch {
    // If CLOB fails, return 0.5 as default (unknown)
    for (const tokenId of tokenIds) {
      midpoints[tokenId] = 0.5;
    }
  }

  return successResult({
    midpoints,
    count: Object.keys(midpoints).length,
    note: "Midpoint = (best_bid + best_ask) / 2. Values are 0-1 scale (0.55 = 55%)",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetSpreads(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const tokenIds = args?.tokenIds as string[];

  if (!tokenIds || tokenIds.length === 0) {
    return errorResult("tokenIds array is required");
  }

  if (tokenIds.length > 50) {
    return errorResult("Maximum 50 tokens per request");
  }

  const spreads: Record<string, {
    spread: number;
    spreadPercent: number;
    bestBid: number;
    bestAsk: number;
  }> = {};

  try {
    // Use batch prices endpoint
    const buyResp = (await fetchClobPost("/prices", 
      tokenIds.map(id => ({ token_id: id, side: "BUY" }))
    )) as Record<string, { BUY?: string } | string>;

    const sellResp = (await fetchClobPost("/prices",
      tokenIds.map(id => ({ token_id: id, side: "SELL" }))
    )) as Record<string, { SELL?: string } | string>;

    for (const tokenId of tokenIds) {
      const buyData = buyResp[tokenId];
      const sellData = sellResp[tokenId];
      
      const bestAsk = buyData 
        ? (typeof buyData === "object" && buyData.BUY ? Number(buyData.BUY) : Number(buyData))
        : 1;
      const bestBid = sellData
        ? (typeof sellData === "object" && sellData.SELL ? Number(sellData.SELL) : Number(sellData))
        : 0;
      
      const spread = bestAsk - bestBid;
      const mid = (bestBid + bestAsk) / 2;
      const spreadPercent = mid > 0 ? (spread / mid) * 100 : 0;

      spreads[tokenId] = {
        spread: Number(spread.toFixed(4)),
        spreadPercent: Number(spreadPercent.toFixed(2)),
        bestBid: Number(bestBid.toFixed(4)),
        bestAsk: Number(bestAsk.toFixed(4)),
      };
    }
  } catch {
    // If CLOB fails, return wide spread (unknown)
    for (const tokenId of tokenIds) {
      spreads[tokenId] = { spread: 1, spreadPercent: 100, bestBid: 0, bestAsk: 1 };
    }
  }

  return successResult({
    spreads,
    count: Object.keys(spreads).length,
    note: "Spread = best_ask - best_bid. Wide spreads (>0.05) indicate low liquidity.",
    fetchedAt: new Date().toISOString(),
  });
}

// ==================== END NEW BATCH/PARAMETER HANDLERS ====================

async function handleSearchMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const query = args?.query as string;
  const category = args?.category as string;
  const status = (args?.status as string) || "live"; // Default to live (tradeable) markets
  const limit = Math.min((args?.limit as number) || 20, 50);

  const normalizedQuery = (query || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");

  // Build query words for matching specific candidates/outcomes in multi-outcome events
  const stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is', 'will', 'be', 'by', 'win', 'presidential', 'nomination', 'president', 'democratic', 'republican']);
  const searchQueryWords = query ? query.toLowerCase().split(/\s+/).filter(w => {
    return w.length > 2 && !stopWords.has(w) && !/^\d+$/.test(w);
  }) : [];
  const rankingStopWords = new Set([
    "the",
    "a",
    "an",
    "in",
    "on",
    "at",
    "to",
    "for",
    "of",
    "and",
    "or",
    "is",
    "will",
    "be",
    "by",
    "with",
    "what",
    "how",
    "show",
    "find",
    "search",
    "markets",
    "market",
    "prediction",
    "related",
  ]);
  const rankingWords = normalizedQuery
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(
      (word) =>
        word.length > 2 && !rankingStopWords.has(word) && !/^\d+$/.test(word)
    );

  let allEvents: GammaEvent[] = [];
  let searchUsed = false;

  // PRIMARY STRATEGY: Use the /public-search endpoint for server-side text search
  // This is the proper Polymarket search API that actually works!
  if (query) {
    try {
      const searchEndpoint = `/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit * 2}${status === 'resolved' ? '&events_status=closed&keep_closed_markets=1' : status === 'live' ? '&events_status=active' : ''}`;
      const searchData = (await fetchJsonWithPolicy({
        upstream: "gamma",
        endpoint: searchEndpoint,
        timeoutMs: 10_000,
        init: {
          headers: {
            Accept: "application/json",
            "User-Agent": "Polymarket-MCP-Server/1.0",
          },
        },
      })) as {
        events?: GammaEvent[];
        pagination?: { totalResults: number; hasMore: boolean };
      };

      if (searchData.events && searchData.events.length > 0) {
        allEvents = searchData.events;
        searchUsed = true;
      }
    } catch (err) {
      // Fall through to events listing if search fails
      console.error('Public search failed, falling back to events listing:', err);
    }
  }

  // FALLBACK: Use events listing only if search wasn't used or returned nothing
  if (!searchUsed) {
    const fetchLimit = limit * 5;
    const orderParams = "&order=volume&ascending=false";
    
    if (status === "all") {
      const [liveEvents, resolvedEvents] = await Promise.all([
        fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
        fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`) as Promise<GammaEvent[]>,
      ]);
      allEvents = [...(liveEvents || []), ...(resolvedEvents || [])];
    } else if (status === "resolved") {
      allEvents = (await fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`)) as GammaEvent[];
    } else {
      allEvents = (await fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${category ? `&category=${category}` : ""}`)) as GammaEvent[];
    }
  }

  let filtered = allEvents || [];

  // Apply status filter if search was used (search may return mixed status)
  if (searchUsed && status !== "all") {
    filtered = filtered.filter(e => {
      const isClosed = e.closed === true;
      if (status === "live") return !isClosed;
      if (status === "resolved") return isClosed;
      return true;
    });
  }

  if (query && rankingWords.length > 0) {
    const tokenizedWordRegex = rankingWords.map(
      (word) => new RegExp(`\\b${word}\\b`, "i")
    );
    const scored = filtered.map((event) => {
      const eventText = [
        event.title || "",
        event.slug || "",
        event.category || "",
        ...(event.markets || []).flatMap((market) => [
          market.question || "",
          market.title || "",
        ]),
      ]
        .join(" ")
        .toLowerCase();

      const compactText = eventText.replace(/[^a-z0-9]/g, "");
      const compactQuery = normalizedQuery.replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");

      let score = 0;
      let exactWordHits = 0;
      for (let i = 0; i < rankingWords.length; i += 1) {
        const word = rankingWords[i];
        if (tokenizedWordRegex[i].test(eventText)) {
          score += 4;
          exactWordHits += 1;
        } else if (eventText.includes(word)) {
          score += 2;
        }
      }

      if (compactQuery.length > 6 && compactText.includes(compactQuery)) {
        score += 8;
      }
      if (exactWordHits === rankingWords.length) {
        score += 6;
      }
      if (
        rankingWords.length >= 2 &&
        eventText.includes(`${rankingWords[0]} ${rankingWords[1]}`)
      ) {
        score += 3;
      }

      return { event, score };
    });

    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.event.volume || 0) - Number(a.event.volume || 0)
    );
    filtered = scored.map((entry) => entry.event);
  }

  // Count by status for breakdown
  let liveCount = 0;
  let resolvedCount = 0;
  
  const results = filtered
    .slice(0, limit)
    .map((e) => {
      const isResolved = e.closed === true;
      const marketStatus = isResolved ? "resolved" : "live";
      
      if (isResolved) {
        resolvedCount++;
      } else {
        liveCount++;
      }

      // Find the specific market matching the search query (e.g., "Gavin Newsom")
      let matchedMarket = e.markets?.[0]; // Default to first market
      let matchedOutcomePrice: string | null = null;
      
      if (searchQueryWords.length > 0 && e.markets && e.markets.length > 1) {
        for (const market of e.markets) {
          const marketText = ((market.question || '') + ' ' + (market.title || '')).toLowerCase();
          const matches = searchQueryWords.some(word => marketText.includes(word));
          if (matches) {
            matchedMarket = market;
            if (market.outcomePrices) {
              try {
                const prices = typeof market.outcomePrices === 'string' 
                  ? JSON.parse(market.outcomePrices) 
                  : market.outcomePrices;
                matchedOutcomePrice = prices[0];
              } catch {}
            }
            break;
          }
        }
      }

      return {
        title: e.title,
        url: `https://polymarket.com/event/${e.slug}`,
        slug: e.slug,
        status: marketStatus,
        category: e.category,
        conditionId: matchedMarket?.conditionId,
        matchedOutcome: matchedMarket?.question || matchedMarket?.title,
        outcomePrice: matchedOutcomePrice,
        volume: e.volume,
        liquidity: e.liquidity,
        endDate: e.endDate || e.endDateIso,
      };
    });

  const hint = searchUsed
    ? `✅ Server-side search used. Found ${results.length} results for "${query}".`
    : (query 
        ? `⚠️ Search fallback: browsing events listing. Results may not be comprehensive.`
        : `Browsing ${status} markets by volume.`);
  
  const statusHint = status === "live"
    ? " Showing LIVE markets only (open for trading)."
    : status === "resolved"
      ? " Showing RESOLVED markets only (already finished)."
      : " Showing ALL markets (both live and resolved).";

  return successResult({
    results,
    count: results.length,
    searchMethod: searchUsed ? "public-search API" : "events listing",
    statusBreakdown: {
      live: liveCount,
      resolved: resolvedCount,
    },
    hint: hint + statusHint,
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

async function handleGetUserActivity(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const address = (args?.address as string) || "";
  const limit = Math.min((args?.limit as number) || 100, 500);
  const offset = Math.max((args?.offset as number) || 0, 0);
  const conditionId = args?.conditionId as string | undefined;
  const side = args?.side as string | undefined;
  const types = Array.isArray(args?.types)
    ? (args?.types as unknown[]).filter((value): value is string => typeof value === "string")
    : [];

  if (!address) {
    return errorResult("address is required");
  }

  const params = new URLSearchParams({
    user: address,
    limit: String(limit),
    offset: String(offset),
  });
  if (conditionId) {
    params.set("market", conditionId);
  }
  if (side) {
    params.set("side", side);
  }
  if (types.length > 0) {
    params.set("type", types.join(","));
  }

  try {
    const activity = (await fetchDataApi(`/activity?${params.toString()}`)) as DataApiActivity[];
    const normalized = Array.isArray(activity) ? activity : [];

    let buyCount = 0;
    let sellCount = 0;
    let totalUsdcFlow = 0;
    const byType: Record<string, number> = {};

    const formatted = normalized.map((entry) => {
      const entryType = (entry.type || "UNKNOWN").toUpperCase();
      const entrySide = (entry.side || "").toUpperCase();
      const usdcSize = Number(entry.usdcSize || 0);
      const size = Number(entry.size || 0);
      const price = Number(entry.price || 0);

      byType[entryType] = (byType[entryType] ?? 0) + 1;
      if (entrySide === "BUY") buyCount += 1;
      if (entrySide === "SELL") sellCount += 1;
      totalUsdcFlow += Number.isFinite(usdcSize) ? usdcSize : 0;

      return {
        timestamp: entry.timestamp
          ? new Date(Number(entry.timestamp) * 1000).toISOString()
          : "",
        type: entryType,
        side: entrySide || undefined,
        conditionId: entry.conditionId || "",
        marketTitle: entry.title || "",
        outcome: entry.outcome || "",
        size: Number.isFinite(size) ? Number(size.toFixed(4)) : 0,
        usdcSize: Number.isFinite(usdcSize) ? Number(usdcSize.toFixed(2)) : 0,
        price: Number.isFinite(price) ? Number(price.toFixed(4)) : 0,
        transactionHash: entry.transactionHash || "",
      };
    });

    return successResult({
      address,
      activity: formatted,
      summary: {
        total: formatted.length,
        buyCount,
        sellCount,
        totalUsdcFlow: Number(totalUsdcFlow.toFixed(2)),
        byType,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to fetch user activity: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function handleGetUserTotalValue(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const address = (args?.address as string) || "";
  const conditionIds = Array.isArray(args?.conditionIds)
    ? (args?.conditionIds as unknown[]).filter(
        (value): value is string => typeof value === "string" && value.length > 0
      )
    : [];

  if (!address) {
    return errorResult("address is required");
  }

  const params = new URLSearchParams({ user: address });
  if (conditionIds.length > 0) {
    params.set("market", conditionIds.join(","));
  }

  try {
    const valueResponse = (await fetchDataApi(`/value?${params.toString()}`)) as DataApiValue[];
    const rows = Array.isArray(valueResponse) ? valueResponse : [];
    const first = rows[0];
    const totalValue = Number(first?.value || 0);

    return successResult({
      address,
      totalValue: Number.isFinite(totalValue) ? Number(totalValue.toFixed(2)) : 0,
      conditionIds,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to fetch total user value: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function handleGetMarketOpenInterest(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string | undefined;
  const conditionIds = Array.isArray(args?.conditionIds)
    ? (args?.conditionIds as unknown[]).filter(
        (value): value is string => typeof value === "string" && value.length > 0
      )
    : [];

  const mergedConditionIds = [
    ...(conditionId ? [conditionId] : []),
    ...conditionIds,
  ];
  const uniqueConditionIds = Array.from(new Set(mergedConditionIds));

  if (uniqueConditionIds.length === 0) {
    return errorResult("Provide conditionId or conditionIds");
  }

  try {
    const oiResponse = (await fetchDataApi(
      `/oi?market=${encodeURIComponent(uniqueConditionIds.join(","))}`
    )) as DataApiOpenInterest[];
    const rows = Array.isArray(oiResponse) ? oiResponse : [];
    const openInterest = rows.map((row) => ({
      conditionId: row.market || "",
      value: Number(row.value || 0),
    }));
    const totalOpenInterest = openInterest.reduce(
      (sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0),
      0
    );

    return successResult({
      openInterest,
      totalOpenInterest: Number(totalOpenInterest.toFixed(2)),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to fetch open interest: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function handleGetEventLiveVolume(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const eventId = args?.eventId as number;
  if (!eventId || !Number.isFinite(eventId)) {
    return errorResult("eventId is required");
  }

  try {
    const liveVolumeResponse = (await fetchDataApi(
      `/live-volume?id=${eventId}`
    )) as DataApiLiveVolume[] | DataApiLiveVolume;
    const first = Array.isArray(liveVolumeResponse)
      ? liveVolumeResponse[0]
      : liveVolumeResponse;

    const markets = Array.isArray(first?.markets)
      ? first.markets.map((row) => ({
          market: row.market || "",
          value: Number(row.value || 0),
        }))
      : [];
    const total = Number(first?.total || 0);

    return successResult({
      eventId,
      total: Number.isFinite(total) ? Number(total.toFixed(2)) : 0,
      markets,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to fetch live event volume: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function handleGetTopHolders(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const conditionId = args?.conditionId as string;
  const outcome = (args?.outcome as string) || "BOTH";
  // User-requested limit (we can return more than 20 via multi-tier fetching)
  const requestedLimit = (args?.limit as number) || 50;
  // Whether to use deep fetching (multiple API calls with different minBalance tiers)
  const deepFetch = args?.deepFetch !== false; // Default to true for thorough results
  const upstreamTimeoutProfile: UpstreamTimeoutProfile = deepFetch
    ? "heavy"
    : "default";

  if (!conditionId) {
    return errorResult("conditionId is required");
  }

  try {
    // Use the PROPER Data API /holders endpoint for accurate top holders
    // Docs: https://docs.polymarket.com/api-reference/core/get-top-holders-for-markets
    // 
    // WORKAROUND FOR API LIMITATION:
    // Polymarket's /holders API caps at 20 results per call with NO pagination.
    // To get more holders, we make multiple calls with different minBalance thresholds
    // and deduplicate the results. This can give us 60-80+ unique holders.
    
    type HolderData = {
      proxyWallet?: string;
      bio?: string;
      asset?: string;
      pseudonym?: string;
      amount?: number;
      displayUsernamePublic?: boolean;
      outcomeIndex?: number;
      name?: string;
      profileImage?: string;
      profileImageOptimized?: string;
    };
    
    type MetaHolder = {
      token: string;
      holders: HolderData[];
    };

    // Get current prices and token IDs first
    let yesPrice = 0.5;
    let noPrice = 0.5;
    let yesTokenId = "";
    let noTokenId = "";
    
    try {
      const market = (await fetchClob(
        `/markets/${conditionId}`,
        undefined,
        upstreamTimeoutProfile
      )) as ClobMarket;
      const tokens = market?.tokens;
      if (tokens && tokens.length >= 2) {
        yesTokenId = tokens[0].token_id;
        noTokenId = tokens[1].token_id;
        const pricesResp = (await fetchClobPost(
          "/prices",
          [
            { token_id: tokens[0].token_id, side: "BUY" },
            { token_id: tokens[1].token_id, side: "BUY" },
          ],
          upstreamTimeoutProfile
        )) as Record<string, { BUY?: string } | string>;

        const yesData = pricesResp[tokens[0].token_id];
        const noData = pricesResp[tokens[1].token_id];
        if (yesData) yesPrice = typeof yesData === "object" && yesData.BUY ? Number(yesData.BUY) : Number(yesData);
        if (noData) noPrice = typeof noData === "object" && noData.BUY ? Number(noData.BUY) : Number(noData);
      }
    } catch {
      // Use defaults
    }

    // Multi-tier minBalance thresholds for deep fetching.
    // Each tier gets up to 20 holders, and we deduplicate by address.
    // The tool description instructs AI clients to call this ALONE (not in parallel)
    // when using deepFetch=true to avoid MCP transport timeouts.
    const minBalanceTiers = deepFetch 
      ? [1000000, 100000, 10000, 5000, 2000, 1000, 500, 100, 10, 1] // Deep: 10 tiers for full spectrum (whales → small)
      : [1]; // Shallow: just one call
    
    // Maps to deduplicate holders by address
    const yesHoldersMap = new Map<string, { address: string; size: number; name?: string; profileImage?: string }>();
    const noHoldersMap = new Map<string, { address: string; size: number; name?: string; profileImage?: string }>();

    // Fetch holders in paced batches to avoid bursty upstream throttling.
    const tierResults: MetaHolder[][] = [];
    const tierBatchSize = deepFetch ? 3 : 1;

    for (let i = 0; i < minBalanceTiers.length; i += tierBatchSize) {
      const tierBatch = minBalanceTiers.slice(i, i + tierBatchSize);
      const batchResults = await Promise.all(
        tierBatch.map((minBal) =>
          (fetchDataApi(
            `/holders?market=${conditionId}&limit=20&minBalance=${minBal}`,
            upstreamTimeoutProfile
          ) as Promise<MetaHolder[]>).catch(() => [] as MetaHolder[])
        )
      );
      tierResults.push(...batchResults);

      if (deepFetch && i + tierBatchSize < minBalanceTiers.length) {
        await sleep(120);
      }
    }
    
    // Process all tier results
    for (const holdersResponse of tierResults) {
      if (!Array.isArray(holdersResponse)) continue;
      
      for (const tokenHolders of holdersResponse as MetaHolder[]) {
        const isYesToken = tokenHolders.token === yesTokenId || 
                          (tokenHolders.holders?.[0]?.outcomeIndex === 0);
        const isNoToken = tokenHolders.token === noTokenId || 
                         (tokenHolders.holders?.[0]?.outcomeIndex === 1);
        
        for (const h of (tokenHolders.holders || [])) {
          const address = h.proxyWallet || "";
          if (!address) continue;
          
          const holderData = {
            address,
            size: Number(h.amount || 0),
            name: h.name || h.pseudonym || undefined,
            profileImage: h.profileImageOptimized || h.profileImage || undefined,
          };
          
          // Deduplicate: keep the entry with the largest size (most accurate)
          if (isYesToken || h.outcomeIndex === 0) {
            const existing = yesHoldersMap.get(address);
            if (!existing || holderData.size > existing.size) {
              yesHoldersMap.set(address, holderData);
            }
          } else if (isNoToken || h.outcomeIndex === 1) {
            const existing = noHoldersMap.get(address);
            if (!existing || holderData.size > existing.size) {
              noHoldersMap.set(address, holderData);
            }
          }
        }
      }
    }

    // Convert maps to arrays and sort by size descending
    const yesHolders = Array.from(yesHoldersMap.values()).sort((a, b) => b.size - a.size);
    const noHolders = Array.from(noHoldersMap.values()).sort((a, b) => b.size - a.size);

    // Calculate totals for percentages
    const totalYes = yesHolders.reduce((sum, p) => sum + p.size, 0);
    const totalNo = noHolders.reduce((sum, p) => sum + p.size, 0);

    const formatHolders = (
      holders: Array<{ address: string; size: number; name?: string; profileImage?: string }>, 
      total: number, 
      price: number
    ) => {
      return holders
        .slice(0, requestedLimit)
        .map((p, idx) => {
          const value = p.size * price;
          return {
            rank: idx + 1,
            address: p.address,
            name: p.name || undefined,
            profileImage: p.profileImage || undefined,
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
    
    // Track how many unique holders we found
    const totalUniqueHolders = yesHolders.length + noHolders.length;

    // Get market title - use direct Gamma /markets?condition_ids= lookup instead of
    // brute-force searching through 50 events (which was adding 5-10s to response time)
    let marketTitle = conditionId;
    try {
      const markets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 5000)) as GammaMarket[];
      if (Array.isArray(markets) && markets.length > 0) {
        marketTitle = markets[0].question || conditionId;
      }
    } catch {
      // Use conditionId as title
    }

    return successResult({
      market: marketTitle,
      conditionId,
      topHolders: { yes: topYes, no: topNo },
      totalUniqueHolders,
      holdersReturned: { yes: topYes.length, no: topNo.length },
      concentration: {
        top10YesPercent: Number(top10YesPercent.toFixed(2)),
        top10NoPercent: Number(top10NoPercent.toFixed(2)),
        whaleCount,
      },
      fetchMethod: deepFetch
        ? "multi-tier (10 API calls in paced batches with minBalance thresholds from $1M to $1)"
        : "single-call",
      note: deepFetch 
        ? `Deep fetch found ${totalUniqueHolders} unique holders by querying 10 position tiers (from $1M ultra-whales to $1 positions). Polymarket API caps at 20 per call with no pagination, so we query [$1M, $100k, $10k, $5k, $2k, $1k, $500, $100, $10, $1] thresholds in paced batches and deduplicate.`
        : "Single API call (limit 20 per side). Use deepFetch=true for more thorough results.",
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
    const event = (await fetchGamma(`/events/slug/${slug}`)) as GammaEvent;
    const eventId = Number(event?.id || 0);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      return successResult({
        event: event?.title || slug,
        comments: [],
        totalComments: 0,
        note: "Event found but no numeric event id available for comments query",
        fetchedAt: new Date().toISOString(),
      });
    }

    const comments = (await fetchGamma(
      `/comments?parent_entity_type=Event&parent_entity_id=${eventId}&limit=${limit}&order=createdAt&ascending=false`
    )) as GammaComment[];

    const normalized = Array.isArray(comments) ? comments : [];
    const formattedComments = normalized.map((comment) => ({
      id: comment.id || "",
      author:
        comment.profile?.pseudonym ||
        comment.profile?.name ||
        comment.userAddress ||
        comment.author ||
        "anonymous",
      content: comment.body || comment.content || comment.text || "",
      createdAt: comment.createdAt || comment.timestamp || "",
      likes: Number(comment.reactionCount || comment.likes || comment.upvotes || 0),
    }));

    return successResult({
      event: event?.title || slug,
      comments: formattedComments,
      totalComments: formattedComments.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch {
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
    
    // IMPORTANT: The Gamma API's ?category= parameter is BROKEN and returns wrong results.
    // Instead, we fetch more events and filter CLIENT-SIDE by checking the tags array.
    // Each event has a tags[] array with objects like {slug: "politics", label: "Politics"}
    const fetchLimit = limit * 10; // Fetch more to ensure enough matches after filtering
    const events = await fetchGamma(
      `/events?closed=${closed}&limit=${fetchLimit}&order=${orderField}&ascending=false`
    ) as GammaEvent[];

    // Normalize category for matching (lowercase, handle common aliases)
    const categoryLower = category.toLowerCase();
    const categoryAliases: Record<string, string[]> = {
      'politics': ['politics', 'elections', 'political'],
      'sports': ['sports', 'nfl', 'nba', 'mlb', 'soccer', 'football', 'basketball', 'baseball'],
      'crypto': ['crypto', 'bitcoin', 'ethereum', 'cryptocurrency'],
      'pop-culture': ['pop-culture', 'culture', 'movies', 'entertainment', 'hollywood'],
      'science': ['science', 'tech', 'technology'],
      'business': ['business', 'economics', 'finance'],
    };
    const matchingSlugs = categoryAliases[categoryLower] || [categoryLower];

    // Filter events by checking if any tag matches the requested category
    const filteredEvents = (events || []).filter((e) => {
      if (!e.tags || !Array.isArray(e.tags)) return false;
      return e.tags.some((tag: { slug?: string; label?: string }) => {
        const tagSlug = (tag.slug || '').toLowerCase();
        const tagLabel = (tag.label || '').toLowerCase();
        return matchingSlugs.some(s => tagSlug === s || tagLabel === s || tagSlug.includes(s) || tagLabel.includes(s));
      });
    });

    const formatted = filteredEvents
      .filter((e) => e.slug)
      .slice(0, limit) // Apply limit after filtering
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
  const marketQuery = args?.marketQuery as string | undefined;

  if (!conditionId && !slug && !marketQuery) {
    return errorResult("Provide one of: conditionId, slug, or marketQuery");
  }

  const resolved = await resolveMarketReference({
    conditionId,
    slug,
    marketQuery,
  });
  if (!resolved?.conditionId) {
    return errorResult(
      marketQuery
        ? `Could not resolve marketQuery '${marketQuery}' to a market conditionId (searched active and resolved markets). Try adding a date or a more specific title.`
        : "Could not resolve conditionId from provided inputs"
    );
  }
  const resolvedConditionId = resolved.conditionId;
  let marketTitle = resolved.marketTitle;

  // Get top holders using the raw data handler with deep fetching enabled
  const holdersResult = await handleGetTopHolders({ conditionId: resolvedConditionId, outcome: "BOTH", limit: 50, deepFetch: true });
  if (holdersResult.isError) {
    return holdersResult;
  }

  const holdersData = JSON.parse((holdersResult.content[0] as { text: string }).text);

  // Get current market price
  let currentPrice = 0.5;
  let noPrice = 0.5;
  try {
    const market = (await fetchClob(
      `/markets/${resolvedConditionId}`,
      undefined,
      "heavy"
    )) as ClobMarket;
    const tokens = market?.tokens;
    if (tokens && tokens.length >= 2) {
      const pricesResp = (await fetchClobPost(
        "/prices",
        [
          { token_id: tokens[0].token_id, side: "BUY" },
          { token_id: tokens[1].token_id, side: "BUY" },
        ],
        "heavy"
      )) as Record<string, { BUY?: string } | string>;

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

  // Check if market is near-resolved (limited whale activity expected)
  const isNearResolved = currentPrice > 0.95 || currentPrice < 0.05;
  const nearResolvedWarning = isNearResolved
    ? `⚠️ Market is ${(currentPrice * 100).toFixed(1)}% YES - near-resolved. Position values appear small because most trading has concluded. For meaningful whale analysis, consider markets with prices between 10-90%.`
    : null;

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
    nearResolvedWarning,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleAnalyzeEventWhaleBreakdown(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const slug = args?.slug as string;
  const maxOutcomes = Math.min((args?.maxOutcomes as number) || 10, 20);

  if (!slug) {
    return errorResult("slug is required - provide the event slug (e.g., '2026-mens-australian-open-winner')");
  }

  try {
    // Fetch the event with all its markets
    const event = (await fetchGamma(`/events/slug/${slug}`, "heavy")) as GammaEvent;
    
    if (!event) {
      return errorResult(`Event not found: ${slug}`);
    }

    const markets = event.markets || [];
    if (markets.length === 0) {
      return errorResult(`Event has no markets: ${slug}`);
    }

    const eventTitle = event.title || slug;
    const totalMarketsInEvent = markets.length;

    // Sort markets by volume/liquidity to prioritize the most active ones
    const sortedMarkets = [...markets].sort((a, b) => {
      const volA = Number(a.volume24hr || a.volume || 0);
      const volB = Number(b.volume24hr || b.volume || 0);
      return volB - volA;
    });

    // Analyze top N markets
    const marketsToAnalyze = sortedMarkets.slice(0, maxOutcomes);

    // Fetch holders for each market in parallel (with rate limiting)
    const whaleResults: Array<{
      outcome: string;
      conditionId: string;
      currentPrice: number;
      totalWhaleValue: number;
      topWhalePosition: number;
      whaleCount: number;
    }> = [];

    // Process in batches of 3 to avoid overwhelming the API
    const batchSize = 3;
    for (let i = 0; i < marketsToAnalyze.length; i += batchSize) {
      const batch = marketsToAnalyze.slice(i, i + batchSize);
      
      const batchPromises = batch.map(async (market) => {
        const conditionId = market.conditionId;
        if (!conditionId) return null;

        // Extract outcome name from market question
        // e.g., "Will Sinner win?" -> "Sinner" or just use the question
        let outcomeName = market.question || market.groupItemTitle || "Unknown";
        // Try to extract just the subject name
        const willMatch = outcomeName.match(/Will (.+?) win/i);
        if (willMatch) {
          outcomeName = willMatch[1];
        }

        try {
          // Get top holders with deep fetch enabled
          const holdersResult = await handleGetTopHolders({ 
            conditionId, 
            outcome: "YES", // Focus on YES side for multi-outcome markets
            limit: 20, 
            deepFetch: true 
          });
          
          if (holdersResult.isError) {
            return null;
          }

          const holdersData = JSON.parse((holdersResult.content[0] as { text: string }).text);
          
          // Calculate whale metrics for YES positions
          const yesHolders = holdersData.topHolders?.yes || [];
          const totalWhaleValue = yesHolders.reduce((sum: number, h: { value: number }) => sum + (h.value || 0), 0);
          const topWhalePosition = yesHolders[0]?.value || 0;
          const whaleCount = yesHolders.filter((h: { value: number }) => h.value > 1000).length;

          // Get current price
          let currentPrice = 0.5;
          try {
            const clobMarket = (await fetchClob(
              `/markets/${conditionId}`,
              undefined,
              "heavy"
            )) as ClobMarket;
            const tokens = clobMarket?.tokens;
            if (tokens && tokens.length >= 1) {
              const pricesResp = (await fetchClobPost(
                "/prices",
                [{ token_id: tokens[0].token_id, side: "BUY" }],
                "heavy"
              )) as Record<string, { BUY?: string } | string>;
              const yesData = pricesResp[tokens[0].token_id];
              if (yesData) currentPrice = typeof yesData === "object" && yesData.BUY ? Number(yesData.BUY) : Number(yesData);
            }
          } catch {
            // Try to use outcomePrices from gamma
            if (market.outcomePrices) {
              try {
                const prices = JSON.parse(market.outcomePrices as string);
                if (prices[0]) currentPrice = Number(prices[0]);
              } catch {
                // Use default
              }
            }
          }

          return {
            outcome: outcomeName,
            conditionId,
            currentPrice,
            totalWhaleValue,
            topWhalePosition,
            whaleCount,
          };
        } catch {
          return null;
        }
      });

      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        if (result) {
          whaleResults.push(result);
        }
      }

      // Small delay between batches to respect rate limits
      if (i + batchSize < marketsToAnalyze.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Sort by total whale value descending
    whaleResults.sort((a, b) => b.totalWhaleValue - a.totalWhaleValue);

    // Format the results with ranks
    const whalesByOutcome = whaleResults.map((r, idx) => {
      let convictionLevel: "extreme" | "high" | "moderate" | "low";
      if (r.totalWhaleValue > 50000) convictionLevel = "extreme";
      else if (r.totalWhaleValue > 10000) convictionLevel = "high";
      else if (r.totalWhaleValue > 1000) convictionLevel = "moderate";
      else convictionLevel = "low";

      return {
        rank: idx + 1,
        outcome: r.outcome,
        conditionId: r.conditionId,
        currentPrice: Number(r.currentPrice.toFixed(4)),
        totalWhaleValue: Number(r.totalWhaleValue.toFixed(2)),
        topWhalePosition: Number(r.topWhalePosition.toFixed(2)),
        whaleCount: r.whaleCount,
        convictionLevel,
      };
    });

    // Determine top whale outcome
    const topOutcome = whalesByOutcome[0];
    const secondOutcome = whalesByOutcome[1];
    
    let confidence: "high" | "medium" | "low" = "low";
    if (topOutcome && secondOutcome) {
      if (topOutcome.totalWhaleValue > secondOutcome.totalWhaleValue * 2) {
        confidence = "high";
      } else if (topOutcome.totalWhaleValue > secondOutcome.totalWhaleValue * 1.3) {
        confidence = "medium";
      }
    } else if (topOutcome && topOutcome.totalWhaleValue > 10000) {
      confidence = "medium";
    }

    // Generate smart money consensus
    let smartMoneyConsensus: string;
    if (!topOutcome || topOutcome.totalWhaleValue < 1000) {
      smartMoneyConsensus = "No significant whale positions detected across outcomes. Market may be too new or lack smart money interest.";
    } else if (confidence === "high") {
      smartMoneyConsensus = `Strong whale consensus on "${topOutcome.outcome}" with $${topOutcome.totalWhaleValue.toFixed(0)} in positions (${topOutcome.whaleCount} whales). This is ${(topOutcome.totalWhaleValue / (secondOutcome?.totalWhaleValue || 1)).toFixed(1)}x the next closest outcome.`;
    } else if (confidence === "medium") {
      smartMoneyConsensus = `Moderate whale preference for "${topOutcome.outcome}" ($${topOutcome.totalWhaleValue.toFixed(0)}) over "${secondOutcome?.outcome || 'others'}" ($${secondOutcome?.totalWhaleValue.toFixed(0) || 0}). Not a strong consensus.`;
    } else {
      smartMoneyConsensus = `Whale positions spread across multiple outcomes. "${topOutcome.outcome}" has slight edge ($${topOutcome.totalWhaleValue.toFixed(0)}) but no clear smart money consensus.`;
    }

    return successResult({
      eventTitle,
      eventSlug: slug,
      totalMarketsInEvent,
      totalMarketsAnalyzed: whaleResults.length,
      whalesByOutcome,
      topWhaleOutcome: topOutcome ? {
        outcome: topOutcome.outcome,
        totalValue: topOutcome.totalWhaleValue,
        confidence,
      } : null,
      smartMoneyConsensus,
      note: `Analyzed ${whaleResults.length} of ${totalMarketsInEvent} markets. Whale positions show YES bets on each outcome - the outcome with most whale money suggests smart money's pick.`,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to analyze event whale breakdown: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
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

interface DataApiActivity {
  proxyWallet?: string;
  timestamp?: string | number;
  conditionId?: string;
  type?: string;
  size?: string | number;
  usdcSize?: string | number;
  transactionHash?: string;
  price?: string | number;
  asset?: string;
  side?: string;
  outcomeIndex?: number;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcome?: string;
}

interface DataApiValue {
  user?: string;
  value?: string | number;
}

interface DataApiOpenInterest {
  market?: string;
  value?: string | number;
}

interface DataApiLiveVolume {
  total?: string | number;
  markets?: Array<{
    market?: string;
    value?: string | number;
  }>;
}

interface GammaComment {
  id?: string;
  body?: string;
  userAddress?: string;
  author?: string;
  profile?: {
    name?: string;
    pseudonym?: string;
  };
  content?: string;
  text?: string;
  createdAt?: string;
  timestamp?: string;
  reactionCount?: number;
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
  slug?: string; // Market slug for URL construction - returned by /markets endpoint
  groupItemTitle?: string; // For multi-outcome events, the specific outcome name (e.g., "Gavin Newsom")
  outcomePrices?: string[] | string; // API may return JSON string
  volume?: number | string; // Can be number or string from API
  volume24hr?: number;
  liquidity?: number;
  clobTokenIds?: string[] | string; // API may return JSON string
  tokens?: Array<{ token_id: string }>;
  // Market status fields - used to filter out resolved/closed outcomes
  closed?: boolean;
  active?: boolean;
  acceptingOrders?: boolean;
  umaResolutionStatus?: string; // 'proposed', 'resolved', etc.
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
const allowUnauthenticatedMcp =
  process.env.POLYMARKET_ALLOW_UNAUTH_MCP === "true";
const mcpAuthMiddleware = allowUnauthenticatedMcp
  ? (_req: Request, _res: Response, next: NextFunction) => {
      next();
    }
  : verifyContextAuth;

if (allowUnauthenticatedMcp) {
  console.warn(
    "[polymarket-auth] POLYMARKET_ALLOW_UNAUTH_MCP=true (auth disabled for /mcp; use only for temporary debugging)."
  );
}

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "polymarket-intelligence",
    version: "1.0.0",
    contextAuthEnabled: !allowUnauthenticatedMcp,
    mcpAuthBypassEnabled: allowUnauthenticatedMcp,
    tools: TOOLS_WITH_METADATA.map((t) => t.name),
    description: "Polymarket Intelligence MCP - Whale cost, market efficiency, smart money tracking",
  });
});

// ============================================================================
// STREAMABLE HTTP TRANSPORT (/mcp)
// ============================================================================

app.post("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id: string) => {
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

app.get("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.delete("/mcp", mcpAuthMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

app.get("/debug-tools", (_req: Request, res: Response) => {
  const analyzePos = TOOLS_WITH_METADATA.find((t) => t.name === "analyze_my_positions");
  const toolMeta =
    analyzePos?._meta && typeof analyzePos._meta === "object"
      ? (analyzePos._meta as Record<string, unknown>)
      : undefined;
  res.json({
    name: analyzePos?.name,
    _meta: toolMeta,
    contextRequirements:
      toolMeta && Array.isArray(toolMeta.contextRequirements)
        ? toolMeta.contextRequirements
        : [],
    inputSchemaKeys: Object.keys(analyzePos?.inputSchema || {}),
  });
});

const port = Number(process.env.PORT || 4003);
app.listen(port, () => {
  console.log("\n🎯 Polymarket Intelligence MCP Server v1.0.0");
  console.log("   Whale cost analysis • Market efficiency • Smart money tracking\n");
  console.log("[polymarket-config] startup", {
    retryAttempts: POLYMARKET_RETRY_ATTEMPTS,
    retryBaseBackoffMs: POLYMARKET_RETRY_BASE_BACKOFF_MS,
    upstreamRatePlans: UPSTREAM_RATE_PLANS,
    toolCount: TOOLS_WITH_METADATA.length,
  });
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health\n`);
  console.log(`🛠️  Available tools (${TOOLS_WITH_METADATA.length}):`);
  console.log("   INTELLIGENCE (12 tools):");
  for (const tool of TOOLS_WITH_METADATA.slice(0, 12)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("   RAW DATA (10 tools):");
  for (const tool of TOOLS_WITH_METADATA.slice(12)) {
    console.log(`   • ${tool.name}`);
  }
  console.log("");
});

