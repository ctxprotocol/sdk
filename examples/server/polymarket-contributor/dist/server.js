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
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";
const contributorSearchModuleSpecifiers = [
    "@ctxprotocol/sdk/contrib/search",
    import.meta.url.includes("/dist/")
        ? "../../../../dist/contrib/search/index.js"
        : "../../../dist/contrib/search/index.js",
];
async function loadContributorSearchModule() {
    let lastError = null;
    for (const specifier of contributorSearchModuleSpecifiers) {
        try {
            return (specifier.startsWith("@")
                ? await import(specifier)
                : await import(new URL(specifier, import.meta.url).href));
        }
        catch (error) {
            lastError = error;
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("Failed to load contributor search helper module.");
}
const { attachContributorSearchMetadata, createSearchIntent, resolveContributorSearch, } = await loadContributorSearchModule();
// ============================================================================
// API ENDPOINTS
// ============================================================================
const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";
const DATA_API_URL = "https://data-api.polymarket.com";
// Polymarket Data API `/holders` deep-scan knobs.
//
// The public docs (as of 2026-04) claim `limit` is capped at 20 with no
// pagination. Empirically the endpoint accepts `limit` up to 500 per call
// and returns the top N holders for each token sorted descending by share
// balance; anything above 500 is silently clamped. We therefore do a single
// `limit=500` call per market/outcome as the primary deep-scan strategy
// and fall back to the legacy `minBalance`-tier sweep only if the upstream
// ever regresses.
const DEEP_HOLDER_SCAN_LIMIT = 500;
const LEGACY_HOLDER_PAGE_SIZE = 20;
const SHALLOW_HOLDER_SCAN_LIMIT = 20;
const TRADE_SMALL_MAX_USD = 50;
const TRADE_MEDIUM_MAX_USD = 500;
const TRADE_WHALE_MIN_USD = 10_000;
const TRADE_SIZE_FILTER_MIN_USD = TRADE_MEDIUM_MAX_USD;
// Public Data API /trades is live-capped at 1,000 rows/page through offset
// 3,000. CLOB /trades has before/after cursor params, but requires auth and
// the public Data API ignores those params.
const TRADE_DATA_API_PAGE_LIMIT = 1_000;
const TRADE_DATA_API_MAX_OFFSET = 3_000;
const TRADE_DATA_API_MAX_ROWS = TRADE_DATA_API_MAX_OFFSET + TRADE_DATA_API_PAGE_LIMIT;
const HOLDER_LARGE_MIN_USD = 1_000;
const HOLDER_WHALE_MIN_USD = 10_000;
const HOLDER_WHALE_MIN_SUPPLY_PERCENT = 1;
const TRADE_COVERAGE_POLICIES = {
    quick: {
        pageSize: TRADE_DATA_API_PAGE_LIMIT,
        maxRows: TRADE_DATA_API_PAGE_LIMIT,
        maxRequests: 1,
        targetCoverageRatio: 0.3,
    },
    standard: {
        pageSize: TRADE_DATA_API_PAGE_LIMIT,
        maxRows: TRADE_DATA_API_MAX_ROWS,
        maxRequests: 4,
        targetCoverageRatio: 0.8,
    },
    deep: {
        pageSize: TRADE_DATA_API_PAGE_LIMIT,
        maxRows: TRADE_DATA_API_MAX_ROWS,
        maxRequests: 4,
        targetCoverageRatio: 0.9,
    },
};
function formatUsdThreshold(value) {
    return `$${value.toLocaleString("en-US")}`;
}
function isMeaningfulHolderWhale(positionValueUsd, percentOfSupply) {
    return (positionValueUsd >= HOLDER_WHALE_MIN_USD ||
        percentOfSupply >= HOLDER_WHALE_MIN_SUPPLY_PERCENT);
}
function getHolderConvictionScore(positionValueUsd, percentOfSupply) {
    if (positionValueUsd >= 100_000 || percentOfSupply >= 5) {
        return "extreme";
    }
    if (positionValueUsd >= 50_000 || percentOfSupply >= 2) {
        return "high";
    }
    if (isMeaningfulHolderWhale(positionValueUsd, percentOfSupply)) {
        return "moderate";
    }
    return "low";
}
function getConfiguredInteger(name, fallback, min, max) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(min, parsed));
}
function normalizeOptionalString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
const POLYMARKET_RETRY_ATTEMPTS = getConfiguredInteger("POLYMARKET_RETRY_ATTEMPTS", 3, 1, 5);
const POLYMARKET_RETRY_BASE_BACKOFF_MS = getConfiguredInteger("POLYMARKET_RETRY_BASE_BACKOFF_MS", 450, 100, 5_000);
const POLYMARKET_DEFAULT_EXECUTE_USD = process.env.POLYMARKET_DEFAULT_EXECUTE_USD?.trim() || "0.001";
const UPSTREAM_RATE_PLANS = {
    gamma: {
        maxRequestsPerMinute: getConfiguredInteger("POLYMARKET_GAMMA_RATE_LIMIT", 180, 1, 2_000),
        cooldownMs: 0,
    },
    clob: {
        maxRequestsPerMinute: getConfiguredInteger("POLYMARKET_CLOB_RATE_LIMIT", 240, 1, 2_000),
        cooldownMs: 0,
    },
    data: {
        maxRequestsPerMinute: getConfiguredInteger("POLYMARKET_DATA_RATE_LIMIT", 120, 1, 2_000),
        cooldownMs: 0,
    },
};
for (const plan of Object.values(UPSTREAM_RATE_PLANS)) {
    plan.cooldownMs = Math.ceil(60_000 / plan.maxRequestsPerMinute);
}
const nextAllowedRequestByUpstream = new Map();
const rateLockByUpstream = new Map();
const HEAVY_ANALYSIS_TOOLS = new Set([
    "analyze_top_holders",
    "analyze_event_whale_breakdown",
    "analyze_event_outcome_liquidity",
    "rank_event_tradability",
    "compare_market_against_related_contracts",
    "build_market_tradability_memo",
    "find_trading_opportunities",
    "find_moderate_probability_bets",
    "find_arbitrage_opportunities",
    "analyze_single_market_whales",
    "discover_trending_markets",
    "get_top_holders",
    "get_top_markets",
    "polymarket_crossref_kalshi",
    "build_high_conviction_workflow",
    "summarize_live_market_activity",
]);
const ANSWER_ONLY_TOOLS = new Set([
    "analyze_market_liquidity",
    "check_market_efficiency",
    "analyze_whale_flow",
    "analyze_top_holders",
    "analyze_single_market_whales",
    "summarize_live_market_activity",
    "analyze_event_whale_breakdown",
    "analyze_event_outcome_liquidity",
    "rank_event_tradability",
    "compare_event_outcome_quotes",
    "compare_market_against_related_contracts",
    "find_correlated_markets",
    "check_market_rules",
    "build_market_tradability_memo",
    "find_arbitrage_opportunities",
    "find_trading_opportunities",
    "build_high_conviction_workflow",
    "find_moderate_probability_bets",
    "get_bets_by_probability",
    "discover_trending_markets",
    "get_top_markets",
    "get_event_live_volume",
    "polymarket_crossref_kalshi",
    "analyze_my_positions",
    "place_polymarket_order",
]);
const UPSTREAM_TIMEOUT_MS = {
    default: 15_000,
    heavy: 45_000,
};
const UPSTREAM_GET_CACHE_TTL_MS = {
    gamma: 6_000,
    clob: 5_000,
    data: 6_000,
};
const DISCOVER_TRENDING_CACHE_TTL_MS = getConfiguredInteger("POLYMARKET_DISCOVER_TRENDING_CACHE_TTL_MS", 15_000, 0, 300_000);
const DISCOVER_TRENDING_STALE_IF_ERROR_TTL_MS = getConfiguredInteger("POLYMARKET_DISCOVER_TRENDING_STALE_IF_ERROR_TTL_MS", 180_000, 0, 900_000);
const ACTIVE_EVENT_SEARCH_INDEX_CACHE_TTL_MS = getConfiguredInteger("POLYMARKET_ACTIVE_EVENT_SEARCH_INDEX_CACHE_TTL_MS", 20_000, 1_000, 900_000);
const ACTIVE_EVENT_SEARCH_INDEX_STALE_IF_ERROR_TTL_MS = getConfiguredInteger("POLYMARKET_ACTIVE_EVENT_SEARCH_INDEX_STALE_IF_ERROR_TTL_MS", 300_000, 0, 3_600_000);
const ACTIVE_EVENT_SEARCH_INDEX_PAGE_SIZE = getConfiguredInteger("POLYMARKET_ACTIVE_EVENT_SEARCH_INDEX_PAGE_SIZE", 100, 20, 200);
const ACTIVE_EVENT_SEARCH_INDEX_MAX_PAGES = getConfiguredInteger("POLYMARKET_ACTIVE_EVENT_SEARCH_INDEX_MAX_PAGES", 2, 1, 6);
const WEBSITE_SEARCH_V2_PAGE_SIZE = getConfiguredInteger("POLYMARKET_WEBSITE_SEARCH_V2_PAGE_SIZE", 50, 10, 50);
const WEBSITE_SEARCH_V2_ACTIVE_MAX_PAGES = getConfiguredInteger("POLYMARKET_WEBSITE_SEARCH_V2_ACTIVE_MAX_PAGES", 2, 1, 4);
const WEBSITE_SEARCH_V2_CLOSED_MAX_PAGES = getConfiguredInteger("POLYMARKET_WEBSITE_SEARCH_V2_CLOSED_MAX_PAGES", 2, 1, 4);
const upstreamGetCache = new Map();
const discoverTrendingMarketsCache = new Map();
const BULK_FIRST_TOOLS = new Set([
    "find_moderate_probability_bets",
    "get_bets_by_probability",
    "discover_trending_markets",
    "get_top_markets",
    "search_and_get_outcomes",
    "search_markets",
    "get_event_outcomes",
    "get_batch_orderbooks",
]);
const TOOL_BATCH_HINTS = {
    analyze_top_holders: ["search_markets", "discover_trending_markets"],
    analyze_single_market_whales: ["get_top_markets"],
    analyze_event_whale_breakdown: ["discover_trending_markets"],
    analyze_event_outcome_liquidity: ["search_and_get_outcomes", "get_event_outcomes"],
    rank_event_tradability: [
        "analyze_event_outcome_liquidity",
        "analyze_event_whale_breakdown",
        "get_event_live_volume",
    ],
    compare_event_outcome_quotes: ["search_and_get_outcomes", "get_spreads"],
    compare_market_against_related_contracts: [
        "search_and_get_outcomes",
        "compare_event_outcome_quotes",
        "check_market_efficiency",
    ],
    build_market_tradability_memo: [
        "check_market_rules",
        "analyze_market_liquidity",
        "analyze_single_market_whales",
    ],
    search_and_get_outcomes: [
        "get_event_by_slug",
        "compare_event_outcome_quotes",
        "analyze_event_outcome_liquidity",
    ],
    search_markets: ["search_and_get_outcomes", "compare_event_outcome_quotes"],
    get_top_holders: ["search_markets", "discover_trending_markets"],
    find_trading_opportunities: ["find_moderate_probability_bets", "get_bets_by_probability"],
    get_event_outcomes: ["get_prices", "get_spreads", "get_orderbook", "get_batch_orderbooks"],
    get_event_by_slug: ["get_event_live_volume", "get_prices", "get_spreads", "get_orderbook"],
};
function resolveRateLimitNote(toolName, heavy) {
    if (toolName === "search_markets") {
        return "Discovery/listing primitive. Prefer search_and_get_outcomes for one event plus current outcomes/prices, and compare_event_outcome_quotes for named same-event outcome comparisons.";
    }
    if (toolName === "search_and_get_outcomes") {
        return "Composite query-first tool. Prefer this over chaining search_markets to get_event_outcomes when the user wants one resolved event with current outcomes/prices. If the result collapses to one exact outcome, reuse primaryTokenId/primaryConditionId directly instead of reranking outcomes.";
    }
    if (toolName === "compare_event_outcome_quotes") {
        return "Query-first comparison tool. Best for two or more named outcomes inside the same event after event resolution. If the prompt is asking whether one named contract looks rich or cheap versus sibling contracts, prefer compare_market_against_related_contracts.";
    }
    if (toolName === "get_event_by_slug") {
        return "Event detail primitive. Use when you already have a slug and may need event.id for get_event_live_volume or per-market token ids for quote/liquidity follow-ups.";
    }
    if (toolName === "get_event_outcomes") {
        return "Outcome breakdown primitive. Great for top-N outcome lists. For cross-outcome execution comparisons, prefer get_prices/get_spreads or get_orderbook with merged=true before declaring a tightest spread.";
    }
    if (toolName === "get_batch_orderbooks") {
        return "Raw direct-book batch snapshot only. Useful for bulk depth context, but do not rank tightest spreads across neg-risk outcomes; prefer get_prices/get_spreads or get_orderbook with merged=true for actionable comparisons.";
    }
    if (toolName === "get_event_live_volume") {
        return "Use after get_event_by_slug when you need live volume shares by submarket. If total is zero or markets is empty, report that the live breakdown is unavailable instead of inferring shares.";
    }
    return heavy
        ? "Heavy Polymarket workflow. Call this tool alone and prefer narrower scopes first."
        : "Prefer batch/snapshot tools before fan-out loops when possible.";
}
function buildToolRateLimitMetadata(toolName) {
    const heavy = HEAVY_ANALYSIS_TOOLS.has(toolName);
    return {
        maxRequestsPerMinute: heavy ? 60 : 120,
        maxConcurrency: 1,
        cooldownMs: heavy ? 1_500 : 500,
        supportsBulk: BULK_FIRST_TOOLS.has(toolName),
        recommendedBatchTools: TOOL_BATCH_HINTS[toolName] ?? [],
        notes: resolveRateLimitNote(toolName, heavy),
    };
}
function resolveToolSurface(toolName) {
    if (ANSWER_ONLY_TOOLS.has(toolName)) {
        return "answer";
    }
    return "both";
}
function resolveExecutePricingMeta(toolName, existingMeta) {
    const existingPricing = "pricing" in existingMeta &&
        typeof existingMeta.pricing === "object" &&
        existingMeta.pricing !== null
        ? { ...existingMeta.pricing }
        : {};
    const currentExecuteUsd = typeof existingPricing.executeUsd === "string"
        ? existingPricing.executeUsd.trim()
        : undefined;
    if (currentExecuteUsd) {
        existingPricing.executeUsd = currentExecuteUsd;
        return existingPricing;
    }
    if (resolveToolSurface(toolName) === "answer") {
        delete existingPricing.executeUsd;
        return Object.keys(existingPricing).length > 0 ? existingPricing : undefined;
    }
    existingPricing.executeUsd = POLYMARKET_DEFAULT_EXECUTE_USD;
    return existingPricing;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function resolveUpstreamTimeoutMs(timeoutMsOrProfile) {
    if (typeof timeoutMsOrProfile === "number") {
        return timeoutMsOrProfile;
    }
    return UPSTREAM_TIMEOUT_MS[timeoutMsOrProfile ?? "default"];
}
async function withUpstreamRateLock(upstream, work) {
    const previous = rateLockByUpstream.get(upstream) ?? Promise.resolve();
    let release = () => { };
    const current = new Promise((resolve) => {
        release = resolve;
    });
    rateLockByUpstream.set(upstream, previous.then(() => current));
    await previous;
    try {
        return await work();
    }
    finally {
        release();
        if (rateLockByUpstream.get(upstream) === current) {
            rateLockByUpstream.delete(upstream);
        }
    }
}
async function reserveRateSlot(upstream, endpoint) {
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
function parseRetryAfterMs(headers) {
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
function isRetryableStatus(status) {
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}
class UpstreamHttpError extends Error {
    status;
    retryable;
    constructor(params) {
        const { upstream, status, bodySnippet, retryable } = params;
        super(`${upstream.toUpperCase()} API error (${status}): ${bodySnippet}`);
        this.name = "UpstreamHttpError";
        this.status = status;
        this.retryable = retryable;
    }
}
function computeBackoffMs(attempt) {
    const exponential = POLYMARKET_RETRY_BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = Math.floor(Math.random() * 200);
    return exponential + jitter;
}
function cloneCachedPayload(value) {
    if (typeof structuredClone === "function") {
        return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
}
function getDiscoverTrendingCacheKey(params) {
    return JSON.stringify({
        v: 2,
        category: params.category?.trim().toLowerCase() || "",
        sortBy: params.sortBy,
        limit: params.limit,
    });
}
function readDiscoverTrendingCachedPayload(cacheKey, options) {
    const cached = discoverTrendingMarketsCache.get(cacheKey);
    if (!cached) {
        return null;
    }
    const now = Date.now();
    if (cached.expiresAt > now) {
        return cloneCachedPayload(cached.value);
    }
    if (options?.allowStaleOnError && cached.staleIfErrorUntil > now) {
        return cloneCachedPayload(cached.value);
    }
    if (cached.staleIfErrorUntil <= now) {
        discoverTrendingMarketsCache.delete(cacheKey);
    }
    return null;
}
function writeDiscoverTrendingCachedPayload(cacheKey, value) {
    const now = Date.now();
    discoverTrendingMarketsCache.set(cacheKey, {
        value: cloneCachedPayload(value),
        expiresAt: now + DISCOVER_TRENDING_CACHE_TTL_MS,
        staleIfErrorUntil: now + DISCOVER_TRENDING_STALE_IF_ERROR_TTL_MS,
    });
}
async function fetchJsonWithPolicy(options) {
    const { upstream, endpoint, init } = options;
    const timeoutMs = resolveUpstreamTimeoutMs(options.timeoutMs);
    const maxAttempts = typeof options.maxAttempts === "number" &&
        Number.isFinite(options.maxAttempts) &&
        options.maxAttempts >= 1
        ? Math.floor(options.maxAttempts)
        : POLYMARKET_RETRY_ATTEMPTS;
    const baseUrl = upstream === "gamma"
        ? GAMMA_API_URL
        : upstream === "clob"
            ? CLOB_API_URL
            : DATA_API_URL;
    const url = `${baseUrl}${endpoint}`;
    const method = init?.method?.toUpperCase() ?? "GET";
    const cacheKey = method === "GET" && !init?.body ? `${upstream}:${url}` : null;
    if (cacheKey) {
        const cached = upstreamGetCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return cloneCachedPayload(cached.value);
        }
        if (cached) {
            upstreamGetCache.delete(cacheKey);
        }
    }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await reserveRateSlot(upstream, endpoint);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, {
                ...init,
                signal: controller.signal,
            });
            if (response.ok) {
                const payload = await response.json();
                if (cacheKey) {
                    upstreamGetCache.set(cacheKey, {
                        value: cloneCachedPayload(payload),
                        expiresAt: Date.now() + UPSTREAM_GET_CACHE_TTL_MS[upstream],
                    });
                }
                return payload;
            }
            const responseText = await response.text();
            const retryAfterMs = parseRetryAfterMs(response.headers);
            const retryable = isRetryableStatus(response.status);
            if (retryable && attempt < maxAttempts) {
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
        }
        catch (error) {
            const isAbortError = error instanceof Error && error.name === "AbortError";
            const isHttpError = error instanceof UpstreamHttpError;
            if (isHttpError && !error.retryable) {
                throw error;
            }
            const canRetry = attempt < maxAttempts;
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
                throw new Error(`${upstream.toUpperCase()} API timeout after ${timeoutMs}ms for ${endpoint}`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    }
    throw new Error(`${upstream.toUpperCase()} API failed after ${maxAttempts} attempts`);
}
function normalizeHeaders(headersInit) {
    if (!headersInit) {
        return {};
    }
    if (headersInit instanceof Headers) {
        const normalized = {};
        headersInit.forEach((value, key) => {
            normalized[key] = value;
        });
        return normalized;
    }
    if (Array.isArray(headersInit)) {
        const normalized = {};
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
// Collateral token decimals (USDC.e has 6 decimals)
const COLLATERAL_DECIMALS = 6;
const CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA = {
    type: "object",
    description: "Compact contributor search helper diagnostics, shortlist provenance, and judge metadata.",
};
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const POLYMARKET_SEARCH_JUDGE_API_KEY = normalizeOptionalString(process.env.POLYMARKET_OPENROUTER_API_KEY) ??
    normalizeOptionalString(process.env.OPENROUTER_API_KEY);
const POLYMARKET_SEARCH_JUDGE_MODEL = normalizeOptionalString(process.env.POLYMARKET_SEARCH_JUDGE_MODEL) ??
    "google/gemini-3.1-flash-lite-preview";
const POLYMARKET_SEARCH_JUDGE_DISABLE = process.env.POLYMARKET_DISABLE_SEARCH_JUDGE === "true";
const POLYMARKET_SEARCH_JUDGE_TIMEOUT_MS = getConfiguredInteger("POLYMARKET_SEARCH_JUDGE_TIMEOUT_MS", 4500, 250, 30000);
const POLYMARKET_SEARCH_JUDGE_MAX_SHORTLIST = getConfiguredInteger("POLYMARKET_SEARCH_JUDGE_MAX_SHORTLIST", 6, 1, 10);
const POLYMARKET_SEARCH_JUDGE_BUDGET_USD = normalizeOptionalString(process.env.POLYMARKET_SEARCH_JUDGE_BUDGET_USD) ??
    "0.010";
const POLYMARKET_SEARCH_JUDGE_REFERER = normalizeOptionalString(process.env.POLYMARKET_SEARCH_JUDGE_REFERER) ??
    "https://ctxprotocol.com";
const POLYMARKET_SEARCH_JUDGE_TITLE = normalizeOptionalString(process.env.POLYMARKET_SEARCH_JUDGE_TITLE) ??
    "Context Polymarket Contributor Search Judge";
const POLYMARKET_SEARCH_JUDGE_INSTRUCTIONS = "Select the single Polymarket market or event that best grounds the user's request. Prefer exact outcome/entity matching, exact venue scope, and precise resolution timing. Treat explicit dates, named expiries, price strikes, and threshold phrases (for example April 15 vs March 31, $200 HIGH vs $160 HIGH, or 50+ bps decrease vs no change) as identity-level constraints, not optional color. Keep broader macro proxies, adjacent escalation markets, and merely related outcomes in related or rejected buckets instead of promoting them to primary. Return a null primaryCandidateId when the shortlist remains genuinely ambiguous.";
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
        description: 'Analyze market liquidity and calculate "Whale Cost" for ONE specific outcome token - simulates the slippage for selling $1k, $5k, and $10k positions. Answers: "Can I exit this position if I put $X in?" Merges direct + synthetic liquidity from both YES and NO orderbooks for accurate depth.\n\n**SIZE-SPECIFIC SIMULATION:** When the user asks about a specific dollar size (e.g. "slippage for a $50,000 buy") or a specific side (buy vs sell), pass `positionSizeUsd` and optionally `side` ("buy" or "sell") to get a walk-the-book fill simulation at that exact size. The result will include `whaleCost.custom` with the avgPrice, worstPrice, slippagePercent, and canFill for that specific size/side. This is how you answer "estimate slippage for a $X buy/sell" questions accurately.\n\n**MARKET STATE (read this first when synthesising answers):** the response ALWAYS includes `marketState`, `marketStateSummary`, `isTradeable`, `marketSlug`, and `polymarketUrl`. If `marketState` is `closed_resolved`, the market has already settled — report the `winningOutcome` and the fact that exits happen via redeem/claim, NOT as "100% slippage / illiquid CLOB". If `marketState` is `closed_unresolved`, trading has ended and UMA settlement is pending. If `marketState` is `orderbook_disabled` / `not_accepting_orders` / `archived`, walk-the-book sizing is not meaningful and the summary explains why. Only when `marketState` is `tradeable` should slippage / depth numbers be quoted as live liquidity. Any link you produce to Polymarket MUST use `polymarketUrl` (or compose `https://polymarket.com/market/<marketSlug>`) verbatim — do not synthesise a slug from the question text, it will be a dead link.\n\nUse this when the user already means ONE named team/candidate/outcome or when you already have tokenId/conditionId. Do NOT use this as the first choice for event-level multi-outcome requests like "World Cup winner market" or "election market" when no specific outcome was named. For those categorical-market prompts, prefer analyze_event_outcome_liquidity.\n\nAccepts tokenId, conditionId, slug, or marketQuery. If you only know the single market by name, pass marketQuery and this tool will resolve the best live match first.\n\n⏱️ PERFORMANCE: Makes 3 CLOB API calls (~3-5s). Safe to call in parallel with 1-2 other lightweight tools, but avoid calling alongside find_trading_opportunities or analyze_top_holders.',
        inputSchema: {
            type: "object",
            properties: {
                tokenId: {
                    type: "string",
                    description: "The token ID (YES or NO outcome token) to analyze",
                },
                conditionId: {
                    type: "string",
                    description: "The market condition ID (alternative to tokenId)",
                },
                slug: {
                    type: "string",
                    description: "Event or market slug when you know the Polymarket URL slug",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language SINGLE-market reference (e.g. 'Will Trump win Pennsylvania?' or 'Fed decision in April'). For categorical event-level requests like 'World Cup winner market', prefer analyze_event_outcome_liquidity unless the exact outcome is named.",
                },
                positionSizeUsd: {
                    type: "number",
                    description: "Optional specific USD notional to simulate (e.g. 50000 for a $50k buy/sell). When provided, the tool walks the merged book and returns avgPrice, worstPrice, slippagePercent, and canFill under whaleCost.custom. Use this whenever the user asks about a specific dollar size.",
                },
                side: {
                    type: "string",
                    enum: ["buy", "sell"],
                    description: "Optional side for positionSizeUsd simulation. 'buy' walks the asks (YES buy). 'sell' walks the bids (YES sell / exit). Defaults to 'buy' when positionSizeUsd is set and side is not specified.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                market: { type: "string" },
                tokenId: { type: "string" },
                conditionId: { type: "string" },
                marketSlug: {
                    type: ["string", "null"],
                    description: "Canonical Polymarket market_slug for this contract. Use this for any user-facing URL instead of synthesizing one from the question.",
                },
                polymarketUrl: {
                    type: ["string", "null"],
                    description: "Real Polymarket URL for this market (https://polymarket.com/market/<market_slug>). Synthesis layers must use this value verbatim rather than guessing a slug from the question text.",
                },
                marketState: {
                    type: "string",
                    enum: [
                        "tradeable",
                        "orderbook_disabled",
                        "not_accepting_orders",
                        "closed_resolved",
                        "closed_unresolved",
                        "archived",
                        "unknown",
                    ],
                    description: "Classification of the market's state. 'closed_resolved' means the market has settled (winningOutcome will be set); 'closed_unresolved' means trading is over but UMA has not settled yet; 'archived' means the market is delisted; 'orderbook_disabled' / 'not_accepting_orders' mean the market is live but unmatchable right now; 'tradeable' means normal operation; 'unknown' means the /book endpoint was transiently unreachable.",
                },
                marketStateSummary: {
                    type: "string",
                    description: "Human-readable explanation of marketState. Answers should quote or paraphrase this instead of defaulting to a generic 'illiquid' framing when the real story is that the market has ended.",
                },
                isTradeable: { type: "boolean" },
                endDate: { type: ["string", "null"] },
                winningOutcome: {
                    type: ["string", "null"],
                    description: "For closed_resolved markets, the outcome that won ('Yes' or 'No' for binary markets).",
                },
                settlementPrices: {
                    type: "object",
                    description: "Final settled per-share prices for YES and NO tokens when the market has resolved (0/1 for binary resolutions). Null means no settlement recorded yet.",
                    properties: {
                        yes: { type: ["number", "null"] },
                        no: { type: ["number", "null"] },
                    },
                },
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
                    description: "Slippage simulation for different position sizes. When marketState is not 'tradeable', all fills are structurally zero because the orderbook is disabled — this is NOT an illiquid-book signal.",
                    properties: {
                        sell1k: { type: "object" },
                        sell5k: { type: "object" },
                        sell10k: { type: "object" },
                        custom: {
                            type: "object",
                            description: "Walk-the-book simulation for a caller-specified positionSizeUsd / side. Present only when positionSizeUsd was passed.",
                            properties: {
                                sizeUsd: { type: "number" },
                                side: { type: "string", enum: ["buy", "sell"] },
                                amountFilled: { type: "number" },
                                avgPrice: { type: "number" },
                                worstPrice: { type: "number" },
                                slippagePercent: { type: "number" },
                                canFill: { type: "boolean" },
                                referencePrice: { type: "number" },
                                estimatedShares: { type: "number" },
                            },
                        },
                    },
                },
                liquidityScore: {
                    type: "string",
                    enum: ["excellent", "good", "moderate", "poor", "illiquid"],
                },
                recommendation: { type: "string" },
                searchMetadata: CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA,
                fetchedAt: { type: "string" },
            },
            required: [
                "market",
                "tokenId",
                "currentPrice",
                "spread",
                "whaleCost",
                "liquidityScore",
                "marketState",
                "marketStateSummary",
                "isTradeable",
            ],
        },
    },
    {
        name: "check_market_efficiency",
        description: 'Check if a market is efficiently priced. Calculates the "vig" (sum of YES + NO prices), identifies if fees/spread are eating potential edge, and reports true implied probabilities. This is the direct tool for vig, spread, overround, and true-probability questions on a yes/no market. Accepts conditionId, slug, or marketQuery. If the user asks about "this market" without an identifier, the tool can fall back to the strongest live binary market candidate instead of returning a generic punt. Do not use holder or whale tools for efficiency questions.',
        inputSchema: {
            type: "object",
            properties: {
                conditionId: {
                    type: "string",
                    description: "The market condition ID (hex string starting with 0x). Works with IDs from discover_trending_markets or other tools.",
                },
                slug: {
                    type: "string",
                    description: "The event slug (e.g., 'will-trump-release-epstein-files-by'). Alternative to conditionId.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language market reference or the raw user request. Use when conditionId/slug is unknown or the prompt says 'this market'.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
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
                selectionReason: {
                    type: "string",
                    description: "How the tool chose the analyzed market when no explicit conditionId/slug was supplied.",
                },
                fetchedAt: { type: "string" },
            },
            required: ["conditionId", "outcomes", "marketEfficiency"],
        },
    },
    {
        name: "analyze_whale_flow",
        description: `Track recent trading activity by analyzing trade sizes. Buckets trades into Small (<${formatUsdThreshold(TRADE_SMALL_MAX_USD)}), Medium (${formatUsdThreshold(TRADE_SMALL_MAX_USD)}-${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}), Large (${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)}), and Whale (>=${formatUsdThreshold(TRADE_WHALE_MIN_USD)}), then calculates YES-directional flow and detects whale-vs-retail divergence.

⚠️ DIRECTIONAL SEMANTICS: Positive netFlow means buying YES / selling NO. Negative netFlow means selling YES / buying NO. NO-token trades are inverted into YES-equivalent direction before aggregation.

⚠️ IMPORTANT: This adaptively pages the public trades API up to the live public pagination cap (${TRADE_DATA_API_MAX_ROWS.toLocaleString("en-US")} rows observed from 1,000-row pages through offset 3,000). For whale/large-print analysis it also fetches a size-filtered public tape (${formatUsdThreshold(TRADE_SIZE_FILTER_MIN_USD)}+ notional) so scarce meaningful prints are not crowded out by tiny recent trades. tradeCoverage reports both raw and size-filtered coverage; full retail-vs-whale divergence still requires raw coverage, while whale-sized print claims can use complete size-filtered coverage.

⚠️ "Whale" here means a single trade at or above ${formatUsdThreshold(TRADE_WHALE_MIN_USD)}. Trades between ${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)} and ${formatUsdThreshold(TRADE_WHALE_MIN_USD)} are meaningful large prints, not necessarily whale activity. Use analyze_top_holders for actual large holder concentration.

USE THIS FOR: "Break down trading by size bucket", "Are whales buying or selling?", "Whale vs retail net flow", "Trading activity in the last 24h?", "What's happening RIGHT NOW?", "Trade size analysis", "Recent whale trades?"

⚠️ DO NOT use get_market_trades for size-bucket or whale-vs-retail analysis. get_market_trades returns raw individual trades without bucketing. THIS tool does the aggregation.

USE analyze_top_holders INSTEAD FOR: "Who are the biggest holders?", "What are whales betting on?", "Which side do smart money players favor?"`,
        inputSchema: {
            type: "object",
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
                    description: "Natural-language market reference (e.g., 'Fed rate decision'). Use when conditionId/slug is unknown.",
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
            type: "object",
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
                        large: {
                            type: "object",
                            description: "Trades $500-$10,000",
                        },
                        whale: {
                            type: "object",
                            description: "Trades >= $10,000",
                        },
                    },
                },
                sizeBucketDefinitions: {
                    type: "object",
                    description: "USD notional thresholds used to separate small, medium, large, and whale-sized trades.",
                },
                tradeSample: {
                    type: "object",
                    description: "Legacy alias for tradeCoverage. Includes sampled volume, Polymarket-reported 24h volume when available, and a warning when coverage is incomplete.",
                },
                tradeCoverage: {
                    type: "object",
                    description: "Coverage contract for the public trades window: pages fetched, rows analyzed, sampled/reported 24h volume ratio, coverageLevel, and whether directional/whale claims are supported.",
                },
                buyerGuidance: {
                    type: "object",
                    description: "Plain-English interpretation guardrails for buyer-facing answers: how to describe large prints vs whale prints, holder whales vs trade-size buckets, and coverage caveats.",
                },
                directionalSemantics: {
                    type: "string",
                    description: "Explains that positive netFlow means buying YES / selling NO, while negative netFlow means selling YES / buying NO.",
                },
                whaleActivity: {
                    type: "object",
                    properties: {
                        netWhaleVolume: { type: "number" },
                        sentiment: { type: "string", enum: ["bullish", "bearish", "neutral"] },
                        largestTrade: { type: "object" },
                        largestTradeOverall: { type: "object" },
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
- yesWhales[]: Largest holders betting YES (with shares, positionValue, convictionScore, name if public)
- noWhales[]: Largest holders betting NO (with shares, positionValue, convictionScore, name if public)
- smartMoneySignal: Which side whales favor (YES/NO/NEUTRAL)
- totalUniqueHolders: Total holders found via deep fetching

🔥 DEEP FETCHING: We now call /holders with limit=500 per side in a single request (the doc'd 20-cap is stale — the endpoint empirically returns up to 500 top holders sorted desc by share balance). The previous multi-tier minBalance workaround collapsed to exactly 20 unique holders for popular outcomes because every tier's top-20 was the same set once an outcome had 20+ holders. The new path routinely surfaces hundreds of unique holders, so whaleCount actually varies per outcome instead of saturating at 20. If the upstream ever regresses, we transparently fall back to the legacy tier sweep.

WHALE THRESHOLD: a holder counts as a whale-sized position at >=${formatUsdThreshold(HOLDER_WHALE_MIN_USD)} current value OR >=${HOLDER_WHALE_MIN_SUPPLY_PERCENT}% of scanned side supply. >=${formatUsdThreshold(HOLDER_LARGE_MIN_USD)} remains a useful large-holder signal, but is not labeled whale by itself.

CONVICTIONSCORES: "extreme" (>=${formatUsdThreshold(100_000)} or >=5% side supply), "high" (>=${formatUsdThreshold(50_000)} or >=2%), "moderate" (whale-sized), "low" (below whale threshold)

USE THIS FOR: Single-outcome markets like "Will Bitcoin hit $100k?" or "Will Trump win?"
USE analyze_event_whale_breakdown FOR: "Which player are whales betting on in Australian Open?"
USE analyze_whale_flow FOR: "Recent trades?", "Trading activity in last 24h?"
DO NOT use this tool for vig, spread, overround, true implied probability, or market-efficiency questions.

⏱️ PERFORMANCE: This tool performs deep fetching in paced batches. It typically takes ~8-15s.
⚠️ Call this tool ALONE (not in parallel with other heavy tools like find_trading_opportunities or analyze_market_liquidity) to avoid timeouts.
If you need multiple analyses, call them SEQUENTIALLY, not with Promise.all().`,
        inputSchema: {
            type: "object",
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
                    description: "Natural-language market title/query (e.g., 'Bitcoin above $100k'). The server resolves this to the best matching market across ACTIVE and RESOLVED markets when conditionId/slug are not provided.",
                },
                deepFetch: {
                    type: "boolean",
                    description: "Set false for a faster but shallower holder scan. Default true for the full whale-spectrum fetch.",
                },
                limit: {
                    type: "number",
                    description: "Optional holder scan target. Deep fetch defaults to 50; shallow mode defaults to 20.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
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
                        largeHolderCount: { type: "number" },
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
        description: `🐋 MULTI-OUTCOME WHALE ANALYSIS: For events with multiple outcomes (like "Australian Open Winner" or "2026 FIFA World Cup Winner"), shows WHICH SPECIFIC OUTCOME whales are betting on.

⚠️ USE THIS for multi-outcome events like sports tournaments, elections with multiple candidates, World Cup winner, etc.
⚠️ analyze_top_holders only shows YES/NO for ONE market. This tool shows whale positions ACROSS ALL outcomes in an event.
⚠️ CALL THIS TOOL DIRECTLY -- do not chain search_and_get_outcomes first. Pass either a slug or a marketQuery and this tool handles resolution internally. It can also choose a strong live fallback event for prompts like "this event" instead of punting.
⚠️ If the user gives a named shortlist (for example "among Spain, France, and England"), pass those names in outcomes so the tool bounds the whale scan to that shortlist instead of timing out on the whole event.

Example: For "2026 FIFA World Cup Winner" event with 48 outcome markets:
- Returns: "Whales have $100k on Spain, $80k on England, $50k on France..."
- NOT just: "Whales have $X on YES, $Y on NO" (which is meaningless without knowing WHICH team)

Returns:
- eventTitle: The event name
- totalMarketsAnalyzed: How many outcome markets were checked
- whalesByOutcome[]: Sorted by total whale value, showing which outcomes have biggest whale positions
- topWhaleOutcome: The outcome with most whale money`,
        inputSchema: {
            type: "object",
            properties: {
                slug: {
                    type: "string",
                    description: "The EVENT slug (e.g., '2026-mens-australian-open-winner'). Preferred when known.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language event query (e.g., '2026 FIFA World Cup winner'). Use when slug is unknown -- the tool will resolve the event automatically.",
                },
                outcomes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional named shortlist to bound the whale scan to specific outcomes (e.g. ['Spain', 'France', 'England']). Strongly preferred when the user asks 'among X, Y, Z'.",
                },
                maxOutcomes: {
                    type: "number",
                    description: "Maximum number of outcomes/markets to analyze (default: 10, max: 20). Higher = slower but more thorough.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                totalMarketsInEvent: { type: "number" },
                totalMarketsAnalyzed: { type: "number" },
                selectionMode: {
                    type: "string",
                    enum: ["requested_outcomes", "top_volume_outcomes"],
                },
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
                            whaleCount: {
                                type: "number",
                                description: "Number of whale-sized YES positions detected across the full deep holder scan (>= $10k current value or >= 1% scanned side supply)",
                            },
                            holdersScanned: {
                                type: "number",
                                description: "Number of YES holders scanned for this outcome before any response truncation",
                            },
                            returnedHolderSampleCount: {
                                type: "number",
                                description: "Number of top YES holders retained in the returned sample payload for this outcome",
                            },
                            convictionLevel: { type: "string", enum: ["extreme", "high", "moderate", "low"] },
                        },
                    },
                },
                unmatchedOutcomes: {
                    type: "array",
                    items: { type: "string" },
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
                selectionReason: { type: "string" },
                synthesisHint: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["eventTitle", "whalesByOutcome", "topWhaleOutcome"],
        },
    },
    {
        name: "analyze_event_outcome_liquidity",
        description: `📉 MULTI-OUTCOME EVENT LIQUIDITY: Analyze spreads, depth, and exit slippage across specific outcomes inside the SAME event.

USE THIS for:
- "Analyze liquidity in the World Cup winner market"
- "Analyze liquidity for the YES side of the current World Cup winner market and estimate slippage for $1k, $5k, and $10k exits"
- "Which candidates in this election market are easiest to exit?"
- "Estimate slippage for top outcomes in a tournament market"

⚠️ IMPORTANT: Multi-outcome events do NOT have one universal YES side. If the user does not name an outcome, this tool will analyze the top outcomes by volume instead of arbitrarily picking one.
⚠️ When the prompt says "the YES side" of a tournament, election, or other categorical market without naming the outcome, this is the correct tool.

DATA FLOW:
- Named outcomes: search_and_get_outcomes → outcome match → analyze_market_liquidity
- Ambiguous event-only request: search_and_get_outcomes/get_event_outcomes → top-volume outcomes → analyze_market_liquidity

Best when the user wants liquidity or slippage for a tournament, election, award, or other categorical market and either names several outcomes or leaves the exact outcome unspecified.`,
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Raw liquidity request. Example: 'Analyze liquidity for the World Cup winner market and estimate slippage for $1k, $5k, and $10k exits.'",
                },
                eventQuery: {
                    type: "string",
                    description: "Natural-language event query if you want to pass the event separately (e.g. '2026 FIFA World Cup winner')",
                },
                slug: {
                    type: "string",
                    description: "Direct Polymarket event slug when already known (preferred over search).",
                },
                outcomes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Specific outcomes to analyze (e.g. ['Spain', 'Brazil']). If omitted, the tool analyzes the top outcomes by volume.",
                },
                category: {
                    type: "string",
                    description: "Optional category hint (sports, politics, crypto, etc.) to narrow event resolution.",
                },
                limit: {
                    type: "number",
                    description: "Maximum outcomes to analyze when outcomes are omitted (default: 4, max: 8).",
                },
                sortBy: {
                    type: "string",
                    enum: ["volume", "price"],
                    description: "How to choose fallback outcomes when no explicit outcomes are provided. 'volume' is the safer default for exit-quality analysis.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                eventUrl: { type: "string", format: "uri" },
                totalOutcomes: { type: "number" },
                selectionMode: {
                    type: "string",
                    enum: ["requested_outcomes", "top_volume_outcomes", "top_price_outcomes"],
                },
                selectionReason: { type: "string" },
                needsOutcomeDisambiguation: { type: "boolean" },
                summary: { type: "string" },
                analyzedOutcomes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            requestedName: { type: "string" },
                            matchedName: { type: "string" },
                            tokenId: { type: "string" },
                            conditionId: { type: "string" },
                            currentPrice: { type: "number" },
                            impliedProbability: { type: "string" },
                            volume: { type: "number" },
                            liquidityScore: { type: "string" },
                            bestBid: { type: "number" },
                            bestAsk: { type: "number" },
                            spreadCents: { type: "number" },
                            spreadBps: { type: "number" },
                            totalDepthUsd: { type: "number" },
                            slippage1kPercent: { type: "number" },
                            slippage5kPercent: { type: "number" },
                            slippage10kPercent: { type: "number" },
                            canExit1k: { type: "boolean" },
                            canExit5k: { type: "boolean" },
                            canExit10k: { type: "boolean" },
                            recommendation: { type: "string" },
                        },
                        required: ["matchedName", "tokenId", "liquidityScore", "slippage5kPercent"],
                    },
                },
                unmatchedOutcomes: {
                    type: "array",
                    items: { type: "string" },
                },
                bestLiquidityOutcome: {
                    type: "object",
                    properties: {
                        matchedName: { type: "string" },
                        totalDepthUsd: { type: "number" },
                        spreadCents: { type: "number" },
                        liquidityScore: { type: "string" },
                    },
                },
                highestVolumeOutcome: {
                    type: "object",
                    properties: {
                        matchedName: { type: "string" },
                        volume: { type: "number" },
                        currentPrice: { type: "number" },
                    },
                },
                analysisNotes: {
                    type: "array",
                    items: { type: "string" },
                },
                fetchedAt: { type: "string" },
            },
            required: ["eventTitle", "selectionMode", "analyzedOutcomes", "needsOutcomeDisambiguation"],
        },
    },
    {
        name: "rank_event_tradability",
        description: `Rank outcomes inside the SAME multi-outcome event by actionable tradability using live spread, depth, slippage, whale participation, and live event-activity context.

USE THIS for:
- "Which candidate submarkets combine tight quotes with meaningful whale participation?"
- "Within the Democratic Presidential Nominee 2028 event, which candidates combine tight quotes with meaningful whale participation, and which are just headline prices?"
- "Which winner markets are genuinely tradable, and which are just headline prices?"
- "Which live submarkets in this game/event look tradeable tonight?"
- "Within the Rockets vs. Suns event, which live submarkets look genuinely tradable tonight?"
- "Compare these expiry buckets/strikes by execution quality"

This tool is the direct answer-first workflow for event-wide tradability prompts. It resolves the event, bounds the candidate set to a small tradability shortlist, joins whale concentration, and adds live event-volume context when available instead of asking the user to narrow to one outcome.

Use this directly for crowded election, tournament, strike-ladder, and same-game-market prompts even when the event has many outcomes. For candidate screens and same-night matchup prompts, do not ask the user to narrow to one submarket first. The tool should prefer a bounded shortlist over broad whole-event scans when the query asks for "most tradable", "best combination", "tightest execution", or "headline-only" outcomes.`,
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Raw event tradability prompt. Example: 'Within the Democratic Presidential Nominee 2028 event, which candidates combine tight quotes with meaningful whale participation?'",
                },
                eventQuery: {
                    type: "string",
                    description: "Natural-language event query when you want to pass the event separately.",
                },
                slug: {
                    type: "string",
                    description: "Direct event slug when already known.",
                },
                outcomes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Optional explicit outcomes to compare. If omitted, the tool ranks the top outcomes by trading activity.",
                },
                category: {
                    type: "string",
                    description: "Optional category hint for event resolution.",
                },
                limit: {
                    type: "number",
                    description: "Maximum outcomes to rank when outcomes are omitted (default: 6, max: 10).",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                selectionReason: { type: "string" },
                rankedOutcomes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            rank: { type: "number" },
                            matchedName: { type: "string" },
                            conditionId: { type: "string" },
                            currentPrice: { type: "number" },
                            volume: { type: "number" },
                            spreadCents: { type: "number" },
                            totalDepthUsd: { type: "number" },
                            slippage5kPercent: { type: "number" },
                            whaleValue: { type: "number" },
                            whaleCount: { type: "number" },
                            liveVolumeShare: { type: "number" },
                            tradabilityScore: { type: "number" },
                            classification: {
                                type: "string",
                                enum: ["tradable_now", "watchlist", "headline_only"],
                            },
                            rationale: {
                                type: "array",
                                items: { type: "string" },
                            },
                        },
                        required: ["rank", "matchedName", "tradabilityScore", "classification"],
                    },
                },
                bestCombinedOutcome: {
                    type: "object",
                    properties: {
                        matchedName: { type: "string" },
                        tradabilityScore: { type: "number" },
                        classification: { type: "string" },
                    },
                },
                analyzedOutcomeNames: {
                    type: "array",
                    items: { type: "string" },
                },
                watchlistOutcomes: {
                    type: "array",
                    items: { type: "string" },
                },
                headlineOnlyOutcomes: {
                    type: "array",
                    items: { type: "string" },
                },
                expensiveButUntradeable: {
                    type: "array",
                    items: { type: "string" },
                },
                analysisNotes: {
                    type: "array",
                    items: { type: "string" },
                },
                fetchedAt: { type: "string" },
            },
            required: ["eventTitle", "rankedOutcomes", "analysisNotes"],
        },
    },
    {
        name: "compare_market_against_related_contracts",
        description: `Compare ONE named market against the sibling contracts in the same event so you can judge relative pricing, obvious over/underpricing, and whether there is any simple event-curve arbitrage.

USE THIS for:
- "Does this Fed outcome look efficient versus the related April contracts?"
- "For the 'Will the Fed decrease interest rates by 50+ bps after the April 2026 meeting?' market, is there any live arbitrage or obvious overpricing/underpricing once depth and related Fed contracts are considered?"
- "Is this strike rich/cheap relative to neighboring strikes?"
- "For Stephen A. Smith versus Gretchen Whitmer and Oprah Winfrey, does the contract look rich or cheap right now?"
- "Compare this named contract to the rest of its event before calling it mispriced"

Pass the raw user prompt or a direct market reference. The tool resolves the primary market, identifies the sibling event, checks direct liquidity on the named leg, compares the relevant outcomes, and packages a bounded relative-value assessment instead of stopping at discovery.

If the user names one leg inside a larger event family, such as "no change", "50+ bps decrease", "$200 HIGH", or a specific expiry bucket, this tool should resolve the parent event and exact leg automatically instead of requiring an exact market-title match first. Use it directly instead of starting with search_markets when the prompt already names the leg to compare.`,
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Raw relative-value prompt. The tool will extract the market reference if needed.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language reference to the primary market to analyze.",
                },
                eventQuery: {
                    type: "string",
                    description: "Optional event query when the sibling event should be resolved separately from the primary market wording.",
                },
                focusOutcome: {
                    type: "string",
                    description: "Optional exact outcome/strike name inside the event when the prompt focuses on one leg.",
                },
                slug: { type: "string" },
                conditionId: { type: "string" },
                category: { type: "string" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                primaryMarket: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        conditionId: { type: "string" },
                        eventTitle: { type: "string" },
                        primaryOutcome: { type: "string" },
                        currentPrice: { type: "number" },
                        spreadCents: { type: "number" },
                        liquidityScore: { type: "string" },
                    },
                },
                siblingOutcomes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            matchedName: { type: "string" },
                            currentPrice: { type: "number" },
                            spread: { type: "number" },
                            volume: { type: "number" },
                        },
                    },
                },
                eventPriceSum: { type: "number" },
                richOrCheap: {
                    type: "string",
                    enum: ["rich", "cheap", "roughly_fair"],
                },
                relativeValueDifference: { type: "number" },
                relativeValueAssessment: { type: "string" },
                arbitrageAssessment: { type: "string" },
                synthesisHint: { type: "string" },
                analysisNotes: {
                    type: "array",
                    items: { type: "string" },
                },
                fetchedAt: { type: "string" },
            },
            required: ["primaryMarket", "siblingOutcomes", "relativeValueAssessment"],
        },
    },
    {
        name: "build_market_tradability_memo",
        description: `Build a buy / pass / avoid memo for ONE named market by combining rules risk, quote quality, whale positioning, and recent tape/activity.

USE THIS for:
- "Does the current quote compensate for the rules and tail-risk profile?"
- "Build a tradability memo for this market"
- "Should I buy, pass, or avoid after checking rules, liquidity, whales, and activity?"

This is the direct answer-first workflow for single-market memo prompts. It packages the key evidence pillars in one tool so the answer does not stop at clarification or unsupported synthesis.

If the prompt names one outcome inside a multi-outcome event family, such as a strike bucket, expiry bucket, or candidate bracket, the tool should resolve the parent event and exact leg automatically from the prompt instead of asking the user to restate the contract in a different format.`,
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Raw memo prompt. The tool will extract the named market when possible.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language reference to the target market.",
                },
                slug: { type: "string" },
                conditionId: { type: "string" },
                hoursBack: {
                    type: "number",
                    description: "Whale-flow/activity lookback window in hours (default: 24).",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                market: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        conditionId: { type: "string" },
                        currentPrice: { type: "number" },
                        spreadCents: { type: "number" },
                        liquidityScore: { type: "string" },
                    },
                },
                rulesRisk: { type: "string" },
                quoteQuality: { type: "string" },
                whalePositioning: { type: "string" },
                recentActivity: { type: "string" },
                tradeCoverage: {
                    type: "object",
                    description: "Coverage diagnostics for activity and whale-flow signals used by the memo.",
                },
                decision: {
                    type: "string",
                    enum: ["buy", "speculative_buy", "pass", "avoid"],
                },
                memo: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["market", "decision", "memo"],
        },
    },
    {
        name: "find_correlated_markets",
        description: 'Find genuinely related hedge candidates for a market. Prioritizes same-event siblings and same-category/theme contracts with live prices, and avoids loose year/title overlaps that are not actually useful hedges. Accepts either conditionId OR slug - both work equally well.',
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                sourceMarket: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        category: { type: "string" },
                        tags: { type: "array", items: { type: "string" } },
                        conditionId: { type: "string" },
                        slug: { type: "string" },
                        currentPrice: { type: "number" },
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
        name: "polymarket_crossref_kalshi",
        description: `Cross-venue comparison helper for matching a resolved Polymarket contract family against likely Kalshi equivalents.

Use this AFTER you have already identified the exact Polymarket market or slug, OR pass marketQuery and let the tool resolve the best live Polymarket candidate first. For deictic prompts like "this contract", prefer passing the resolved Polymarket contract reference rather than a long free-form comparison instruction.

Best for:
- "Find the Kalshi equivalent of this Polymarket contract"
- "Cross-check whether this Polymarket line exists on Kalshi"
- "Compare rule wording / YES meaning across Polymarket and Kalshi"

This tool performs the Kalshi lookup itself from the provided Polymarket title/keywords. Prefer calling THIS TOOL directly for Polymarket-vs-Kalshi questions instead of substituting unrelated Polymarket-only liquidity tools.

Returns candidate Kalshi matches with live Kalshi prices, plus the grounded Polymarket contract metadata/pricing when resolvable, so you can validate whether the contracts are actually equivalent before comparing which venue is richer.`,
        inputSchema: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Exact Polymarket market title to match against Kalshi candidates.",
                },
                keywords: {
                    type: "string",
                    description: "Optional fallback keyword string when you want to guide the Kalshi lookup more explicitly.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language Polymarket market reference or raw deictic prompt. When title is missing, the tool can resolve a live Polymarket contract first.",
                },
                polymarketSlug: {
                    type: "string",
                    description: "Optional Polymarket slug for traceability in the comparison result.",
                },
                limit: {
                    type: "number",
                    description: "Maximum Kalshi candidates to return (default: 10, max: 25).",
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
                        title: { type: "string" },
                        keywords: { type: "string" },
                        polymarketSlug: { type: "string" },
                    },
                },
                polymarketMarket: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        slug: { type: "string" },
                        conditionId: { type: "string" },
                        url: { type: "string", format: "uri" },
                        currentYesPrice: { type: "number" },
                        resolutionSource: { type: "string" },
                        resolvesYesIf: { type: "string" },
                    },
                },
                kalshiResults: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            title: { type: "string" },
                            ticker: { type: "string" },
                            eventTicker: { type: "string" },
                            yesPrice: { type: "number" },
                            volume24h: { type: "number" },
                            url: { type: "string", format: "uri" },
                            matchScore: { type: "number" },
                            rules: { type: "string" },
                            yesOutcomeMeans: { type: "string" },
                            noOutcomeMeans: { type: "string" },
                        },
                    },
                },
                hint: { type: "string" },
                comparisonNote: { type: "string" },
                searchExhausted: { type: "boolean" },
                noResultsReason: { type: "string" },
                sourcesTried: {
                    type: "array",
                    items: { type: "string" },
                },
                fetchedAt: { type: "string" },
            },
            required: ["kalshiResults", "searchExhausted", "fetchedAt"],
        },
    },
    {
        name: "check_market_rules",
        description: 'Parse market resolution rules and highlight potential "gotchas". Extracts the description, resolution source, and edge cases that could cause unexpected resolution. This is the direct tool for prompts like "what makes this market resolve YES or NO?" Accepts conditionId, slug, or marketQuery. If the user asks about "this market" without an identifier, the tool can choose a live fallback contract and state that assumption instead of returning generic market lore.',
        inputSchema: {
            type: "object",
            properties: {
                slug: {
                    type: "string",
                    description: "The event slug (e.g., 'will-trump-release-epstein-files-by'). Alternative to conditionId.",
                },
                conditionId: {
                    type: "string",
                    description: "The market condition ID (hex string starting with 0x). Works with IDs from discover_trending_markets or other tools.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language market reference or the raw user request. Use when slug/conditionId is unknown or the prompt says 'this market'.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
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
                selectionReason: {
                    type: "string",
                    description: "How the tool chose the analyzed market when no explicit conditionId/slug was supplied.",
                },
                fetchedAt: { type: "string" },
            },
            required: ["market", "description", "rulesSummary"],
        },
    },
    {
        name: "find_arbitrage_opportunities",
        description: "Scan LIVE markets for VERIFIED arbitrage and wide spreads by fetching actual CLOB orderbooks. Checks if buying both YES and NO costs less than $1 (guaranteed profit), returns direct Polymarket URLs, and only surfaces markets whose quotes were verified from live books. Category filters (e.g. politics, sports) use Polymarket tag_slug plus client-side tag verification — wideSpreadMarkets and scanned set stay category-consistent. Limited to ~20 orderbook probes to avoid timeout.",
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                scannedMarkets: { type: "number" },
                arbitrageOpportunities: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            market: { type: "string" },
                            url: { type: "string", format: "uri" },
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
                            url: { type: "string", format: "uri" },
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
        description: `Advanced tool for finding Polymarket opportunities with complex filtering. Supports strategies: lottery_tickets (1-15¢), moderate_conviction (35-65¢), high_confidence (70-90¢), momentum, mispriced, near_resolution.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent markets or construct URLs. If no results match the criteria, say "No matching markets found" - do NOT make up markets that might exist.

⚠️ FOR SIMPLER QUERIES: If user wants 'likely bets', 'safer bets', or 'bets that will probably win' → use find_moderate_probability_bets instead. For filtering by probability like 'coinflip bets' or 'unlikely bets' → use get_bets_by_probability instead.

⏱️ PERFORMANCE: This tool scans many markets. Use the 'depth' parameter to control how many markets are scanned:
- "shallow" (~500 markets, ~5s) - Quick scan for fast answers or when called alongside other tools
- "medium" (~1000 markets, ~10s) - Good balance, DEFAULT for most queries
- "deep" (~2000+ markets, ~20s) - Maximum coverage. Use when user specifically asks for thorough/comprehensive analysis, or when initial results are insufficient
⚠️ Call this tool ALONE (not in parallel with other heavy tools) when using "deep" depth to avoid timeouts.`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
        description: `Run an end-to-end high-conviction workflow in ONE call: discover trending markets, validate rules, check efficiency, analyze liquidity, and return top tradable setups with explicit risks.

This is the recommended tool when users ask for a multi-step workflow like:
"discover trending markets → validate rules → check efficiency → top setups with risks."

Why use this:
- Avoids brittle multi-call orchestration in client-generated code
- Executes analysis sequentially and safely on the server
- Returns normalized setup cards with entry guidance and risk factors
- When candidates satisfy the workflow checks, \`topSetups\` contains the surviving high-conviction setups directly
- When no candidate survives the rule/liquidity/whale-alignment screen, \`analysisNotes\` explains the blocker instead of pretending setups survived
- If model edge is flat or negative, the workflow should downgrade the setup instead of marketing it as high conviction

⏱️ PERFORMANCE: Runs several analyses sequentially (~10-25s depending on candidateCount and whale options).`,
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                workflowSummary: {
                    type: "object",
                    properties: {
                        strategy: { type: "string" },
                        category: { type: "string" },
                        discoveredMarkets: { type: "number" },
                        analyzedMarkets: { type: "number" },
                        survivingHighConvictionSetups: { type: "number" },
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
                nearMissSetups: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            rank: { type: "number" },
                            market: { type: "string" },
                            url: { type: "string", format: "uri" },
                            score: { type: "number" },
                            signal: { type: "string" },
                            whyRejected: {
                                type: "array",
                                items: { type: "string" },
                            },
                            checks: { type: "object" },
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
        name: "analyze_single_market_whales",
        description: `Run recent whale-flow analysis plus top-holder concentration analysis for a SINGLE-OUTCOME market in one call.

USE THIS for:
- "Show me whale flow and top holders for a live single-outcome politics market"
- "Give me the smart-money read on a live yes/no market"
- "Pick the most liquid live politics market and tell me what whales are doing"

If marketQuery is omitted, this tool uses the category to pick the most liquid live single-outcome market first, then runs both whale analyses and returns a combined smart-money summary. If the prompt is deictic ("this market") and no identifier is available, the tool can still choose a strong live single-outcome fallback market and state that assumption.

For broad prompts like "show me whale flow and top holders for a live single-outcome politics market", call THIS TOOL ALONE.
Do not prefetch get_top_markets or call analyze_top_holders separately unless the user explicitly asks for a specific market shortlist or deeper follow-up.`,
        inputSchema: {
            type: "object",
            properties: {
                conditionId: {
                    type: "string",
                    description: "Direct market condition ID when you already resolved the target market.",
                },
                slug: {
                    type: "string",
                    description: "Direct market or event slug when you already resolved the target market.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language market reference to analyze (preferred when the user names a market)",
                },
                category: {
                    type: "string",
                    description: "Category to sample when marketQuery is omitted (e.g. politics, sports, crypto)",
                },
                hoursBack: {
                    type: "number",
                    description: "Lookback window for recent trade-flow analysis (default: 24)",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                selectedMarket: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        slug: { type: "string" },
                        conditionId: { type: "string" },
                        url: { type: "string", format: "uri" },
                        category: { type: "string" },
                        selectionReason: { type: "string" },
                    },
                    required: ["title", "conditionId", "url"],
                },
                whaleFlow: {
                    type: "object",
                    properties: {
                        period: { type: "string" },
                        totalTrades: { type: "number" },
                        totalVolume: { type: "number" },
                        flowBySize: { type: "object" },
                        sizeBucketDefinitions: { type: "object" },
                        tradeSample: { type: "object" },
                        tradeCoverage: { type: "object" },
                        buyerGuidance: { type: "object" },
                        directionalSemantics: { type: "string" },
                        whaleActivity: { type: "object" },
                        divergence: { type: "string" },
                    },
                    required: ["period", "totalTrades", "totalVolume"],
                },
                holderAnalysis: {
                    type: "object",
                    properties: {
                        marketConcentration: { type: "object" },
                        smartMoneySignal: { type: "object" },
                        recommendation: { type: "string" },
                    },
                },
                yesWhales: {
                    type: "array",
                    items: { type: "object" },
                },
                noWhales: {
                    type: "array",
                    items: { type: "object" },
                },
                buyerGuidance: {
                    type: "object",
                    description: "Plain-English guidance for synthesizing holder-whale and trade-flow data without confusing top holders, large prints, and whale-sized prints.",
                },
                fetchedAt: { type: "string" },
            },
            required: ["selectedMarket", "whaleFlow", "holderAnalysis"],
        },
    },
    {
        name: "summarize_live_market_activity",
        description: `Select a live market and return recent trades plus current open interest in one call.

USE THIS for:
- "Show me recent trades and open interest for a live market ending this week"
- "Pick a live market ending soon and summarize current trading activity"
- "Summarize recent trades and open interest for this market"
- "Find the live market with the highest open interest relative to recent traded volume"
- "Explain whether the tape looks like fresh conviction or churn using buy/sell volume plus open interest"

If marketQuery/conditionId/slug is omitted, this tool picks a live market automatically using endingWithinDays plus optional category filters. If the prompt explicitly asks for "ending soon", that requirement stays hard: the tool widens progressively (up to 90 days) but should not silently substitute a far-dated high-volume market.

For prompts that ask for both recent trades and open interest together, call THIS TOOL ALONE instead of chaining get_top_markets + get_market_trades + get_market_open_interest.

Important: the open-interest field is a point-in-time snapshot. Use it for current OI level only, not for a true change rate unless you have a second time-separated snapshot. Trade summaries include tradeCoverage; if coverageLevel is partial or insufficient, describe buy/sell totals as sampled public tape.

If sortBy is set to "open_interest_vs_volume", this tool screens a shortlist of live candidates and picks the market with the highest current openInterest-to-recent-volume ratio before returning the detailed trade/open-interest breakdown.`,
        inputSchema: {
            type: "object",
            properties: {
                marketQuery: {
                    type: "string",
                    description: "Natural-language market reference when the user names a market",
                },
                conditionId: {
                    type: "string",
                    description: "Specific market condition ID to analyze",
                },
                slug: {
                    type: "string",
                    description: "Specific event or market slug to analyze",
                },
                category: {
                    type: "string",
                    description: "Optional category filter when auto-selecting a live market",
                },
                endingWithinDays: {
                    type: "number",
                    description: "When auto-selecting, prefer live markets ending within this many days (default: 7)",
                },
                sortBy: {
                    type: "string",
                    enum: ["ending_soon", "volume", "liquidity", "open_interest_vs_volume"],
                    description: "How to rank auto-selected markets before pulling activity (default: ending_soon). Use open_interest_vs_volume to pick the live market with the highest open-interest-to-recent-volume ratio.",
                },
                tradeLimit: {
                    type: "number",
                    description: "Maximum recent trades to return (default: 20, max: 100)",
                },
                hoursBack: {
                    type: "number",
                    description: "Lookback window for trade coverage and summary volume (default: 24)",
                },
                minNotional: {
                    type: "number",
                    description: "Optional minimum USD notional filter for the trade summary. Use when the prompt asks for large trades/prints; omit for normal activity/open-interest ratios.",
                },
                side: {
                    type: "string",
                    enum: ["BUY", "SELL"],
                    description: "Optional trade side filter for the trade summary.",
                },
                user: {
                    type: "string",
                    description: "Optional wallet/proxy address filter for wallet-specific activity.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                selectedMarket: {
                    type: "object",
                    properties: {
                        title: { type: "string" },
                        slug: { type: "string" },
                        conditionId: { type: "string" },
                        url: { type: "string", format: "uri" },
                        endDate: { type: "string" },
                        category: { type: "string" },
                        liquidity: { type: "number" },
                        volume24h: { type: "number" },
                        selectionReason: { type: "string" },
                    },
                    required: ["title", "conditionId", "url", "selectionReason"],
                },
                tradesSummary: {
                    type: "object",
                    properties: {
                        totalTrades: { type: "number" },
                        totalVolume: { type: "number" },
                        buyVolume: { type: "number" },
                        sellVolume: { type: "number" },
                        avgPrice: { type: "number" },
                    },
                    required: ["totalTrades", "totalVolume", "buyVolume", "sellVolume", "avgPrice"],
                },
                openInterest: {
                    type: "object",
                    properties: {
                        conditionId: { type: "string" },
                        value: { type: "number" },
                        changeRateAvailable: { type: "boolean" },
                        note: { type: "string" },
                    },
                    required: ["conditionId", "value", "changeRateAvailable", "note"],
                },
                recentTrades: {
                    type: "array",
                    items: { type: "object" },
                },
                tradeCoverage: {
                    type: "object",
                    description: "Coverage diagnostics for the recent trade window used by tradesSummary.",
                },
                noResultsReason: {
                    type: "string",
                    description: "Present when no live market matches the requested or auto-selected criteria.",
                },
                searchExhausted: {
                    type: "boolean",
                    description: "True when the tool could not find a suitable live market for this activity summary.",
                },
                fetchedAt: { type: "string" },
            },
            required: ["selectedMarket", "tradesSummary", "openInterest", "recentTrades"],
        },
    },
    {
        name: "find_moderate_probability_bets",
        description: `🎯 BEST TOOL for 'likely bets', 'safer bets', or 'bets that will probably win'. Finds prediction market bets priced 40-75¢ (40-75% implied probability) with good liquidity. Returns 1.3-2.5x if correct. USE THIS instead of find_trading_opportunities when user wants higher probability outcomes.

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent additional markets or URLs. Each result includes a real 'url' field - use ONLY those URLs.

⏱️ PERFORMANCE: Scans ~50 events (~5-8s). Safe to call alone or alongside lightweight tools like check_market_efficiency.`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
        description: `🎯 SIMPLEST tool for filtering bets by win probability. Use when user asks for: 'coinflip bets' → likelihood='coinflip', 'unlikely bets'/'longshots' → likelihood='very_unlikely', 'likely bets' → likelihood='likely'. Options: very_unlikely (1-15%), unlikely (15-35%), coinflip (35-65%), likely (65-85%), very_likely (85-95%).

⚠️ CRITICAL: Only present markets returned by this tool. NEVER invent additional markets or construct URLs from titles. Use ONLY the 'url' field provided in each result.`,
        inputSchema: {
            type: "object",
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
            type: "object",
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

USE THIS for:
- "What categories are hottest right now?"
- "Which tags are active on Polymarket today?"
- "Why is this market/category suddenly active?"

Do not pair this with get_top_markets when the user only needs a direct ranked list or a filtered market screen.
Use get_top_markets alone for direct retrieval of ranked/filtered markets.
Use discover_trending_markets when the user wants surge detection, active tags/categories, or an explanation of why activity is unusual relative to baseline. The result is a broad sampled live-market heat map, not just a tiny top-of-book anecdote.

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
            type: "object",
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
            type: "object",
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
                topTags: {
                    type: "array",
                    description: "Most common tags across the sampled active markets",
                    items: {
                        type: "object",
                        properties: {
                            label: { type: "string" },
                            slug: { type: "string" },
                            count: { type: "number" },
                        },
                    },
                },
                topLiquidMarketsByCategory: {
                    type: "object",
                    description: "Top liquid sampled markets grouped by category",
                    additionalProperties: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                title: { type: "string" },
                                url: { type: "string", format: "uri" },
                                slug: { type: "string" },
                                conditionId: { type: "string" },
                                liquidity: { type: "number" },
                                volume24h: { type: "number" },
                            },
                        },
                    },
                },
                totalActive: { type: "number" },
                hotnessMethodology: {
                    type: "string",
                    description: "How trendScore and tag counts were computed for this snapshot",
                },
                fetchedAt: { type: "string" },
            },
            required: ["marketSummary", "trendingMarkets"],
        },
    },
    {
        name: "get_top_markets",
        description: `📊 Get the highest volume/liquidity markets on Polymarket.

Default behavior is LIVE/NOW: only active, tradeable markets are returned (excludes ended and near-resolved markets unless explicitly included).
      
Sorting options (mirrors Polymarket UI):
- total_volume: ALL-TIME volume (e.g., $507M) - USE THIS for "biggest markets" questions
- volume: 24-hour trading volume (e.g., $9M) - USE THIS for "most active today" / "right now" / "currently" questions
- recent_activity: alias of volume (best match for "recent activity" wording)
- liquidity: Deepest orderbooks
- trending: Most popular (default)
- newest: Recently created markets  
- ending_soon: Markets closing soon
- competitive: 50/50 contested markets
- includeNearResolved: Include very high/low probability markets (>95% YES or <5% YES). Default false.
- includeEnded: Include markets whose endDate has already passed. Default false.

USE THIS for questions like:
- "What are the biggest markets of all time?" → sortBy: "total_volume"
- "What's the highest-volume market right now?" → sortBy: "volume"
- "Show me the most liquid markets" → sortBy: "liquidity"
- "Return the exact top contracts and downstream token IDs for follow-up quote calls"

For straightforward ranked retrieval and filter-constrained screens, call this tool ALONE.
Add discover_trending_markets only when the user explicitly wants trend/surge context in addition to the ranked market list.

Each returned row is the exact market contract chosen for ranking, not a vague event-family placeholder.

For "highest", "top", or "biggest" questions, offset=0 already contains the highest-ranked matching markets. Do NOT page to later offsets unless the user asks for more results, asks to audit deeper pages, or you need results beyond the returned limit.

Returns BOTH total volume AND 24h volume for each market, plus direct Polymarket URLs and YES/NO token IDs when available.`,
        inputSchema: {
            type: "object",
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
                    description: "Minimum ALL-TIME volume in USD (e.g., 10000000 for $10M+). Use to find only major markets. OMIT THIS FIELD if you do not want a minimum filter — do NOT pass 0 or a negative number as a sentinel.",
                },
                maxTotalVolume: {
                    type: "number",
                    description: "Maximum ALL-TIME volume in USD. Use with minTotalVolume (must be strictly greater than minTotalVolume) to find mid-tier markets. OMIT THIS FIELD if you do not want a maximum filter — do NOT pass 0 or a negative number as a sentinel.",
                },
                minLiquidity: {
                    type: "number",
                    description: "Minimum liquidity in USD. Higher = better exit options. OMIT THIS FIELD if you do not want a minimum filter — do NOT pass 0 or a negative number as a sentinel.",
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
                    description: "Include near-resolved markets (>95% YES or <5% YES). Default false; set true to include one-sided markets.",
                },
                includeEnded: {
                    type: "boolean",
                    description: "Include markets whose endDate is in the past. Default false to keep results focused on currently live opportunities.",
                },
                offset: {
                    type: "number",
                    description: "Skip first N results for pagination. Use only to go DEEPER (e.g., offset=50 for results 51-100), not to answer a highest/top/biggest-market question where offset=0 is already the top page.",
                },
                limit: {
                    type: "number",
                    description: "Number of markets to return (default: 15, max: 100)",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                sortedBy: { type: "string" },
                markets: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            rank: {
                                type: "number",
                                description: "Rank relative to the requested offset/page; offset=0 rank 1 is the highest matching market.",
                            },
                            pageRank: {
                                type: "number",
                                description: "Rank within this returned page only.",
                            },
                            title: { type: "string" },
                            eventTitle: { type: "string" },
                            eventId: { type: "string" },
                            url: { type: "string", format: "uri", description: "Direct Polymarket URL - ALWAYS provided" },
                            slug: { type: "string" },
                            conditionId: { type: "string" },
                            yesTokenId: {
                                type: "string",
                                description: "YES token ID for the ranked market when available. Useful for get_midpoints/get_spreads/get_market_parameters.",
                            },
                            noTokenId: {
                                type: "string",
                                description: "NO token ID for the ranked market when available.",
                            },
                            currentPrice: { type: "number", description: "YES price (0-1)" },
                            yesPrice: {
                                type: "number",
                                description: "Explicit alias of currentPrice. Use this field when the user explicitly asks for YES price.",
                            },
                            volume24h: { type: "number", description: "24h trading volume in USD" },
                            totalVolume: { type: "number", description: "All-time volume" },
                            liquidity: { type: "number", description: "Current liquidity in USD" },
                            endDate: { type: "string" },
                            category: { type: "string" },
                        },
                    },
                },
                summary: { type: "string" },
                paginationGuidance: {
                    type: "string",
                    description: "Instruction for agents on whether another paginated get_top_markets call is useful.",
                },
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
                    description: "True when the API has no further rows to scan and fewer than requested results were returned.",
                },
                filtersApplied: { type: "object" },
                fetchedAt: { type: "string" },
            },
            required: ["sortedBy", "markets"],
        },
    },
    {
        name: "analyze_my_positions",
        description: "Analyze your Polymarket positions with exit liquidity simulation, P&L calculation, " +
            "and personalized recommendations. Requires portfolio context to be injected by the app.",
        // ✅ Context requirements in _meta (preserved by MCP SDK)
        // The Context platform reads this to inject user's Polymarket portfolio data.
        _meta: {
            contextRequirements: ["polymarket"],
        },
        inputSchema: {
            type: "object",
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
            type: "object",
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
                    description: "Present when there are no analyzable positions (e.g., no_active_positions).",
                },
                searchExhausted: {
                    type: "boolean",
                    description: "True when there are no additional positions to analyze for this wallet context.",
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
            type: "object",
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
            type: "object",
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
    // ==================== TIER 2: RAW DATA TOOLS ====================
    {
        name: "get_events",
        description: "Get list of events (markets) from Polymarket with optional filters. By default returns LIVE (active) markets. Use closed=true for resolved/finished markets.",
        inputSchema: {
            type: "object",
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
            type: "object",
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
        description: "Get detailed information about a specific event by its slug. Returns event metadata, the numeric event.id you can pass directly to get_event_live_volume, and all associated markets with their token IDs for trading.",
        inputSchema: {
            type: "object",
            properties: {
                slug: {
                    type: "string",
                    description: "The event slug from the Polymarket URL (e.g., 'maduro-out-in-2025')",
                },
            },
            required: ["slug"],
        },
        outputSchema: {
            type: "object",
            properties: {
                event: {
                    type: "object",
                    description: "The event (parent container for markets)",
                    properties: {
                        id: {
                            type: "string",
                            description: "Event identifier. Pass this to get_event_live_volume for live submarket volume shares.",
                        },
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
        description: `🔍 Query-first composite for resolving ONE Polymarket event and returning all current outcomes in ONE CALL.

🚨 ROUTING CONTRACT (READ FIRST — APPLIES EVEN IF AN EARLIER SCOUT/DISCOVERY SEARCH RETURNED EMPTY OR IRRELEVANT RESULTS): Whenever the user names an event, even loosely (e.g. "Paris Saint-Germain FC vs. Liverpool FC", "The Masters - Winner", "2026 FIFA World Cup winner", "US recession in 2026", any "within/inside <event> event…" phrasing), and asks about outcomes, prices, bids, asks, spreads, probabilities, liquidity, or comparisons inside it, YOU MUST CALL THIS TOOL AT LEAST ONCE before emitting any clarification. This tool runs its own independent resolution pipeline (Polymarket /search-v2 + /events + /markets index + LLM-assisted candidate judge) that is STRONGER than the upstream scout/discovery pass; a scout/discovery miss does NOT mean this tool will miss — call it anyway. Pass the event name EXACTLY as the user wrote it (trailing spaces, punctuation, and quotes included). When this tool returns a substitute event (matchConfidence is "high", "medium", or "low", or eventTitle differs from what the user typed), DO NOT ask the user "should I proceed with the substitute?" or present a confirmation menu — PROCEED with the returned data, prepend a one-sentence assumption preamble to the final answer (e.g. "No exact match for 'X'; closest live event is 'Y'. Proceeding with that event."), and render the tool's outcomes inline. Do not ask the user to confirm the slug, paste a Polymarket URL, or pick between menu options before invoking this tool. This tool runs fuzzy search against live Polymarket discovery data and — if no exact match exists — proceeds with the closest live substitute event and labels the assumption inside its response (eventTitle, searchMethod, matchConfidence, note). Returning a clarification to the user with zero contributor tool calls for an event/outcome prompt is an EXPLICIT FAILURE MODE; always try this tool first and only surface a clarification if this tool itself comes back with no plausible match.

✅ Uses Polymarket's website-backed /search-v2 discovery surface first, with local reranking and fallback search if needed.

⚠️ USE THIS INSTEAD OF: search_markets → get_event_outcomes (which requires chaining calls)

✅ FIRST CHOICE when the user wants:
- one event plus all current outcomes/prices
- a full binary or multi-outcome market breakdown in one response
- a clean follow-up input for compare_event_outcome_quotes or analyze_event_outcome_liquidity
- a direct token/condition handoff for get_market_parameters, get_spreads, or get_orderbook when the search collapses to one exact outcome
- an eventSlug to feed into get_event_by_slug for event-level metadata or get_event_live_volume follow-up analysis
- a live-vs-expired bucket map for date ladder events when the prompt asks which buckets are still live

⚠️ DO NOT use this as the first choice for broad contract-family mapping across multiple related markets or rich-vs-cheap sibling analysis. For those, prefer search_markets or compare_market_against_related_contracts.

This tool:
1. Searches for the most relevant market matching your query (using Polymarket's website-backed search surface)
2. Automatically fetches all outcomes for that market
3. Returns everything in one response

If the response contains exactly one primaryOutcome, treat primaryTokenId and primaryConditionId as the canonical handoff for downstream venue-parameter tools instead of doing another semantic candidate search.

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
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Single-event natural-language query. Examples: 'US forces enter Iran by', '2026 FIFA World Cup winner', 'Democratic presidential nominee'.",
                    examples: [
                        "US forces enter Iran by",
                        "2026 FIFA World Cup winner",
                        "Democratic presidential nominee",
                    ],
                },
                category: {
                    type: "string",
                    enum: ["sports", "politics", "crypto", "pop-culture", "science", "business"],
                    description: "Optional category to narrow search",
                },
                sortBy: {
                    type: "string",
                    enum: ["volume", "price", "name"],
                    description: "How to order returned outcomes. Defaults to volume so ranked outcome lists stay faithful to the most-active contracts.",
                },
                includeInactive: {
                    type: "boolean",
                    description: "Include inactive or expired outcomes in the returned event ladder. Useful when the question explicitly asks which buckets are still live after earlier dates expired.",
                },
            },
            required: ["query"],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                eventUrl: { type: "string" },
                totalVolume: { type: "number" },
                totalOutcomes: { type: "number" },
                sortedBy: { type: "string" },
                synthesisHint: { type: "string" },
                outcomes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: { type: "string", description: "Team/candidate/outcome name" },
                            price: { type: "number", description: "Current YES price (0-1, treat as probability)" },
                            currentPrice: {
                                type: "number",
                                description: "Alias of price. Prefer this field when downstream code expects currentPrice.",
                            },
                            impliedProbability: {
                                type: "string",
                                description: "Human-readable YES probability percentage",
                            },
                            pricePercent: { type: "string" },
                            volume: { type: "number" },
                            conditionId: { type: "string" },
                            tokenId: {
                                type: "string",
                                description: "Primary YES token ID for this outcome. Use directly with get_prices/get_spreads or get_orderbook merged=true for actionable quote comparison. Use get_batch_orderbooks only when you explicitly want raw direct-book snapshots.",
                            },
                            active: { type: "boolean" },
                            closed: { type: "boolean" },
                            endDate: {
                                type: "string",
                                description: "Parsed bucket deadline when the outcome label itself names a date (for example April 15). Empty when no bucket date was inferred.",
                            },
                            dateStatus: {
                                type: "string",
                                enum: ["future", "expired", "undated"],
                            },
                        },
                    },
                },
                primaryOutcome: {
                    type: "object",
                    properties: {
                        name: { type: "string" },
                        price: { type: "number" },
                        currentPrice: { type: "number" },
                        impliedProbability: { type: "string" },
                        volume: { type: "number" },
                        conditionId: { type: "string" },
                        tokenId: { type: "string" },
                    },
                },
                primaryTokenId: { type: "string" },
                primaryConditionId: { type: "string" },
                stateSummary: {
                    type: "object",
                    properties: {
                        liveOutcomeCount: { type: "number" },
                        expiredOutcomeCount: { type: "number" },
                        liveOutcomeNames: {
                            type: "array",
                            items: { type: "string" },
                        },
                        expiredOutcomeNames: {
                            type: "array",
                            items: { type: "string" },
                        },
                        liveOutcomes: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    currentPrice: { type: "number" },
                                    volume: { type: "number" },
                                    conditionId: { type: "string" },
                                    tokenId: { type: "string" },
                                    active: { type: "boolean" },
                                    closed: { type: "boolean" },
                                    endDate: { type: "string" },
                                    dateStatus: {
                                        type: "string",
                                        enum: ["future", "expired", "undated"],
                                    },
                                },
                            },
                        },
                        expiredOutcomes: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: { type: "string" },
                                    currentPrice: { type: "number" },
                                    volume: { type: "number" },
                                    conditionId: { type: "string" },
                                    tokenId: { type: "string" },
                                    active: { type: "boolean" },
                                    closed: { type: "boolean" },
                                    endDate: { type: "string" },
                                    dateStatus: {
                                        type: "string",
                                        enum: ["future", "expired", "undated"],
                                    },
                                },
                            },
                        },
                        highestLiveOutcomeByPrice: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                currentPrice: { type: "number" },
                                volume: { type: "number" },
                                conditionId: { type: "string" },
                                tokenId: { type: "string" },
                            },
                        },
                        highestLiveOutcomeByVolume: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                currentPrice: { type: "number" },
                                volume: { type: "number" },
                                conditionId: { type: "string" },
                                tokenId: { type: "string" },
                            },
                        },
                    },
                },
                searchQuery: { type: "string" },
                searchMethod: {
                    type: "string",
                    description: "Which discovery surface or fallback path found the winning market",
                },
                matchConfidence: { type: "string", enum: ["exact", "high", "medium", "low"] },
                searchMetadata: CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA,
                fetchedAt: { type: "string" },
            },
            required: ["eventTitle", "outcomes"],
        },
    },
    {
        name: "compare_event_outcome_quotes",
        description: `Compare specific named outcomes inside the SAME multi-outcome event in one call.

🚨 ROUTING CONTRACT (READ FIRST — APPLIES EVEN IF AN EARLIER SCOUT/DISCOVERY SEARCH RETURNED EMPTY OR IRRELEVANT RESULTS): For prompts of the form "inside the '<Event>' event, compare/show <Outcome A>, <Outcome B>, <Outcome C> on price/spread/liquidity" (e.g. "Inside 'The Masters - Winner' event, compare Xander Schauffele, Cameron Young, and Akshay Bhatia"; "Within 'PSG vs Liverpool', compare the draw, PSG, and Liverpool quotes"; "Compare <candidate A>, <candidate B>, <candidate C> in the <election/tournament> market"), YOU MUST CALL THIS TOOL AT LEAST ONCE before emitting any clarification. Do not pre-emptively ask the user to confirm the slug, paste a URL, or pick between menu options. This tool runs its own independent event-resolution pipeline (Polymarket /search-v2 + /events + /markets index + LLM-assisted candidate judge) that is STRONGER than the upstream scout/discovery pass — a scout/discovery miss does NOT mean this tool will miss, so call it even if earlier searches looked empty or returned unrelated categories (e.g. "we only found esports markets"). This tool fuzzy-matches the event, falls back to the closest live substitute event when the named event is not live or is historically expired, matches the named outcomes against that event's actual outcome titles (including loose/nickname matches), and labels any assumption it had to make in its response (eventTitle, matchConfidence, searchMethod, note). Pass the event name EXACTLY as the user wrote it in the eventQuery field (trailing spaces and quotes included), and pass the outcome names in outcomeNames. Returning a clarification with zero contributor tool calls on these prompts is an EXPLICIT FAILURE MODE; always call this tool first. When this tool returns a substitute event (matchConfidence is "high", "medium", or "low", or eventTitle differs from what the user typed), DO NOT ask the user "should I proceed with the substitute?" or present a confirmation menu — just PROCEED with the returned data, prepend a one-sentence assumption preamble to the final answer (for example: "No exact match for 'PSG vs Liverpool' on 2026-04-08; closest live event is 'Paris Saint-Germain vs FC Bayern München'. Proceeding with that event."), and render the tool's matchedOutcomes quotes inline. Only surface a clarification if this tool itself returns no plausible event AND no plausible outcome matches.

USE THIS for:
- "Compare Spain, Brazil, and France in the World Cup winner market"
- "Show the implied odds and spreads for the top three candidates in this election market"
- "Which named outcomes inside this event have the widest spreads right now?"
- "Inside this event, which outcomes have moved the most over the last week, and what are their current spreads right now?"

This tool:
1. Resolves the event from a natural-language query
2. Matches the requested outcome names
3. Fetches current spread snapshots for those token IDs
4. Optionally fetches recent price-history summaries when the prompt asks about movement or momentum
5. Returns a clean side-by-side comparison with token IDs and best quotes

For prompts like "inside this event..." or "within this event..." this tool should be called directly. It can resolve the event from the prompt or choose a strong live fallback event instead of returning a clarification menu.

Best when the user names 2+ teams, candidates, or outcomes in the same event and wants current implied odds plus spread comparison without brittle multi-tool chaining. If the prompt asks for top movers without naming outcomes, this tool can rank the event's top active outcomes by recent price change and still return current spreads.

Each matched outcome includes price (alias of currentPrice), spreadCentsDisplay, spreadPercentDisplay, optional priceChange/priceChangePercent fields, and readableQuote — copy those fields into tables instead of N/A placeholders.

If the user wants the FULL event breakdown first, prefer search_and_get_outcomes.
If the prompt is really asking whether one named contract is rich or cheap versus sibling outcomes, prefer compare_market_against_related_contracts instead of recomputing from raw quote rows.`,
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Raw comparison request. Example: 'Compare Spain, Brazil, and France in the 2026 FIFA World Cup winner market.'",
                    examples: [
                        "Compare Spain, Brazil, and France in the 2026 FIFA World Cup winner market.",
                        "Show the implied odds and spreads for the top three candidates in this election market.",
                    ],
                },
                eventQuery: {
                    type: "string",
                    description: "Natural-language event query if you want to pass the event separately (e.g. '2026 FIFA World Cup winner')",
                    examples: ["2026 FIFA World Cup winner", "Democratic presidential nominee"],
                },
                outcomes: {
                    type: "array",
                    items: { type: "string" },
                    description: "Specific outcome names to compare (e.g. ['Spain', 'Brazil', 'France'])",
                    examples: [["Spain", "Brazil", "France"], ["Trump", "Newsom", "Whitmer"]],
                },
                category: {
                    type: "string",
                    description: "Optional category hint (sports, politics, crypto, etc.) to narrow event resolution",
                },
                limit: {
                    type: "number",
                    description: "If outcomes are omitted, compare the top N outcomes by current price (default: 5, max: 10)",
                    default: 5,
                },
                includeHistory: {
                    type: "boolean",
                    description: "Fetch recent price-history summaries for each selected outcome. Useful for momentum or 'moved the most' prompts.",
                },
                historyInterval: {
                    type: "string",
                    enum: ["1h", "1d", "1w", "max"],
                    description: "History window used when includeHistory=true. Defaults to 1w for momentum-style prompts.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                eventUrl: { type: "string", format: "uri" },
                matchedOutcomes: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            requestedName: { type: "string" },
                            matchedName: { type: "string" },
                            tokenId: { type: "string" },
                            conditionId: { type: "string" },
                            currentPrice: { type: "number" },
                            price: { type: "number", description: "Alias of currentPrice for table mapping" },
                            yesMid: { type: "number", description: "Alias of currentPrice (YES mid / implied prob)" },
                            impliedProbability: { type: "string" },
                            bestBid: { type: "number" },
                            bestAsk: { type: "number" },
                            spread: { type: "number" },
                            spreadPercent: { type: "number" },
                            spreadPercentDisplay: { type: "string" },
                            spreadCentsDisplay: { type: "string" },
                            priceChange: { type: "number" },
                            priceChangePercent: { type: "number" },
                            historyWindow: { type: "string" },
                            readableQuote: {
                                type: "string",
                                description: "Preformatted row for answers — copy instead of N/A placeholders",
                            },
                            volume: { type: "number" },
                        },
                        required: ["matchedName", "tokenId", "currentPrice", "spread"],
                    },
                },
                synthesisHint: { type: "string" },
                selectionReason: { type: "string" },
                unmatchedOutcomes: {
                    type: "array",
                    items: { type: "string" },
                },
                widestSpreadOutcome: {
                    type: "object",
                    properties: {
                        matchedName: { type: "string" },
                        spread: { type: "number" },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["eventTitle", "matchedOutcomes"],
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

Includes tokenId per outcome so you can call get_prices/get_spreads or get_orderbook with merged=true immediately without extra lookup. Use get_batch_orderbooks only when you explicitly want raw direct books.`,
        inputSchema: {
            type: "object",
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
            type: "object",
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
                                description: "Primary YES token ID for this outcome. Use directly with get_prices/get_spreads or get_orderbook merged=true for quote comparison. Use get_batch_orderbooks only for raw direct-book snapshots.",
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
            type: "object",
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
            type: "object",
            properties: {
                market: { type: "string" },
                assetId: { type: "string" },
                view: { type: "string", description: "'raw' or 'merged'" },
                bids: {
                    type: "array",
                    description: "Bid orders sorted by price descending",
                    items: {
                        type: "object",
                        properties: {
                            price: { type: "number", description: "Bid price on a 0-1 scale" },
                            size: { type: "number", description: "Available size at this price level" },
                            source: {
                                type: "string",
                                description: "Whether this level is from the direct book or synthetic complement liquidity in merged view",
                                enum: ["direct", "synthetic"],
                            },
                        },
                    },
                },
                asks: {
                    type: "array",
                    description: "Ask orders sorted by price ascending",
                    items: {
                        type: "object",
                        properties: {
                            price: { type: "number", description: "Ask price on a 0-1 scale" },
                            size: { type: "number", description: "Available size at this price level" },
                            source: {
                                type: "string",
                                description: "Whether this level is from the direct book or synthetic complement liquidity in merged view",
                                enum: ["direct", "synthetic"],
                            },
                        },
                    },
                },
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
        description: `Get RAW direct CLOB orderbooks for MULTIPLE tokens in a single request. Much faster than calling get_orderbook multiple times.

USE THIS when comparing prices across multiple markets or scanning for arbitrage.
Ideal for event-wide raw depth snapshots after get_event_outcomes.

IMPORTANT: This batch endpoint returns DIRECT books only, not the merged synthetic liquidity view shown in the Polymarket UI. Do NOT use these raw spreads to rank "tightest books" across outcomes on neg-risk markets. If multiple outcomes share the same raw spread, report that it is a tie and do NOT pick a single winner. For actionable quote snapshots, use get_prices/get_spreads or get_orderbook with merged=true for a single UI-equivalent orderbook.

Returns raw bids/asks arrays for each token with direct-book best prices and depth.
Supports up to 150 token IDs per call.`,
        inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
                orderbooks: {
                    type: "object",
                    description: "Map of token_id to orderbook data",
                    additionalProperties: {
                        type: "object",
                        properties: {
                            view: {
                                type: "string",
                                enum: ["raw"],
                                description: "Batch orderbooks return direct raw CLOB books only",
                            },
                            warning: {
                                type: "string",
                                description: "Raw spread can be misleading on neg-risk markets; use get_prices/get_spreads for quote snapshots or get_orderbook with merged=true for a UI-equivalent book",
                            },
                            bestBid: { type: "number" },
                            bestAsk: { type: "number" },
                            midpoint: { type: "number" },
                            spread: { type: "number" },
                            bidDepth: { type: "number", description: "Total size at best bid" },
                            askDepth: { type: "number", description: "Total size at best ask" },
                            bids: {
                                type: "array",
                                description: "Top 5 bids",
                                items: {
                                    type: "object",
                                    properties: {
                                        price: { type: "number", description: "Bid price on a 0-1 scale" },
                                        size: { type: "number", description: "Available size at this price level" },
                                    },
                                },
                            },
                            asks: {
                                type: "array",
                                description: "Top 5 asks",
                                items: {
                                    type: "object",
                                    properties: {
                                        price: { type: "number", description: "Ask price on a 0-1 scale" },
                                        size: { type: "number", description: "Available size at this price level" },
                                    },
                                },
                            },
                        },
                    },
                },
                comparisonGuidance: {
                    type: "object",
                    description: "Machine-readable guardrails for interpreting this raw batch snapshot safely.",
                    properties: {
                        view: {
                            type: "string",
                            enum: ["raw_direct_only"],
                        },
                        spreadRankingSafeAcrossOutcomes: {
                            type: "boolean",
                            description: "False for this tool. Do not declare one outcome has the tightest spread from these raw books alone.",
                        },
                        shouldDeclareSingleTightestOutcome: {
                            type: "boolean",
                            description: "False when this raw batch view should not be used to pick a single winner for spread quality.",
                        },
                        reason: { type: "string" },
                        recommendedAlternatives: {
                            type: "array",
                            items: { type: "string" },
                        },
                        identicalSpreadSummary: {
                            type: "object",
                            properties: {
                                spread: { type: "number" },
                                count: { type: "number" },
                            },
                        },
                    },
                },
                tightestDirectBookSpread: {
                    type: "object",
                    description: "Precomputed direct-book spread summary. Use this instead of inventing a winner when spreads tie.",
                    properties: {
                        status: {
                            type: "string",
                            enum: ["unique", "tie", "unavailable"],
                        },
                        spread: { type: "number" },
                        tokenIds: {
                            type: "array",
                            items: { type: "string" },
                        },
                        outcomeCount: { type: "number" },
                        reason: { type: "string" },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["orderbooks", "comparisonGuidance", "tightestDirectBookSpread"],
        },
    },
    {
        name: "get_market_parameters",
        description: `Get trading parameters for a market: tick size, fee rate, minimum order size, and negative risk setting.

- tick_size: Minimum price increment (e.g., 0.01 = 1 cent)
- fee_rate_bps: Trading fee in basis points (e.g., 100 = 1%)
- min_order_size: Minimum order size accepted by the venue
- neg_risk: Whether market uses negative risk model

Use this directly for prompts asking for token parameters, trading parameters, venue settings, minimum order size, or whether negative risk is enabled.

If search_and_get_outcomes already collapsed the query to one exact outcome, pass primaryTokenId (or primaryConditionId) directly here instead of re-ranking candidates from the outcomes array.`,
        inputSchema: {
            type: "object",
            properties: {
                tokenId: {
                    type: "string",
                    description: "Token ID to get parameters for",
                },
                conditionId: {
                    type: "string",
                    description: "Condition ID when you know the market but not the token ID. The tool resolves the primary YES token automatically.",
                },
                slug: {
                    type: "string",
                    description: "Market or event slug when you know the Polymarket URL but not the token ID.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language market reference when the user named a contract but no token ID is available yet.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
        description: `Discovery/listing primitive for Polymarket market families and candidate contracts.

✅ Uses Polymarket's website-backed /search-v2 discovery surface first, with local reranking and fallback search if needed.

USE THIS when the user wants to:
- see which live markets exist about a topic
- map a family of related contracts before choosing one
- get slugs, URLs, or conditionIds for follow-up tools

⚠️ DO NOT use this as the first choice when:
- the user wants ONE event plus all current outcomes/prices -> prefer search_and_get_outcomes
- the user names 2+ outcomes in the SAME event -> prefer compare_event_outcome_quotes

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
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Discovery query for candidate markets or market families. Examples: 'boots on the ground iran polymarket', 'us forces enter iran by', 'supreme court trump tariffs', 'world cup winner'. Use broader topic language here, not same-event outcome comparison prompts.",
                    examples: [
                        "boots on the ground iran polymarket",
                        "us forces enter iran by",
                        "supreme court trump tariffs",
                        "world cup winner",
                    ],
                },
                category: {
                    type: "string",
                    description: "Filter by category (e.g., 'politics', 'crypto', 'sports')",
                },
                status: {
                    type: "string",
                    enum: ["live", "resolved", "all"],
                    description: "Filter by market status: 'live' (default) = still trading/open for bets, 'resolved' = already finished/closed, 'all' = both",
                    default: "live",
                },
                limit: {
                    type: "number",
                    description: "Number of results (default: 20, max: 50)",
                    default: 20,
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
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
                            yesTokenId: {
                                type: "string",
                                description: "Primary YES token ID for the matched market when available. Use directly with get_market_parameters, get_prices, or get_spreads.",
                            },
                            tokenId: {
                                type: "string",
                                description: "Alias of yesTokenId for downstream code that expects tokenId.",
                            },
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
                searchMetadata: CONTRIBUTOR_SEARCH_METADATA_OUTPUT_SCHEMA,
                dataProvenanceNote: {
                    type: "string",
                    description: "Explicit freshness / anti-hallucination note for synthesis",
                },
                fetchedAt: { type: "string" },
            },
            required: ["results", "count"],
        },
    },
    {
        name: "get_market_trades",
        description: `Get recent RAW trades for a specific market. Returns individual trade records with side, price, size, and notional value.

⚠️ DO NOT USE for size-bucket analysis, whale-vs-retail breakdowns, or net directional flow. Use analyze_whale_flow instead -- it pages the trade tape, reports tradeCoverage, buckets trades into Small/Medium/Large/Whale, calculates YES-directional flow, and gates divergence claims by coverage.

USE THIS FOR: "Show me the last 50 raw trades" or when you need individual trade records with wallet addresses.
USE analyze_whale_flow FOR: "Break down trading by size bucket", "Are whales buying or selling?", "Whale vs retail activity", "Net directional flow", "Trade size analysis".`,
        inputSchema: {
            type: "object",
            properties: {
                conditionId: {
                    type: "string",
                    description: "The market condition ID",
                },
                limit: {
                    type: "number",
                    description: "Number of raw trade records to return (default: 50, max: 500). The summary may analyze more rows depending on coverageMode.",
                },
                hoursBack: {
                    type: "number",
                    description: "Lookback window for the summary/coverage calculation (default: 24)",
                },
                coverageMode: {
                    type: "string",
                    enum: ["quick", "standard", "deep"],
                    description: "How aggressively to page the public trades API for summary coverage (default: quick for raw trades).",
                },
                minNotional: {
                    type: "number",
                    description: "Optional minimum USD notional filter for the public trades API. Use for raw large/whale prints; omit for ordinary recent tape.",
                },
                side: {
                    type: "string",
                    enum: ["BUY", "SELL"],
                    description: "Optional public trade side filter. Use only when the user asks for one side of the tape.",
                },
                user: {
                    type: "string",
                    description: "Optional Polymarket wallet/proxy address filter for wallet-specific trades.",
                },
            },
            required: ["conditionId"],
        },
        outputSchema: {
            type: "object",
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
                tradeCoverage: {
                    type: "object",
                    description: "Coverage diagnostics for the rows used in the summary; raw trades returned may be truncated to the requested limit.",
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
            type: "object",
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
            type: "object",
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
        description: "Get on-chain user activity from the Polymarket Data API. Useful for tracking trade flow, side bias (BUY/SELL), and recent wallet behavior.",
        inputSchema: {
            type: "object",
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
                    description: "Optional activity type filter (TRADE, SPLIT, MERGE, REDEEM, REWARD, CONVERSION, MAKER_REBATE)",
                },
            },
            required: ["address"],
        },
        outputSchema: {
            type: "object",
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
        description: "Get total marked-to-market value of a user's positions from Polymarket Data API /value.",
        inputSchema: {
            type: "object",
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
            type: "object",
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
        description: "Get open interest from Polymarket Data API /oi for one or more conditionIds. This is a snapshot endpoint, not a time series, so it can answer current OI level but not true rate-of-change without a second snapshot.",
        inputSchema: {
            type: "object",
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
            type: "object",
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
                changeRateAvailable: { type: "boolean" },
                note: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["openInterest", "totalOpenInterest"],
        },
    },
    {
        name: "get_event_live_volume",
        description: "Get real-time event-level volume breakdown from Polymarket Data API /live-volume. Accepts eventId directly, or resolves from slug/eventQuery first. Use this for prompts like 'Within this event, which submarkets are taking the biggest share of live trading right now?' This tool should be called directly for deictic event prompts and can choose a strong live fallback event instead of asking the user to pick an internal method. If total is zero or no markets are returned, treat the live breakdown as unavailable and do not infer submarket shares.",
        inputSchema: {
            type: "object",
            properties: {
                eventId: {
                    anyOf: [{ type: "number" }, { type: "string" }],
                    description: "Polymarket event id (number or numeric string)",
                },
                slug: {
                    type: "string",
                    description: "Polymarket event slug. Alternative to eventId when you already know the event URL slug.",
                },
                eventQuery: {
                    type: "string",
                    description: "Natural-language event reference or raw prompt. Use when the user says 'this event' and eventId is not yet known.",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                eventId: { type: "number" },
                eventTitle: { type: "string" },
                eventSlug: { type: "string" },
                total: { type: "number" },
                markets: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            market: {
                                type: "string",
                                description: "Legacy alias for the conditionId returned by the upstream live-volume API.",
                            },
                            conditionId: {
                                type: "string",
                                description: "ConditionId for the submarket row. Join this to get_event_by_slug.markets[].conditionId instead of comparing against question text.",
                            },
                            title: {
                                type: "string",
                                description: "Best-effort human-readable submarket question/title matched from the event markets array.",
                            },
                            value: { type: "number" },
                            shareOfEventTotal: {
                                type: "number",
                                description: "value / total when total > 0. Safe to use only when volumeBreakdownAvailable is true.",
                            },
                        },
                    },
                },
                volumeBreakdownAvailable: {
                    type: "boolean",
                    description: "True only when the tool returned both a positive event total and at least one market row suitable for share calculations.",
                },
                warning: {
                    type: "string",
                    description: "Present when live-volume share calculations should not be made from this response.",
                },
                selectionReason: {
                    type: "string",
                    description: "How the tool resolved the target event when no explicit eventId was supplied.",
                },
                fetchedAt: { type: "string" },
            },
            required: ["eventId", "total", "markets"],
        },
    },
    {
        name: "get_top_holders",
        description: `Get the top holders (biggest positions) for a specific market. Shows the largest holders, their position sizes, and implied conviction. Essential for smart money analysis.

DEEP FETCHING (default=true): Uses a single /holders call with limit=500 per side, returning up to 500 top holders sorted descending by share balance (well beyond the public docs' stated 20-cap, which is stale). This is the deepest public top-holder snapshot we can get from Polymarket's Data API, not a tiny top-20 sample. It should capture material whales, though it is still bounded by the upstream top-500-per-side response. If the upstream ever regresses to the doc'd 20-cap we automatically fall back to a paced minBalance tier sweep.

WHALE THRESHOLD: a holder counts as whale-sized at >=${formatUsdThreshold(HOLDER_WHALE_MIN_USD)} current value OR >=${HOLDER_WHALE_MIN_SUPPLY_PERCENT}% of scanned side supply. >=${formatUsdThreshold(HOLDER_LARGE_MIN_USD)} is reported as large-holder participation, not whale participation by itself.

Set deepFetch=false for faster but shallower results (20 per side max).

⏱️ PERFORMANCE: With deepFetch=true, a single /holders call typically completes in ~1-2s.
The response includes scanMode, perCallLimit, and perSideScanCeilingHit so callers can tell whether the deep single-call path or the fallback tier sweep was used, and whether the scan ceiling may have truncated a long tail.`,
        inputSchema: {
            type: "object",
            properties: {
                conditionId: {
                    type: "string",
                    description: "The market condition ID (0x-prefixed 66-char hex). Preferred when known. If you only have a market name, pass marketQuery instead and the tool will resolve the conditionId automatically.",
                },
                slug: {
                    type: "string",
                    description: "Optional event/market slug (e.g. 'will-okc-win-2026-nba-finals'). Used when conditionId is not known.",
                },
                marketQuery: {
                    type: "string",
                    description: "Natural-language market title/question (e.g. 'Will the Oklahoma City Thunder win the 2026 NBA Finals?'). Used when conditionId and slug are unknown — the tool resolves this to a real conditionId before fetching holders. Pass this instead of fabricating a placeholder conditionId.",
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
            required: [],
        },
        outputSchema: {
            type: "object",
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
                                    positionTier: {
                                        type: "string",
                                        enum: ["whale", "large", "small"],
                                        description: "whale means >= $10k current value or >= 1% of scanned side supply; large means >= $1k but below whale threshold",
                                    },
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
                                    positionTier: {
                                        type: "string",
                                        enum: ["whale", "large", "small"],
                                    },
                                },
                            },
                        },
                    },
                },
                totalUniqueHolders: {
                    type: "number",
                    description: "Combined YES + NO holders found after deep-fetch deduplication",
                },
                holdersReturned: {
                    type: "object",
                    properties: {
                        yes: { type: "number" },
                        no: { type: "number" },
                    },
                },
                holdersScanned: {
                    type: "object",
                    properties: {
                        yes: { type: "number" },
                        no: { type: "number" },
                    },
                },
                positionValueSummary: {
                    type: "object",
                    properties: {
                        yesTotalValue: {
                            type: "number",
                            description: "Total current YES-side position value across the full scanned holder set",
                        },
                        noTotalValue: {
                            type: "number",
                            description: "Total current NO-side position value across the full scanned holder set",
                        },
                        yesWhaleCount: {
                            type: "number",
                            description: "Number of YES holders above the whale threshold across the full scanned set",
                        },
                        noWhaleCount: {
                            type: "number",
                            description: "Number of NO holders above the whale threshold across the full scanned set",
                        },
                        yesLargeHolderCount: {
                            type: "number",
                            description: "Number of YES holders with at least $1k current value across the full scanned set",
                        },
                        noLargeHolderCount: {
                            type: "number",
                            description: "Number of NO holders with at least $1k current value across the full scanned set",
                        },
                        yesWhaleValue: {
                            type: "number",
                            description: "Current YES-side value held by whale-sized positions across the full scanned set",
                        },
                        noWhaleValue: {
                            type: "number",
                            description: "Current NO-side value held by whale-sized positions across the full scanned set",
                        },
                    },
                },
                concentration: {
                    type: "object",
                    description: "How concentrated the market is",
                    properties: {
                        top10YesPercent: { type: "number", description: "% of YES held by top 10" },
                        top10NoPercent: { type: "number", description: "% of NO held by top 10" },
                        whaleCount: {
                            type: "number",
                            description: "Holders with >= $10k current value or >= 1% of scanned side supply",
                        },
                        largeHolderCount: {
                            type: "number",
                            description: "Holders with >= $1k current value",
                        },
                    },
                },
                scanMode: {
                    type: "string",
                    enum: ["deep-single-call", "legacy-tier-sweep", "shallow"],
                    description: "Which /holders fetch path was actually used (single call up to 500, fallback tier sweep, or shallow limit=20).",
                },
                perCallLimit: {
                    type: "number",
                    description: "The limit used per /holders call during the selected scan mode.",
                },
                perSideScanCeilingHit: {
                    type: "boolean",
                    description: "True when at least one side returned exactly the per-call limit, signalling a long tail of smaller holders may exist beyond the scan. The largest holders and material whale-sized positions should still be captured.",
                },
                fetchMethod: { type: "string" },
                note: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["market", "conditionId", "topHolders"],
        },
    },
    {
        name: "get_market_comments",
        description: "Get comments and discussion for a market or event. Useful for understanding market sentiment, identifying controversies, and seeing what traders are saying.",
        inputSchema: {
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
            type: "object",
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
    const existingMeta = "_meta" in tool && typeof tool._meta === "object" && tool._meta !== null
        ? tool._meta
        : {};
    const { pricing: _existingPricing, ...existingMetaWithoutPricing } = existingMeta;
    const latencyClass = HEAVY_ANALYSIS_TOOLS.has(tool.name)
        ? "slow"
        : "instant";
    const surface = resolveToolSurface(tool.name);
    const queryEligible = true;
    const pricing = resolveExecutePricingMeta(tool.name, existingMeta);
    return {
        ...tool,
        _meta: {
            ...existingMetaWithoutPricing,
            surface,
            queryEligible,
            latencyClass,
            ...(pricing ? { pricing } : {}),
            rateLimit: buildToolRateLimitMetadata(tool.name),
        },
    };
});
// ============================================================================
// MCP SERVER SETUP
// ============================================================================
const server = new Server({ name: "polymarket-intelligence", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS_WITH_METADATA,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
            case "analyze_single_market_whales":
                return await handleAnalyzeSingleMarketWhales(args);
            case "summarize_live_market_activity":
                return await handleSummarizeLiveMarketActivity(args);
            case "analyze_event_whale_breakdown":
                return await handleAnalyzeEventWhaleBreakdown(args);
            case "analyze_event_outcome_liquidity":
                return await handleAnalyzeEventOutcomeLiquidity(args);
            case "rank_event_tradability":
                return await handleRankEventTradability(args);
            case "compare_event_outcome_quotes":
                return await handleCompareEventOutcomeQuotes(args);
            case "compare_market_against_related_contracts":
                return await handleCompareMarketAgainstRelatedContracts(args);
            case "find_correlated_markets":
                return await handleFindCorrelatedMarkets(args);
            case "check_market_rules":
                return await handleCheckMarketRules(args);
            case "build_market_tradability_memo":
                return await handleBuildMarketTradabilityMemo(args);
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
            case "polymarket_crossref_kalshi":
                return await handleSearchOnKalshi(args);
            case "analyze_my_positions":
                return await handleAnalyzeMyPositions(args);
            // Trading Tools (Redirect to Polymarket UI)
            case "place_polymarket_order":
                return await handlePlacePolymarketOrder(args);
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
function getNonEmptyString(value) {
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}
function getFiniteNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value !== "string") {
        return null;
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
        return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}
function extractTextFromOpenRouterContent(content) {
    if (typeof content === "string") {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return "";
    }
    const fragments = [];
    for (const item of content) {
        if (!item || typeof item !== "object") {
            continue;
        }
        if ("text" in item && typeof item.text === "string") {
            fragments.push(item.text);
            continue;
        }
        if ("content" in item && typeof item.content === "string") {
            fragments.push(item.content);
        }
    }
    return fragments.join("\n").trim();
}
function extractJsonObjectText(rawText) {
    const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
        return fencedMatch[1].trim();
    }
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start >= 0 && end > start) {
        return rawText.slice(start, end + 1).trim();
    }
    return rawText.trim();
}
function normalizeJudgeCandidateIds(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const normalizedIds = [];
    const seen = new Set();
    for (const entry of value) {
        if (typeof entry !== "string") {
            continue;
        }
        const normalized = entry.trim();
        if (normalized.length === 0 || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        normalizedIds.push(normalized);
    }
    return normalizedIds;
}
function normalizeJudgeConfidence(value) {
    if (value === "high" || value === "medium" || value === "low") {
        return value;
    }
    return "low";
}
function parseContributorSearchJudgeResult(rawText) {
    const parsed = JSON.parse(extractJsonObjectText(rawText));
    return {
        primaryCandidateId: typeof parsed.primaryCandidateId === "string"
            ? parsed.primaryCandidateId.trim() || null
            : null,
        relatedCandidateIds: normalizeJudgeCandidateIds(parsed.relatedCandidateIds),
        rejectedCandidateIds: normalizeJudgeCandidateIds(parsed.rejectedCandidateIds),
        confidence: normalizeJudgeConfidence(parsed.confidence),
        reason: typeof parsed.reason === "string" && parsed.reason.trim().length > 0
            ? parsed.reason.trim()
            : "OpenRouter judge selected a candidate.",
    };
}
function createPolymarketOpenRouterJudge() {
    if (!POLYMARKET_SEARCH_JUDGE_API_KEY || POLYMARKET_SEARCH_JUDGE_DISABLE) {
        return null;
    }
    return {
        async evaluate(input, context) {
            const shortlist = input.shortlist.candidates.map((candidate, index) => ({
                rank: index + 1,
                candidateId: candidate.candidateId,
                title: candidate.title,
                description: candidate.description ?? null,
                rawIds: candidate.rawIds ?? {},
                rankFeatures: candidate.rankFeatures ?? {},
                metadata: candidate.metadata ?? {},
                provenance: candidate.provenance.map((provenance) => ({
                    source: provenance.source,
                    query: provenance.query,
                    rank: provenance.rank,
                })),
            }));
            const response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${POLYMARKET_SEARCH_JUDGE_API_KEY}`,
                    "Content-Type": "application/json",
                    "HTTP-Referer": POLYMARKET_SEARCH_JUDGE_REFERER,
                    "X-Title": POLYMARKET_SEARCH_JUDGE_TITLE,
                },
                body: JSON.stringify({
                    model: context.model ?? POLYMARKET_SEARCH_JUDGE_MODEL,
                    temperature: 0,
                    response_format: { type: "json_object" },
                    messages: [
                        {
                            role: "system",
                            content: "You are a contributor-side Polymarket search judge. Return exactly one JSON object with keys primaryCandidateId, relatedCandidateIds, rejectedCandidateIds, confidence, and reason. Never invent candidate ids that are not present in the shortlist.",
                        },
                        {
                            role: "user",
                            content: JSON.stringify({
                                rawRequest: input.rawRequest,
                                intents: input.intents,
                                instructions: input.instructions ?? POLYMARKET_SEARCH_JUDGE_INSTRUCTIONS,
                                traceLabel: context.traceLabel,
                                shortlist,
                            }, null, 2),
                        },
                    ],
                }),
            });
            if (!response.ok) {
                throw new Error(`OpenRouter judge request failed with ${response.status} ${response.statusText}`);
            }
            const payload = (await response.json());
            const choices = Array.isArray(payload.choices) ? payload.choices : [];
            const firstChoice = choices[0] && typeof choices[0] === "object"
                ? choices[0]
                : null;
            const message = firstChoice &&
                typeof firstChoice.message === "object" &&
                firstChoice.message !== null
                ? firstChoice.message
                : null;
            const rawText = extractTextFromOpenRouterContent(message?.content);
            if (rawText.length === 0) {
                throw new Error("OpenRouter judge returned empty content.");
            }
            const result = parseContributorSearchJudgeResult(rawText);
            const usage = typeof payload.usage === "object" && payload.usage !== null
                ? payload.usage
                : null;
            if (usage) {
                result.usage = {
                    promptTokens: getFiniteNumber(usage.prompt_tokens) ?? undefined,
                    completionTokens: getFiniteNumber(usage.completion_tokens) ?? undefined,
                    totalTokens: getFiniteNumber(usage.total_tokens) ?? undefined,
                    costUsd: getNonEmptyString(usage.cost),
                    latencyMs: getFiniteNumber(usage.latency_ms),
                };
            }
            return result;
        },
    };
}
async function resolvePolymarketContributorSearch(params) {
    if (params.candidates.length === 0) {
        return null;
    }
    const judge = createPolymarketOpenRouterJudge();
    const derivedIntentQueries = buildMarketSearchQueries(params.rawRequest);
    const defaultIntentQueries = derivedIntentQueries.length > 1
        ? derivedIntentQueries.slice(1)
        : derivedIntentQueries;
    const intentQueries = (params.intentQueries && params.intentQueries.length > 0
        ? params.intentQueries
        : defaultIntentQueries).slice(0, 3);
    const fallbackIntentQuery = normalizeMarketQueryText(params.rawRequest);
    return await resolveContributorSearch({
        rawRequest: params.rawRequest,
        intents: intentQueries.length > 0
            ? intentQueries.map((query, index) => createSearchIntent({
                rawRequest: params.rawRequest,
                query,
                clause: `polymarket contributor search resolution ${index + 1}`,
            }))
            : [
                createSearchIntent({
                    rawRequest: params.rawRequest,
                    query: fallbackIntentQuery,
                    clause: "polymarket contributor search resolution",
                }),
            ],
        candidates: params.candidates,
        ...(judge ? { judge } : {}),
        contributorConfig: {
            provider: "openrouter",
            model: POLYMARKET_SEARCH_JUDGE_MODEL,
            timeoutMs: POLYMARKET_SEARCH_JUDGE_TIMEOUT_MS,
            budgetUsd: POLYMARKET_SEARCH_JUDGE_BUDGET_USD,
            disableJudge: POLYMARKET_SEARCH_JUDGE_DISABLE,
            degradedOutcomePolicy: "allow_low_confidence_selected",
            maxShortlistSize: judge ? POLYMARKET_SEARCH_JUDGE_MAX_SHORTLIST : 1,
        },
        instructions: params.instructions ?? POLYMARKET_SEARCH_JUDGE_INSTRUCTIONS,
        traceLabel: params.traceLabel,
    });
}
function buildPolymarketEventSearchCandidate(params) {
    const matchedOutcome = params.matchedMarket?.groupItemTitle ||
        params.matchedMarket?.question ||
        params.matchedMarket?.title ||
        null;
    const candidateId = params.event.slug ||
        params.matchedMarket?.conditionId ||
        params.event.conditionId ||
        params.event.id ||
        `${params.rank}-${normalizeMarketQueryText(params.event.title || params.query)}`;
    const endDate = params.event.endDate || params.event.endDateIso || null;
    const descriptionParts = [matchedOutcome, endDate ? `Resolves ${endDate}` : null]
        .filter((part) => typeof part === "string" && part.length > 0);
    return {
        candidateId,
        title: params.event.title || matchedOutcome || params.query,
        description: descriptionParts.length > 0 ? descriptionParts.join(" | ") : null,
        rawIds: {
            ...(params.event.slug ? { slug: params.event.slug } : {}),
            ...(params.matchedMarket?.conditionId
                ? { conditionId: params.matchedMarket.conditionId }
                : params.event.conditionId
                    ? { conditionId: params.event.conditionId }
                    : {}),
        },
        rankFeatures: {
            rank: params.rank,
            score: Number(params.score.toFixed(2)),
            volume: Number(params.event.volume || 0),
            liquidity: Number(params.event.liquidity || 0),
            closed: params.event.closed === true,
            matchedOutcome,
        },
        provenance: [
            {
                source: params.source,
                query: params.query,
                rank: params.rank,
                fetchedAt: new Date().toISOString(),
                metadata: {
                    slug: params.event.slug ?? null,
                    matchedOutcome,
                },
            },
        ],
        metadata: {
            category: params.event.category ?? null,
            resolutionDate: endDate,
            closed: params.event.closed === true,
            matchedOutcome,
        },
    };
}
function buildPolymarketResultSearchCandidate(params) {
    const title = getNonEmptyString(params.result.title) ?? params.query;
    const slug = getNonEmptyString(params.result.slug);
    const conditionId = getNonEmptyString(params.result.conditionId);
    const matchedOutcome = getNonEmptyString(params.result.matchedOutcome);
    const endDate = getNonEmptyString(params.result.endDate);
    const score = getFiniteNumber(params.result.score) ?? 0;
    return {
        candidateId: slug ||
            conditionId ||
            `${params.rank}-${normalizeMarketQueryText(title)}`,
        title,
        description: matchedOutcome || endDate
            ? [matchedOutcome, endDate ? `Resolves ${endDate}` : null]
                .filter((part) => Boolean(part))
                .join(" | ")
            : null,
        rawIds: {
            ...(slug ? { slug } : {}),
            ...(conditionId ? { conditionId } : {}),
        },
        rankFeatures: {
            rank: params.rank,
            score: Number(score.toFixed(2)),
            volume: getFiniteNumber(params.result.volume),
            liquidity: getFiniteNumber(params.result.liquidity),
            status: getNonEmptyString(params.result.status),
            matchedOutcome,
        },
        provenance: [
            {
                source: params.source,
                query: params.query,
                rank: params.rank,
                fetchedAt: new Date().toISOString(),
                metadata: {
                    slug,
                    matchedOutcome,
                },
            },
        ],
        metadata: {
            category: getNonEmptyString(params.result.category),
            resolutionDate: endDate,
            status: getNonEmptyString(params.result.status),
            matchedOutcome,
        },
    };
}
// ============================================================================
// API FETCH HELPERS
// ============================================================================
/**
 * Parse JSON string or return array as-is
 * Polymarket API returns some fields as JSON strings (e.g., clobTokenIds, outcomePrices)
 */
function parseJsonArray(value) {
    if (!value)
        return [];
    if (Array.isArray(value))
        return value;
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
/**
 * Generate a Polymarket URL - ALWAYS returns a valid URL
 * Uses slug if available, falls back to conditionId
 */
function getPolymarketUrl(slug, conditionId) {
    if (slug) {
        return `https://polymarket.com/event/${slug}`;
    }
    if (conditionId) {
        return `https://polymarket.com/event/${conditionId}`;
    }
    return "https://polymarket.com/markets";
}
const activeEventSearchIndexCache = new Map();
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
    "which",
    "how",
    "when",
    "where",
    "whether",
    "should",
    "would",
    "could",
    "about",
    "including",
    "that",
    "than",
    "into",
    "now",
    "off",
    "show",
]);
const MARKET_QUERY_VARIANT_STOP_WORDS = new Set([
    "analyze",
    "analysis",
    "answer",
    "answers",
    "around",
    "better",
    "broader",
    "current",
    "compare",
    "dates",
    "explain",
    "focus",
    "focused",
    "help",
    "how",
    "including",
    "implied",
    "into",
    "levels",
    "live",
    "matter",
    "matters",
    "market",
    "markets",
    "odds",
    "position",
    "positioning",
    "price",
    "prices",
    "resolution",
    "resolutions",
    "results",
    "right",
    "risk",
    "pricing",
    "show",
    "should",
    "specific",
    "that",
    "than",
    "today",
    "think",
    "understand",
    "whether",
    "which",
    "would",
    "now",
]);
const MARKET_QUERY_NAMED_TOKEN_STOP_WORDS = new Set([
    ...MARKET_QUERY_STOP_WORDS,
    "how",
    "polymarket",
    "which",
    "why",
]);
const DISCOVERY_CATEGORY_TAG_ALIASES = {
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
        "golf",
        "hockey",
    ],
    crypto: ["crypto", "bitcoin", "ethereum", "cryptocurrency", "defi", "solana"],
    "pop-culture": [
        "pop culture",
        "pop-culture",
        "culture",
        "movies",
        "entertainment",
        "hollywood",
        "music",
        "awards",
    ],
    science: ["science", "tech", "technology", "ai", "space"],
    business: ["business", "economics", "finance", "fed", "inflation", "stocks"],
};
const POLITICS_DISCOVERY_HINT_TERMS = [
    "geopolitics",
    "geopolitical",
    "iran",
    "israel",
    "gaza",
    "ukraine",
    "russia",
    "china",
    "taiwan",
    "ceasefire",
    "troop",
    "troops",
    "military",
    "missile",
    "missiles",
    "sanction",
    "sanctions",
    "tariff",
    "tariffs",
    "strike",
    "strikes",
    "war",
    "attack",
    "attacks",
    "invasion",
    "ally",
    "allied",
    "allies",
    "boots on the ground",
];
const DISCOVERY_QUERY_SYNONYM_GROUPS = [
    [
        "boots",
        "ground",
        "troop",
        "troops",
        "enter",
        "enters",
        "entered",
        "invade",
        "invades",
        "invaded",
        "invasion",
    ],
    ["military", "operation", "operations", "strike", "strikes", "attack", "attacks", "offensive"],
    ["ceasefire", "truce", "deescalation", "peace"],
];
const DISCOVERY_ACTION_HINT_TERMS = new Set(DISCOVERY_QUERY_SYNONYM_GROUPS.flat());
const DISCOVERY_COALITION_HINT_TERMS = new Set([
    "us",
    "american",
    "america",
    "allied",
    "allies",
    "ally",
    "britain",
    "british",
    "uk",
    "coalition",
]);
const ACTIVE_EVENT_SEARCH_ORDER_PLAN = [
    {
        order: "volume24hr",
        pages: ACTIVE_EVENT_SEARCH_INDEX_MAX_PAGES,
    },
    {
        order: "liquidity",
        pages: ACTIVE_EVENT_SEARCH_INDEX_MAX_PAGES,
    },
    {
        order: "startDate",
        pages: 1,
    },
];
function normalizeMarketQueryText(value) {
    const withCollapsedInitialisms = value.replace(/\b(?:[A-Za-z]\.){2,}[A-Za-z]?\.?/g, (match) => match.replace(/\./g, ""));
    return withCollapsedInitialisms
        .toLowerCase()
        .replace(/'s\b/g, "")
        .replace(/,/g, "")
        .replace(/[^a-z0-9$\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function deriveEventSearchQuery(value) {
    const trimmed = value.trim().replace(/[?]+$/g, "");
    const winOnDateMatch = trimmed.match(/^will\s+(.+?)\s+win(?:\s+on\s+(\d{4}-\d{2}-\d{2}))?$/i);
    if (winOnDateMatch?.[1]) {
        return [winOnDateMatch[1].trim(), winOnDateMatch[2]?.trim() ?? ""]
            .filter((part) => part.length > 0)
            .join(" ");
    }
    return trimmed;
}
function extractMarketQueryTokens(value) {
    const normalized = normalizeMarketQueryText(value);
    if (!normalized) {
        return [];
    }
    const tokens = normalized
        .split(" ")
        .map((token) => token.replace(/^\$+/, ""))
        .filter((token) => token.length >= 3 && !MARKET_QUERY_STOP_WORDS.has(token));
    return Array.from(new Set(tokens));
}
function extractNamedMarketQueryTokens(value) {
    const matches = value.match(/\b(?:[A-Z]\.){2,}[A-Z]?\.?|\b[A-Z]{2,}(?:[-/][A-Z]{2,})*|\b[A-Z][a-z]+(?:[-'][A-Za-z]+)*/g) ?? [];
    const deduped = [];
    const seen = new Set();
    for (const match of matches) {
        const cleaned = match.trim();
        const normalized = normalizeMarketQueryText(cleaned);
        if (normalized.length < 2 ||
            MARKET_QUERY_NAMED_TOKEN_STOP_WORDS.has(normalized) ||
            seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        deduped.push(cleaned);
    }
    return deduped;
}
function buildMarketQueryScoringTokens(value) {
    const tokens = [];
    const seen = new Set();
    const addToken = (rawToken) => {
        const normalized = normalizeMarketQueryText(rawToken);
        if (normalized.length < 2 ||
            MARKET_QUERY_VARIANT_STOP_WORDS.has(normalized) ||
            seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        tokens.push(normalized);
    };
    for (const token of extractNamedMarketQueryTokens(value)) {
        addToken(token);
    }
    for (const token of extractMarketQueryTokens(value)) {
        addToken(token);
    }
    return tokens;
}
function buildMarketSearchQueries(value) {
    const trimmed = value.trim();
    const normalized = normalizeMarketQueryText(trimmed);
    if (trimmed.length === 0 || normalized.length === 0) {
        return [];
    }
    const context = buildStructuredMarketSearchContext({ query: trimmed });
    const variants = [];
    const seen = new Set();
    const addVariant = (variant) => {
        if (!variant) {
            return;
        }
        const cleaned = variant.replace(/\s+/g, " ").trim();
        const normalizedVariant = normalizeMarketQueryText(cleaned);
        if (cleaned.length < 3 ||
            normalizedVariant.length < 3 ||
            seen.has(normalizedVariant)) {
            return;
        }
        seen.add(normalizedVariant);
        variants.push(cleaned);
    };
    addVariant(trimmed);
    for (const quotedFragment of workflowExtractQuotedFragments(trimmed)) {
        addVariant(quotedFragment);
    }
    for (const likelyFragment of workflowExtractLikelyOutcomeFragments(trimmed)) {
        addVariant(likelyFragment);
    }
    const namedTokens = context.namedTokens.filter((token) => !MARKET_QUERY_VARIANT_STOP_WORDS.has(token));
    const searchTokens = context.scoringTokens.filter((token) => !MARKET_QUERY_VARIANT_STOP_WORDS.has(token));
    const variantTokens = searchTokens.filter((token) => token !== "polymarket");
    const coalitionTokens = variantTokens.filter((token) => DISCOVERY_COALITION_HINT_TERMS.has(token));
    const actionTokens = variantTokens.filter((token) => DISCOVERY_ACTION_HINT_TERMS.has(token));
    const placeTokens = Array.from(new Set([...namedTokens, ...variantTokens.filter((token) => POLITICS_DISCOVERY_HINT_TERMS.includes(token))].filter((token) => !DISCOVERY_COALITION_HINT_TERMS.has(token))));
    if (namedTokens.length > 0) {
        addVariant(namedTokens.slice(0, 3).join(" "));
    }
    if (variantTokens.length > 0) {
        addVariant(variantTokens.slice(0, 4).join(" "));
    }
    const primaryPlace = placeTokens[0];
    const preferredActionTokens = ["enter", "invade"].filter((token) => actionTokens.includes(token));
    const actionSlice = preferredActionTokens.length > 0
        ? preferredActionTokens
        : actionTokens.slice(0, 2);
    if (normalized.includes("boots on the ground") && primaryPlace) {
        addVariant(`boots on the ground ${primaryPlace}`);
        if (normalized.includes("polymarket")) {
            addVariant(`boots on the ground ${primaryPlace} polymarket`);
        }
    }
    if (primaryPlace && actionSlice.length > 0) {
        if (coalitionTokens.length > 0) {
            addVariant([...coalitionTokens.slice(0, 2), ...actionSlice.slice(0, 2), primaryPlace].join(" "));
        }
        addVariant([...actionSlice.slice(0, 2), primaryPlace].join(" "));
    }
    if (variantTokens.length > 1) {
        addVariant(`${variantTokens[0]} ${variantTokens.at(-1)}`);
    }
    return variants.slice(0, 6);
}
async function searchGammaEventsByVariants(params) {
    const queries = buildMarketSearchQueries(params.query);
    if (queries.length === 0) {
        return [];
    }
    const eventsByKey = new Map();
    const cappedLimitPerType = Math.min(Math.max(params.limitPerType, 1), 24);
    for (const searchQuery of queries) {
        let endpoint = `/public-search?q=${encodeURIComponent(searchQuery)}` +
            `&limit_per_type=${cappedLimitPerType}` +
            "&search_tags=false&search_profiles=false&optimized=true";
        if (params.eventsStatus) {
            endpoint += `&events_status=${params.eventsStatus}`;
        }
        if (params.includeClosed) {
            endpoint += "&keep_closed_markets=1";
        }
        const searchData = (await fetchJsonWithPolicy({
            upstream: "gamma",
            endpoint,
            timeoutMs: 8_000,
            init: {
                headers: {
                    Accept: "application/json",
                    "User-Agent": "Polymarket-MCP-Server/1.0",
                },
            },
        }));
        const events = Array.isArray(searchData.events) ? searchData.events : [];
        for (const event of events) {
            const key = event.slug || event.id || event.title || "";
            if (key.length === 0 || eventsByKey.has(key)) {
                continue;
            }
            eventsByKey.set(key, event);
        }
        if (eventsByKey.size >= cappedLimitPerType * 2) {
            break;
        }
    }
    return [...eventsByKey.values()];
}
async function searchGammaEventsByWebsiteSearch(params) {
    const trimmedQuery = params.query.trim();
    if (trimmedQuery.length === 0) {
        return [];
    }
    const cappedLimitPerType = Math.min(Math.max(params.limitPerType, 1), WEBSITE_SEARCH_V2_PAGE_SIZE);
    const maxPages = Math.min(Math.max(params.maxPages ??
        (params.eventsStatus === "closed"
            ? WEBSITE_SEARCH_V2_CLOSED_MAX_PAGES
            : WEBSITE_SEARCH_V2_ACTIVE_MAX_PAGES), 1), 6);
    const eventsByKey = new Map();
    const queries = buildMarketSearchQueries(trimmedQuery);
    for (const searchQuery of queries) {
        for (let page = 1; page <= maxPages; page += 1) {
            let endpoint = `/search-v2?q=${encodeURIComponent(searchQuery)}` +
                `&page=${page}` +
                `&limit_per_type=${cappedLimitPerType}` +
                "&type=events&optimized=false";
            if (params.eventsStatus) {
                endpoint += `&events_status=${params.eventsStatus}`;
            }
            const searchData = (await fetchJsonWithPolicy({
                upstream: "gamma",
                endpoint,
                timeoutMs: 8_000,
                init: {
                    headers: {
                        Accept: "application/json",
                        "User-Agent": "Polymarket-MCP-Server/1.0",
                    },
                },
            }));
            const events = Array.isArray(searchData.events) ? searchData.events : [];
            for (const event of events) {
                const key = event.slug || event.id || event.title || "";
                if (key.length === 0 || eventsByKey.has(key)) {
                    continue;
                }
                eventsByKey.set(key, event);
            }
            if (searchData.pagination?.hasMore !== true || events.length < cappedLimitPerType) {
                break;
            }
        }
    }
    return [...eventsByKey.values()];
}
function extractPriceTargets(value) {
    const normalized = value.toLowerCase().replace(/,/g, "");
    const targets = new Set();
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
function normalizeDiscoveryCategoryTagSlug(value) {
    if (!value) {
        return undefined;
    }
    const normalized = normalizeMarketQueryText(value).replace(/\s+/g, " ").trim();
    if (!normalized) {
        return undefined;
    }
    for (const [tagSlug, aliases] of Object.entries(DISCOVERY_CATEGORY_TAG_ALIASES)) {
        if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) {
            return tagSlug;
        }
    }
    return normalized.replace(/\s+/g, "-");
}
function inferDiscoveryCategoryTagSlug(value) {
    const normalized = normalizeMarketQueryText(value);
    if (!normalized) {
        return undefined;
    }
    const queryText = ` ${normalized} `;
    const hasAliasMatch = (aliases) => aliases.some((alias) => queryText.includes(` ${alias} `) || normalized.includes(alias));
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES.politics) ||
        POLITICS_DISCOVERY_HINT_TERMS.some((term) => queryText.includes(` ${term} `) || normalized.includes(term))) {
        return "politics";
    }
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES.crypto)) {
        return "crypto";
    }
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES.sports)) {
        return "sports";
    }
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES.business)) {
        return "business";
    }
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES.science)) {
        return "science";
    }
    if (hasAliasMatch(DISCOVERY_CATEGORY_TAG_ALIASES["pop-culture"])) {
        return "pop-culture";
    }
    return undefined;
}
function resolveDiscoveryCategoryTagSlug(params) {
    return (normalizeDiscoveryCategoryTagSlug(params.category) ??
        (params.query ? inferDiscoveryCategoryTagSlug(params.query) : undefined));
}
function expandStructuredSearchTokens(normalizedQuery, baseTokens) {
    const expanded = new Set(baseTokens);
    const queryText = ` ${normalizedQuery} `;
    for (const group of DISCOVERY_QUERY_SYNONYM_GROUPS) {
        if (!group.some((token) => queryText.includes(` ${token} `))) {
            continue;
        }
        for (const token of group) {
            if (token.length >= 3 &&
                !MARKET_QUERY_VARIANT_STOP_WORDS.has(token)) {
                expanded.add(token);
            }
        }
    }
    return [...expanded];
}
function buildStructuredMarketSearchContext(params) {
    const normalizedQuery = normalizeMarketQueryText(params.query);
    const scoringTokens = expandStructuredSearchTokens(normalizedQuery, buildMarketQueryScoringTokens(params.query));
    return {
        normalizedQuery,
        compactQuery: normalizedQuery.replace(/[^a-z0-9]/g, ""),
        namedTokens: extractNamedMarketQueryTokens(params.query).map((token) => normalizeMarketQueryText(token)),
        scoringTokens,
        queryTargets: extractPriceTargets(params.query),
        categoryTagSlug: resolveDiscoveryCategoryTagSlug(params),
    };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasWordBoundaryMatch(text, token) {
    if (!token) {
        return false;
    }
    return new RegExp(`\\b${escapeRegExp(token)}\\b`, "i").test(text);
}
function getEventTagSearchText(event) {
    return (event.tags ?? [])
        .flatMap((tag) => [tag.slug ?? "", tag.label ?? ""])
        .join(" ");
}
function eventMatchesDiscoveryCategoryTagSlug(event, tagSlug) {
    const normalizedTagSlug = normalizeDiscoveryCategoryTagSlug(tagSlug);
    if (!normalizedTagSlug) {
        return true;
    }
    if (normalizeDiscoveryCategoryTagSlug(event.category) === normalizedTagSlug) {
        return true;
    }
    const normalizedTagSearchText = normalizeMarketQueryText(getEventTagSearchText(event));
    if (!normalizedTagSearchText) {
        return false;
    }
    const aliases = DISCOVERY_CATEGORY_TAG_ALIASES[normalizedTagSlug] ?? [
        normalizedTagSlug.replace(/-/g, " "),
    ];
    return aliases.some((alias) => {
        const normalizedAlias = normalizeMarketQueryText(alias);
        return (normalizedAlias.length > 0 &&
            (hasWordBoundaryMatch(normalizedTagSearchText, normalizedAlias) ||
                normalizedTagSearchText.includes(normalizedAlias)));
    });
}
function filterEventsByStructuredSearchContext(params) {
    if (!params.context.categoryTagSlug) {
        return params.events;
    }
    const filtered = params.events.filter((event) => eventMatchesDiscoveryCategoryTagSlug(event, params.context.categoryTagSlug));
    return filtered.length > 0 ? filtered : params.events;
}
function buildActiveEventCandidateText(event, market) {
    return [
        event.title || "",
        event.slug || "",
        event.category || "",
        getEventTagSearchText(event),
        market.groupItemTitle || "",
        market.question || "",
        market.title || "",
    ].join(" ");
}
function getActiveEventIndexCacheKey(params) {
    return JSON.stringify({
        tagSlug: params.tagSlug?.trim().toLowerCase() || "",
    });
}
function readActiveEventIndexCache(cacheKey, options) {
    const cached = activeEventSearchIndexCache.get(cacheKey);
    if (!cached) {
        return null;
    }
    const now = Date.now();
    if (cached.expiresAt > now) {
        return cloneCachedPayload(cached.value);
    }
    if (options?.allowStaleOnError && cached.staleIfErrorUntil > now) {
        return cloneCachedPayload(cached.value);
    }
    if (cached.staleIfErrorUntil <= now) {
        activeEventSearchIndexCache.delete(cacheKey);
    }
    return null;
}
function writeActiveEventIndexCache(cacheKey, value) {
    const now = Date.now();
    activeEventSearchIndexCache.set(cacheKey, {
        value: cloneCachedPayload(value),
        expiresAt: now + ACTIVE_EVENT_SEARCH_INDEX_CACHE_TTL_MS,
        staleIfErrorUntil: now + ACTIVE_EVENT_SEARCH_INDEX_STALE_IF_ERROR_TTL_MS,
    });
}
async function buildActiveEventSearchIndex(params) {
    const eventsByKey = new Map();
    const sourceOrders = [];
    for (const plan of ACTIVE_EVENT_SEARCH_ORDER_PLAN) {
        for (let page = 0; page < plan.pages; page += 1) {
            const eventParams = new URLSearchParams({
                active: "true",
                closed: "false",
                limit: String(ACTIVE_EVENT_SEARCH_INDEX_PAGE_SIZE),
                offset: String(page * ACTIVE_EVENT_SEARCH_INDEX_PAGE_SIZE),
                order: plan.order,
                ascending: "false",
            });
            if (params.tagSlug) {
                eventParams.set("tag_slug", params.tagSlug);
            }
            const events = (await fetchGamma(`/events?${eventParams.toString()}`, 10_000, 2));
            sourceOrders.push(`${plan.order}:${page}`);
            for (const event of Array.isArray(events) ? events : []) {
                const key = event.slug || event.id || "";
                if (!key || eventsByKey.has(key)) {
                    continue;
                }
                eventsByKey.set(key, event);
            }
            if (!Array.isArray(events) || events.length < ACTIVE_EVENT_SEARCH_INDEX_PAGE_SIZE) {
                break;
            }
        }
    }
    return {
        events: [...eventsByKey.values()],
        builtAt: new Date().toISOString(),
        tagSlug: params.tagSlug,
        sourceOrders,
    };
}
async function getActiveEventSearchIndex(params) {
    const cacheKey = getActiveEventIndexCacheKey(params);
    const cached = readActiveEventIndexCache(cacheKey);
    if (cached) {
        return cached;
    }
    try {
        const fresh = await buildActiveEventSearchIndex(params);
        writeActiveEventIndexCache(cacheKey, fresh);
        return cloneCachedPayload(fresh);
    }
    catch (error) {
        const stale = readActiveEventIndexCache(cacheKey, {
            allowStaleOnError: true,
        });
        if (stale) {
            console.warn("[polymarket-active-index] serving stale cache", {
                tagSlug: params.tagSlug ?? null,
                error: error instanceof Error
                    ? error.message.slice(0, 160)
                    : String(error).slice(0, 160),
            });
            return stale;
        }
        throw error;
    }
}
function scoreIndexedActiveEventCandidate(params) {
    const { context, event, market } = params;
    const normalizedCandidateText = normalizeMarketQueryText(buildActiveEventCandidateText(event, market));
    if (!normalizedCandidateText) {
        return 0;
    }
    const compactCandidateText = normalizedCandidateText.replace(/[^a-z0-9]/g, "");
    const normalizedCategoryText = normalizeMarketQueryText(`${event.category || ""} ${getEventTagSearchText(event)}`);
    let score = 0;
    if (context.normalizedQuery &&
        normalizedCandidateText.includes(context.normalizedQuery)) {
        score += 260;
    }
    if (context.compactQuery.length >= 8 &&
        compactCandidateText.includes(context.compactQuery)) {
        score += 45;
    }
    let namedMatches = 0;
    for (const token of context.namedTokens) {
        if (hasWordBoundaryMatch(normalizedCandidateText, token)) {
            namedMatches += 1;
            score += 80;
            continue;
        }
        if (normalizedCandidateText.includes(token)) {
            namedMatches += 1;
            score += 45;
        }
    }
    let tokenMatches = 0;
    for (const token of context.scoringTokens) {
        if (context.namedTokens.includes(token)) {
            continue;
        }
        if (hasWordBoundaryMatch(normalizedCandidateText, token)) {
            tokenMatches += 1;
            score += 24;
            continue;
        }
        if (normalizedCandidateText.includes(token)) {
            tokenMatches += 1;
            score += 12;
        }
    }
    if (context.namedTokens.length > 0) {
        if (namedMatches === 0) {
            score -= 120;
        }
        else if (namedMatches === context.namedTokens.length) {
            score += 90;
        }
    }
    if (context.namedTokens.length >= 2) {
        const [firstToken, secondToken] = context.namedTokens;
        const firstIndex = normalizedCandidateText.indexOf(firstToken);
        const secondIndex = firstIndex >= 0
            ? normalizedCandidateText.indexOf(secondToken, firstIndex + firstToken.length)
            : -1;
        if (firstIndex >= 0 && secondIndex > firstIndex) {
            score += 45;
        }
    }
    if (context.scoringTokens.length >= 2) {
        for (let i = 0; i < context.scoringTokens.length - 1; i += 1) {
            const phrase = `${context.scoringTokens[i]} ${context.scoringTokens[i + 1]}`;
            if (normalizedCandidateText.includes(phrase)) {
                score += 12;
                break;
            }
        }
    }
    if (context.categoryTagSlug &&
        normalizedCategoryText.includes(context.categoryTagSlug)) {
        score += 55;
    }
    if (context.queryTargets.length > 0) {
        const candidateTargets = extractPriceTargets(normalizedCandidateText);
        let targetOverlap = 0;
        for (const queryTarget of context.queryTargets) {
            const matched = candidateTargets.some((candidateTarget) => {
                const tolerance = Math.max(1000, Math.round(queryTarget * 0.02));
                return Math.abs(candidateTarget - queryTarget) <= tolerance;
            });
            if (matched) {
                targetOverlap += 1;
            }
        }
        if (targetOverlap > 0) {
            score += targetOverlap * 120;
        }
    }
    const volumeSignal = Number(event.volume24hr || event.volume || market.volume24hr || market.volume || 0);
    if (Number.isFinite(volumeSignal) && volumeSignal > 0) {
        score += Math.min(24, Math.log10(volumeSignal + 1) * 4);
    }
    return score + tokenMatches;
}
function rankIndexedActiveEventCandidates(params) {
    const candidates = [];
    for (const event of params.events) {
        for (const market of event.markets ?? []) {
            if (!market.conditionId &&
                !market.slug &&
                !event.slug) {
                continue;
            }
            const marketIsClosed = event.closed === true || market.closed === true || market.active === false;
            if (!params.includeClosed && marketIsClosed) {
                continue;
            }
            const score = scoreIndexedActiveEventCandidate({
                context: params.context,
                event,
                market,
            });
            if (score <= 0) {
                continue;
            }
            candidates.push({
                conditionId: market.conditionId,
                marketTitle: market.groupItemTitle ||
                    market.question ||
                    market.title ||
                    event.title ||
                    params.context.normalizedQuery,
                slug: market.slug || event.slug,
                eventSlug: event.slug,
                score,
                closed: marketIsClosed,
                volume: Number(event.volume24hr || event.volume || market.volume || 0),
                source: params.source,
                event,
                market,
            });
        }
    }
    return candidates
        .sort((a, b) => {
        if (b.score !== a.score) {
            return b.score - a.score;
        }
        if (b.volume !== a.volume) {
            return b.volume - a.volume;
        }
        return a.marketTitle.localeCompare(b.marketTitle);
    })
        .slice(0, params.limit);
}
async function searchIndexedActiveEventCandidates(params) {
    const context = buildStructuredMarketSearchContext({
        query: params.query,
        category: params.category,
    });
    const tagSlug = context.categoryTagSlug;
    const primaryIndex = await getActiveEventSearchIndex({
        tagSlug,
    });
    let candidates = rankIndexedActiveEventCandidates({
        events: primaryIndex.events,
        context,
        limit: params.limit,
        source: tagSlug ? `active-events-index:${tagSlug}` : "active-events-index",
    });
    let source = tagSlug ? `active-events-index:${tagSlug}` : "active-events-index";
    let searchIndex = primaryIndex;
    if (candidates.length === 0 && tagSlug && !params.category) {
        const broadIndex = await getActiveEventSearchIndex({});
        candidates = rankIndexedActiveEventCandidates({
            events: broadIndex.events,
            context: {
                ...context,
                categoryTagSlug: undefined,
            },
            limit: params.limit,
            source: "active-events-index:broad-fallback",
        });
        source = "active-events-index:broad-fallback";
        searchIndex = broadIndex;
    }
    return {
        candidates,
        searchIndex,
        source,
    };
}
async function searchGammaWebsiteEventCandidates(params) {
    const context = buildStructuredMarketSearchContext({
        query: params.query,
        category: params.category,
    });
    const events = filterEventsByStructuredSearchContext({
        events: await searchGammaEventsByWebsiteSearch({
            query: params.query,
            limitPerType: WEBSITE_SEARCH_V2_PAGE_SIZE,
            eventsStatus: params.eventsStatus,
            maxPages: params.maxPages,
        }),
        context,
    });
    const source = params.eventsStatus === "closed" ? "website-search-v2:closed" : "website-search-v2";
    return {
        candidates: rankIndexedActiveEventCandidates({
            events,
            context,
            limit: params.limit,
            source,
            includeClosed: params.eventsStatus === "closed",
        }),
        events,
        source,
    };
}
function getIndexedCandidateEventKey(candidate) {
    return (candidate.event.slug ||
        candidate.event.id ||
        candidate.eventSlug ||
        candidate.slug ||
        candidate.conditionId ||
        candidate.marketTitle);
}
function pickTopIndexedCandidatesByEvent(candidates, limit) {
    const bestByEvent = new Map();
    for (const candidate of candidates) {
        const key = getIndexedCandidateEventKey(candidate);
        if (!bestByEvent.has(key)) {
            bestByEvent.set(key, candidate);
        }
        if (bestByEvent.size >= limit) {
            break;
        }
    }
    return [...bestByEvent.values()];
}
function scoreMarketCandidate(params) {
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
        if (normalizedCandidateText.includes("above") ||
            normalizedCandidateText.includes("over")) {
            score += 35;
        }
    }
    if (queryText.includes("below") || queryText.includes("under")) {
        if (normalizedCandidateText.includes("below") ||
            normalizedCandidateText.includes("under")) {
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
        }
        else {
            score -= 180;
        }
    }
    return score;
}
function pickBestMarketCandidate(candidates) {
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
async function resolveCandidateConditionId(candidate) {
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
            const markets = (await fetchGamma(`/markets?slug=${encodeURIComponent(candidate.slug)}&limit=1`, 8_000));
            if (Array.isArray(markets) && markets.length > 0 && markets[0].conditionId) {
                return {
                    conditionId: markets[0].conditionId,
                    marketTitle: markets[0].question || markets[0].title || candidate.marketTitle,
                    slug: markets[0].slug || candidate.slug,
                };
            }
        }
        catch {
            // Keep resolving through event slug fallback.
        }
    }
    if (candidate.eventSlug) {
        try {
            const event = (await fetchGamma(`/events/slug/${encodeURIComponent(candidate.eventSlug)}`, 8_000));
            const markets = Array.isArray(event?.markets) ? event.markets : [];
            const matched = markets.find((market) => {
                if (!market.conditionId) {
                    return false;
                }
                if (candidate.slug && market.slug === candidate.slug) {
                    return true;
                }
                const normalizedMarketTitle = normalizeMarketQueryText(`${market.question || ""} ${market.title || ""}`);
                const normalizedCandidateTitle = normalizeMarketQueryText(candidate.marketTitle);
                return (normalizedCandidateTitle.length > 0 &&
                    normalizedMarketTitle.includes(normalizedCandidateTitle));
            });
            if (matched?.conditionId) {
                return {
                    conditionId: matched.conditionId,
                    marketTitle: matched.question || matched.title || candidate.marketTitle,
                    slug: matched.slug || candidate.slug || candidate.eventSlug,
                };
            }
        }
        catch {
            // Final failure handled by caller.
        }
    }
    return null;
}
async function resolveMarketReference(options) {
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
            const event = (await fetchGamma(`/events/slug/${slug}`, 8_000));
            const market = getRepresentativeGammaMarket(event, {
                preference: "tradable",
            });
            if (market?.conditionId) {
                return {
                    conditionId: market.conditionId,
                    marketTitle: market.question || event.title || slug,
                    slug: market.slug || slug,
                };
            }
        }
        catch {
            // Fallback to market-by-slug lookup.
        }
        try {
            const markets = (await fetchGamma(`/markets?slug=${encodeURIComponent(slug)}&limit=1`, 8_000));
            if (Array.isArray(markets) && markets.length > 0 && markets[0].conditionId) {
                return {
                    conditionId: markets[0].conditionId,
                    marketTitle: markets[0].question || markets[0].title || slug,
                    slug: markets[0].slug || slug,
                };
            }
        }
        catch {
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
        const queryTokens = buildMarketQueryScoringTokens(trimmedQuery);
        const queryTargets = extractPriceTargets(trimmedQuery);
        const strictThreshold = queryTargets.length > 0 ? 120 : 70;
        const fallbackThreshold = queryTargets.length > 0 ? 80 : 50;
        const indexedStrictThreshold = queryTargets.length > 0 ? 170 : 110;
        const indexedFallbackThreshold = queryTargets.length > 0 ? 120 : 75;
        let websiteActiveBest = null;
        let activeIndexBest = null;
        try {
            const websiteSearch = await searchGammaWebsiteEventCandidates({
                query: trimmedQuery,
                limit: 24,
                eventsStatus: "active",
            });
            websiteActiveBest = pickBestMarketCandidate(websiteSearch.candidates);
            console.info("[polymarket-resolve] phase", {
                query: trimmedQuery.slice(0, 120),
                phase: websiteSearch.source,
                candidates: websiteSearch.candidates.length,
                bestScore: websiteActiveBest?.score ?? null,
                selectedConditionId: websiteActiveBest?.conditionId ?? null,
            });
            if (websiteActiveBest && websiteActiveBest.score >= indexedStrictThreshold) {
                const resolvedFromWebsiteSearch = await resolveCandidateConditionId(websiteActiveBest);
                if (resolvedFromWebsiteSearch) {
                    return resolvedFromWebsiteSearch;
                }
            }
        }
        catch (error) {
            console.warn("[polymarket-resolve] phase_failed", {
                query: trimmedQuery.slice(0, 120),
                phase: "website-search-v2",
                error: error instanceof Error
                    ? error.message.slice(0, 160)
                    : String(error).slice(0, 160),
            });
        }
        try {
            const indexedSearch = await searchIndexedActiveEventCandidates({
                query: trimmedQuery,
                limit: 24,
            });
            activeIndexBest = pickBestMarketCandidate(indexedSearch.candidates);
            console.info("[polymarket-resolve] phase", {
                query: trimmedQuery.slice(0, 120),
                phase: indexedSearch.source,
                candidates: indexedSearch.candidates.length,
                indexSize: indexedSearch.searchIndex.events.length,
                tagSlug: indexedSearch.searchIndex.tagSlug ?? null,
                bestScore: activeIndexBest?.score ?? null,
                selectedConditionId: activeIndexBest?.conditionId ?? null,
            });
            if (activeIndexBest && activeIndexBest.score >= indexedStrictThreshold) {
                const resolvedFromActiveIndex = await resolveCandidateConditionId(activeIndexBest);
                if (resolvedFromActiveIndex) {
                    return resolvedFromActiveIndex;
                }
            }
        }
        catch (error) {
            console.warn("[polymarket-resolve] phase_failed", {
                query: trimmedQuery.slice(0, 120),
                phase: "active-events-index",
                error: error instanceof Error
                    ? error.message.slice(0, 160)
                    : String(error).slice(0, 160),
            });
        }
        const tryPublicSearch = async (params) => {
            try {
                const events = await searchGammaEventsByVariants({
                    query: trimmedQuery,
                    limitPerType: 20,
                    eventsStatus: params.eventsStatus,
                    includeClosed: params.includeClosed,
                });
                const candidates = [];
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
            }
            catch (error) {
                console.warn("[polymarket-resolve] phase_failed", {
                    query: trimmedQuery.slice(0, 120),
                    phase: params.phase,
                    error: error instanceof Error
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
        let websiteResolvedBest = null;
        try {
            const websiteSearch = await searchGammaWebsiteEventCandidates({
                query: trimmedQuery,
                limit: 24,
                eventsStatus: "closed",
            });
            websiteResolvedBest = pickBestMarketCandidate(websiteSearch.candidates);
            console.info("[polymarket-resolve] phase", {
                query: trimmedQuery.slice(0, 120),
                phase: websiteSearch.source,
                candidates: websiteSearch.candidates.length,
                bestScore: websiteResolvedBest?.score ?? null,
                selectedConditionId: websiteResolvedBest?.conditionId ?? null,
            });
            if (websiteResolvedBest && websiteResolvedBest.score >= indexedStrictThreshold) {
                const resolvedFromWebsiteClosed = await resolveCandidateConditionId(websiteResolvedBest);
                if (resolvedFromWebsiteClosed) {
                    return resolvedFromWebsiteClosed;
                }
            }
        }
        catch (error) {
            console.warn("[polymarket-resolve] phase_failed", {
                query: trimmedQuery.slice(0, 120),
                phase: "website-search-v2:closed",
                error: error instanceof Error
                    ? error.message.slice(0, 160)
                    : String(error).slice(0, 160),
            });
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
        const searchFallbackBest = pickBestMarketCandidate([
            websiteActiveBest,
            activeIndexBest,
            activeBest,
            websiteResolvedBest,
            resolvedBest,
        ].filter((candidate) => candidate !== null));
        if (searchFallbackBest &&
            searchFallbackBest.score >=
                (searchFallbackBest === websiteActiveBest ||
                    searchFallbackBest === activeIndexBest ||
                    searchFallbackBest === websiteResolvedBest
                    ? indexedFallbackThreshold
                    : fallbackThreshold)) {
            const resolvedFromSearchFallback = await resolveCandidateConditionId(searchFallbackBest);
            if (resolvedFromSearchFallback) {
                return resolvedFromSearchFallback;
            }
        }
        const tryMarketsList = async (params) => {
            try {
                const markets = (await fetchGamma(`/markets?limit=80&closed=${params.closed ? "true" : "false"}&order=volume24hr&ascending=false`, 10_000));
                const candidates = [];
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
            }
            catch (error) {
                console.warn("[polymarket-resolve] phase_failed", {
                    query: trimmedQuery.slice(0, 120),
                    phase: params.phase,
                    error: error instanceof Error
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
            const resolvedFromLiveList = await resolveCandidateConditionId(liveListBest);
            if (resolvedFromLiveList) {
                return resolvedFromLiveList;
            }
        }
        const resolvedListBest = await tryMarketsList({
            phase: "markets-list-closed",
            closed: true,
        });
        if (resolvedListBest && resolvedListBest.score >= strictThreshold) {
            const resolvedFromClosedList = await resolveCandidateConditionId(resolvedListBest);
            if (resolvedFromClosedList) {
                return resolvedFromClosedList;
            }
        }
        const finalBest = pickBestMarketCandidate([activeIndexBest, liveListBest, resolvedListBest].filter((candidate) => candidate !== null));
        if (finalBest &&
            finalBest.score >=
                (finalBest === activeIndexBest
                    ? indexedFallbackThreshold
                    : fallbackThreshold)) {
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
async function fetchGamma(endpoint, timeoutMs, maxAttempts) {
    return fetchJsonWithPolicy({
        upstream: "gamma",
        endpoint,
        timeoutMs,
        maxAttempts,
    });
}
async function fetchClob(endpoint, options, timeoutMs) {
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
async function fetchClobPost(endpoint, body, timeoutMs) {
    return fetchClob(endpoint, {
        method: "POST",
        body: JSON.stringify(body),
    }, timeoutMs);
}
async function fetchDataApi(endpoint, timeoutMs) {
    return fetchJsonWithPolicy({
        upstream: "data",
        endpoint,
        timeoutMs,
    });
}
function parseClobQuoteValue(value, side) {
    if (!value) {
        return 0;
    }
    const raw = typeof value === "object" && value !== null
        ? value[side]
        : value;
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : 0;
}
async function fetchClobQuoteSnapshots(tokenIds, timeoutMs) {
    const uniqueTokenIds = Array.from(new Set(tokenIds.filter((tokenId) => typeof tokenId === "string" && tokenId.trim().length > 0)));
    if (uniqueTokenIds.length === 0) {
        return {};
    }
    const [buyResp, sellResp] = (await Promise.all([
        fetchClobPost("/prices", uniqueTokenIds.map((tokenId) => ({ token_id: tokenId, side: "BUY" })), timeoutMs),
        fetchClobPost("/prices", uniqueTokenIds.map((tokenId) => ({ token_id: tokenId, side: "SELL" })), timeoutMs),
    ]));
    const snapshots = {};
    for (const tokenId of uniqueTokenIds) {
        // Live production semantics:
        // - BUY quote = best bid
        // - SELL quote = best ask
        let bestBid = parseClobQuoteValue(buyResp[tokenId], "BUY");
        let bestAsk = parseClobQuoteValue(sellResp[tokenId], "SELL");
        if (bestBid > 0 && bestAsk > 0 && bestAsk < bestBid) {
            [bestBid, bestAsk] = [bestAsk, bestBid];
        }
        const midpoint = bestBid > 0 && bestAsk > 0
            ? (bestBid + bestAsk) / 2
            : bestAsk || bestBid || 0;
        const spread = bestBid > 0 && bestAsk > 0
            ? bestAsk - bestBid
            : 0;
        snapshots[tokenId] = {
            bestBid,
            bestAsk,
            midpoint,
            spread,
        };
    }
    return snapshots;
}
function parseFiniteNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}
function extractGammaMarketTokenIds(market) {
    if (Array.isArray(market.tokens)) {
        return market.tokens
            .map((token) => token.token_id)
            .filter((tokenId) => typeof tokenId === "string" && tokenId.trim().length > 0);
    }
    return parseJsonArray(market.clobTokenIds).filter((tokenId) => typeof tokenId === "string" && tokenId.trim().length > 0);
}
function extractGammaYesTokenId(market) {
    return extractGammaMarketTokenIds(market)[0] || "";
}
function extractGammaNoTokenId(market) {
    return extractGammaMarketTokenIds(market)[1] || "";
}
function parseGammaOutcomePriceAtIndex(market, index) {
    const prices = parseJsonArray(market.outcomePrices);
    if (index < 0 || index >= prices.length) {
        return null;
    }
    return parseFiniteNumber(prices[index]);
}
function resolveQuoteMidpoint(quote) {
    if (!quote) {
        return null;
    }
    return Number.isFinite(quote.midpoint) && quote.midpoint > 0
        ? quote.midpoint
        : null;
}
function isTradableGammaMarket(market) {
    if (market.active === false || market.closed === true) {
        return false;
    }
    if (market.acceptingOrders === false) {
        return false;
    }
    return (market.umaResolutionStatus || "").toLowerCase() !== "resolved";
}
function isResolvedGammaMarket(market) {
    if (market.closed === true) {
        return true;
    }
    return (market.umaResolutionStatus || "").toLowerCase() === "resolved";
}
function scoreGammaMarketForSelection(market, preference) {
    let score = 0;
    const tradable = isTradableGammaMarket(market);
    const resolved = isResolvedGammaMarket(market);
    if (preference === "tradable" && tradable) {
        score += 1_000_000_000;
    }
    else if (preference === "resolved" && resolved) {
        score += 1_000_000_000;
    }
    else if (preference === "any" && tradable) {
        score += 100_000_000;
    }
    if (market.active !== false) {
        score += 10_000_000;
    }
    if (market.closed !== true) {
        score += 1_000_000;
    }
    if (market.acceptingOrders !== false) {
        score += 100_000;
    }
    if (!resolved) {
        score += 10_000;
    }
    score += (getFiniteNumber(market.liquidity) ?? 0) * 10;
    score += (getFiniteNumber(market.volume24hr) ?? 0) * 5;
    score += getFiniteNumber(market.volume) ?? 0;
    return score;
}
function selectPreferredGammaMarket(markets, options) {
    if (markets.length === 0) {
        return null;
    }
    const preference = options?.preference ?? "tradable";
    return [...markets].sort((a, b) => {
        const scoreDelta = scoreGammaMarketForSelection(b, preference) -
            scoreGammaMarketForSelection(a, preference);
        if (scoreDelta !== 0) {
            return scoreDelta;
        }
        return (a.question || a.title || "").localeCompare(b.question || b.title || "");
    })[0] ?? null;
}
function getRepresentativeGammaMarket(event, options) {
    const markets = Array.isArray(event?.markets)
        ? event.markets.filter((market) => typeof market === "object" && market !== null)
        : [];
    return selectPreferredGammaMarket(markets, options);
}
function getRepresentativeGammaMarkets(events, options) {
    return events.flatMap((event) => {
        const market = getRepresentativeGammaMarket(event, options);
        return market ? [market] : [];
    });
}
function selectMarketForTopMarkets(event, sortBy) {
    const markets = Array.isArray(event?.markets)
        ? event.markets.filter((market) => typeof market === "object" && market !== null)
        : [];
    if (markets.length === 0) {
        return null;
    }
    const liveTradableMarkets = markets.filter((market) => {
        if (market.active === false || market.closed === true) {
            return false;
        }
        if (market.acceptingOrders === false) {
            return false;
        }
        return (market.umaResolutionStatus || "").toLowerCase() !== "resolved";
    });
    const candidates = liveTradableMarkets.length > 0 ? liveTradableMarkets : markets;
    const metricForSort = (market) => {
        switch (sortBy) {
            case "liquidity":
                return Number(market.liquidity || 0);
            case "volume":
            case "recent_activity":
                return Number(market.volume24hr || 0);
            case "total_volume":
            case "trending":
                return Number(market.volume || market.volume24hr || 0);
            default:
                return Number.NaN;
        }
    };
    return [...candidates].sort((left, right) => {
        const rightMetric = metricForSort(right);
        const leftMetric = metricForSort(left);
        if (Number.isFinite(rightMetric) && Number.isFinite(leftMetric)) {
            const metricDelta = rightMetric - leftMetric;
            if (metricDelta !== 0) {
                return metricDelta;
            }
        }
        const selectionDelta = scoreGammaMarketForSelection(right, "tradable") -
            scoreGammaMarketForSelection(left, "tradable");
        if (selectionDelta !== 0) {
            return selectionDelta;
        }
        return (left.question || left.title || "").localeCompare(right.question || right.title || "");
    })[0] ?? null;
}
async function fetchClobQuoteSnapshotsBatched(tokenIds, timeoutMs) {
    const uniqueTokenIds = Array.from(new Set(tokenIds.filter((tokenId) => typeof tokenId === "string" && tokenId.trim().length > 0)));
    if (uniqueTokenIds.length === 0) {
        return {};
    }
    const batchSize = 120;
    const snapshots = {};
    for (let offset = 0; offset < uniqueTokenIds.length; offset += batchSize) {
        const batch = uniqueTokenIds.slice(offset, offset + batchSize);
        try {
            Object.assign(snapshots, await fetchClobQuoteSnapshots(batch, timeoutMs));
        }
        catch (error) {
            console.warn("[polymarket-clob] quote batch failed", {
                batchSize: batch.length,
                error: error instanceof Error
                    ? error.message.slice(0, 160)
                    : String(error).slice(0, 160),
            });
        }
    }
    return snapshots;
}
async function fetchGammaMarketQuoteSnapshots(markets, options) {
    const tokenIds = [];
    for (const market of markets) {
        const marketTokenIds = extractGammaMarketTokenIds(market);
        if (marketTokenIds[0]) {
            tokenIds.push(marketTokenIds[0]);
        }
        if (options?.includeNoTokens && marketTokenIds[1]) {
            tokenIds.push(marketTokenIds[1]);
        }
    }
    return fetchClobQuoteSnapshotsBatched(tokenIds, options?.timeoutMs);
}
function resolveCurrentBinaryPrices(market, quoteSnapshots) {
    const yesTokenId = extractGammaYesTokenId(market);
    const noTokenId = extractGammaNoTokenId(market);
    const liveYesPrice = resolveQuoteMidpoint(yesTokenId ? quoteSnapshots?.[yesTokenId] : undefined);
    const liveNoPrice = resolveQuoteMidpoint(noTokenId ? quoteSnapshots?.[noTokenId] : undefined);
    if (liveYesPrice !== null && liveNoPrice !== null) {
        return {
            yesPrice: liveYesPrice,
            noPrice: liveNoPrice,
            usedLiveQuotes: true,
        };
    }
    const gammaYesPrice = parseGammaOutcomePriceAtIndex(market, 0);
    const gammaNoPrice = parseGammaOutcomePriceAtIndex(market, 1);
    if (gammaYesPrice !== null && gammaNoPrice !== null) {
        return {
            yesPrice: gammaYesPrice,
            noPrice: gammaNoPrice,
            usedLiveQuotes: false,
        };
    }
    return {
        yesPrice: liveYesPrice ?? gammaYesPrice,
        noPrice: liveNoPrice ?? gammaNoPrice,
        usedLiveQuotes: liveYesPrice !== null || liveNoPrice !== null,
    };
}
function resolveCurrentOutcomePrice(market, quoteSnapshots) {
    const yesTokenId = extractGammaYesTokenId(market);
    const livePrice = resolveQuoteMidpoint(yesTokenId ? quoteSnapshots?.[yesTokenId] : undefined);
    if (livePrice !== null) {
        return livePrice;
    }
    return parseGammaOutcomePriceAtIndex(market, 0) ?? 0;
}
function isPlaceholderOutcomeName(name, volume) {
    if (/^Person [A-Z]{1,2}$/i.test(name)) {
        return true;
    }
    return (name === "Other" || name === "Unknown") && volume <= 0;
}
function deriveGammaOutcomeName(market) {
    const groupItemTitle = typeof market.groupItemTitle === "string" ? market.groupItemTitle.trim() : "";
    const question = typeof market.question === "string" ? market.question.trim() : "";
    const title = typeof market.title === "string" ? market.title.trim() : "";
    if (/\b(?:draw|tie)\b/i.test(question) || /\bend in a draw\b/i.test(question)) {
        return "Draw";
    }
    if (groupItemTitle.length > 0) {
        return groupItemTitle;
    }
    if (question.length > 0) {
        return question;
    }
    if (title.length > 0) {
        return title;
    }
    return "Unknown";
}
function parseOutcomeBucketDeadline(label, referenceYear) {
    const normalizedLabel = normalizeOutcomeLabelDashes(label);
    const match = normalizedLabel.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:,?\s*(\d{4}))?\b/i);
    if (!match) {
        return null;
    }
    const monthToken = match[1]?.slice(0, 3).toLowerCase() ?? "";
    const monthIndexMap = {
        jan: 0,
        feb: 1,
        mar: 2,
        apr: 3,
        may: 4,
        jun: 5,
        jul: 6,
        aug: 7,
        sep: 8,
        oct: 9,
        nov: 10,
        dec: 11,
    };
    const monthIndex = monthIndexMap[monthToken];
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : referenceYear;
    if (!Number.isFinite(monthIndex) || !Number.isFinite(day) || !Number.isFinite(year)) {
        return null;
    }
    const parsed = new Date(Date.UTC(year, monthIndex, day, 23, 59, 59, 999));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function classifyOutcomeDateState(label, event) {
    const referenceDate = new Date(event.endDate || event.endDateIso || event.startDate || new Date().toISOString());
    const referenceYear = Number.isNaN(referenceDate.getTime())
        ? new Date().getUTCFullYear()
        : referenceDate.getUTCFullYear();
    const parsedDeadline = parseOutcomeBucketDeadline(label, referenceYear);
    if (!parsedDeadline) {
        return {
            endDate: "",
            dateStatus: "undated",
        };
    }
    return {
        endDate: parsedDeadline.toISOString(),
        dateStatus: parsedDeadline.getTime() >= Date.now() ? "future" : "expired",
    };
}
function isCurrentlyTradableEventOutcome(market, event) {
    if (!isTradableGammaMarket(market)) {
        return false;
    }
    const outcomeName = deriveGammaOutcomeName(market);
    const { dateStatus } = classifyOutcomeDateState(outcomeName, event);
    return dateStatus !== "expired";
}
async function buildEventOutcomeRows(params) {
    const markets = Array.isArray(params.event.markets) ? params.event.markets : [];
    const rawOutcomeCount = markets.length;
    const nonPlaceholderMarkets = markets.filter((market) => {
        const volume = parseFiniteNumber(market.volume) ?? 0;
        const name = deriveGammaOutcomeName(market);
        return !isPlaceholderOutcomeName(name, volume);
    });
    const filteredPlaceholderCount = rawOutcomeCount - nonPlaceholderMarkets.length;
    let visibleMarkets = nonPlaceholderMarkets;
    let filteredInactiveCount = 0;
    if (!params.includeInactive) {
        const activeMarkets = nonPlaceholderMarkets.filter((market) => isCurrentlyTradableEventOutcome(market, params.event));
        if (activeMarkets.length > 0) {
            filteredInactiveCount = nonPlaceholderMarkets.length - activeMarkets.length;
            visibleMarkets = activeMarkets;
        }
    }
    const quoteSnapshots = await fetchGammaMarketQuoteSnapshots(visibleMarkets, {
        timeoutMs: visibleMarkets.length > 60 ? "heavy" : "default",
    });
    const outcomes = visibleMarkets.map((market) => {
        const volume = parseFiniteNumber(market.volume) ?? 0;
        const price = resolveCurrentOutcomePrice(market, quoteSnapshots);
        const tokenId = extractGammaYesTokenId(market);
        const name = deriveGammaOutcomeName(market);
        const { endDate, dateStatus } = classifyOutcomeDateState(name, params.event);
        const active = isCurrentlyTradableEventOutcome(market, params.event);
        return {
            rank: 0,
            name,
            volume,
            price,
            currentPrice: price,
            impliedProbability: `${(price * 100).toFixed(1)}%`,
            pricePercent: `${(price * 100).toFixed(1)}%`,
            conditionId: market.conditionId || "",
            tokenId,
            active,
            closed: isResolvedGammaMarket(market) || dateStatus === "expired",
            endDate,
            dateStatus,
        };
    });
    return {
        outcomes,
        rawOutcomeCount,
        filteredPlaceholderCount,
        filteredInactiveCount,
    };
}
function computeMarketTradability(market) {
    const tokens = Array.isArray(market.tokens) ? market.tokens : [];
    const yesToken = tokens.find((t) => t?.outcome?.toLowerCase() === "yes") ?? tokens[0];
    const noToken = tokens.find((t) => t?.outcome?.toLowerCase() === "no") ?? tokens[1];
    const winnerToken = tokens.find((t) => t?.winner === true);
    const toPriceNumber = (v) => {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        return Number.isFinite(n) ? n : null;
    };
    const yesPrice = toPriceNumber(yesToken?.price);
    const noPrice = toPriceNumber(noToken?.price);
    const slug = typeof market.market_slug === "string" && market.market_slug.trim().length > 0
        ? market.market_slug.trim()
        : null;
    const polymarketUrl = slug ? `https://polymarket.com/market/${slug}` : null;
    const question = typeof market.question === "string" && market.question.trim().length > 0
        ? market.question.trim()
        : null;
    const endDate = typeof market.end_date_iso === "string" && market.end_date_iso.trim().length > 0
        ? market.end_date_iso.trim()
        : null;
    // Classification order matters: archived > resolved > closed-unresolved >
    // orderbook_disabled > not_accepting_orders > tradeable.
    let state = "tradeable";
    let summary = "Market is live and accepts orders on the CLOB.";
    let winningOutcome = null;
    if (market.archived === true) {
        state = "archived";
        summary = "Market is archived on Polymarket and no longer available for trading.";
    }
    else if (market.closed === true) {
        if (winnerToken) {
            state = "closed_resolved";
            winningOutcome = winnerToken.outcome ?? null;
            const priceLabel = winnerToken.outcome?.toLowerCase() === "yes" && yesPrice !== null
                ? ` at $${yesPrice.toFixed(2)}/share`
                : winnerToken.outcome?.toLowerCase() === "no" && noPrice !== null
                    ? ` at $${noPrice.toFixed(2)}/share`
                    : "";
            summary = `Market has resolved${winningOutcome ? ` with ${winningOutcome} as the winning outcome${priceLabel}` : ""}. The CLOB orderbook is permanently disabled for this contract; any existing positions settle via redeem/claim rather than a CLOB exit.`;
        }
        else {
            state = "closed_unresolved";
            summary = "Market is closed (trading has ended) but has not yet been resolved on-chain. Orderbook trading is over; awaiting UMA settlement.";
        }
    }
    else if (market.enable_order_book === false) {
        state = "orderbook_disabled";
        summary = "Market is published but the CLOB orderbook is disabled for this contract, so walk-the-book execution is not possible.";
    }
    else if (market.accepting_orders === false) {
        state = "not_accepting_orders";
        summary = "Market is live but is currently not accepting new orders (paused). Existing orders may still be resting but the book is effectively frozen.";
    }
    return {
        state,
        isTradeable: state === "tradeable",
        summary,
        question,
        marketSlug: slug,
        polymarketUrl,
        endDate,
        winningOutcome,
        settlementPrices: { yes: yesPrice, no: noPrice },
    };
}
const NON_TRADEABLE_ZERO_FILL = {
    amountFilled: 0,
    avgPrice: 0,
    worstPrice: 0,
    slippagePercent: 100,
    canFill: false,
};
function buildNonTradeableLiquidityResponse(params) {
    const { tradability, tokenId, conditionId, marketTitle } = params;
    const yesSettled = tradability.settlementPrices.yes;
    const refPrice = typeof yesSettled === "number" && yesSettled >= 0 && yesSettled <= 1
        ? Number(yesSettled.toFixed(4))
        : 0;
    // For resolved markets, the honest "recommendation" is: there is no CLOB
    // exit, position settles at the winning token's price. For closed-unresolved
    // markets, it's: trading is over, wait for settlement. For paused/disabled
    // orderbook markets, it's: market is live but unmatchable right now.
    let recommendation;
    switch (tradability.state) {
        case "closed_resolved":
            recommendation = tradability.winningOutcome
                ? `Market has resolved with ${tradability.winningOutcome} as the winning outcome. CLOB trading is permanently disabled; YES shares are redeemable at $${(tradability.settlementPrices.yes ?? 0).toFixed(2)} and NO at $${(tradability.settlementPrices.no ?? 0).toFixed(2)} via Polymarket's redeem flow rather than a CLOB sell.`
                : "Market has resolved and CLOB trading is permanently disabled. Position exit is via redeem/claim at the settled price, not via the orderbook.";
            break;
        case "closed_unresolved":
            recommendation =
                "Market is closed to new trading and awaiting on-chain resolution. No CLOB exit is possible; wait for UMA settlement and then redeem.";
            break;
        case "archived":
            recommendation =
                "Market is archived on Polymarket and no longer tradeable. Any exit simulation on the CLOB is not meaningful here.";
            break;
        case "orderbook_disabled":
            recommendation =
                "Market is published but the CLOB orderbook is disabled, so walk-the-book slippage simulations are not meaningful. Exit size at a given price is effectively zero right now.";
            break;
        case "not_accepting_orders":
            recommendation =
                "Market is live but currently paused (not accepting new orders). No matching will occur; treat execution/exit risk as high until the pause lifts.";
            break;
        default:
            recommendation = tradability.summary;
    }
    return {
        market: marketTitle,
        tokenId,
        conditionId: conditionId ?? undefined,
        marketSlug: tradability.marketSlug,
        polymarketUrl: tradability.polymarketUrl,
        marketState: tradability.state,
        marketStateSummary: tradability.summary,
        isTradeable: false,
        endDate: tradability.endDate,
        winningOutcome: tradability.winningOutcome,
        settlementPrices: tradability.settlementPrices,
        currentPrice: refPrice,
        spread: {
            bestBid: refPrice,
            bestAsk: refPrice,
            spreadCents: 0,
            spreadBps: 0,
            absolute: 0,
            percentage: 0,
            bps: 0,
        },
        depth: {
            bidDepthUsd: 0,
            askDepthUsd: 0,
            totalDepthUsd: 0,
            note: tradability.state === "closed_resolved"
                ? "Market is resolved; CLOB orderbook is permanently disabled, so merged depth is zero by design. This is NOT a liquidity problem — positions settle via redeem rather than CLOB sell."
                : tradability.state === "closed_unresolved"
                    ? "Market is closed and awaiting on-chain settlement; CLOB depth is zero because trading has ended, not because the book is thin."
                    : tradability.state === "archived"
                        ? "Market is archived; there is no orderbook to measure depth against."
                        : "CLOB orderbook is disabled or the market is paused; depth is structurally zero rather than an indicator of liquidity.",
        },
        whaleCost: {
            sell1k: NON_TRADEABLE_ZERO_FILL,
            sell5k: NON_TRADEABLE_ZERO_FILL,
            sell10k: NON_TRADEABLE_ZERO_FILL,
        },
        liquidityScore: "illiquid",
        recommendation,
        fetchedAt: new Date().toISOString(),
    };
}
// ============================================================================
// TIER 1: INTELLIGENCE TOOL HANDLERS
// ============================================================================
async function handleAnalyzeMarketLiquidity(args) {
    const tokenId = args?.tokenId;
    const inputConditionId = args?.conditionId;
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    let conditionId = inputConditionId;
    const positionSizeUsdRaw = typeof args?.positionSizeUsd === "number"
        ? args.positionSizeUsd
        : typeof args?.positionSizeUsd === "string"
            ? Number(args.positionSizeUsd)
            : NaN;
    const positionSizeUsd = Number.isFinite(positionSizeUsdRaw) && positionSizeUsdRaw > 0
        ? positionSizeUsdRaw
        : 0;
    const rawSide = typeof args?.side === "string" ? args.side.trim().toLowerCase() : "";
    const side = rawSide === "sell" ? "sell" : "buy";
    if (!tokenId && !conditionId) {
        const resolved = await resolveMarketReference({
            slug: slug || undefined,
            marketQuery: marketQuery || undefined,
        });
        if (!resolved) {
            return errorResult("Provide tokenId, conditionId, slug, or marketQuery so the tool can resolve a market.");
        }
        conditionId = resolved.conditionId;
    }
    let yesTokenId = tokenId;
    let noTokenId = "";
    let clobMarket = null;
    // PERF: Resolve token IDs first, then fetch both orderbooks in parallel.
    // Previously this was 5 sequential calls (market → yesBook → market again → noBook → prices).
    // Now it's: 1 market call → 2 parallel book calls + 1 price call = 2 round-trips total.
    if (conditionId) {
        const market = (await fetchClob(`/markets/${conditionId}`, undefined, 8000).catch(() => null));
        if (market) {
            clobMarket = market;
            const yesFromTokens = market.tokens?.find((t) => t?.outcome?.toLowerCase() === "yes")?.token_id ??
                market.tokens?.[0]?.token_id;
            const noFromTokens = market.tokens?.find((t) => t?.outcome?.toLowerCase() === "no")?.token_id ??
                market.tokens?.[1]?.token_id;
            yesTokenId = yesFromTokens || tokenId;
            noTokenId = noFromTokens || "";
        }
    }
    if (!yesTokenId) {
        return errorResult("Could not resolve token ID");
    }
    // If we have a CLOB market payload, inspect tradability BEFORE hitting /book.
    // A closed / resolved / archived / orderbook-disabled market should not be
    // reported as a generic "illiquid" surface — the truthful story is that the
    // market has ended or been paused, and any "100% slippage" framing is
    // actively misleading.
    const tradability = clobMarket ? computeMarketTradability(clobMarket) : null;
    const marketTitleFromClob = (tradability?.question?.length ?? 0) > 0
        ? tradability.question
        : clobMarket?.question || conditionId || yesTokenId;
    if (tradability && !tradability.isTradeable) {
        return successResult(buildNonTradeableLiquidityResponse({
            tradability,
            tokenId: yesTokenId,
            conditionId: conditionId || clobMarket?.condition_id || null,
            marketTitle: marketTitleFromClob,
        }));
    }
    // Fetch both orderbooks in parallel (+ price) instead of sequentially.
    // NOTE: Even when CLOB /markets reports enable_order_book=true, the /book
    // endpoint can still 404 transiently. That is a transport-level failure and
    // is handled below distinctly from the "market said it's not tradeable"
    // case, which has already been resolved above.
    const [yesOrderbook, noOrderbook] = (await Promise.all([
        fetchClob(`/book?token_id=${yesTokenId}`, undefined, 8000)
            .then((r) => r)
            .catch(() => null),
        noTokenId
            ? fetchClob(`/book?token_id=${noTokenId}`, undefined, 8000)
                .then((r) => r)
                .catch(() => null)
            : Promise.resolve(null),
    ]));
    if (!yesOrderbook) {
        let fallbackMarketTitle = marketTitleFromClob;
        let fallbackPrice = 0.5;
        let fallbackLiquidity = 0;
        try {
            if (conditionId) {
                const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000));
                if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
                    const m = gammaMarkets[0];
                    fallbackMarketTitle = m.question || m.title || fallbackMarketTitle;
                    fallbackLiquidity = Number(m.liquidity || 0);
                    const yesPrice = resolveCurrentOutcomePrice(m);
                    if (yesPrice > 0 && yesPrice < 1) {
                        fallbackPrice = yesPrice;
                    }
                }
            }
        }
        catch {
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
                note: "CLOB /book temporarily unreachable; Gamma liquidity used as rough proxy.",
            },
            whaleCost: noBookWhaleCost,
            liquidityScore: "illiquid",
            marketState: "unknown",
            marketStateSummary: "Upstream /book endpoint did not return an orderbook on this attempt. Market appeared live per /markets, so this is likely a transient transport issue rather than a resolved or paused market.",
            marketSlug: tradability?.marketSlug ?? null,
            polymarketUrl: tradability?.polymarketUrl ?? null,
            recommendation: "CLOB /book was temporarily unreachable. Treat execution/exit risk as high and retry; if the condition persists, check market status directly on Polymarket.",
            fetchedAt: new Date().toISOString(),
        });
    }
    // Build MERGED orderbook combining direct + synthetic liquidity
    // Polymarket UI shows this merged view
    const mergedBids = [];
    const mergedAsks = [];
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
        const quoteSnapshots = await fetchClobQuoteSnapshots([yesTokenId], 8000);
        const quote = quoteSnapshots[yesTokenId];
        if (quote && quote.midpoint > 0) {
            currentPrice = quote.midpoint;
        }
    }
    catch {
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
    if (positionSizeUsd > 0) {
        const customSim = side === "buy"
            ? simulateBuyMerged(mergedAsks, positionSizeUsd, currentPrice)
            : simulateSellMerged(mergedBids, positionSizeUsd, currentPrice);
        whaleCost.custom = {
            sizeUsd: Number(positionSizeUsd.toFixed(2)),
            side,
            amountFilled: customSim.amountFilled,
            avgPrice: customSim.avgPrice,
            worstPrice: customSim.worstPrice,
            slippagePercent: customSim.slippagePercent,
            canFill: customSim.canFill,
            referencePrice: Number(currentPrice.toFixed(4)),
            estimatedShares: customSim.avgPrice > 0
                ? Number((customSim.amountFilled / customSim.avgPrice).toFixed(2))
                : 0,
        };
    }
    // Determine liquidity score
    let liquidityScore;
    const totalDepth = totalBidDepthUsd + totalAskDepthUsd;
    const slippage5k = whaleCost.sell5k.slippagePercent;
    const slippage1k = whaleCost.sell1k.slippagePercent;
    if (slippage5k < 2 && spread < 0.02) {
        liquidityScore = "excellent";
    }
    else if (slippage5k < 5 && spread < 0.03) {
        liquidityScore = "good";
    }
    else if (slippage5k < 10 && spread < 0.05) {
        liquidityScore = "moderate";
    }
    else if (slippage1k < 20) {
        liquidityScore = "poor";
    }
    else {
        liquidityScore = "illiquid";
    }
    // Generate recommendation
    let recommendation;
    if (liquidityScore === "excellent") {
        recommendation = `Excellent liquidity. Spread: ${(spread * 100).toFixed(0)}¢. Exit $5k with ~${slippage5k.toFixed(1)}% slippage.`;
    }
    else if (liquidityScore === "good") {
        recommendation = `Good liquidity. Spread: ${(spread * 100).toFixed(0)}¢. Exit $1k: ~${slippage1k.toFixed(1)}% slippage, $5k: ~${slippage5k.toFixed(1)}%.`;
    }
    else if (liquidityScore === "moderate") {
        recommendation = `Moderate liquidity. Consider limit orders. $1k exit: ~${slippage1k.toFixed(1)}% slippage.`;
    }
    else {
        recommendation = `Low liquidity. Exit $1k would cost ~${slippage1k.toFixed(1)}% in slippage. Use limit orders.`;
    }
    return successResult({
        market: (tradability?.question?.length ?? 0) > 0
            ? tradability.question
            : (yesOrderbook.market || conditionId),
        tokenId: yesTokenId,
        conditionId: conditionId || clobMarket?.condition_id,
        marketSlug: tradability?.marketSlug ?? null,
        polymarketUrl: tradability?.polymarketUrl ?? null,
        marketState: tradability?.state ?? "tradeable",
        marketStateSummary: tradability?.summary ?? "Market is live and accepts orders on the CLOB.",
        isTradeable: true,
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
function simulateSellMerged(mergedBids, usdAmount, currentPrice) {
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
        if (remainingUsd <= 0)
            break;
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
/**
 * Simulate buying on the MERGED asks (walk the book upward).
 * Returns avgPrice paid, worstPrice, and slippage vs currentPrice (midpoint or reference).
 */
function simulateBuyMerged(mergedAsks, usdAmount, currentPrice) {
    if (mergedAsks.length === 0 || currentPrice <= 0) {
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
    for (const ask of mergedAsks) {
        if (remainingUsd <= 0)
            break;
        const levelValueUsd = ask.size * ask.price;
        const fillValueUsd = Math.min(remainingUsd, levelValueUsd);
        const fillShares = ask.price > 0 ? fillValueUsd / ask.price : 0;
        totalShares += fillShares;
        remainingUsd -= fillValueUsd;
        worstPrice = ask.price;
    }
    const filledAmount = usdAmount - remainingUsd;
    const avgPrice = totalShares > 0 ? filledAmount / totalShares : 0;
    // For a buy, slippage is how much MORE you pay vs currentPrice.
    const slippagePercent = currentPrice > 0 ? ((avgPrice - currentPrice) / currentPrice) * 100 : 0;
    return {
        amountFilled: Number(filledAmount.toFixed(2)),
        avgPrice: Number(avgPrice.toFixed(4)),
        worstPrice: Number(worstPrice.toFixed(4)),
        slippagePercent: Number(Math.max(0, slippagePercent).toFixed(1)),
        canFill: remainingUsd <= 0,
    };
}
async function handleCheckMarketEfficiency(args) {
    let conditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    let slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    let selectionReason = conditionId.length > 0
        ? "Used the provided conditionId."
        : slug.length > 0
            ? "Used the provided slug."
            : "";
    const genericMarketQuery = marketQuery.length > 0 && isGenericMarketReferenceQuery(marketQuery);
    if (conditionId.length === 0 && slug.length === 0) {
        if (marketQuery.length > 0 && isGenericMarketReferenceQuery(marketQuery)) {
            selectionReason =
                "The prompt referenced a market deictically, so the tool skipped exact-title matching and used a strong live fallback market for an efficiency read.";
        }
        const resolvedFromQuery = marketQuery.length > 0 && !genericMarketQuery
            ? await resolveMarketReference({ marketQuery })
            : null;
        if (resolvedFromQuery) {
            conditionId = resolvedFromQuery.conditionId;
            slug = resolvedFromQuery.slug || "";
            selectionReason = "Resolved directly from the provided marketQuery.";
        }
        else {
            const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                sortBy: "liquidity",
                preferSingleOutcome: true,
            });
            if (!fallbackCandidate) {
                return errorResult("Provide conditionId, slug, or marketQuery so the tool can resolve a market.");
            }
            conditionId = fallbackCandidate.conditionId;
            slug = fallbackCandidate.slug;
            selectionReason =
                "Committed to analyzing the strongest live single-outcome Polymarket market as a best-effort substitute when an explicit market identifier was absent.";
        }
    }
    // Get market data
    let market;
    if (conditionId) {
        // Query by conditionId - use Gamma /markets?condition_ids= for direct lookup
        // and CLOB API in parallel for token data. This replaces the old approach of
        // brute-force searching through 100+50 events which caused MCP timeouts.
        const [gammaMarkets, clobMarket] = await Promise.all([
            fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000)
                .then(r => r)
                .catch(() => []),
            fetchClob(`/markets/${conditionId}`, undefined, 8000)
                .then(r => r)
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
    if (!market && slug) {
        const event = (await fetchGamma(`/events/slug/${slug}`));
        if (!event || !event.markets || event.markets.length === 0) {
            return errorResult(`Event not found: ${slug}`);
        }
        market = getRepresentativeGammaMarket(event, {
            preference: "tradable",
        }) ?? event.markets[0];
    }
    if (!market) {
        return errorResult("Market not found");
    }
    // Get prices for all outcome tokens
    const outcomes = [];
    // For binary markets, prefer live CLOB midpoints and fall back to Gamma.
    const yesToken = extractGammaYesTokenId(market);
    const noToken = extractGammaNoTokenId(market);
    if (yesToken && noToken) {
        let quoteSnapshots = {};
        try {
            quoteSnapshots = await fetchClobQuoteSnapshots([yesToken, noToken]);
        }
        catch {
            // CLOB API error - will fall back to Gamma prices
        }
        const { yesPrice, noPrice } = resolveCurrentBinaryPrices(market, quoteSnapshots);
        const safeYesPrice = yesPrice ?? 0.5;
        const safeNoPrice = noPrice ?? 0.5;
        outcomes.push({
            name: "YES",
            tokenId: yesToken,
            price: safeYesPrice,
            impliedProbability: Number(safeYesPrice.toFixed(4)),
            impliedProbabilityPercent: Number((safeYesPrice * 100).toFixed(2)),
        }, {
            name: "NO",
            tokenId: noToken,
            price: safeNoPrice,
            impliedProbability: Number(safeNoPrice.toFixed(4)),
            impliedProbabilityPercent: Number((safeNoPrice * 100).toFixed(2)),
        });
    }
    // Calculate market efficiency
    const sumOfOutcomes = outcomes.reduce((sum, o) => sum + o.price, 0);
    const vig = sumOfOutcomes - 1;
    const vigBps = vig * 10000;
    let efficiency;
    if (Math.abs(vig) < 0.005) {
        efficiency = "excellent";
    }
    else if (Math.abs(vig) < 0.02) {
        efficiency = "good";
    }
    else if (Math.abs(vig) < 0.05) {
        efficiency = "fair";
    }
    else if (vig > 0) {
        efficiency = "poor";
    }
    else {
        efficiency = "exploitable";
    }
    // Calculate true probabilities (vig-adjusted)
    const trueProbabilities = {};
    const trueProbabilitiesPercent = {};
    const probabilityDenominator = sumOfOutcomes > 0 ? sumOfOutcomes : 1;
    for (const outcome of outcomes) {
        const decimalProbability = outcome.price / probabilityDenominator;
        trueProbabilities[outcome.name] = Number(decimalProbability.toFixed(4));
        trueProbabilitiesPercent[outcome.name] = Number((decimalProbability * 100).toFixed(2));
    }
    // Generate recommendation
    let recommendation;
    if (vig < -0.01) {
        recommendation = `🚨 Arbitrage opportunity! Sum of prices is ${sumOfOutcomes.toFixed(4)}. Buy all outcomes for guaranteed profit.`;
    }
    else if (vig > 0.05) {
        recommendation = `⚠️ High vig (${(vig * 100).toFixed(1)}%). Spread is eating potential edge. Consider waiting for better prices.`;
    }
    else if (vig > 0.02) {
        recommendation = `Moderate vig (${(vig * 100).toFixed(1)}%). Account for this when sizing positions.`;
    }
    else {
        recommendation = "Market is efficiently priced. Edge must come from superior information.";
    }
    // Try to get spread info from merged orderbook
    let spreadInfo = null;
    try {
        const tokenIds = parseJsonArray(market.clobTokenIds);
        if (tokenIds[0] && tokenIds[1]) {
            const yesBook = (await fetchClob(`/book?token_id=${tokenIds[0]}`));
            const noBook = (await fetchClob(`/book?token_id=${tokenIds[1]}`));
            // Build merged orderbook for YES token
            const mergedBids = [];
            const mergedAsks = [];
            // Synthetic YES bids from NO asks
            for (const ask of noBook.asks || []) {
                const synthetic = 1 - Number(ask.price);
                if (synthetic > 0 && synthetic < 1)
                    mergedBids.push(synthetic);
            }
            // Synthetic YES asks from NO bids  
            for (const bid of noBook.bids || []) {
                const synthetic = 1 - Number(bid.price);
                if (synthetic > 0 && synthetic < 1)
                    mergedAsks.push(synthetic);
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
    }
    catch {
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
        selectionReason,
        fetchedAt: new Date().toISOString(),
    });
}
function getTradeNotional(trade) {
    return Number(trade.size || 0) * Number(trade.price || 0);
}
function getTradeBucket(notional) {
    if (notional < TRADE_SMALL_MAX_USD) {
        return "small";
    }
    if (notional < TRADE_MEDIUM_MAX_USD) {
        return "medium";
    }
    if (notional < TRADE_WHALE_MIN_USD) {
        return "large";
    }
    return "whale";
}
function getTradeDedupeKey(trade) {
    return [
        trade.id,
        trade.transactionHash,
        trade.match_time,
        trade.matchTime,
        trade.timestamp,
        trade.proxyWallet,
        trade.trader,
        trade.side,
        trade.outcome,
        trade.size,
        trade.price,
    ]
        .filter((value) => value !== undefined && value !== null && String(value).length > 0)
        .join("|");
}
function mergeTradeSamples(...samples) {
    const merged = new Map();
    for (const sample of samples) {
        for (const trade of sample) {
            const key = getTradeDedupeKey(trade);
            if (key.length > 0 && !merged.has(key)) {
                merged.set(key, trade);
            }
        }
    }
    return Array.from(merged.values()).sort((left, right) => {
        const leftTimestamp = getTradeTimestampMs(left) ?? 0;
        const rightTimestamp = getTradeTimestampMs(right) ?? 0;
        return rightTimestamp - leftTimestamp;
    });
}
function getYesDirectionalSign(trade) {
    const side = (trade.side || "BUY").toUpperCase();
    const outcome = (trade.outcome || "").toLowerCase();
    const isBuy = side === "BUY" || side === "B";
    if (outcome === "no") {
        return isBuy ? -1 : 1;
    }
    return isBuy ? 1 : -1;
}
function formatTradeTime(timestamp) {
    const numericTimestamp = Number(timestamp || 0);
    if (!Number.isFinite(numericTimestamp) || numericTimestamp <= 0) {
        return null;
    }
    return new Date(numericTimestamp * 1000).toISOString();
}
function getTradeTimestampMs(trade) {
    const timestamp = Number(trade.match_time || trade.timestamp || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
    }
    return timestamp > 1_000_000_000_000 ? timestamp : timestamp * 1_000;
}
function getTradeTimestampSeconds(trade) {
    const timestampMs = getTradeTimestampMs(trade);
    return timestampMs === null ? undefined : Math.floor(timestampMs / 1_000);
}
async function fetchReportedMarketVolume24h(conditionId) {
    if (!conditionId) {
        return null;
    }
    try {
        const markets = (await fetchGamma(`/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`, 8_000));
        const market = Array.isArray(markets) ? markets[0] : null;
        const volume = Number(market?.volume24hr ?? 0);
        return Number.isFinite(volume) && volume > 0 ? volume : null;
    }
    catch {
        return null;
    }
}
function buildTradeCoverageWarning(params) {
    if (params.filterDescription) {
        if (params.coverageLevel === "insufficient") {
            return `Public trades coverage is insufficient for ${params.filterDescription} over ${params.hoursBack}h (stop reason: ${params.endReason}). Treat matching trade-flow direction as unavailable.`;
        }
        if (params.coverageLevel === "partial") {
            return `Public trades coverage is partial for ${params.filterDescription} over ${params.hoursBack}h (stop reason: ${params.endReason}). Describe matching large/whale prints as sampled, not complete.`;
        }
        return null;
    }
    const ratio = params.coverageRatio === null
        ? "unknown"
        : `${Math.round(params.coverageRatio * 100)}%`;
    if (params.coverageLevel === "insufficient") {
        return `Public trades coverage is insufficient for a full ${params.hoursBack}h flow claim (sample/reported volume ratio: ${ratio}; stop reason: ${params.endReason}). Treat buy/sell and whale-flow direction as unreliable.`;
    }
    if (params.coverageLevel === "partial") {
        return `Public trades coverage is partial for the ${params.hoursBack}h window (sample/reported volume ratio: ${ratio}; stop reason: ${params.endReason}). Describe this as sampled public tape, not complete market flow.`;
    }
    return null;
}
function getTradeCoverageLevel(params) {
    if (params.recentTrades === 0) {
        return "insufficient";
    }
    if (!params.usesReportedVolumeCoverage) {
        return params.reachedWindowStart || params.sourceExhausted
            ? "complete"
            : "partial";
    }
    if ((params.reachedWindowStart || params.sourceExhausted) &&
        (params.sampledToReportedVolumeRatio === null ||
            params.sampledToReportedVolumeRatio >= 0.95)) {
        return "complete";
    }
    if (params.sampledToReportedVolumeRatio !== null &&
        params.sampledToReportedVolumeRatio >= params.targetCoverageRatio) {
        return "high_coverage";
    }
    if (params.sampledToReportedVolumeRatio !== null &&
        params.sampledToReportedVolumeRatio < 0.2) {
        return "insufficient";
    }
    return "partial";
}
async function fetchMarketTradesWindow(params) {
    const policy = TRADE_COVERAGE_POLICIES[params.coverageMode];
    const cutoffMs = Date.now() - params.hoursBack * 60 * 60 * 1_000;
    const filterParts = [
        params.tradeFilter?.description,
        params.side ? `${params.side} trades` : undefined,
        params.user ? `wallet ${params.user}` : undefined,
    ].filter((value) => typeof value === "string");
    const filterDescription = filterParts.length > 0 ? filterParts.join(", ") : undefined;
    const isFilteredFetch = filterDescription !== undefined;
    const reportedVolume24h = isFilteredFetch
        ? null
        : await fetchReportedMarketVolume24h(params.conditionId);
    const allFetchedTrades = [];
    let pagesFetched = 0;
    let endReason = "request_cap_reached";
    let reachedWindowStart = false;
    let sourceExhausted = false;
    while (allFetchedTrades.length < policy.maxRows &&
        pagesFetched < policy.maxRequests) {
        const offset = pagesFetched * policy.pageSize;
        if (offset > TRADE_DATA_API_MAX_OFFSET) {
            endReason = "offset_cap_reached";
            break;
        }
        const remainingRows = policy.maxRows - allFetchedTrades.length;
        const pageLimit = Math.min(policy.pageSize, remainingRows);
        const searchParams = new URLSearchParams({
            market: params.conditionId,
            limit: String(pageLimit),
            offset: String(offset),
        });
        if (params.tradeFilter) {
            searchParams.set("filterType", params.tradeFilter.filterType);
            searchParams.set("filterAmount", String(params.tradeFilter.filterAmount));
        }
        if (params.side) {
            searchParams.set("side", params.side);
        }
        if (params.user) {
            searchParams.set("user", params.user);
        }
        const endpoint = `/trades?${searchParams.toString()}`;
        let page;
        try {
            page = (await fetchDataApi(endpoint));
        }
        catch (error) {
            if (allFetchedTrades.length === 0) {
                throw error;
            }
            endReason = "page_fetch_failed_after_partial_data";
            break;
        }
        pagesFetched++;
        if (!Array.isArray(page) || page.length === 0) {
            sourceExhausted = true;
            endReason = "source_exhausted";
            break;
        }
        allFetchedTrades.push(...page);
        const pageTimestamps = page
            .map(getTradeTimestampMs)
            .filter((value) => value !== null);
        const oldestPageTimestamp = pageTimestamps.length > 0 ? Math.min(...pageTimestamps) : null;
        if (oldestPageTimestamp !== null && oldestPageTimestamp <= cutoffMs) {
            reachedWindowStart = true;
            endReason = "reached_requested_window_start";
            break;
        }
        if (page.length < pageLimit) {
            sourceExhausted = true;
            endReason = "source_exhausted";
            break;
        }
        const recentVolumeSoFar = allFetchedTrades
            .filter((trade) => {
            const timestampMs = getTradeTimestampMs(trade);
            return timestampMs !== null && timestampMs > cutoffMs;
        })
            .reduce((sum, trade) => sum + getTradeNotional(trade), 0);
        if (!isFilteredFetch &&
            reportedVolume24h !== null &&
            recentVolumeSoFar / reportedVolume24h >= policy.targetCoverageRatio) {
            endReason = "target_coverage_reached";
            break;
        }
    }
    const recentTrades = allFetchedTrades.filter((trade) => {
        const timestampMs = getTradeTimestampMs(trade);
        return timestampMs !== null && timestampMs > cutoffMs;
    });
    const sampledTradeVolume = recentTrades.reduce((sum, trade) => sum + getTradeNotional(trade), 0);
    const sampledToReportedVolumeRatio = reportedVolume24h !== null && reportedVolume24h > 0
        ? sampledTradeVolume / reportedVolume24h
        : null;
    const coverageLevel = getTradeCoverageLevel({
        recentTrades: recentTrades.length,
        sampledToReportedVolumeRatio,
        reachedWindowStart,
        sourceExhausted,
        targetCoverageRatio: policy.targetCoverageRatio,
        usesReportedVolumeCoverage: !isFilteredFetch,
    });
    const canMakeDirectionalClaim = !isFilteredFetch &&
        (coverageLevel === "complete" || coverageLevel === "high_coverage");
    const canMakeFilteredFlowClaim = isFilteredFetch &&
        (coverageLevel === "complete" || coverageLevel === "high_coverage");
    const canMakeWhaleClaim = canMakeDirectionalClaim ||
        (canMakeFilteredFlowClaim &&
            (params.tradeFilter?.filterType !== "CASH" ||
                params.tradeFilter.filterAmount <= TRADE_WHALE_MIN_USD));
    const oldestRecentTimestamp = recentTrades
        .map(getTradeTimestampSeconds)
        .filter((value) => value !== undefined)
        .sort((left, right) => left - right)[0] ?? undefined;
    const newestRecentTimestamp = recentTrades
        .map(getTradeTimestampSeconds)
        .filter((value) => value !== undefined)
        .sort((left, right) => right - left)[0] ?? undefined;
    const tradeCoverage = {
        coverageMode: params.coverageMode,
        coverageScope: isFilteredFetch ? "filtered_public_tape" : "all_public_tape",
        tradeFilter: params.tradeFilter ?? null,
        sideFilter: params.side ?? null,
        userFilter: params.user ?? null,
        coverageLevel,
        rowsFetched: allFetchedTrades.length,
        fetchedTrades: allFetchedTrades.length,
        maxRows: policy.maxRows,
        maxTradesFetched: policy.maxRows,
        pageSize: policy.pageSize,
        pagesFetched,
        maxRequests: policy.maxRequests,
        recentRowsAnalyzed: recentTrades.length,
        recentTradesAnalyzed: recentTrades.length,
        sampledTradeVolume: Number(sampledTradeVolume.toFixed(2)),
        reportedMarketVolume24h: reportedVolume24h === null ? null : Number(reportedVolume24h.toFixed(2)),
        sampledToReportedVolumeRatio: sampledToReportedVolumeRatio === null
            ? null
            : Number(sampledToReportedVolumeRatio.toFixed(4)),
        targetCoverageRatio: policy.targetCoverageRatio,
        oldestRecentTradeAt: formatTradeTime(oldestRecentTimestamp),
        newestRecentTradeAt: formatTradeTime(newestRecentTimestamp),
        endReason,
        reachedWindowStart,
        sourceExhausted,
        canMakeDirectionalClaim,
        canMakeFilteredFlowClaim,
        canMakeWhaleClaim,
        coverageWarning: buildTradeCoverageWarning({
            coverageLevel,
            coverageRatio: sampledToReportedVolumeRatio,
            endReason,
            hoursBack: params.hoursBack,
            filterDescription,
        }),
    };
    return {
        allFetchedTrades,
        recentTrades,
        tradeCoverage,
    };
}
function combineRawAndSizeFilteredTradeCoverage(params) {
    const rawRowsFetched = Number(params.rawCoverage.rowsFetched ?? 0);
    const sizeFilteredRowsFetched = Number(params.sizeFilteredCoverage.rowsFetched ?? 0);
    const rawPagesFetched = Number(params.rawCoverage.pagesFetched ?? 0);
    const sizeFilteredPagesFetched = Number(params.sizeFilteredCoverage.pagesFetched ?? 0);
    const rawMaxRows = Number(params.rawCoverage.maxRows ?? 0);
    const sizeFilteredMaxRows = Number(params.sizeFilteredCoverage.maxRows ?? 0);
    const rawMaxRequests = Number(params.rawCoverage.maxRequests ?? 0);
    const sizeFilteredMaxRequests = Number(params.sizeFilteredCoverage.maxRequests ?? 0);
    const rawWarning = typeof params.rawCoverage.coverageWarning === "string"
        ? params.rawCoverage.coverageWarning
        : null;
    const sizeFilteredWarning = typeof params.sizeFilteredCoverage.coverageWarning === "string"
        ? params.sizeFilteredCoverage.coverageWarning
        : null;
    const canMakeDirectionalClaim = params.rawCoverage.canMakeDirectionalClaim === true;
    const canMakeWhaleClaim = params.sizeFilteredCoverage.canMakeWhaleClaim === true ||
        params.rawCoverage.canMakeWhaleClaim === true;
    const coverageWarning = [rawWarning, canMakeWhaleClaim ? null : sizeFilteredWarning]
        .filter((value) => typeof value === "string")
        .join(" ");
    return {
        ...params.rawCoverage,
        sampleStrategy: "raw_recent_plus_size_filtered_large_trades",
        coverageScope: "all_public_tape_with_size_filtered_large_supplement",
        rowsFetched: rawRowsFetched + sizeFilteredRowsFetched,
        fetchedTrades: rawRowsFetched + sizeFilteredRowsFetched,
        maxRows: rawMaxRows + sizeFilteredMaxRows,
        maxTradesFetched: rawMaxRows + sizeFilteredMaxRows,
        pagesFetched: rawPagesFetched + sizeFilteredPagesFetched,
        maxRequests: rawMaxRequests + sizeFilteredMaxRequests,
        recentRowsAnalyzed: params.mergedRecentTrades.length,
        recentTradesAnalyzed: params.mergedRecentTrades.length,
        rawTradeCoverage: params.rawCoverage,
        sizeFilteredTradeCoverage: params.sizeFilteredCoverage,
        sizeFilteredCoverageLevel: params.sizeFilteredCoverage.coverageLevel,
        rawSampledToReportedVolumeRatio: params.rawCoverage.sampledToReportedVolumeRatio ?? null,
        canMakeDirectionalClaim,
        canMakeWhaleClaim,
        coverageWarning: coverageWarning.length > 0 ? coverageWarning : null,
    };
}
function tradeFlowBucketValue(flowBySize, bucketName, fieldName) {
    const bucket = workflowObject(flowBySize[bucketName]);
    return workflowToNumber(bucket[fieldName], 0);
}
function buildWhaleFlowBuyerGuidance(params) {
    const rawCoverage = workflowObject(params.tradeCoverage.rawTradeCoverage);
    const sizeFilteredCoverage = workflowObject(params.tradeCoverage.sizeFilteredTradeCoverage);
    const rawCoverageLevel = typeof rawCoverage.coverageLevel === "string"
        ? rawCoverage.coverageLevel
        : typeof params.tradeCoverage.coverageLevel === "string"
            ? params.tradeCoverage.coverageLevel
            : "unknown";
    const sizeFilteredCoverageLevel = typeof sizeFilteredCoverage.coverageLevel === "string"
        ? sizeFilteredCoverage.coverageLevel
        : typeof params.tradeCoverage.sizeFilteredCoverageLevel === "string"
            ? params.tradeCoverage.sizeFilteredCoverageLevel
            : "unknown";
    const rawCoverageRatio = workflowToNumber(rawCoverage.sampledToReportedVolumeRatio ??
        params.tradeCoverage.rawSampledToReportedVolumeRatio, 0);
    const largeNetFlow = tradeFlowBucketValue(params.flowBySize, "large", "netFlow");
    const whaleNetFlow = tradeFlowBucketValue(params.flowBySize, "whale", "netFlow");
    const whaleCount = tradeFlowBucketValue(params.flowBySize, "whale", "count");
    const largeDominatesWhale = Math.abs(largeNetFlow) > 0 &&
        Math.abs(largeNetFlow) >= Math.max(Math.abs(whaleNetFlow) * 2, 1_000);
    const rawRatioText = rawCoverageRatio > 0
        ? ` Raw unfiltered tape covers about ${Math.round(rawCoverageRatio * 100)}% of reported 24h volume.`
        : "";
    const sizeFilteredText = sizeFilteredCoverageLevel === "complete"
        ? ` All ${formatUsdThreshold(TRADE_SIZE_FILTER_MIN_USD)}+ trades in the requested window were captured.`
        : ` ${formatUsdThreshold(TRADE_SIZE_FILTER_MIN_USD)}+ trade coverage is ${sizeFilteredCoverageLevel}; describe large-print flow as sampled.`;
    const dominantFlowPlainEnglish = whaleCount === 0 && largeDominatesWhale
        ? `Recent directional flow is dominated by large prints (${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)}); there were no whale-sized prints (${formatUsdThreshold(TRADE_WHALE_MIN_USD)}+) in this window.`
        : largeDominatesWhale
            ? `Recent directional flow is dominated by large prints (${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)}), not by the whale-print bucket.`
            : `Use the large and whale buckets separately; do not merge ${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)} prints with ${formatUsdThreshold(TRADE_WHALE_MIN_USD)}+ prints.`;
    return {
        tradeSizeTaxonomy: {
            small: `<${formatUsdThreshold(TRADE_SMALL_MAX_USD)} retail-sized prints`,
            medium: `${formatUsdThreshold(TRADE_SMALL_MAX_USD)}-${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)} medium prints`,
            large: `${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)} large prints`,
            whale: `>=${formatUsdThreshold(TRADE_WHALE_MIN_USD)} whale-sized prints`,
        },
        wordingRules: [
            `Reserve "whale prints" for single trades >=${formatUsdThreshold(TRADE_WHALE_MIN_USD)}.`,
            `Call ${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)} trades "large prints" or "large-sized trades", not whales or accounts.`,
            "Use holder-whale language only for top-holder position data; trade buckets measure single-trade notional.",
        ],
        coveragePlainEnglish: `${sizeFilteredText}${rawRatioText}`.trim(),
        rawRetailFlowCaveat: rawCoverageLevel === "complete" || rawCoverageLevel === "high_coverage"
            ? `Raw retail tape has ${rawCoverageLevel} coverage for full-market direction.`
            : `Raw retail tape is ${rawCoverageLevel}; retail flow is sampled and should not be overstated as exhaustive.`,
        dominantFlowPlainEnglish,
    };
}
async function handleAnalyzeWhaleFlow(args) {
    const conditionIdInput = typeof args?.conditionId === "string" ? args.conditionId : undefined;
    const slug = typeof args?.slug === "string" ? args.slug : undefined;
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery : undefined;
    const tokenId = args?.tokenId;
    const hoursBack = args?.hoursBack || 24;
    let conditionId = conditionIdInput;
    let marketLabel = marketQuery?.trim() || slug || conditionIdInput || tokenId || "unknown-market";
    if (!conditionId && !tokenId) {
        const resolved = await resolveMarketReference({
            conditionId: conditionIdInput,
            slug,
            marketQuery,
        });
        if (!resolved?.conditionId) {
            return errorResult("Provide one of conditionId, tokenId, slug, or marketQuery. Could not resolve a market from the provided reference.");
        }
        conditionId = resolved.conditionId;
        marketLabel = resolved.marketTitle || resolved.conditionId;
    }
    let trades = [];
    let tradeCoverage;
    try {
        if (conditionId) {
            const rawFetched = await fetchMarketTradesWindow({
                conditionId,
                hoursBack,
                coverageMode: "deep",
            });
            const sizeFilteredFetched = await fetchMarketTradesWindow({
                conditionId,
                hoursBack,
                coverageMode: "deep",
                tradeFilter: {
                    filterType: "CASH",
                    filterAmount: TRADE_SIZE_FILTER_MIN_USD,
                    description: `trades >= ${formatUsdThreshold(TRADE_SIZE_FILTER_MIN_USD)} notional`,
                },
            });
            trades = mergeTradeSamples(rawFetched.recentTrades, sizeFilteredFetched.recentTrades);
            tradeCoverage = combineRawAndSizeFilteredTradeCoverage({
                rawCoverage: rawFetched.tradeCoverage,
                sizeFilteredCoverage: sizeFilteredFetched.tradeCoverage,
                mergedRecentTrades: trades,
            });
        }
        else {
            const tradesResp = (await fetchClob(`/trades?asset_id=${tokenId}`));
            const cutoffTime = Date.now() - hoursBack * 60 * 60 * 1000;
            trades = (tradesResp || []).filter((trade) => {
                const timestampMs = getTradeTimestampMs(trade);
                return timestampMs !== null && timestampMs > cutoffTime;
            });
            const sampledTradeVolume = trades.reduce((sum, trade) => sum + getTradeNotional(trade), 0);
            tradeCoverage = {
                coverageMode: "quick",
                coverageLevel: trades.length > 0 ? "partial" : "insufficient",
                rowsFetched: tradesResp?.length ?? 0,
                fetchedTrades: tradesResp?.length ?? 0,
                maxRows: null,
                maxTradesFetched: null,
                pageSize: null,
                pagesFetched: 1,
                maxRequests: 1,
                recentRowsAnalyzed: trades.length,
                recentTradesAnalyzed: trades.length,
                sampledTradeVolume: Number(sampledTradeVolume.toFixed(2)),
                reportedMarketVolume24h: null,
                sampledToReportedVolumeRatio: null,
                targetCoverageRatio: null,
                oldestRecentTradeAt: formatTradeTime(trades
                    .map(getTradeTimestampSeconds)
                    .filter((value) => value !== undefined)
                    .sort((left, right) => left - right)[0]),
                newestRecentTradeAt: formatTradeTime(trades
                    .map(getTradeTimestampSeconds)
                    .filter((value) => value !== undefined)
                    .sort((left, right) => right - left)[0]),
                endReason: "clob_unpaginated_asset_trades",
                reachedWindowStart: false,
                sourceExhausted: false,
                canMakeDirectionalClaim: false,
                canMakeWhaleClaim: false,
                coverageWarning: "CLOB asset trades are an unpaginated public sample; describe direction as sampled tape only.",
            };
        }
    }
    catch {
        // If trades endpoint fails, return limited analysis
        const tradeCoverageUnavailable = {
            coverageMode: conditionId ? "deep" : "quick",
            coverageLevel: "insufficient",
            rowsFetched: 0,
            fetchedTrades: 0,
            maxRows: conditionId ? TRADE_COVERAGE_POLICIES.deep.maxRows : null,
            maxTradesFetched: conditionId ? TRADE_COVERAGE_POLICIES.deep.maxRows : null,
            pageSize: conditionId ? TRADE_COVERAGE_POLICIES.deep.pageSize : null,
            pagesFetched: 0,
            maxRequests: conditionId ? TRADE_COVERAGE_POLICIES.deep.maxRequests : 1,
            recentRowsAnalyzed: 0,
            recentTradesAnalyzed: 0,
            sampledTradeVolume: 0,
            reportedMarketVolume24h: null,
            sampledToReportedVolumeRatio: null,
            targetCoverageRatio: conditionId
                ? TRADE_COVERAGE_POLICIES.deep.targetCoverageRatio
                : null,
            oldestRecentTradeAt: null,
            newestRecentTradeAt: null,
            endReason: "trades_endpoint_unavailable",
            reachedWindowStart: false,
            sourceExhausted: false,
            canMakeDirectionalClaim: false,
            canMakeWhaleClaim: false,
            coverageWarning: "Trades endpoint was unavailable; no public trade-flow sample could be analyzed.",
        };
        return successResult({
            market: marketLabel,
            conditionId: conditionId || null,
            period: `Last ${hoursBack} hours`,
            totalTrades: 0,
            totalVolume: 0,
            flowBySize: {
                small: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
                medium: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
                large: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
                whale: { count: 0, buyVolume: 0, sellVolume: 0, netFlow: 0, sentiment: "neutral" },
            },
            sizeBucketDefinitions: {
                small: `<${formatUsdThreshold(TRADE_SMALL_MAX_USD)}`,
                medium: `${formatUsdThreshold(TRADE_SMALL_MAX_USD)}-${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}`,
                large: `${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)}`,
                whale: `>=${formatUsdThreshold(TRADE_WHALE_MIN_USD)}`,
            },
            directionalSemantics: "Positive netFlow means buying YES / selling NO. Negative netFlow means selling YES / buying NO.",
            tradeSample: {
                ...tradeCoverageUnavailable,
            },
            tradeCoverage: tradeCoverageUnavailable,
            whaleActivity: {
                netWhaleVolume: 0,
                sentiment: "neutral",
                largestTrade: null,
                largestTradeOverall: null,
            },
            divergence: "Insufficient data - trades endpoint may require authentication",
            fetchedAt: new Date().toISOString(),
        });
    }
    // Bucket trades by size, normalized into YES-equivalent direction:
    // BUY YES and SELL NO are bullish YES; SELL YES and BUY NO are bearish YES.
    const buckets = {
        small: { count: 0, buyVolume: 0, sellVolume: 0 },
        medium: { count: 0, buyVolume: 0, sellVolume: 0 },
        large: { count: 0, buyVolume: 0, sellVolume: 0 },
        whale: { count: 0, buyVolume: 0, sellVolume: 0 },
    };
    let largestTradeOverall = null;
    let largestWhaleTrade = null;
    let oldestRecentTimestamp;
    let newestRecentTimestamp;
    for (const trade of trades) {
        const price = Number(trade.price || 0);
        const notional = getTradeNotional(trade);
        if (!Number.isFinite(notional) || notional <= 0) {
            continue;
        }
        const side = trade.side?.toLowerCase() || "buy";
        const bucket = getTradeBucket(notional);
        const yesDirection = getYesDirectionalSign(trade);
        const timestamp = trade.match_time || trade.timestamp;
        if (timestamp &&
            (!oldestRecentTimestamp || Number(timestamp) < Number(oldestRecentTimestamp))) {
            oldestRecentTimestamp = timestamp;
        }
        if (timestamp &&
            (!newestRecentTimestamp || Number(timestamp) > Number(newestRecentTimestamp))) {
            newestRecentTimestamp = timestamp;
        }
        buckets[bucket].count++;
        if (yesDirection > 0) {
            buckets[bucket].buyVolume += notional;
        }
        else {
            buckets[bucket].sellVolume += notional;
        }
        if (!largestTradeOverall || notional > largestTradeOverall.size) {
            largestTradeOverall = {
                size: notional,
                side,
                price,
                outcome: trade.outcome || null,
                yesDirection: yesDirection > 0 ? "buying_yes" : "selling_yes",
            };
        }
        if (bucket === "whale" && (!largestWhaleTrade || notional > largestWhaleTrade.size)) {
            largestWhaleTrade = {
                size: notional,
                side,
                price,
                outcome: trade.outcome || null,
                yesDirection: yesDirection > 0 ? "buying_yes" : "selling_yes",
            };
        }
    }
    // Calculate net flows and sentiments
    const flowBySize = {};
    for (const [bucket, data] of Object.entries(buckets)) {
        const netFlow = data.buyVolume - data.sellVolume;
        let sentiment;
        if (Math.abs(netFlow) < 100) {
            sentiment = "neutral";
        }
        else if (netFlow > 0) {
            sentiment = "bullish";
        }
        else {
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
    let whaleSentiment;
    if (Math.abs(whaleNetFlow) < 500) {
        whaleSentiment = "neutral";
    }
    else if (whaleNetFlow > 0) {
        whaleSentiment = "bullish";
    }
    else {
        whaleSentiment = "bearish";
    }
    const canMakeDirectionalClaim = tradeCoverage.canMakeDirectionalClaim === true;
    const canMakeWhaleClaim = tradeCoverage.canMakeWhaleClaim === true;
    const coverageWarning = typeof tradeCoverage.coverageWarning === "string"
        ? tradeCoverage.coverageWarning
        : null;
    const coverageLevel = typeof tradeCoverage.coverageLevel === "string"
        ? tradeCoverage.coverageLevel
        : "insufficient";
    // Check for divergence
    const retailNetFlow = buckets.small.buyVolume - buckets.small.sellVolume;
    const retailSentiment = retailNetFlow > 100 ? "buying" : retailNetFlow < -100 ? "selling" : "neutral";
    const whaleBehavior = whaleNetFlow > 500 ? "buying" : whaleNetFlow < -500 ? "selling" : "neutral";
    let divergence;
    if (!canMakeDirectionalClaim) {
        if (canMakeWhaleClaim) {
            const whaleObservation = whaleBehavior === "neutral"
                ? "size-filtered large-trade tape found no strong whale-sized lean"
                : `size-filtered large-trade tape supports whale-sized prints leaning ${whaleBehavior}`;
            divergence = `Full-market retail flow is still sampled (${coverageLevel} raw coverage): retail-sized trades are ${retailSentiment}; ${whaleObservation}. Avoid treating retail-vs-whale divergence as complete unless raw trade coverage improves.`;
        }
        else {
            const whaleObservation = whaleBehavior === "neutral"
                ? "no whale-sized prints were observed"
                : `observed whale-sized prints lean ${whaleBehavior}`;
            divergence = `Sampled public tape only (${coverageLevel} coverage): retail-sized trades are ${retailSentiment}; ${whaleObservation}. ${coverageWarning ?? "Avoid treating this as complete market-wide flow."}`;
        }
    }
    else if (!canMakeWhaleClaim && whaleBehavior === "neutral") {
        divergence =
            "No whale-sized prints observed in the available high-coverage public tape; do not infer off-venue or private whale inactivity.";
    }
    else if (retailSentiment === "selling" && whaleBehavior === "buying") {
        divergence = "🐋 Divergence detected: Retail is selling, but whales are buying YES";
    }
    else if (retailSentiment === "buying" && whaleBehavior === "selling") {
        divergence = "🐋 Divergence detected: Retail is buying, but whales are selling";
    }
    else if (whaleBehavior !== "neutral") {
        divergence = `Whale flow is ${whaleBehavior}, aligned with retail`;
    }
    else {
        divergence = "No significant whale activity detected";
    }
    const totalVolume = Object.values(buckets).reduce((sum, b) => sum + b.buyVolume + b.sellVolume, 0);
    return successResult({
        market: marketLabel,
        conditionId: conditionId || null,
        period: `Last ${hoursBack} hours`,
        totalTrades: trades.length,
        totalVolume: Number(totalVolume.toFixed(2)),
        flowBySize,
        sizeBucketDefinitions: {
            small: `<${formatUsdThreshold(TRADE_SMALL_MAX_USD)}`,
            medium: `${formatUsdThreshold(TRADE_SMALL_MAX_USD)}-${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}`,
            large: `${formatUsdThreshold(TRADE_MEDIUM_MAX_USD)}-${formatUsdThreshold(TRADE_WHALE_MIN_USD)}`,
            whale: `>=${formatUsdThreshold(TRADE_WHALE_MIN_USD)}`,
        },
        directionalSemantics: "Positive netFlow means buying YES / selling NO. Negative netFlow means selling YES / buying NO.",
        tradeSample: {
            ...tradeCoverage,
            sampledTradeVolume: Number(totalVolume.toFixed(2)),
            oldestRecentTradeAt: tradeCoverage.oldestRecentTradeAt ?? formatTradeTime(oldestRecentTimestamp),
            newestRecentTradeAt: tradeCoverage.newestRecentTradeAt ?? formatTradeTime(newestRecentTimestamp),
        },
        tradeCoverage: {
            ...tradeCoverage,
            sampledTradeVolume: Number(totalVolume.toFixed(2)),
            oldestRecentTradeAt: tradeCoverage.oldestRecentTradeAt ?? formatTradeTime(oldestRecentTimestamp),
            newestRecentTradeAt: tradeCoverage.newestRecentTradeAt ?? formatTradeTime(newestRecentTimestamp),
        },
        buyerGuidance: buildWhaleFlowBuyerGuidance({
            flowBySize,
            tradeCoverage,
        }),
        whaleActivity: {
            netWhaleVolume: Number(whaleNetFlow.toFixed(2)),
            sentiment: whaleSentiment,
            confidence: canMakeWhaleClaim ? "size_filter_coverage_supported" : "sample_observation_only",
            claimWarning: canMakeWhaleClaim ? null : coverageWarning,
            largestTrade: largestWhaleTrade,
            largestTradeOverall,
        },
        divergence,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleFindCorrelatedMarkets(args) {
    const conditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    if (!conditionId && !slug) {
        return errorResult("Either conditionId or slug is required");
    }
    let sourceEvent = null;
    let sourceMarket = null;
    let sourceSlug = slug;
    try {
        if (sourceSlug.length > 0) {
            sourceEvent = (await fetchGamma(`/events/slug/${sourceSlug}`, 8_000));
            sourceMarket =
                selectMarketForTopMarkets(sourceEvent, "volume") ??
                    getRepresentativeGammaMarket(sourceEvent, {
                        preference: "tradable",
                    });
        }
        else {
            const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`, 8_000));
            sourceMarket = Array.isArray(gammaMarkets) ? gammaMarkets[0] ?? null : null;
            sourceSlug = sourceMarket?.slug || "";
            if (sourceSlug.length > 0) {
                sourceEvent = (await fetchGamma(`/events/slug/${sourceSlug}`, 8_000));
                sourceMarket =
                    sourceEvent?.markets?.find((market) => market.conditionId === sourceMarket?.conditionId) ??
                        sourceMarket;
            }
        }
    }
    catch {
        sourceEvent = null;
    }
    if (!sourceMarket) {
        return errorResult("Source market not found");
    }
    const sourceConditionId = sourceMarket.conditionId || conditionId;
    const sourceTags = Array.from(new Set((sourceEvent?.tags || [])
        .map((tag) => tag.slug || tag.label || "")
        .filter((tag) => tag.length > 0)));
    const sourceCategory = sourceEvent?.category ||
        sourceMarket.category ||
        "";
    const sourceTitle = sourceMarket.question || sourceMarket.title || sourceEvent?.title || "";
    const sourceInferredCategory = categorizeMarket(sourceTitle, sourceCategory);
    const sourceEventId = sourceEvent?.id !== undefined && sourceEvent?.id !== null
        ? String(sourceEvent.id)
        : "";
    const candidateByConditionId = new Map();
    const buildHedgeNote = (correlationType, correlationScore, marketTitle) => {
        switch (correlationType) {
            case "same_event":
                return `Same event family as the source market. "${marketTitle}" is a direct sibling outcome and the cleanest hedge candidate if you want intra-event exposure.`;
            case "same_tags":
                return `Shares the strongest source tags/themes with the original contract. Good secondary hedge candidate if you want related exposure without the exact same event.`;
            case "title_similarity":
                return `Title semantics overlap with the source contract. Treat as a looser thematic hedge, not a guaranteed equivalent.`;
            default:
                return correlationScore >= 60
                    ? "Same-category market with meaningfully similar exposure. Review rules before treating it as a hedge."
                    : "Same-category market with weaker overlap. Use only as a loose hedge after checking the rule wording.";
        }
    };
    const upsertCandidate = (market, event, correlationType, correlationScore) => {
        const candidateConditionId = market.conditionId || "";
        if (candidateConditionId.length === 0 ||
            candidateConditionId === sourceConditionId) {
            return;
        }
        const existing = candidateByConditionId.get(candidateConditionId);
        if (existing && existing.correlationScore >= correlationScore) {
            return;
        }
        const title = market.question || market.title || event?.title || candidateConditionId;
        candidateByConditionId.set(candidateConditionId, {
            event,
            market,
            correlationType,
            correlationScore,
            hedgeNote: buildHedgeNote(correlationType, correlationScore, title),
        });
    };
    if (Array.isArray(sourceEvent?.markets)) {
        for (const sibling of sourceEvent.markets) {
            if (sibling.conditionId === sourceConditionId ||
                sibling.active === false ||
                sibling.closed === true) {
                continue;
            }
            upsertCandidate(sibling, sourceEvent, "same_event", 95);
        }
    }
    const relatedEvents = (await fetchGamma(`/events?closed=false&limit=40${sourceCategory ? `&category=${encodeURIComponent(sourceCategory)}` : ""}`, 10_000));
    const sourceKeywordSet = new Set(extractKeywords(sourceTitle));
    for (const event of relatedEvents) {
        const eventSlug = event.slug || "";
        if ((sourceSlug.length > 0 && eventSlug === sourceSlug) ||
            (sourceEventId.length > 0 && String(event.id || "") === sourceEventId)) {
            continue;
        }
        if (event.active === false || event.closed === true) {
            continue;
        }
        const representativeMarket = selectMarketForTopMarkets(event, "volume") ??
            getRepresentativeGammaMarket(event, { preference: "tradable" });
        if (!representativeMarket) {
            continue;
        }
        const candidateTitle = representativeMarket.question || representativeMarket.title || event.title || "";
        const candidateInferredCategory = categorizeMarket(candidateTitle, event.category);
        if (sourceInferredCategory !== "other" &&
            candidateInferredCategory !== sourceInferredCategory) {
            continue;
        }
        const eventTags = Array.from(new Set((event.tags || [])
            .map((tag) => tag.slug || tag.label || "")
            .filter((tag) => tag.length > 0)));
        const sharedTagCount = sourceTags.filter((tag) => eventTags.includes(tag)).length;
        const eventKeywordSet = new Set(extractKeywords(event.title || ""));
        let sharedKeywordCount = 0;
        for (const keyword of eventKeywordSet) {
            if (sourceKeywordSet.has(keyword)) {
                sharedKeywordCount += 1;
            }
        }
        let correlationType = null;
        let correlationScore = 0;
        if (sourceEventId.length > 0 &&
            typeof event.parentEvent !== "undefined" &&
            String(event.parentEvent) === sourceEventId) {
            correlationType = "same_event";
            correlationScore = 85;
        }
        else if (sharedTagCount > 0) {
            correlationType = "same_tags";
            correlationScore = 52 + sharedTagCount * 10;
        }
        else if (sharedKeywordCount >= 2) {
            correlationType = "title_similarity";
            correlationScore = 44 + sharedKeywordCount * 8;
        }
        else if (sourceCategory.length > 0 &&
            (event.category || "").toLowerCase() === sourceCategory.toLowerCase()) {
            correlationType = "same_category";
            correlationScore = 46;
        }
        if (!correlationType || correlationScore < 45) {
            continue;
        }
        upsertCandidate(representativeMarket, event, correlationType, Math.min(correlationScore, 99));
    }
    const candidateRecords = Array.from(candidateByConditionId.values());
    const quoteSnapshots = await fetchGammaMarketQuoteSnapshots(candidateRecords.map((candidate) => candidate.market), {
        timeoutMs: "heavy",
    });
    const correlatedMarkets = candidateRecords
        .map((candidate) => ({
        title: candidate.market.question ||
            candidate.market.title ||
            candidate.event?.title ||
            "Unknown market",
        conditionId: candidate.market.conditionId || "",
        correlationType: candidate.correlationType,
        correlationScore: candidate.correlationScore,
        currentPrice: Number(resolveCurrentOutcomePrice(candidate.market, quoteSnapshots).toFixed(4)),
        hedgeNote: candidate.hedgeNote,
    }))
        .sort((left, right) => {
        if (right.correlationScore !== left.correlationScore) {
            return right.correlationScore - left.correlationScore;
        }
        return right.currentPrice - left.currentPrice;
    });
    let hedgingStrategy;
    if (correlatedMarkets.length === 0) {
        hedgingStrategy = "No correlated markets found for hedging";
    }
    else if (correlatedMarkets[0].correlationType === "same_event") {
        hedgingStrategy = `The cleanest hedge path is staying inside the same event family. Start with "${correlatedMarkets[0].title}" and confirm the outcome exposure before trading.`;
    }
    else {
        hedgingStrategy = `${correlatedMarkets.length} related markets were found. Prioritize the highest-scoring tag/title matches and review their rule wording before treating them as a hedge.`;
    }
    return successResult({
        sourceMarket: {
            title: sourceTitle,
            category: sourceCategory,
            tags: sourceTags,
            conditionId: sourceConditionId,
            slug: sourceSlug,
            currentPrice: Number(resolveCurrentOutcomePrice(sourceMarket).toFixed(4)),
        },
        correlatedMarkets: correlatedMarkets.slice(0, 10),
        hedgingStrategy,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleCheckMarketRules(args) {
    let slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    let conditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    let selectionReason = conditionId.length > 0
        ? "Used the provided conditionId."
        : slug.length > 0
            ? "Used the provided slug."
            : "";
    const genericMarketQuery = marketQuery.length > 0 && isGenericMarketReferenceQuery(marketQuery);
    if (slug.length === 0 && conditionId.length === 0) {
        const resolvedFromQuery = marketQuery.length > 0 && !genericMarketQuery
            ? await resolveMarketReference({ marketQuery })
            : null;
        if (resolvedFromQuery) {
            slug = resolvedFromQuery.slug || "";
            conditionId = resolvedFromQuery.conditionId;
            selectionReason = "Resolved directly from the provided marketQuery.";
        }
        else {
            const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                sortBy: "volume",
                preferSingleOutcome: true,
            });
            if (!fallbackCandidate) {
                return errorResult("Provide slug, conditionId, or marketQuery so the tool can resolve a market.");
            }
            slug = fallbackCandidate.slug;
            conditionId = fallbackCandidate.conditionId;
            selectionReason =
                "Committed to inspecting the strongest live single-outcome Polymarket market as a best-effort substitute when an explicit market identifier was absent.";
        }
    }
    // Get the event
    let event;
    if (conditionId) {
        // Use Gamma /markets?condition_ids= for direct market lookup
        // PERF: Replaces brute-force search through 100+50 events
        try {
            const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 8000));
            if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
                const m = gammaMarkets[0];
                // Construct event-like object from market data (has description, resolutionSource, etc.)
                event = {
                    title: m.question || m.title,
                    description: m.description,
                    resolutionSource: m.resolutionSource,
                    endDate: m.endDate,
                    markets: [m],
                };
            }
        }
        catch {
            // Fall through to slug-based lookup below when available.
        }
    }
    if (!event && slug) {
        event = (await fetchGamma(`/events/slug/${slug}`, 8000));
    }
    if (!event) {
        return errorResult("Event not found");
    }
    const title = event.title || "";
    const description = event.description || "";
    const compactDescription = description.replace(/\s+/g, " ").trim();
    const descriptionSentences = compactDescription
        .split(/(?<=[.!?])\s+/u)
        .map((sentence) => sentence.trim())
        .filter((sentence) => sentence.length > 0);
    const inferredResolutionSource = compactDescription.match(/(?:as announced by|according to|resolution source(?: will be| is)?|official source(?: will be| is)?)[\s:]+([^.]+)/i)?.[1]?.trim() || "";
    const resolutionSource = event.resolutionSource || inferredResolutionSource || "Not specified";
    const endDate = event.endDate || event.endDateIso || "";
    // Parse rules from description
    const descLower = description.toLowerCase();
    // Extract potential gotchas
    const potentialGotchas = [];
    const ambiguities = [];
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
    const primarySummarySentence = descriptionSentences.find((sentence) => /resolve|according to|announced|winner|official/i.test(sentence)) || descriptionSentences[0] || "";
    const cleanedPrimarySummary = primarySummarySentence
        .replace(/^this market (?:will )?resolve(?:s)? according to\s+/i, "")
        .replace(/^this market (?:will )?resolve(?:s)? if\s+/i, "")
        .replace(/^this market\s+/i, "")
        .trim();
    const noFallbackMatch = description.match(/(?:otherwise|if not|if no|unless)[^.]*(?:market\s+)?resolves?\s+(?:to\s+)?no[^.]*/i)?.[0] ||
        description.match(/(?:fails?|does not|is not)[^.]+/i)?.[0] ||
        "";
    if (yesMatch)
        resolvesYesIf = yesMatch[1].trim();
    if (noMatch)
        resolvesNoIf = noMatch[1].trim();
    if (!yesMatch && cleanedPrimarySummary) {
        resolvesYesIf = cleanedPrimarySummary;
    }
    if (!noMatch && noFallbackMatch) {
        resolvesNoIf = noFallbackMatch
            .replace(/^otherwise[:,]?\s*/i, "")
            .replace(/^if\s+/i, "If ")
            .trim();
    }
    else if (!noMatch && cleanedPrimarySummary) {
        resolvesNoIf =
            resolutionSource !== "Not specified"
                ? `The named outcome is not confirmed by ${resolutionSource}.`
                : "The named outcome is not confirmed under the market's stated resolution criteria.";
    }
    // Risk factors
    const riskFactors = [];
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
        }
        else if (daysRemaining < 7) {
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
        selectionReason,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleFindArbitrageOpportunities(args) {
    const category = args?.category;
    // Limit to 20 markets to avoid timeout - we need to fetch orderbooks
    const limit = Math.min(args?.limit || 20, 30);
    const categoryTagSlug = resolveDiscoveryCategoryTagSlug({ category });
    // Step 1: Get top markets by liquidity from Gamma (fast).
    // Gamma's ?category= filter is unreliable; use tag_slug + client-side tag checks
    // (same pattern as discover_trending_markets / get_top_markets).
    const fetchEventLimit = Math.min(Math.max(limit * 4, 24), 60);
    let endpoint = `/events?closed=false&limit=${fetchEventLimit}&order=liquidity&ascending=false`;
    if (categoryTagSlug) {
        endpoint += `&tag_slug=${encodeURIComponent(categoryTagSlug)}`;
    }
    let events = (await fetchGamma(endpoint, 10000));
    if (categoryTagSlug) {
        const filtered = events.filter((event) => eventMatchesDiscoveryCategoryTagSlug(event, categoryTagSlug));
        if (filtered.length > 0) {
            events = filtered;
        }
    }
    const arbitrageOpportunities = [];
    const wideSpreadMarkets = [];
    let marketsAnalyzed = 0;
    let totalSpread = 0;
    let wideSpreadCount = 0;
    // Step 2: For each market, fetch orderbooks and compute MERGED book
    // Polymarket shows synthetic liquidity from complement token
    const marketsToCheck = [];
    for (const event of events) {
        if (!event.markets || event.markets.length === 0)
            continue;
        for (const market of event.markets) {
            const yesTokenId = extractGammaYesTokenId(market);
            const noTokenId = extractGammaNoTokenId(market);
            if (!yesTokenId || !noTokenId)
                continue;
            const { yesPrice } = resolveCurrentBinaryPrices(market);
            // Skip settled markets
            if (yesPrice === null || yesPrice <= 0 || yesPrice >= 1)
                continue;
            marketsToCheck.push({
                event,
                market,
                yesTokenId,
                noTokenId,
            });
        }
    }
    // Fetch orderbooks in parallel (batches of 5 to respect rate limits)
    const batchSize = 5;
    for (let i = 0; i < marketsToCheck.length && i < limit * 2; i += batchSize) {
        const batch = marketsToCheck.slice(i, i + batchSize);
        const results = await Promise.all(batch.map(async ({ event, market, yesTokenId, noTokenId }) => {
            try {
                // Fetch both orderbooks in parallel
                const [yesBook, noBook] = await Promise.all([
                    fetchClob(`/book?token_id=${yesTokenId}`),
                    fetchClob(`/book?token_id=${noTokenId}`),
                ]);
                // Build MERGED orderbook for YES token
                // This is what Polymarket UI shows - includes synthetic liquidity
                const mergedYesAsks = [];
                const mergedYesBids = [];
                const mergedNoAsks = [];
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
            }
            catch {
                return null;
            }
        }));
        for (const result of results) {
            if (!result || result.bestYesAsk === null || result.bestNoAsk === null)
                continue;
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
                    url: getPolymarketUrl(event.slug || market.slug, market.conditionId),
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
                if (spread > 0.02) {
                    wideSpreadCount += 1;
                }
                wideSpreadMarkets.push({
                    market: market.question || event.title || "Unknown",
                    url: getPolymarketUrl(event.slug || market.slug, market.conditionId),
                    conditionId: market.conditionId || "",
                    spread: Number(spread.toFixed(4)),
                    spreadPercent: (spread * 100).toFixed(1) + "¢",
                    midPrice: Number(((bestYesAsk + bestYesBid) / 2).toFixed(4)),
                });
            }
        }
    }
    // Sort by edge
    arbitrageOpportunities.sort((a, b) => b.potentialEdge - a.potentialEdge);
    wideSpreadMarkets.sort((a, b) => b.spread - a.spread);
    const avgSpread = marketsAnalyzed > 0 ? (totalSpread / marketsAnalyzed) * 100 : 0;
    // Generate summary
    let summaryNote;
    if (arbitrageOpportunities.length > 0) {
        summaryNote = `🚨 Found ${arbitrageOpportunities.length} REAL arbitrage opportunities! Buy both YES and NO for guaranteed profit.`;
    }
    else if (marketsAnalyzed === 0) {
        summaryNote = "⚠️ Could not fetch orderbook data. Try again or reduce limit.";
    }
    else {
        summaryNote = `✅ No arbitrage found in ${marketsAnalyzed} markets. Polymarket is efficiently priced. Average spread: ${avgSpread.toFixed(1)}¢.`;
    }
    const categoryFilterNote = categoryTagSlug
        ? `Category scope: Polymarket tag "${categoryTagSlug}" with client-side tag verification (Gamma ?category= is not used).`
        : "No category filter — scanned global liquidity-ranked live events.";
    return successResult({
        scannedMarkets: marketsAnalyzed,
        arbitrageOpportunities: arbitrageOpportunities.slice(0, 10),
        wideSpreadMarkets: wideSpreadMarkets.slice(0, 5),
        summary: {
            arbitrageCount: arbitrageOpportunities.length,
            wideSpreadCount,
            averageSpreadCents: Number(avgSpread.toFixed(2)),
            summaryNote,
        },
        methodology: `Fetched real CLOB orderbooks and checked if BUY YES + BUY NO < $1.00. This is true arbitrage detection using executable prices, not midpoints. ${categoryFilterNote}`,
        fetchedAt: new Date().toISOString(),
    });
}
/**
 * Probability range presets for targetProbability parameter
 */
const PROBABILITY_RANGES = {
    longshot: { min: 0.01, max: 0.20 }, // 1-20%
    moderate: { min: 0.35, max: 0.65 }, // 35-65%
    likely: { min: 0.65, max: 0.85 }, // 65-85%
    near_certain: { min: 0.85, max: 0.98 }, // 85-98%
};
/**
 * Find genuine trading opportunities across multiple strategies
 */
async function handleFindTradingOpportunities(args) {
    // Parse arguments
    let strategy = args?.strategy || "all";
    const category = args?.category;
    const minLiquidity = args?.minLiquidity || 1000;
    const riskTolerance = args?.riskTolerance || "moderate";
    const priceRange = args?.priceRange;
    const targetProbability = args?.targetProbability;
    // Calculate effective price range from targetProbability or priceRange
    let effectivePriceMin = 0;
    let effectivePriceMax = 1;
    if (targetProbability && PROBABILITY_RANGES[targetProbability]) {
        effectivePriceMin = PROBABILITY_RANGES[targetProbability].min;
        effectivePriceMax = PROBABILITY_RANGES[targetProbability].max;
    }
    else if (priceRange) {
        effectivePriceMin = priceRange.min ?? 0;
        effectivePriceMax = priceRange.max ?? 1;
    }
    const hasPriceFilter = effectivePriceMin > 0 || effectivePriceMax < 1;
    // Depth-tiered fetching: controls how many events (and thus markets) are scanned.
    // The tool description instructs AI clients to use appropriate depth and avoid
    // calling this in parallel with other heavy tools when using "deep".
    const depth = args?.depth || "medium";
    const depthConfig = {
        shallow: { vol: 25, liq: 25, new: 15, timeout: 8000 }, // ~500 markets, ~5s
        medium: { vol: 50, liq: 50, new: 25, timeout: 12000 }, // ~1000 markets, ~10s
        deep: { vol: 100, liq: 100, new: 50, timeout: 20000 }, // ~2000+ markets, ~20s
    }[depth] || { vol: 50, liq: 50, new: 25, timeout: 12000 };
    const [volumeEvents, liquidityEvents, newEvents] = await Promise.all([
        fetchGamma(`/events?closed=false&limit=${depthConfig.vol}&order=volume24hr&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout),
        fetchGamma(`/events?closed=false&limit=${depthConfig.liq}&order=liquidity&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout),
        fetchGamma(`/events?closed=false&limit=${depthConfig.new}&order=startDate&ascending=false${category ? `&category=${category}` : ""}`, depthConfig.timeout),
    ]);
    // Combine and dedupe events
    const eventMap = new Map();
    [...volumeEvents, ...liquidityEvents, ...newEvents].forEach(e => {
        if (e.id && !eventMap.has(e.id)) {
            eventMap.set(e.id, e);
        }
    });
    const allEvents = Array.from(eventMap.values());
    const tradingOpportunityQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(allEvents.flatMap((event) => event.markets || []), {
        includeNoTokens: true,
        timeoutMs: "heavy",
    });
    const opportunities = [];
    // Track all markets for suggestions when empty
    const allMarketsData = [];
    let marketsScanned = 0;
    // Count markets by price range for suggestions
    let lotteryTicketCount = 0;
    let moderateCount = 0;
    let likelyCount = 0;
    for (const event of allEvents) {
        if (!event.markets || event.markets.length === 0)
            continue;
        const eventLiquidity = Number(event.liquidity || 0);
        const eventVolume24h = Number(event.volume24hr || 0);
        const eventSlug = event.slug || "";
        for (const market of event.markets) {
            const { yesPrice, noPrice } = resolveCurrentBinaryPrices(market, tradingOpportunityQuoteSnapshots);
            const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
            const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
            const marketTitle = market.question || event.title || "Unknown";
            if (marketLiquidity < minLiquidity)
                continue;
            if (yesPrice === null ||
                noPrice === null ||
                yesPrice <= 0 ||
                noPrice <= 0) {
                continue;
            }
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
            if (yesPrice < 0.15 || noPrice < 0.15)
                lotteryTicketCount++;
            if (yesPrice >= 0.35 && yesPrice <= 0.65)
                moderateCount++;
            if (yesPrice >= 0.65 && yesPrice <= 0.85)
                likelyCount++;
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
                    const riskFactors = [];
                    if (marketLiquidity < 5000)
                        riskFactors.push("Low liquidity - hard to exit");
                    if (yesPrice < 0.05)
                        riskFactors.push("Very low probability - likely to lose");
                    let confidence = "medium";
                    if (marketLiquidity > 20000 && marketVolume24h > 5000)
                        confidence = "high";
                    if (marketLiquidity < 5000 || yesPrice < 0.05)
                        confidence = "low";
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
                    const riskFactors = [];
                    if (marketLiquidity < 5000)
                        riskFactors.push("Low liquidity - hard to exit");
                    if (noPrice < 0.05)
                        riskFactors.push("Very low probability - likely to lose");
                    let confidence = "medium";
                    if (marketLiquidity > 20000 && marketVolume24h > 5000)
                        confidence = "high";
                    if (marketLiquidity < 5000 || noPrice < 0.05)
                        confidence = "low";
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
                    const riskFactors = [];
                    if (marketLiquidity < 10000)
                        riskFactors.push("Moderate liquidity");
                    let confidence = "medium";
                    if (marketLiquidity > 50000 && marketVolume24h > 10000)
                        confidence = "high";
                    if (marketLiquidity < 10000)
                        confidence = "low";
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
                    const riskFactors = [];
                    if (marketLiquidity < 20000)
                        riskFactors.push("Check liquidity before large bets");
                    let confidence = "high";
                    if (marketLiquidity < 20000)
                        confidence = "medium";
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
                    const riskFactors = [];
                    if (marketLiquidity < 20000)
                        riskFactors.push("Check liquidity before large bets");
                    let confidence = "high";
                    if (marketLiquidity < 20000)
                        confidence = "medium";
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
                    const riskFactors = [];
                    if (volumeToLiquidityRatio > 1)
                        riskFactors.push("Extremely high volume - news event likely");
                    let confidence = "medium";
                    if (marketLiquidity > 50000)
                        confidence = "high";
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
                    const riskFactors = [];
                    let signal;
                    let suggestedSide;
                    let confidence = "medium";
                    if (sumOfPrices < 0.97) {
                        // Arbitrage-like opportunity
                        signal = `Prices sum to ${(sumOfPrices * 100).toFixed(1)}¢ - under 100¢`;
                        suggestedSide = "EITHER";
                        confidence = "high";
                        riskFactors.push("May be temporary - act quickly");
                    }
                    else if (sumOfPrices > 1.05) {
                        // Wide spread - one side is probably mispriced
                        signal = `Wide spread - prices sum to ${(sumOfPrices * 100).toFixed(1)}¢`;
                        suggestedSide = yesPrice > noPrice ? "NO" : "YES"; // Bet on the cheaper side
                        confidence = "low";
                        riskFactors.push("Wide spread may indicate low liquidity on one side");
                    }
                    else {
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
                            const riskFactors = [];
                            riskFactors.push(`Resolves in ${daysRemaining.toFixed(1)} days`);
                            const isYesFavored = yesPrice > 0.5;
                            const favoredPrice = isYesFavored ? yesPrice : noPrice;
                            const underdogPrice = isYesFavored ? noPrice : yesPrice;
                            let confidence = "medium";
                            if (favoredPrice > 0.90)
                                confidence = "high";
                            if (marketLiquidity < 10000)
                                confidence = "low";
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
    }, {});
    const bestType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "none";
    let marketConditions;
    if (opportunities.length === 0) {
        marketConditions = "No markets match your specific criteria.";
    }
    else if (opportunities.length < 3) {
        marketConditions = "Few opportunities available matching your criteria.";
    }
    else if (opportunities.filter(o => o.confidence === "high").length > 3) {
        marketConditions = "Active market with multiple high-confidence opportunities. Good time to trade.";
    }
    else {
        marketConditions = "Normal market conditions with some speculative opportunities.";
    }
    // Build suggestions and nearestMatches when no opportunities found
    let noOpportunitiesReason;
    let suggestions;
    let nearestMatches;
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
            if (!hasPriceFilter)
                return false;
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
function workflowToNumber(value, fallback = 0) {
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
function workflowToBoundedInteger(value, fallback, min, max) {
    const numericValue = workflowToNumber(value, fallback);
    const rounded = Math.floor(numericValue);
    return Math.min(max, Math.max(min, rounded));
}
function workflowClamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
function workflowObject(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function workflowObjectArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => !!entry && typeof entry === "object" && !Array.isArray(entry));
}
function workflowStringArray(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((entry) => typeof entry === "string" && entry.length > 0);
}
function workflowUniqueStrings(values) {
    return Array.from(new Set(values
        .map((value) => value.trim())
        .filter((value) => value.length > 0)));
}
function workflowSplitOutcomeNames(value) {
    return workflowUniqueStrings(value
        .split(/,| and | vs\.? | versus /i)
        .map((part) => part
        .replace(/^(?:the\s+current\s+|current\s+)?(?:implied odds and spreads|odds and spreads|spreads|quotes)\s+for\s+/i, "")
        .replace(/^for\s+/i, "")
        .trim()));
}
function workflowExtractComparisonOutcomesFromQuery(value) {
    const patterns = [
        /implied odds and spreads for\s+(.+?)\s+(?:in|within)\s+/i,
        /odds and spreads for\s+(.+?)\s+(?:in|within)\s+/i,
        /spreads for\s+(.+?)\s+(?:in|within)\s+/i,
        /quotes for\s+(.+?)\s+(?:in|within)\s+/i,
        /(?:between|among)\s+(.+?)\s+(?:in|within)\s+/i,
        /compare\s+(.+?)\s+(?:in|within)\s+/i,
        /for\s+(.+?)\s+(?:in|within)\s+/i,
        /(?:between|among)\s+(.+?)(?:[?.!]|$)/i,
    ];
    for (const pattern of patterns) {
        const match = value.match(pattern);
        if (!match?.[1]) {
            continue;
        }
        const outcomes = workflowSplitOutcomeNames(match[1]);
        if (outcomes.length >= 2) {
            return outcomes;
        }
    }
    return [];
}
function workflowExtractQuotedFragments(value) {
    const matches = Array.from(value.matchAll(/["'`](.{2,160}?)["'`]/g))
        .map((match) => match[1]?.trim() || "")
        .filter((fragment) => fragment.length > 0);
    return workflowUniqueStrings(matches);
}
function workflowExtractMarketQueryFromRawPrompt(value) {
    const quoted = workflowExtractQuotedFragments(value);
    if (quoted.length > 0) {
        return quoted[0];
    }
    return value.trim();
}
function workflowExtractLikelyOutcomeFragments(value) {
    const fragments = new Set();
    const normalized = normalizeOutcomeLabelDashes(value);
    const monthDayMatches = normalized.match(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}\b/gi);
    for (const match of monthDayMatches ?? []) {
        fragments.add(normalizeMarketQueryText(match));
    }
    const thresholdMatches = normalized.match(/\b(?:no change|\d+\+?\s*bps\s+(?:increase|decrease)|\$\s*\d+(?:\s*(?:high|low))?)\b/gi);
    for (const match of thresholdMatches ?? []) {
        fragments.add(normalizeMarketQueryText(match));
    }
    const quoted = workflowExtractQuotedFragments(normalized);
    for (const fragment of quoted) {
        const cleaned = normalizeMarketQueryText(fragment);
        if (cleaned.length > 0) {
            fragments.add(cleaned);
        }
    }
    const winMatches = normalized.matchAll(/\bwill\s+(.+?)\s+win(?:\s+on\b|\s+by\b|\s+before\b|\?|$)/gi);
    for (const match of winMatches) {
        const cleaned = normalizeMarketQueryText(match[1] ?? "");
        if (cleaned.length > 0) {
            fragments.add(cleaned);
        }
    }
    if (/\b(?:end(?:ing)?\s+in\s+a\s+draw|be\s+a\s+draw|draw|tie)\b/i.test(normalized)) {
        fragments.add("draw");
    }
    return Array.from(fragments).filter((fragment) => fragment.length > 0);
}
function workflowExtractEventQueryFromComparison(value) {
    const trimmed = value.trim();
    const eventMatch = trimmed.match(/\b(?:in|within)\s+(?:the\s+)?["'`]?(.+?)["'`]?\s+event\b/i);
    if (eventMatch?.[1]) {
        return eventMatch[1].trim();
    }
    const match = trimmed.match(/\b(?:in|within)\s+(?:the\s+)?(.+?)(?:\s+market)?[?.!]*$/i);
    return match?.[1]?.trim() || trimmed;
}
function workflowExtractHeadToHeadSides(value) {
    const trimmed = value.trim().replace(/\s+event$/i, "");
    const match = trimmed.match(/^(.{2,80}?)\s+(?:vs\.?|v\.?|versus|@|at)\s+(.{2,80}?)$/i);
    if (!match) {
        return [];
    }
    return workflowUniqueStrings(match
        .slice(1)
        .map((side) => normalizeMarketQueryText(side))
        .filter((side) => side.length >= 2));
}
function workflowCandidateMatchesHeadToHead(candidateText, headToHeadSides) {
    if (headToHeadSides.length < 2) {
        return true;
    }
    const normalizedCandidate = normalizeMarketQueryText(candidateText);
    if (normalizedCandidate.length === 0) {
        return false;
    }
    return headToHeadSides.every((side) => normalizedCandidate.includes(side));
}
function workflowResolvedEventMatchesHeadToHead(eventData, headToHeadSides) {
    if (headToHeadSides.length < 2) {
        return true;
    }
    const eventTitle = typeof eventData.eventTitle === "string" ? eventData.eventTitle : "";
    const eventSlug = typeof eventData.eventSlug === "string" ? eventData.eventSlug : "";
    return workflowCandidateMatchesHeadToHead(`${eventTitle} ${eventSlug}`, headToHeadSides);
}
function workflowExtractEventQueryFromLiquidity(value) {
    const trimmed = value.trim();
    const patterns = [
        /\b(?:for|of)\s+(?:the\s+)?(?:yes|no)\s+side of\s+(?:the\s+)?(.+?)(?:\s+market)?(?:\s+and\s+(?:estimate|size|model)|\s+with\s+|\?|$)/i,
        /\bbet on\s+(?:the\s+)?(.+?)(?:\.\s+based on|\s+based on|\s+with\s+|\?|$)/i,
        /\bsplit(?:ting)?(?:\s+(?:my|the))?\s+(?:bets?|capital|position|positions|stakes?)\s+(?:across|among|between|for)\s+(?:the\s+)?(.+?)(?:\.\s+based on|\s+based on|\s+with\s+|\?|$)/i,
        /\ballocat(?:e|ing)\s+(?:my\s+|the\s+)?(?:bets?|capital|position|positions|stakes?)?\s*(?:across|among|between|to|into|for)\s+(?:the\s+)?(.+?)(?:\.\s+based on|\s+based on|\s+with\s+|\?|$)/i,
        /\b(?:for|in|within)\s+(?:the\s+)?(.+?)(?:\s+market)?(?:\s+and\s+(?:estimate|size|model)|\s+with\s+|\?|$)/i,
    ];
    for (const pattern of patterns) {
        const match = trimmed.match(pattern);
        const extracted = match?.[1]?.trim();
        if (extracted && extracted.length > 0) {
            return extracted.replace(/\bcurrent\b\s+/i, "").trim();
        }
    }
    return trimmed;
}
function isGenericMarketReferenceQuery(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return true;
    }
    return /\b(?:this|that)\s+(?:polymarket\s+)?(?:market|contract)\b/i.test(trimmed) ||
        /\b(?:single[-\s]?outcome|yes\/no|live)\s+(?:market|contract)\b/i.test(trimmed) ||
        /\b(?:a|an|any|some)\s+(?:live\s+)?(?:polymarket\s+)?(?:(?:political|politics|geopolitical|geopolitics|sports|crypto|finance|financial|economic|economy|weather|tech|technology|culture)\s+)?(?:(?:single[-\s]?outcome|yes\/no)\s+)?(?:market|contract)\b/i.test(trimmed);
}
function inferGenericMarketCategory(value) {
    const normalized = value.trim().toLowerCase();
    if (/\b(?:politics|political|election|senate|congress|president)\b/i.test(normalized)) {
        return "politics";
    }
    if (/\b(?:geopolitics|geopolitical|foreign policy|world|war|invasion)\b/i.test(normalized)) {
        return "geopolitics";
    }
    if (/\b(?:crypto|bitcoin|ethereum|btc|eth)\b/i.test(normalized)) {
        return "crypto";
    }
    if (/\b(?:sports|nba|nfl|mlb|nhl|soccer|football)\b/i.test(normalized)) {
        return "sports";
    }
    if (/\b(?:finance|financial|economy|economic|stocks?|rates?)\b/i.test(normalized)) {
        return "finance";
    }
    if (/\bweather\b/i.test(normalized)) {
        return "weather";
    }
    if (/\b(?:tech|technology|ai)\b/i.test(normalized)) {
        return "tech";
    }
    if (/\b(?:culture|entertainment|celebrity)\b/i.test(normalized)) {
        return "culture";
    }
    return "";
}
function isGenericEventReferenceQuery(value) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return true;
    }
    return /\b(?:this|that)\s+event\b/i.test(trimmed) ||
        /\bmulti[-\s]?outcome\s+event\b/i.test(trimmed) ||
        /\blive\s+event\b/i.test(trimmed);
}
async function resolveFallbackTopMarketCandidate(params) {
    try {
        const fallbackTopMarkets = workflowExtractToolData(await handleGetTopMarkets({
            sortBy: params?.sortBy || "volume",
            category: params?.category,
            limit: 12,
            includeNearResolved: false,
        }), "get_top_markets");
        const candidates = workflowObjectArray(fallbackTopMarkets.markets);
        let fallbackCandidate = null;
        for (const candidate of candidates) {
            const slug = typeof candidate.slug === "string" ? candidate.slug.trim() : "";
            const conditionId = typeof candidate.conditionId === "string"
                ? candidate.conditionId.trim()
                : "";
            const title = typeof candidate.title === "string" ? candidate.title : "";
            const eventTitle = typeof candidate.eventTitle === "string"
                ? candidate.eventTitle
                : title;
            const eventId = typeof candidate.eventId === "string" ? candidate.eventId : "";
            if (slug.length === 0 && conditionId.length === 0) {
                continue;
            }
            let event = null;
            if (slug.length > 0) {
                try {
                    event = (await fetchGamma(`/events/slug/${slug}`, 8_000));
                }
                catch {
                    event = null;
                }
            }
            const normalizedCandidate = {
                slug,
                conditionId,
                title,
                eventTitle,
                eventId,
                event,
            };
            if (!fallbackCandidate) {
                fallbackCandidate = normalizedCandidate;
            }
            const tradableMarketCount = Array.isArray(event?.markets)
                ? event.markets.filter((market) => isTradableGammaMarket(market)).length
                : 0;
            const totalMarketCount = event?.markets?.length ?? 0;
            const effectiveMarketCount = tradableMarketCount > 0 ? tradableMarketCount : totalMarketCount;
            if (params?.preferSingleOutcome && effectiveMarketCount <= 1) {
                return normalizedCandidate;
            }
            if (params?.preferMultiOutcome && effectiveMarketCount > 1) {
                return normalizedCandidate;
            }
            if (!params?.preferSingleOutcome && !params?.preferMultiOutcome) {
                return normalizedCandidate;
            }
        }
        return fallbackCandidate;
    }
    catch {
        return null;
    }
}
async function workflowResolveEventDataForAnalysis(params) {
    const sortBy = params.sortBy ?? "volume";
    const slug = params.slug?.trim() || "";
    const eventQuery = params.eventQuery?.trim() || "";
    const category = params.category?.trim() || "";
    const headToHeadSides = workflowExtractHeadToHeadSides(eventQuery);
    if (slug.length > 0) {
        return {
            eventData: workflowExtractToolData(await handleGetEventOutcomes({
                slug,
                sortBy,
            }), "get_event_outcomes"),
            selectionReason: "Used the provided event slug.",
        };
    }
    if (eventQuery.length > 0) {
        if (headToHeadSides.length >= 2) {
            try {
                const searchResults = workflowExtractToolData(await handleSearchMarkets({
                    query: eventQuery,
                    status: "live",
                    limit: 12,
                    ...(category.length > 0 ? { category } : {}),
                }), "search_markets");
                const exactMatch = workflowObjectArray(searchResults.results).find((candidate) => workflowCandidateMatchesHeadToHead(`${typeof candidate.title === "string" ? candidate.title : ""} ${typeof candidate.matchedOutcome === "string" ? candidate.matchedOutcome : ""} ${typeof candidate.slug === "string" ? candidate.slug : ""}`, headToHeadSides));
                const exactMatchSlug = exactMatch && typeof exactMatch.slug === "string" ? exactMatch.slug.trim() : "";
                if (exactMatchSlug.length > 0) {
                    return {
                        eventData: workflowExtractToolData(await handleGetEventOutcomes({
                            slug: exactMatchSlug,
                            sortBy,
                        }), "get_event_outcomes"),
                        selectionReason: "Resolved from an exact head-to-head search match.",
                    };
                }
            }
            catch {
                // Fall back to the normal event-resolution path below.
            }
        }
        try {
            const directEventData = workflowExtractToolData(await handleSearchAndGetOutcomes({
                query: eventQuery,
                ...(category.length > 0 ? { category } : {}),
                sortBy,
            }), "search_and_get_outcomes");
            if (!workflowResolvedEventMatchesHeadToHead(directEventData, headToHeadSides)) {
                throw new Error("Resolved event did not preserve both sides of the head-to-head query.");
            }
            return {
                eventData: directEventData,
                selectionReason: "Resolved directly from the provided event query.",
            };
        }
        catch (error) {
            console.warn("[polymarket-event-resolve] search_and_get_outcomes failed", {
                eventQuery: eventQuery.slice(0, 120),
                category,
                error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
            });
        }
        const fallbackTargets = extractPriceTargets(eventQuery);
        const searchFallbackThreshold = fallbackTargets.length > 0 ? 95 : 60;
        const searchFallbackCandidates = [];
        try {
            const websiteSearch = await searchGammaWebsiteEventCandidates({
                query: eventQuery,
                limit: 24,
                eventsStatus: "active",
            });
            searchFallbackCandidates.push(...websiteSearch.candidates);
        }
        catch {
            // Fall through to other event-resolution fallbacks.
        }
        try {
            const indexedSearch = await searchIndexedActiveEventCandidates({
                query: eventQuery,
                limit: 24,
            });
            searchFallbackCandidates.push(...indexedSearch.candidates);
        }
        catch {
            // Fall through to discovery-based fallback.
        }
        const searchFallbackBest = pickBestMarketCandidate(headToHeadSides.length >= 2
            ? searchFallbackCandidates.filter((candidate) => workflowCandidateMatchesHeadToHead(`${candidate.marketTitle} ${candidate.slug || ""} ${candidate.eventSlug || ""}`, headToHeadSides))
            : searchFallbackCandidates);
        const searchFallbackSlug = searchFallbackBest?.eventSlug || searchFallbackBest?.slug || "";
        if (searchFallbackSlug.length > 0 &&
            (searchFallbackBest?.score ?? 0) >= searchFallbackThreshold) {
            return {
                eventData: workflowExtractToolData(await handleGetEventOutcomes({
                    slug: searchFallbackSlug,
                    sortBy,
                }), "get_event_outcomes"),
                selectionReason: "Committed to the best-matching active-event Polymarket search result as a best-effort substitute for the user's requested entity.",
            };
        }
        const discoveryData = workflowExtractToolData(await handleDiscoverTrendingMarkets({
            ...(category.length > 0 ? { category } : {}),
            sortBy: "liquidity",
            limit: 12,
        }), "discover_trending_markets");
        const candidates = workflowObjectArray(discoveryData.trendingMarkets);
        const normalizedQuery = normalizeMarketQueryText(eventQuery);
        const queryTargets = extractPriceTargets(eventQuery);
        const queryTokens = extractMarketQueryTokens(eventQuery);
        let bestCandidate = null;
        let bestScore = 0;
        for (const candidate of candidates) {
            const candidateText = `${typeof candidate.title === "string" ? candidate.title : ""} ${typeof candidate.slug === "string" ? candidate.slug : ""}`;
            const score = scoreMarketCandidate({
                queryText: normalizedQuery,
                queryTokens,
                queryTargets,
                candidateText,
            });
            if (score > bestScore) {
                bestScore = score;
                bestCandidate = candidate;
            }
        }
        const fallbackSlug = bestCandidate && typeof bestCandidate.slug === "string"
            ? bestCandidate.slug.trim()
            : "";
        const fallbackMatchesHeadToHead = headToHeadSides.length < 2 ||
            workflowCandidateMatchesHeadToHead(`${bestCandidate && typeof bestCandidate.title === "string" ? bestCandidate.title : ""} ${fallbackSlug}`, headToHeadSides);
        if (fallbackSlug.length > 0 && bestScore >= 35 && fallbackMatchesHeadToHead) {
            return {
                eventData: workflowExtractToolData(await handleGetEventOutcomes({
                    slug: fallbackSlug,
                    sortBy,
                }), "get_event_outcomes"),
                selectionReason: "Committed to the best-matching live discovery Polymarket event as a best-effort substitute for the user's requested entity.",
            };
        }
    }
    if (headToHeadSides.length >= 2) {
        throw new Error("Could not resolve an exact head-to-head event for analysis.");
    }
    const fallbackCandidate = await resolveFallbackTopMarketCandidate({
        category: category || undefined,
        sortBy: "liquidity",
        preferMultiOutcome: true,
    });
    if (!fallbackCandidate?.slug) {
        throw new Error("Could not resolve a multi-outcome event for analysis.");
    }
    return {
        eventData: workflowExtractToolData(await handleGetEventOutcomes({
            slug: fallbackCandidate.slug,
            sortBy,
        }), "get_event_outcomes"),
        selectionReason: "Committed to the strongest live multi-outcome Polymarket event as a best-effort substitute for the user's requested entity.",
    };
}
function normalizeOutcomeLabelDashes(value) {
    return value.replace(/[\u2013\u2014\u2212]/g, "-");
}
function workflowScoreOutcomeMatch(requestedName, candidateName) {
    const requestedForMatch = normalizeOutcomeLabelDashes(requestedName);
    const candidateForMatch = normalizeOutcomeLabelDashes(candidateName);
    const normalizedRequested = normalizeMarketQueryText(requestedForMatch);
    const normalizedCandidate = normalizeMarketQueryText(candidateForMatch);
    if (!normalizedRequested) {
        return 0;
    }
    const requestedDrawLike = /\b(?:draw|tie)\b/i.test(requestedForMatch);
    const candidateDrawLike = /\b(?:draw|tie)\b/i.test(candidateForMatch);
    if (requestedDrawLike && !candidateDrawLike) {
        return -1000;
    }
    const requestedFragments = workflowExtractLikelyOutcomeFragments(requestedForMatch);
    const candidateFragments = new Set(workflowExtractLikelyOutcomeFragments(candidateForMatch));
    if (requestedFragments.length > 0 &&
        candidateFragments.size > 0 &&
        !requestedFragments.some((fragment) => candidateFragments.has(fragment))) {
        return -1000;
    }
    let score = scoreMarketCandidate({
        queryText: normalizedRequested,
        queryTokens: extractMarketQueryTokens(requestedForMatch),
        queryTargets: extractPriceTargets(requestedForMatch),
        candidateText: candidateForMatch,
    });
    if (!normalizedCandidate) {
        return score;
    }
    if (normalizedRequested === normalizedCandidate) {
        score += 200;
    }
    else if (normalizedRequested.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedRequested)) {
        score += 120;
    }
    for (const fragment of requestedFragments) {
        if (fragment === normalizedCandidate) {
            score += 180;
            continue;
        }
        if (normalizedCandidate.includes(fragment) || fragment.includes(normalizedCandidate)) {
            score += 120;
        }
    }
    return score;
}
function workflowPickBestOutcomeMatch(outcomes, seeds) {
    const candidateSeeds = workflowUniqueStrings(seeds.flatMap((seed) => {
        const trimmed = seed.trim();
        if (trimmed.length === 0) {
            return [];
        }
        return [trimmed, ...workflowExtractLikelyOutcomeFragments(trimmed)];
    }));
    let bestOutcome = null;
    let matchedName = "";
    let bestScore = 0;
    for (const outcome of outcomes) {
        const candidateName = typeof outcome.name === "string" ? outcome.name.trim() : "";
        if (candidateName.length === 0) {
            continue;
        }
        for (const seed of candidateSeeds) {
            const score = workflowScoreOutcomeMatch(seed, candidateName);
            if (score > bestScore) {
                bestOutcome = outcome;
                matchedName = candidateName;
                bestScore = score;
            }
        }
    }
    return {
        outcome: bestOutcome,
        matchedName,
        score: bestScore,
    };
}
function workflowGetErrorMessage(result) {
    const firstContent = result.content[0];
    if (!firstContent || firstContent.type !== "text" || typeof firstContent.text !== "string") {
        return "Unknown tool failure";
    }
    try {
        const parsed = JSON.parse(firstContent.text);
        if (typeof parsed?.error === "string" && parsed.error.length > 0) {
            return parsed.error;
        }
    }
    catch {
        // Not JSON, fall through to plain text
    }
    return firstContent.text;
}
function workflowExtractToolData(result, toolName) {
    if (result.isError) {
        throw new Error(`${toolName} failed: ${workflowGetErrorMessage(result)}`);
    }
    if (result.structuredContent &&
        typeof result.structuredContent === "object" &&
        !Array.isArray(result.structuredContent)) {
        return result.structuredContent;
    }
    const firstContent = result.content[0];
    if (firstContent && firstContent.type === "text" && typeof firstContent.text === "string") {
        try {
            const parsed = JSON.parse(firstContent.text);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed;
            }
        }
        catch {
            // Non-JSON response
        }
    }
    return {};
}
function workflowNormalizeProbability(value) {
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
function workflowLiquidityPoints(liquidityScore) {
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
function workflowRulePoints(status) {
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
async function handleBuildHighConvictionWorkflow(args) {
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const candidateCount = workflowToBoundedInteger(args?.candidateCount, 6, 3, 10);
    const topSetupsLimit = workflowToBoundedInteger(args?.topSetups, 3, 1, 5);
    const includeWhaleFlow = args?.includeWhaleFlow === true;
    const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
    const analysisNotes = [];
    try {
        const discoveryInput = {
            sortBy: "volume",
            limit: Math.max(candidateCount * 2, 10),
        };
        if (category.length > 0) {
            discoveryInput.category = category;
        }
        const discoveryData = workflowExtractToolData(await handleDiscoverTrendingMarkets(discoveryInput), "discover_trending_markets");
        const discoveredMarkets = workflowObjectArray(discoveryData.trendingMarkets);
        const candidates = discoveredMarkets
            .map((market) => {
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
        const scoredSetups = [];
        for (const candidate of candidates) {
            const risks = [];
            let marketPriceYes = workflowClamp(candidate.currentPrice, 0.01, 0.99);
            let ruleStatus = "caution";
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
            let whaleCoverage = {
                canMakeWhaleClaim: !includeWhaleFlow,
                coverageLevel: includeWhaleFlow ? "not_requested" : "not_applicable",
            };
            let trueProbYes = null;
            let whaleAlignedWithTrade = !includeWhaleFlow;
            try {
                const rulesInput = {};
                if (candidate.slug.length > 0) {
                    rulesInput.slug = candidate.slug;
                }
                else {
                    rulesInput.conditionId = candidate.conditionId;
                }
                const rulesData = workflowExtractToolData(await handleCheckMarketRules(rulesInput), "check_market_rules");
                const ruleFactors = workflowStringArray(rulesData.riskFactors);
                const rulesSummary = workflowObject(rulesData.rulesSummary);
                const ambiguities = workflowStringArray(rulesSummary.ambiguities);
                const gotchas = workflowStringArray(rulesSummary.potentialGotchas);
                const resolvesYesIf = typeof rulesSummary.resolvesYesIf === "string" ? rulesSummary.resolvesYesIf : "";
                rulesAmbiguityCount = ambiguities.length;
                ruleRiskCount = ruleFactors.length + gotchas.length;
                rulesSummaryText = resolvesYesIf.length > 0
                    ? `YES resolves if: ${resolvesYesIf}`
                    : "Resolution criteria available; review full market description.";
                risks.push(...ruleFactors, ...ambiguities.map((item) => `Ambiguity: ${item}`));
                const resolutionSource = typeof rulesData.resolutionSource === "string" ? rulesData.resolutionSource : "";
                if (resolutionSource === "Not specified") {
                    risks.push("Resolution source is not clearly specified.");
                }
                if (rulesAmbiguityCount >= 3 || ruleRiskCount >= 6) {
                    ruleStatus = "fail";
                }
                else if (rulesAmbiguityCount > 0 || ruleRiskCount >= 2) {
                    ruleStatus = "caution";
                }
                else {
                    ruleStatus = "pass";
                }
            }
            catch (error) {
                risks.push("Could not complete automated rule validation.");
                ruleStatus = "fail";
                analysisNotes.push(`Rules check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`);
            }
            try {
                const efficiencyInput = {};
                if (candidate.conditionId.length > 0) {
                    efficiencyInput.conditionId = candidate.conditionId;
                }
                if (candidate.slug.length > 0) {
                    efficiencyInput.slug = candidate.slug;
                }
                const efficiencyData = workflowExtractToolData(await handleCheckMarketEfficiency(efficiencyInput), "check_market_efficiency");
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
                }
                else if (vigBps > 120) {
                    risks.push(`Moderate vig (${vigBps.toFixed(1)} bps) requires better entry price.`);
                }
            }
            catch (error) {
                risks.push("Could not verify market efficiency/vig.");
                analysisNotes.push(`Efficiency check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`);
            }
            try {
                const liquidityInput = {};
                if (candidate.conditionId.length > 0) {
                    liquidityInput.conditionId = candidate.conditionId;
                }
                const liquidityData = workflowExtractToolData(await handleAnalyzeMarketLiquidity(liquidityInput), "analyze_market_liquidity");
                liquidityScore =
                    typeof liquidityData.liquidityScore === "string" ? liquidityData.liquidityScore : "unknown";
                const spread = workflowObject(liquidityData.spread);
                spreadCents = workflowToNumber(spread.spreadCents, workflowToNumber(spread.absolute, 0));
                const whaleCost = workflowObject(liquidityData.whaleCost);
                const sell5k = workflowObject(whaleCost.sell5k);
                slippage5kPercent = workflowToNumber(sell5k.slippagePercent, 0);
                if (liquidityScore === "illiquid" || slippage5kPercent > 12) {
                    risks.push("Exit risk is high for medium-sized positions.");
                }
                if (spreadCents > 3) {
                    risks.push(`Wide spread (${spreadCents.toFixed(1)} cents) hurts execution.`);
                }
            }
            catch (error) {
                risks.push("Could not verify orderbook depth/slippage.");
                analysisNotes.push(`Liquidity check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`);
            }
            if (includeWhaleFlow) {
                try {
                    const whaleData = workflowExtractToolData(await handleAnalyzeWhaleFlow({
                        conditionId: candidate.conditionId,
                        hoursBack,
                    }), "analyze_whale_flow");
                    const whaleActivity = workflowObject(whaleData.whaleActivity);
                    whaleSentiment =
                        typeof whaleActivity.sentiment === "string" ? whaleActivity.sentiment : "neutral";
                    whaleNetVolume = workflowToNumber(whaleActivity.netWhaleVolume, 0);
                    whaleDivergence =
                        typeof whaleData.divergence === "string" ? whaleData.divergence : "No divergence data";
                    whaleCoverage = workflowObject(whaleData.tradeCoverage ?? whaleData.tradeSample);
                    if (whaleCoverage.canMakeWhaleClaim !== true) {
                        const coverageWarning = typeof whaleCoverage.coverageWarning === "string"
                            ? whaleCoverage.coverageWarning
                            : "Whale-flow coverage is not strong enough for directional setup scoring.";
                        risks.push(coverageWarning);
                    }
                }
                catch (error) {
                    whaleSentiment = "neutral";
                    whaleDivergence = "Whale flow unavailable";
                    analysisNotes.push(`Whale-flow check failed for "${candidate.title}": ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }
            const whaleSignalUsable = !includeWhaleFlow || whaleCoverage.canMakeWhaleClaim === true;
            let suggestedSide;
            if (edgePercent > 2) {
                suggestedSide = "YES";
            }
            else if (edgePercent < -2) {
                suggestedSide = "NO";
            }
            else if (whaleSignalUsable && whaleSentiment === "bullish") {
                suggestedSide = "YES";
            }
            else if (whaleSignalUsable && whaleSentiment === "bearish") {
                suggestedSide = "NO";
            }
            else {
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
                const sideAligned = (suggestedSide === "YES" && whaleSentiment === "bullish") ||
                    (suggestedSide === "NO" && whaleSentiment === "bearish");
                whaleAlignedWithTrade =
                    !whaleSignalUsable || sideAligned || whaleSentiment === "neutral";
                if (sideAligned) {
                    whalePoints = whaleSignalUsable ? 6 : 0;
                }
                else if (whaleSentiment === "neutral") {
                    whalePoints = 0;
                }
                else if (whaleSignalUsable) {
                    whalePoints = -4;
                    risks.push("Whale flow currently leans against this side.");
                }
            }
            const rawScore = trendPoints + rulePoints + liquidityPoints + efficiencyPoints + edgePoints + whalePoints;
            const normalizedScore = workflowClamp(rawScore, 1, 99);
            const tradabilityReasons = [];
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
            const passesHighConviction = ruleStatus !== "fail" &&
                isTradable &&
                whaleAlignedWithTrade &&
                sideEdgePercent >= 1;
            const riskList = Array.from(new Set(risks.filter((risk) => risk.length > 0))).slice(0, 8);
            const takeProfitPrice = workflowClamp(sideMarketPrice + 0.08, 0.05, 0.98);
            const invalidationPrice = workflowClamp(sideMarketPrice - 0.06, 0.01, 0.95);
            const sizeGuidance = liquidityScore === "excellent" || liquidityScore === "good"
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
                    alignedWithTrade: whaleAlignedWithTrade,
                    netVolume: Number(whaleNetVolume.toFixed(2)),
                    divergence: whaleDivergence,
                    tradeCoverage: whaleCoverage,
                },
                risks: riskList,
                isTradable,
                passesHighConviction,
                internalScore: normalizedScore,
            });
        }
        scoredSetups.sort((left, right) => right.internalScore - left.internalScore);
        const highConvictionSetups = scoredSetups.filter((setup) => setup.passesHighConviction === true);
        const tradableSetups = scoredSetups.filter((setup) => setup.isTradable === true);
        const nonTradableSetups = scoredSetups.filter((setup) => setup.isTradable !== true);
        const selectedSetups = highConvictionSetups.length > 0
            ? highConvictionSetups.slice(0, topSetupsLimit)
            : [];
        const selectedTradableCount = selectedSetups.filter((setup) => setup.isTradable === true).length;
        const topSetups = selectedSetups.map((setup, index) => {
            const { internalScore, ...visibleSetup } = setup;
            return {
                ...visibleSetup,
                rank: index + 1,
            };
        });
        const nearMissCandidates = highConvictionSetups.length === 0
            ? (tradableSetups.length > 0 ? tradableSetups : scoredSetups).slice(0, topSetupsLimit)
            : [];
        const nearMissSetups = nearMissCandidates.map((setup, index) => {
            const { internalScore, passesHighConviction, ...visibleSetup } = setup;
            const checks = workflowObject(visibleSetup.checks);
            const tradability = workflowObject(checks.tradability);
            const whyRejected = Array.from(new Set([
                ...workflowStringArray(tradability.reasons),
                ...workflowStringArray(visibleSetup.risks),
                ...(passesHighConviction === true
                    ? []
                    : ["Did not clear the high-conviction edge/risk threshold."]),
            ])).slice(0, 4);
            return {
                ...visibleSetup,
                rank: index + 1,
                whyRejected,
            };
        });
        if (highConvictionSetups.length === 0) {
            analysisNotes.push("No setups survived the high-conviction screen (manageable rule risk, executable $5k exit, and non-contradictory whale flow when enabled).");
            for (const nearMiss of nearMissSetups) {
                const nearMissRecord = workflowObject(nearMiss);
                const nearMissMarket = typeof nearMissRecord.market === "string" &&
                    nearMissRecord.market.trim().length > 0
                    ? nearMissRecord.market
                    : "Unnamed market";
                analysisNotes.push(`Near miss: "${nearMissMarket}" scored ${String(nearMissRecord.score ?? "n/a")}/99. Blockers: ${workflowStringArray(nearMissRecord.whyRejected).join("; ")}`);
            }
        }
        if (tradableSetups.length === 0 && scoredSetups.length > 0) {
            analysisNotes.push("No fully tradeable setups met execution/rules thresholds.");
        }
        if (selectedTradableCount > 0 && selectedTradableCount < topSetupsLimit) {
            analysisNotes.push(`Only ${selectedTradableCount}/${topSetupsLimit} setups met tradability thresholds. Consider increasing candidateCount (max 10) or switching category for more liquid markets.`);
        }
        return successResult({
            workflowSummary: {
                strategy: "high-conviction-sequential",
                category: category || "all",
                discoveredMarkets: discoveredMarkets.length,
                analyzedMarkets: candidates.length,
                survivingHighConvictionSetups: highConvictionSetups.length,
                topSetupsReturned: topSetups.length,
            },
            topSetups,
            nearMissSetups,
            analysisNotes,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`build_high_conviction_workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
function buildCommittedSubstitutePayload(params) {
    const title = params.substitutedEventTitle || params.substitutedEventSlug;
    const confidence = params.matchConfidence === "low" ? "medium" : "medium";
    return {
        assumption: {
            type: "substituted_event",
            requestedEntity: params.requestedEntity,
            substitutedEventTitle: title,
            substitutedEventSlug: params.substitutedEventSlug,
            reason: params.reason,
            confidence,
        },
        note: `committed_substitute: returning best-effort answer for ${title}; user should treat assumption.requestedEntity/substitutedEventTitle as the disclosed substitution.`,
        synthesisHint: `Handler already committed to "${title}" as the closest live Polymarket event for the user's requested "${params.requestedEntity}". Present the substitute's real live data directly and open with a one-line assumption preface naming both the requested entity and the substituted event title, for example: 'Assumption: Polymarket has "${title}" live as the closest match for the user's asked "${params.requestedEntity}"; using it as the committed best-effort answer. Current numbers follow:'. Answer with the substitute's live data; skip clarification requests entirely.`,
    };
}
function requestedEntityDiffersMeaningfullyFromTitle(requested, title) {
    if (!requested || !title) {
        return false;
    }
    const requestedTokens = extractMarketQueryTokens(requested).filter((token) => token.length >= 4);
    if (requestedTokens.length === 0) {
        return false;
    }
    const titleTokens = new Set(extractMarketQueryTokens(title));
    for (const token of requestedTokens) {
        if (!titleTokens.has(token)) {
            return true;
        }
    }
    return false;
}
async function handleCompareEventOutcomeQuotes(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    const explicitEventQuery = typeof args?.eventQuery === "string" ? args.eventQuery.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const limit = workflowToBoundedInteger(args?.limit, 5, 2, 10);
    const includeHistoryExplicit = args?.includeHistory === true;
    const historyIntervalRaw = typeof args?.historyInterval === "string" ? args.historyInterval : "";
    const historyInterval = historyIntervalRaw === "1h" ||
        historyIntervalRaw === "1d" ||
        historyIntervalRaw === "1w" ||
        historyIntervalRaw === "max"
        ? historyIntervalRaw
        : "1w";
    const momentumRequested = includeHistoryExplicit ||
        /\b(momentum|moved?|move|price\s+change|changed?|top movers?|largest movers?)\b/i.test(rawQuery);
    const requestedOutcomes = workflowUniqueStrings([
        ...workflowStringArray(args?.outcomes),
        ...(typeof args?.outcomeNames === "string"
            ? workflowSplitOutcomeNames(args.outcomeNames)
            : []),
    ]);
    const eventQuery = explicitEventQuery.length > 0
        ? explicitEventQuery
        : workflowExtractEventQueryFromComparison(rawQuery);
    const desiredOutcomes = requestedOutcomes.length > 0
        ? requestedOutcomes
        : workflowExtractComparisonOutcomesFromQuery(rawQuery);
    try {
        let eventData;
        let selectionReason = "";
        const shouldUseFallbackEvent = eventQuery.length === 0 || isGenericEventReferenceQuery(eventQuery);
        if (shouldUseFallbackEvent &&
            desiredOutcomes.length > 0 &&
            /\bthis event\b/i.test(rawQuery)) {
            return errorResult("Could not resolve the referenced event from this query alone. Provide the event title or slug so the requested named outcomes can be grounded correctly.");
        }
        if (shouldUseFallbackEvent) {
            const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                category: category || undefined,
                sortBy: momentumRequested ? "volume" : "liquidity",
                preferMultiOutcome: true,
            });
            if (!fallbackCandidate || fallbackCandidate.slug.length === 0) {
                return errorResult("Could not resolve a live multi-outcome event to compare.");
            }
            eventData = workflowExtractToolData(await handleGetEventOutcomes({
                slug: fallbackCandidate.slug,
                sortBy: "volume",
            }), "get_event_outcomes");
            selectionReason =
                category.length > 0
                    ? `No concrete event was provided, so the tool picked a high-liquidity live ${category} event fallback.`
                    : "No concrete event was provided, so the tool picked a high-liquidity live multi-outcome event fallback.";
        }
        else {
            let searchResolvedEvent = null;
            if (desiredOutcomes.length > 0) {
                try {
                    searchResolvedEvent = workflowExtractToolData(await handleSearchAndGetOutcomes({
                        query: eventQuery,
                        ...(category.length > 0 ? { category } : {}),
                        sortBy: "name",
                    }), "search_and_get_outcomes");
                }
                catch {
                    searchResolvedEvent = null;
                }
            }
            if (searchResolvedEvent &&
                workflowObjectArray(searchResolvedEvent.outcomes).length > 0) {
                eventData = searchResolvedEvent;
                selectionReason =
                    typeof searchResolvedEvent.note === "string"
                        ? searchResolvedEvent.note
                        : "Resolved the requested event through direct event search.";
            }
            else {
                const resolvedEvent = await workflowResolveEventDataForAnalysis({
                    eventQuery,
                    ...(category.length > 0 ? { category } : {}),
                    sortBy: "volume",
                });
                eventData = resolvedEvent.eventData;
                selectionReason = resolvedEvent.selectionReason;
            }
        }
        const availableOutcomes = workflowObjectArray(eventData.outcomes);
        if (availableOutcomes.length === 0) {
            return errorResult(shouldUseFallbackEvent
                ? "No tokenized outcomes were available for the selected fallback event."
                : `No outcomes found for event query: "${eventQuery}".`);
        }
        const selectedOutcomes = [];
        const usedKeys = new Set();
        const matchRequestedOutcomes = (requestedNames, candidateOutcomes) => {
            const unmatched = [];
            for (const requestedName of requestedNames) {
                let bestMatch = null;
                let bestKey = "";
                let bestScore = 0;
                for (const outcome of candidateOutcomes) {
                    const candidateName = typeof outcome.name === "string" ? outcome.name : "";
                    const tokenId = typeof outcome.tokenId === "string" ? outcome.tokenId : "";
                    const key = tokenId || candidateName;
                    if (candidateName.length === 0 || usedKeys.has(key)) {
                        continue;
                    }
                    const score = workflowScoreOutcomeMatch(requestedName, candidateName);
                    if (score > bestScore) {
                        bestMatch = outcome;
                        bestKey = key;
                        bestScore = score;
                    }
                }
                if (!bestMatch || bestScore < 30) {
                    unmatched.push(requestedName);
                    continue;
                }
                usedKeys.add(bestKey);
                selectedOutcomes.push({
                    ...bestMatch,
                    requestedName,
                });
            }
            return unmatched;
        };
        let unmatchedOutcomes = [];
        if (desiredOutcomes.length > 0) {
            unmatchedOutcomes = matchRequestedOutcomes(desiredOutcomes, availableOutcomes);
            if (unmatchedOutcomes.length > 0 && eventQuery.length > 0) {
                try {
                    const expandedEventData = workflowExtractToolData(await handleSearchAndGetOutcomes({
                        query: eventQuery,
                        ...(category.length > 0 ? { category } : {}),
                        sortBy: "name",
                        includeInactive: true,
                    }), "search_and_get_outcomes");
                    const expandedOutcomes = workflowObjectArray(expandedEventData.outcomes);
                    if (expandedOutcomes.length > availableOutcomes.length) {
                        unmatchedOutcomes = matchRequestedOutcomes(unmatchedOutcomes, expandedOutcomes);
                        eventData = expandedEventData;
                        selectionReason =
                            typeof expandedEventData.note === "string"
                                ? `${selectionReason} Retried unmatched outcomes against the full event ladder, including inactive rows.`
                                : selectionReason;
                    }
                }
                catch {
                    // Keep the original partial result when the broader inactive lookup fails.
                }
            }
        }
        else if (momentumRequested) {
            const tokenIdsForHistory = workflowUniqueStrings(availableOutcomes
                .map((outcome) => typeof outcome.tokenId === "string" ? outcome.tokenId.trim() : "")
                .filter((tokenId) => tokenId.length > 0));
            const historySummaries = await Promise.all(tokenIdsForHistory.map(async (tokenId) => {
                try {
                    const historyData = workflowExtractToolData(await handleGetPriceHistory({
                        tokenId,
                        interval: historyInterval,
                    }), "get_price_history");
                    const summary = workflowObject(historyData.summary);
                    return {
                        tokenId,
                        priceChange: workflowToNumber(summary.change, 0),
                        priceChangePercent: workflowToNumber(summary.changePercent, 0),
                    };
                }
                catch {
                    return {
                        tokenId,
                        priceChange: 0,
                        priceChangePercent: 0,
                    };
                }
            }));
            const historyByTokenId = new Map(historySummaries.map((entry) => [entry.tokenId, entry]));
            const rankedOutcomes = [...availableOutcomes]
                .map((outcome) => {
                const tokenId = typeof outcome.tokenId === "string" ? outcome.tokenId.trim() : "";
                const historyEntry = historyByTokenId.get(tokenId);
                return {
                    outcome,
                    priceChange: historyEntry?.priceChange ?? 0,
                    priceChangePercent: historyEntry?.priceChangePercent ?? 0,
                };
            })
                .sort((left, right) => Math.abs(right.priceChangePercent) - Math.abs(left.priceChangePercent))
                .slice(0, limit);
            selectedOutcomes.push(...rankedOutcomes.map((entry) => entry.outcome));
        }
        else {
            selectedOutcomes.push(...availableOutcomes.slice(0, limit));
        }
        if (selectedOutcomes.length === 0) {
            return errorResult(`Could not match any requested outcomes inside "${eventQuery}". Try clearer outcome names.`);
        }
        const tokenIds = workflowUniqueStrings(selectedOutcomes
            .map((outcome) => typeof outcome.tokenId === "string" ? outcome.tokenId : "")
            .filter((tokenId) => tokenId.length > 0));
        const spreadData = tokenIds.length > 0
            ? workflowExtractToolData(await handleGetSpreads({ tokenIds }), "get_spreads")
            : {};
        const spreadsByTokenId = workflowObject(spreadData.spreads);
        const historyByTokenId = new Map();
        if (momentumRequested && tokenIds.length > 0) {
            const historyResults = await Promise.all(tokenIds.map(async (tokenId) => {
                try {
                    const historyData = workflowExtractToolData(await handleGetPriceHistory({
                        tokenId,
                        interval: historyInterval,
                    }), "get_price_history");
                    const summary = workflowObject(historyData.summary);
                    return {
                        tokenId,
                        priceChange: workflowToNumber(summary.change, 0),
                        priceChangePercent: workflowToNumber(summary.changePercent, 0),
                        historyWindow: historyInterval,
                    };
                }
                catch {
                    return {
                        tokenId,
                        priceChange: 0,
                        priceChangePercent: 0,
                        historyWindow: historyInterval,
                    };
                }
            }));
            for (const historyResult of historyResults) {
                historyByTokenId.set(historyResult.tokenId, historyResult);
            }
        }
        const matchedOutcomes = selectedOutcomes.map((outcome) => {
            const tokenId = typeof outcome.tokenId === "string" ? outcome.tokenId : "";
            const spreadInfo = workflowObject(spreadsByTokenId[tokenId]);
            const historyInfo = historyByTokenId.get(tokenId);
            const currentPrice = workflowToNumber(outcome.price, 0.5);
            const matchedName = typeof outcome.name === "string" ? outcome.name : "Unknown outcome";
            const bestBid = workflowToNumber(spreadInfo.bestBid, 0);
            const bestAsk = workflowToNumber(spreadInfo.bestAsk, 0);
            const spread = workflowToNumber(spreadInfo.spread, 0);
            const spreadPercent = workflowToNumber(spreadInfo.spreadPercent, 0);
            const rowLabel = typeof outcome.requestedName === "string"
                ? outcome.requestedName
                : matchedName;
            return {
                requestedName: typeof outcome.requestedName === "string"
                    ? outcome.requestedName
                    : matchedName,
                matchedName,
                tokenId,
                conditionId: typeof outcome.conditionId === "string" ? outcome.conditionId : "",
                currentPrice: Number(currentPrice.toFixed(4)),
                price: Number(currentPrice.toFixed(4)),
                yesMid: Number(currentPrice.toFixed(4)),
                impliedProbability: `${(currentPrice * 100).toFixed(1)}%`,
                bestBid,
                bestAsk,
                spread,
                spreadPercent,
                spreadPercentDisplay: `${spreadPercent.toFixed(2)}%`,
                spreadCentsDisplay: `${(spread * 100).toFixed(2)}¢`,
                priceChange: Number((historyInfo?.priceChange ?? 0).toFixed(4)),
                priceChangePercent: Number((historyInfo?.priceChangePercent ?? 0).toFixed(2)),
                historyWindow: historyInfo?.historyWindow || "",
                volume: workflowToNumber(outcome.volume, 0),
                readableQuote: `${rowLabel} → matched "${matchedName}": YES mid ${(currentPrice * 100).toFixed(1)}% (0–1: ${currentPrice.toFixed(4)}), bid ${(bestBid * 100).toFixed(1)}¢ / ask ${(bestAsk * 100).toFixed(1)}¢, spread ${(spread * 100).toFixed(2)}¢ (${spreadPercent.toFixed(2)}% pts)${historyInfo ? `, ${historyInfo.historyWindow} change ${historyInfo.priceChange >= 0 ? "+" : ""}${historyInfo.priceChange.toFixed(4)} (${historyInfo.priceChangePercent >= 0 ? "+" : ""}${historyInfo.priceChangePercent.toFixed(2)}%).` : "."}`,
            };
        });
        if (momentumRequested) {
            matchedOutcomes.sort((left, right) => Math.abs(right.priceChangePercent) - Math.abs(left.priceChangePercent));
        }
        const widestSpreadOutcome = matchedOutcomes.length > 0
            ? matchedOutcomes.reduce((widest, current) => current.spread > widest.spread ? current : widest)
            : null;
        const resolvedEventTitle = typeof eventData.eventTitle === "string"
            ? eventData.eventTitle
            : eventQuery;
        const resolvedEventSlug = typeof eventData.eventSlug === "string" ? eventData.eventSlug : "";
        const inheritedMatchConfidenceRaw = typeof eventData.matchConfidence === "string"
            ? eventData.matchConfidence
            : "";
        const inheritedMatchConfidence = inheritedMatchConfidenceRaw === "exact" ||
            inheritedMatchConfidenceRaw === "high" ||
            inheritedMatchConfidenceRaw === "medium" ||
            inheritedMatchConfidenceRaw === "low"
            ? inheritedMatchConfidenceRaw
            : "";
        const originalRequestedEntity = rawQuery || explicitEventQuery || eventQuery;
        const selectionReasonLower = (selectionReason || "").toLowerCase();
        const compareTitleMismatchFromQuery = inheritedMatchConfidence !== "exact" &&
            requestedEntityDiffersMeaningfullyFromTitle(originalRequestedEntity, resolvedEventTitle);
        const isSubstituteCompare = originalRequestedEntity.length > 0 &&
            resolvedEventTitle.length > 0 &&
            (inheritedMatchConfidence === "medium" ||
                inheritedMatchConfidence === "low" ||
                shouldUseFallbackEvent ||
                compareTitleMismatchFromQuery ||
                /fallback|did not map|strongest live|slow or ambiguous/.test(selectionReasonLower));
        const substitutePayloadCompare = isSubstituteCompare
            ? buildCommittedSubstitutePayload({
                requestedEntity: originalRequestedEntity,
                substitutedEventTitle: resolvedEventTitle,
                substitutedEventSlug: resolvedEventSlug,
                matchConfidence: inheritedMatchConfidence === ""
                    ? "medium"
                    : inheritedMatchConfidence,
                reason: selectionReason && selectionReason.length > 0
                    ? selectionReason
                    : "Closest live multi-outcome Polymarket event selected as a committed best-effort substitute for the user's requested entity.",
            })
            : null;
        const baseCompareHint = momentumRequested
            ? "Copy numeric fields from each matchedOutcomes row into tables: use currentPrice (or price/yesMid) for implied YES probability, bestBid/bestAsk for quotes, spread and spreadPercent for width, and priceChange/priceChangePercent for recent movement. Each row includes readableQuote — paste verbatim for outcome rows instead of placeholders. Do not relabel a row as a different requested outcome if matchedName disagrees; instead surface it as unmatched or unavailable."
            : "Copy numeric fields from each matchedOutcomes row into tables: use currentPrice (or price/yesMid) for implied YES probability, bestBid/bestAsk for quotes, spread and spreadPercent for width. Each row includes readableQuote — paste verbatim for outcome rows instead of placeholders. If unmatchedOutcomes is non-empty, retry them against the full event ladder (including inactive outcomes when necessary) before concluding the rows are unavailable.";
        const comparePayload = {
            eventTitle: resolvedEventTitle,
            eventSlug: resolvedEventSlug,
            eventUrl: typeof eventData.eventUrl === "string" ? eventData.eventUrl : "",
            synthesisHint: substitutePayloadCompare
                ? `${substitutePayloadCompare.synthesisHint} ${baseCompareHint}`
                : baseCompareHint,
            selectionReason: substitutePayloadCompare
                ? substitutePayloadCompare.note
                : selectionReason,
            note: substitutePayloadCompare ? substitutePayloadCompare.note : undefined,
            matchedOutcomes,
            unmatchedOutcomes,
            widestSpreadOutcome: widestSpreadOutcome === null
                ? null
                : {
                    matchedName: widestSpreadOutcome.matchedName,
                    spread: widestSpreadOutcome.spread,
                },
            fetchedAt: new Date().toISOString(),
        };
        if (substitutePayloadCompare) {
            comparePayload.assumption = substitutePayloadCompare.assumption;
        }
        return successResult(comparePayload);
    }
    catch (error) {
        return errorResult(`compare_event_outcome_quotes failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleAnalyzeEventOutcomeLiquidity(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    const explicitEventQuery = typeof args?.eventQuery === "string" ? args.eventQuery.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const limit = workflowToBoundedInteger(args?.limit, 4, 2, 8);
    const sortByRaw = typeof args?.sortBy === "string" ? args.sortBy : "volume";
    const sortBy = sortByRaw === "price" ? "price" : "volume";
    const requestedOutcomes = workflowUniqueStrings([
        ...workflowStringArray(args?.outcomes),
        ...(typeof args?.outcomeNames === "string"
            ? workflowSplitOutcomeNames(args.outcomeNames)
            : []),
    ]);
    const eventQuery = explicitEventQuery.length > 0
        ? explicitEventQuery
        : slug.length > 0
            ? ""
            : workflowExtractEventQueryFromLiquidity(rawQuery);
    if (slug.length === 0 && eventQuery.length === 0) {
        return errorResult("Provide slug, eventQuery, or query so the tool can resolve the multi-outcome event.");
    }
    try {
        const resolvedEvent = await workflowResolveEventDataForAnalysis({
            slug,
            eventQuery,
            ...(category.length > 0 ? { category } : {}),
            sortBy,
        });
        const eventData = resolvedEvent.eventData;
        const availableOutcomes = workflowObjectArray(eventData.outcomes).filter((outcome) => typeof outcome.tokenId === "string" &&
            outcome.tokenId.trim().length > 0 &&
            typeof outcome.conditionId === "string" &&
            outcome.conditionId.trim().length > 0);
        if (availableOutcomes.length === 0) {
            return errorResult("No tokenized outcomes were available for event liquidity analysis.");
        }
        const unmatchedOutcomes = [];
        const selectedOutcomes = [];
        const usedKeys = new Set();
        if (requestedOutcomes.length > 0) {
            for (const requestedName of requestedOutcomes) {
                let bestMatch = null;
                let bestKey = "";
                let bestScore = 0;
                for (const outcome of availableOutcomes) {
                    const candidateName = typeof outcome.name === "string" ? outcome.name : "";
                    const tokenId = typeof outcome.tokenId === "string" ? outcome.tokenId : "";
                    const key = tokenId || candidateName;
                    if (candidateName.length === 0 || usedKeys.has(key)) {
                        continue;
                    }
                    const score = workflowScoreOutcomeMatch(requestedName, candidateName);
                    if (score > bestScore) {
                        bestMatch = outcome;
                        bestKey = key;
                        bestScore = score;
                    }
                }
                if (!bestMatch || bestScore < 30) {
                    unmatchedOutcomes.push(requestedName);
                    continue;
                }
                usedKeys.add(bestKey);
                selectedOutcomes.push({
                    ...bestMatch,
                    requestedName,
                });
            }
        }
        else {
            const rankedOutcomes = [...availableOutcomes].sort((left, right) => {
                const leftValue = sortBy === "price"
                    ? workflowToNumber(left.price, 0)
                    : workflowToNumber(left.volume, 0);
                const rightValue = sortBy === "price"
                    ? workflowToNumber(right.price, 0)
                    : workflowToNumber(right.volume, 0);
                if (rightValue !== leftValue) {
                    return rightValue - leftValue;
                }
                return (workflowToNumber(right.price, 0) - workflowToNumber(left.price, 0));
            });
            selectedOutcomes.push(...rankedOutcomes.slice(0, limit));
        }
        if (selectedOutcomes.length === 0) {
            return errorResult(`Could not match any outcomes inside "${eventQuery || slug}". Try clearer outcome names.`);
        }
        const eventTitle = typeof eventData.eventTitle === "string"
            ? eventData.eventTitle
            : eventQuery || slug;
        const eventSlug = typeof eventData.eventSlug === "string" && eventData.eventSlug.length > 0
            ? eventData.eventSlug
            : slug;
        const eventUrl = typeof eventData.eventUrl === "string" && eventData.eventUrl.length > 0
            ? eventData.eventUrl
            : typeof eventData.url === "string" && eventData.url.length > 0
                ? eventData.url
                : getPolymarketUrl(eventSlug);
        const totalOutcomes = Math.max(availableOutcomes.length, workflowToBoundedInteger(eventData.totalOutcomes, availableOutcomes.length, 1, 500));
        const needsOutcomeDisambiguation = requestedOutcomes.length === 0 && totalOutcomes > 1;
        const selectionMode = requestedOutcomes.length > 0
            ? "requested_outcomes"
            : sortBy === "price"
                ? "top_price_outcomes"
                : "top_volume_outcomes";
        const selectionReason = requestedOutcomes.length > 0
            ? `Matched ${selectedOutcomes.length} requested outcomes inside the event.`
            : sortBy === "price"
                ? `This event has ${totalOutcomes} outcomes, so the tool analyzed the top ${selectedOutcomes.length} outcomes by current implied probability instead of pretending there is one generic YES side.`
                : `This event has ${totalOutcomes} outcomes, so the tool analyzed the top ${selectedOutcomes.length} outcomes by trading volume instead of pretending there is one generic YES side.`;
        const analyzedOutcomes = [];
        const analysisNotes = [];
        for (const outcome of selectedOutcomes) {
            const tokenId = typeof outcome.tokenId === "string" ? outcome.tokenId : "";
            const conditionId = typeof outcome.conditionId === "string" ? outcome.conditionId : "";
            const matchedName = typeof outcome.name === "string" ? outcome.name : "Unknown outcome";
            try {
                const liquidityData = workflowExtractToolData(await handleAnalyzeMarketLiquidity({ tokenId }), "analyze_market_liquidity");
                const spread = workflowObject(liquidityData.spread);
                const depth = workflowObject(liquidityData.depth);
                const whaleCost = workflowObject(liquidityData.whaleCost);
                const sell1k = workflowObject(whaleCost.sell1k);
                const sell5k = workflowObject(whaleCost.sell5k);
                const sell10k = workflowObject(whaleCost.sell10k);
                const currentPrice = workflowToNumber(liquidityData.currentPrice, workflowToNumber(outcome.price, 0));
                analyzedOutcomes.push({
                    requestedName: typeof outcome.requestedName === "string"
                        ? outcome.requestedName
                        : matchedName,
                    matchedName,
                    tokenId,
                    conditionId,
                    currentPrice: Number(currentPrice.toFixed(4)),
                    impliedProbability: `${(currentPrice * 100).toFixed(1)}%`,
                    volume: Number(workflowToNumber(outcome.volume, 0).toFixed(2)),
                    liquidityScore: typeof liquidityData.liquidityScore === "string"
                        ? liquidityData.liquidityScore
                        : "unknown",
                    bestBid: workflowToNumber(spread.bestBid, 0),
                    bestAsk: workflowToNumber(spread.bestAsk, 0),
                    spreadCents: workflowToNumber(spread.spreadCents, 0),
                    spreadBps: workflowToNumber(spread.spreadBps, 0),
                    totalDepthUsd: workflowToNumber(depth.totalDepthUsd, 0),
                    slippage1kPercent: workflowToNumber(sell1k.slippagePercent, 0),
                    slippage5kPercent: workflowToNumber(sell5k.slippagePercent, 0),
                    slippage10kPercent: workflowToNumber(sell10k.slippagePercent, 0),
                    canExit1k: sell1k.canFill === true,
                    canExit5k: sell5k.canFill === true,
                    canExit10k: sell10k.canFill === true,
                    recommendation: typeof liquidityData.recommendation === "string"
                        ? liquidityData.recommendation
                        : "",
                });
            }
            catch (error) {
                analysisNotes.push(`Liquidity analysis failed for "${matchedName}": ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
        if (analyzedOutcomes.length === 0) {
            return errorResult(`Could not analyze liquidity for any matched outcomes inside "${eventTitle}".`);
        }
        const bestLiquidityOutcome = [...analyzedOutcomes].sort((left, right) => {
            const depthDifference = workflowToNumber(right.totalDepthUsd, 0) -
                workflowToNumber(left.totalDepthUsd, 0);
            if (depthDifference !== 0) {
                return depthDifference;
            }
            return (workflowToNumber(left.spreadCents, 0) -
                workflowToNumber(right.spreadCents, 0));
        })[0];
        const highestVolumeOutcome = [...analyzedOutcomes].sort((left, right) => workflowToNumber(right.volume, 0) - workflowToNumber(left.volume, 0))[0];
        const summary = needsOutcomeDisambiguation
            ? `This is a ${totalOutcomes}-outcome event, so there is no single generic YES side. Returned ${analyzedOutcomes.length} representative outcomes to show which exits look tradeable.`
            : `Analyzed liquidity for ${analyzedOutcomes.length} selected outcomes inside this multi-outcome event.`;
        return successResult({
            eventTitle,
            eventSlug,
            eventUrl,
            totalOutcomes,
            selectionMode,
            selectionReason,
            needsOutcomeDisambiguation,
            summary,
            analyzedOutcomes,
            unmatchedOutcomes,
            bestLiquidityOutcome: !bestLiquidityOutcome
                ? null
                : {
                    matchedName: bestLiquidityOutcome.matchedName,
                    totalDepthUsd: bestLiquidityOutcome.totalDepthUsd,
                    spreadCents: bestLiquidityOutcome.spreadCents,
                    liquidityScore: bestLiquidityOutcome.liquidityScore,
                },
            highestVolumeOutcome: !highestVolumeOutcome
                ? null
                : {
                    matchedName: highestVolumeOutcome.matchedName,
                    volume: highestVolumeOutcome.volume,
                    currentPrice: highestVolumeOutcome.currentPrice,
                },
            analysisNotes,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`analyze_event_outcome_liquidity failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleAnalyzeSingleMarketWhales(args) {
    const conditionIdInput = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const slugInput = typeof args?.slug === "string" ? args.slug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    const explicitCategory = typeof args?.category === "string" ? args.category.trim() : "";
    const category = explicitCategory.length > 0
        ? explicitCategory
        : inferGenericMarketCategory(marketQuery);
    const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
    const genericMarketQuery = marketQuery.length > 0 && isGenericMarketReferenceQuery(marketQuery);
    try {
        let resolved = conditionIdInput.length > 0 || slugInput.length > 0
            ? await resolveMarketReference({
                conditionId: conditionIdInput || undefined,
                slug: slugInput || undefined,
            })
            : marketQuery.length > 0 && !genericMarketQuery
                ? await resolveMarketReference({ marketQuery })
                : null;
        let selectionReason = conditionIdInput.length > 0
            ? "Used the provided conditionId."
            : slugInput.length > 0
                ? "Used the provided slug."
                : marketQuery.length > 0 && !genericMarketQuery
                    ? "Resolved directly from the provided marketQuery."
                    : "";
        if (!resolved && category.length > 0) {
            const discoveryData = workflowExtractToolData(await handleDiscoverTrendingMarkets({
                category,
                sortBy: "recent_activity",
                limit: 6,
            }), "discover_trending_markets");
            let candidates = workflowObjectArray(discoveryData.trendingMarkets);
            if (candidates.length === 0) {
                const topMarketsData = workflowExtractToolData(await handleGetTopMarkets({
                    category,
                    sortBy: "recent_activity",
                    limit: 6,
                }), "get_top_markets");
                candidates = workflowObjectArray(topMarketsData.markets);
            }
            let fallbackResolved = null;
            for (const candidate of candidates) {
                const slug = typeof candidate.slug === "string" ? candidate.slug : "";
                const conditionId = typeof candidate.conditionId === "string" ? candidate.conditionId : "";
                if (slug.length === 0 && conditionId.length === 0) {
                    continue;
                }
                const candidateResolved = await resolveMarketReference(slug.length > 0
                    ? { slug }
                    : { conditionId: conditionId || undefined });
                if (!candidateResolved) {
                    continue;
                }
                if (!fallbackResolved) {
                    fallbackResolved = candidateResolved;
                }
                if (slug.length === 0) {
                    continue;
                }
                try {
                    const event = (await fetchGamma(`/events/slug/${slug}`, 8_000));
                    if ((event.markets?.length ?? 0) <= 1) {
                        resolved = candidateResolved;
                        selectionReason = `Picked the highest recent-activity live single-outcome ${category} market from the current sample.`;
                        break;
                    }
                }
                catch {
                    // Keep scanning other candidates.
                }
            }
            if (!resolved && fallbackResolved) {
                resolved = fallbackResolved;
                selectionReason = `Fell back to the highest recent-activity live ${category} market because no clear single-outcome market was detected in the sample.`;
            }
        }
        if (!resolved) {
            const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                category: category || undefined,
                sortBy: "recent_activity",
                preferSingleOutcome: true,
            });
            if (fallbackCandidate) {
                resolved = await resolveMarketReference({
                    conditionId: fallbackCandidate.conditionId || undefined,
                    slug: fallbackCandidate.slug || undefined,
                });
                if (resolved) {
                    selectionReason =
                        category.length > 0
                            ? `No concrete market was provided, so whale analysis used a high-volume live single-outcome ${category} fallback.`
                            : "No concrete market was provided, so whale analysis used a strong live single-outcome fallback.";
                }
            }
        }
        if (!resolved) {
            return errorResult("Could not resolve a market for whale analysis.");
        }
        const [whaleFlowResult, holdersResult] = await Promise.all([
            handleAnalyzeWhaleFlow({
                conditionId: resolved.conditionId,
                slug: resolved.slug,
                hoursBack,
            }),
            handleAnalyzeTopHolders({
                conditionId: resolved.conditionId,
                slug: resolved.slug,
                deepFetch: true,
                limit: 50,
            }),
        ]);
        const whaleFlowData = workflowExtractToolData(whaleFlowResult, "analyze_whale_flow");
        const holdersData = workflowExtractToolData(holdersResult, "analyze_top_holders");
        const whaleAnalysis = workflowObject(holdersData.whaleAnalysis);
        return successResult({
            selectedMarket: {
                title: typeof holdersData.market === "string" &&
                    !/^0x[a-f0-9]{64}$/i.test(holdersData.market.trim())
                    ? holdersData.market
                    : resolved.marketTitle,
                slug: resolved.slug || "",
                conditionId: resolved.conditionId,
                url: getPolymarketUrl(resolved.slug, resolved.conditionId),
                category,
                selectionReason,
            },
            whaleFlow: {
                period: typeof whaleFlowData.period === "string"
                    ? whaleFlowData.period
                    : `Last ${hoursBack} hours`,
                totalTrades: workflowToNumber(whaleFlowData.totalTrades, 0),
                totalVolume: workflowToNumber(whaleFlowData.totalVolume, 0),
                flowBySize: workflowObject(whaleFlowData.flowBySize),
                sizeBucketDefinitions: workflowObject(whaleFlowData.sizeBucketDefinitions),
                tradeSample: workflowObject(whaleFlowData.tradeSample),
                tradeCoverage: workflowObject(whaleFlowData.tradeCoverage ?? whaleFlowData.tradeSample),
                buyerGuidance: workflowObject(whaleFlowData.buyerGuidance),
                directionalSemantics: typeof whaleFlowData.directionalSemantics === "string"
                    ? whaleFlowData.directionalSemantics
                    : "Positive netFlow means buying YES / selling NO. Negative netFlow means selling YES / buying NO.",
                whaleActivity: workflowObject(whaleFlowData.whaleActivity),
                divergence: typeof whaleFlowData.divergence === "string"
                    ? whaleFlowData.divergence
                    : "No divergence note available.",
            },
            holderAnalysis: {
                marketConcentration: workflowObject(holdersData.marketConcentration),
                smartMoneySignal: workflowObject(holdersData.smartMoneySignal),
                recommendation: typeof holdersData.recommendation === "string"
                    ? holdersData.recommendation
                    : "",
            },
            yesWhales: workflowObjectArray(whaleAnalysis.yesWhales).slice(0, 5),
            noWhales: workflowObjectArray(whaleAnalysis.noWhales).slice(0, 5),
            buyerGuidance: {
                holderVsTradeWhaleNote: `Holder whales are top positions from holderAnalysis (>=${formatUsdThreshold(HOLDER_WHALE_MIN_USD)} current value or >=${HOLDER_WHALE_MIN_SUPPLY_PERCENT}% of scanned side supply). Trade-flow whale prints are single trades >=${formatUsdThreshold(TRADE_WHALE_MIN_USD)}. Keep these concepts separate in buyer-facing answers and chart labels.`,
                whaleFlow: workflowObject(whaleFlowData.buyerGuidance),
            },
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`analyze_single_market_whales failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleSummarizeLiveMarketActivity(args) {
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    const explicitConditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const endingWithinDays = workflowToBoundedInteger(args?.endingWithinDays, 7, 1, 30);
    const tradeLimit = workflowToBoundedInteger(args?.tradeLimit, 20, 5, 500);
    const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
    const minNotional = workflowToBoundedInteger(args?.minNotional, 0, 0, 1_000_000);
    const sideFilter = args?.side === "BUY" || args?.side === "SELL" ? args.side : undefined;
    const userFilter = typeof args?.user === "string" ? args.user.trim() : "";
    const sortByRaw = typeof args?.sortBy === "string" ? args.sortBy : "ending_soon";
    const sortBy = sortByRaw === "volume" ||
        sortByRaw === "liquidity" ||
        sortByRaw === "open_interest_vs_volume"
        ? sortByRaw
        : "ending_soon";
    const noResultsPayload = (reason) => successResult({
        selectedMarket: {
            title: "",
            slug: "",
            conditionId: "",
            url: "https://polymarket.com",
            endDate: "",
            category,
            liquidity: 0,
            volume24h: 0,
            selectionReason: reason,
        },
        tradesSummary: {
            totalTrades: 0,
            totalVolume: 0,
            buyVolume: 0,
            sellVolume: 0,
            avgPrice: 0,
        },
        openInterest: {
            conditionId: "",
            value: 0,
        },
        recentTrades: [],
        tradeCoverage: {
            coverageMode: "standard",
            coverageLevel: "insufficient",
            coverageWarning: reason,
            canMakeDirectionalClaim: false,
            canMakeWhaleClaim: false,
        },
        noResultsReason: reason,
        searchExhausted: true,
        fetchedAt: new Date().toISOString(),
    });
    const extractMatchedOpenInterest = (openInterestData, targetConditionId) => {
        const openInterestRows = workflowObjectArray(openInterestData.openInterest);
        const matchedOpenInterestRow = openInterestRows.find((row) => {
            const openInterestRow = workflowObject(row);
            return (typeof openInterestRow.conditionId === "string" &&
                openInterestRow.conditionId === targetConditionId);
        }) ?? (openInterestRows[0] ?? null);
        return matchedOpenInterestRow === null
            ? workflowToNumber(openInterestData.totalOpenInterest, 0)
            : workflowToNumber(workflowObject(matchedOpenInterestRow).value, 0);
    };
    try {
        let resolved = await resolveMarketReference({
            conditionId: explicitConditionId || undefined,
            slug: slug || undefined,
            marketQuery: marketQuery || undefined,
        });
        let selectedMarketData = null;
        let selectionReason = "";
        let prefetchedActivity = null;
        if (resolved) {
            selectionReason =
                marketQuery.length > 0
                    ? "Resolved directly from the provided marketQuery."
                    : explicitConditionId.length > 0
                        ? "Used the provided conditionId."
                        : "Resolved directly from the provided slug.";
        }
        else {
            const dayTiers = Array.from(new Set([endingWithinDays, 14, 30].filter((d) => d >= 1))).sort((a, b) => a - b);
            let effectiveEndingDays = endingWithinDays;
            let usedVolumeFallback = false;
            let topMarketsData = {};
            let candidates = [];
            for (const days of dayTiers) {
                const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
                topMarketsData = workflowExtractToolData(await handleGetTopMarkets({
                    category: category || undefined,
                    sortBy: sortBy === "open_interest_vs_volume" ? "liquidity" : sortBy,
                    endDateBefore: cutoff,
                    includeEnded: false,
                    includeNearResolved: false,
                    limit: 12,
                }), "get_top_markets");
                candidates = workflowObjectArray(topMarketsData.markets);
                if (candidates.length > 0) {
                    effectiveEndingDays = days;
                    break;
                }
            }
            if (candidates.length === 0 && sortBy === "ending_soon") {
                return noResultsPayload(`No live market matched the current ending-soon window within ${endingWithinDays} days (also tried up to 90 days).`);
            }
            if (candidates.length === 0) {
                topMarketsData = workflowExtractToolData(await handleGetTopMarkets({
                    category: category || undefined,
                    sortBy: "volume",
                    includeEnded: false,
                    includeNearResolved: false,
                    limit: 20,
                }), "get_top_markets");
                candidates = workflowObjectArray(topMarketsData.markets).filter((row) => workflowToNumber(row.volume24h, 0) >= 500);
                usedVolumeFallback = true;
                effectiveEndingDays = 0;
            }
            if (sortBy === "open_interest_vs_volume") {
                const candidateSnapshots = [];
                for (const candidate of candidates.slice(0, 5)) {
                    const candidateConditionId = typeof candidate.conditionId === "string"
                        ? candidate.conditionId
                        : "";
                    const candidateSlug = typeof candidate.slug === "string" ? candidate.slug : "";
                    if (candidateConditionId.length === 0 && candidateSlug.length === 0) {
                        continue;
                    }
                    const candidateResolved = await resolveMarketReference({
                        conditionId: candidateConditionId || undefined,
                        slug: candidateSlug || undefined,
                    });
                    if (!candidateResolved) {
                        continue;
                    }
                    const [candidateTradesData, candidateOpenInterestData] = await Promise.all([
                        workflowExtractToolData(await handleGetMarketTrades({
                            conditionId: candidateResolved.conditionId,
                            limit: tradeLimit,
                            hoursBack,
                            coverageMode: "standard",
                            ...(minNotional > 0 ? { minNotional } : {}),
                            ...(sideFilter ? { side: sideFilter } : {}),
                            ...(userFilter.length > 0 ? { user: userFilter } : {}),
                        }), "get_market_trades"),
                        workflowExtractToolData(await handleGetMarketOpenInterest({
                            conditionId: candidateResolved.conditionId,
                        }), "get_market_open_interest"),
                    ]);
                    const candidateOpenInterestValue = extractMatchedOpenInterest(candidateOpenInterestData, candidateResolved.conditionId);
                    const tradesSummary = workflowObject(candidateTradesData.summary);
                    const tradeCoverage = workflowObject(candidateTradesData.tradeCoverage);
                    const totalVolume = workflowToNumber(tradesSummary.totalVolume, 0);
                    const coverageLevel = typeof tradeCoverage.coverageLevel === "string"
                        ? tradeCoverage.coverageLevel
                        : "insufficient";
                    const coverageScore = coverageLevel === "complete"
                        ? 3
                        : coverageLevel === "high_coverage"
                            ? 2
                            : coverageLevel === "partial"
                                ? 1
                                : 0;
                    const ratio = coverageScore === 0
                        ? 0
                        : candidateOpenInterestValue / Math.max(totalVolume, 1);
                    candidateSnapshots.push({
                        selectedMarketData: candidate,
                        resolved: candidateResolved,
                        tradesData: candidateTradesData,
                        openInterestData: candidateOpenInterestData,
                        openInterestValue: candidateOpenInterestValue,
                        totalVolume,
                        ratio,
                        coverageScore,
                    });
                }
                candidateSnapshots.sort((left, right) => {
                    if (right.coverageScore !== left.coverageScore) {
                        return right.coverageScore - left.coverageScore;
                    }
                    if (right.ratio !== left.ratio) {
                        return right.ratio - left.ratio;
                    }
                    if (right.openInterestValue !== left.openInterestValue) {
                        return right.openInterestValue - left.openInterestValue;
                    }
                    return left.totalVolume - right.totalVolume;
                });
                const bestCandidate = candidateSnapshots[0] ?? null;
                selectedMarketData = bestCandidate?.selectedMarketData ?? null;
                if (bestCandidate) {
                    resolved = bestCandidate.resolved;
                    prefetchedActivity = {
                        tradesData: bestCandidate.tradesData,
                        openInterestData: bestCandidate.openInterestData,
                    };
                    const windowPart = usedVolumeFallback || effectiveEndingDays === 0
                        ? "volume-ranked live markets (no near-resolution window match)"
                        : `ending within ${effectiveEndingDays} days (widened from ${endingWithinDays} if needed)`;
                    selectionReason = `Screened ${candidateSnapshots.length} live candidate markets (${windowPart}) and picked the one with the highest coverage-supported openInterest-to-recent-volume ratio.`;
                }
                else if (candidates[0]) {
                    selectedMarketData = candidates[0] ?? null;
                    selectionReason =
                        "Open-interest ratio screening did not yield a winner; using the top liquidity-ranked candidate from the shortlist instead.";
                }
            }
            else {
                selectedMarketData = candidates[0] ?? null;
            }
            if (!selectedMarketData) {
                return noResultsPayload(usedVolumeFallback
                    ? "No live market with sufficient recent volume matched after widening near-term windows."
                    : `No live market matched the current selection window within ${endingWithinDays} days (also tried up to 90 days).`);
            }
            const candidateConditionId = typeof selectedMarketData.conditionId === "string"
                ? selectedMarketData.conditionId
                : "";
            const candidateSlug = typeof selectedMarketData.slug === "string" ? selectedMarketData.slug : "";
            resolved = await resolveMarketReference({
                conditionId: candidateConditionId || undefined,
                slug: candidateSlug || undefined,
            });
            if (!resolved) {
                return noResultsPayload("A live market candidate was found, but its activity target could not be resolved.");
            }
            if (selectionReason.length === 0) {
                const scope = usedVolumeFallback
                    ? "ranked by 24h volume (fallback after no match in ending-soon windows up to 90d)"
                    : sortBy === "ending_soon"
                        ? `ending within ${effectiveEndingDays} days (requested ≤${endingWithinDays}d; widened if empty)`
                        : `ranked by ${sortBy}`;
                selectionReason = [
                    "Picked the highest-ranked live market",
                    scope,
                    category.length > 0 ? `in ${category}` : "",
                ]
                    .filter((value) => value.length > 0)
                    .join(" ");
            }
        }
        if (!selectedMarketData) {
            const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${encodeURIComponent(resolved.conditionId)}&limit=1`, 8_000));
            const market = Array.isArray(gammaMarkets) && gammaMarkets.length > 0 ? gammaMarkets[0] : null;
            const marketRecord = market === null ? {} : market;
            selectedMarketData = {
                title: market?.question || market?.title || resolved.marketTitle,
                slug: market?.slug || resolved.slug || "",
                conditionId: resolved.conditionId,
                url: getPolymarketUrl(market?.slug || resolved.slug, resolved.conditionId),
                endDate: typeof marketRecord.endDate === "string" ? marketRecord.endDate : "",
                category: typeof marketRecord.category === "string"
                    ? marketRecord.category
                    : category,
                liquidity: Number(market?.liquidity || 0),
                volume24h: Number(market?.volume24hr || 0),
            };
        }
        const activityData = prefetchedActivity ??
            (await (async () => {
                const [tradesData, openInterestData] = await Promise.all([
                    workflowExtractToolData(await handleGetMarketTrades({
                        conditionId: resolved.conditionId,
                        limit: tradeLimit,
                        hoursBack,
                        coverageMode: "standard",
                        ...(minNotional > 0 ? { minNotional } : {}),
                        ...(sideFilter ? { side: sideFilter } : {}),
                        ...(userFilter.length > 0 ? { user: userFilter } : {}),
                    }), "get_market_trades"),
                    workflowExtractToolData(await handleGetMarketOpenInterest({
                        conditionId: resolved.conditionId,
                    }), "get_market_open_interest"),
                ]);
                return { tradesData, openInterestData };
            })());
        const { tradesData, openInterestData } = activityData;
        const matchedOpenInterest = extractMatchedOpenInterest(openInterestData, resolved.conditionId);
        return successResult({
            selectedMarket: {
                title: typeof selectedMarketData.title === "string"
                    ? selectedMarketData.title
                    : resolved.marketTitle,
                slug: typeof selectedMarketData.slug === "string" ? selectedMarketData.slug : "",
                conditionId: resolved.conditionId,
                url: typeof selectedMarketData.url === "string"
                    ? selectedMarketData.url
                    : getPolymarketUrl(resolved.slug, resolved.conditionId),
                endDate: typeof selectedMarketData.endDate === "string"
                    ? selectedMarketData.endDate
                    : "",
                category: typeof selectedMarketData.category === "string"
                    ? selectedMarketData.category
                    : category,
                liquidity: workflowToNumber(selectedMarketData.liquidity, 0),
                volume24h: workflowToNumber(selectedMarketData.volume24h, 0),
                selectionReason,
            },
            tradesSummary: workflowObject(tradesData.summary),
            tradeCoverage: workflowObject(tradesData.tradeCoverage),
            openInterest: {
                conditionId: resolved.conditionId,
                value: matchedOpenInterest,
                changeRateAvailable: false,
                note: "This is a point-in-time open-interest snapshot. Use it for current OI level, not for a true change rate without a second time-separated snapshot.",
            },
            recentTrades: workflowObjectArray(tradesData.trades),
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`summarize_live_market_activity failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleRankEventTradability(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    const explicitEventQuery = typeof args?.eventQuery === "string" ? args.eventQuery.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const limit = workflowToBoundedInteger(args?.limit, 6, 2, 10);
    const quotedFragments = workflowExtractQuotedFragments(rawQuery);
    const requestedOutcomes = workflowUniqueStrings([
        ...workflowStringArray(args?.outcomes),
        ...(quotedFragments.length > 1 ? quotedFragments.slice(1) : []),
    ]);
    const eventQuery = explicitEventQuery ||
        (slug.length > 0
            ? ""
            : quotedFragments[0] ||
                workflowExtractEventQueryFromComparison(rawQuery) ||
                rawQuery);
    try {
        const resolvedEvent = await workflowResolveEventDataForAnalysis({
            eventQuery,
            slug,
            category,
            sortBy: "volume",
        });
        const eventData = resolvedEvent.eventData;
        const eventSlug = typeof eventData.eventSlug === "string" ? eventData.eventSlug : slug;
        const eventTitle = typeof eventData.eventTitle === "string"
            ? eventData.eventTitle
            : eventQuery || eventSlug;
        const selectedOutcomeNames = requestedOutcomes.length > 0
            ? requestedOutcomes
            : workflowUniqueStrings([
                ...workflowObjectArray(eventData.outcomes)
                    .slice(0, Math.max(limit - 2, 1))
                    .map((outcome) => typeof outcome.name === "string" ? outcome.name : "")
                    .filter((name) => name.length > 0),
                ...[...workflowObjectArray(eventData.outcomes)]
                    .sort((left, right) => workflowToNumber(right.price, 0) - workflowToNumber(left.price, 0))
                    .slice(0, Math.min(2, limit))
                    .map((outcome) => typeof outcome.name === "string" ? outcome.name : "")
                    .filter((name) => name.length > 0),
            ]).slice(0, Math.max(limit, 2));
        const liquidityData = workflowExtractToolData(await handleAnalyzeEventOutcomeLiquidity({
            slug: eventSlug,
            outcomes: selectedOutcomeNames,
            sortBy: "volume",
        }), "analyze_event_outcome_liquidity");
        const whaleData = workflowExtractToolData(await handleAnalyzeEventWhaleBreakdown({
            slug: eventSlug,
            maxOutcomes: Math.min(Math.max(limit, selectedOutcomeNames.length, 4), 8),
        }), "analyze_event_whale_breakdown");
        let liveVolumeData = {};
        try {
            liveVolumeData = workflowExtractToolData(await handleGetEventLiveVolume({ slug: eventSlug }), "get_event_live_volume");
        }
        catch {
            liveVolumeData = {};
        }
        const whaleByConditionId = new Map();
        for (const whaleRow of workflowObjectArray(whaleData.whalesByOutcome)) {
            const conditionId = typeof whaleRow.conditionId === "string" ? whaleRow.conditionId : "";
            if (conditionId.length > 0) {
                whaleByConditionId.set(conditionId, whaleRow);
            }
        }
        const liveShareByConditionId = new Map();
        for (const marketRow of workflowObjectArray(liveVolumeData.markets)) {
            const conditionId = typeof marketRow.conditionId === "string"
                ? marketRow.conditionId
                : typeof marketRow.market === "string"
                    ? marketRow.market
                    : "";
            if (conditionId.length === 0) {
                continue;
            }
            liveShareByConditionId.set(conditionId, workflowToNumber(marketRow.shareOfEventTotal, 0));
        }
        const rankedOutcomes = workflowObjectArray(liquidityData.analyzedOutcomes)
            .map((outcome) => {
            const matchedName = typeof outcome.matchedName === "string"
                ? outcome.matchedName
                : "Unknown outcome";
            const conditionId = typeof outcome.conditionId === "string" ? outcome.conditionId : "";
            const spreadCents = workflowToNumber(outcome.spreadCents, 999);
            const totalDepthUsd = workflowToNumber(outcome.totalDepthUsd, 0);
            const slippage5kPercent = workflowToNumber(outcome.slippage5kPercent, 999);
            const currentPrice = workflowToNumber(outcome.currentPrice, 0);
            const volume = workflowToNumber(outcome.volume, 0);
            const liquidityScore = typeof outcome.liquidityScore === "string"
                ? outcome.liquidityScore
                : "unknown";
            const whaleRow = whaleByConditionId.get(conditionId) ?? {};
            const whaleValue = workflowToNumber(whaleRow.totalWhaleValue, 0);
            const whaleCount = workflowToNumber(whaleRow.whaleCount, 0);
            const liveVolumeShare = liveShareByConditionId.get(conditionId) ?? 0;
            const rationale = [];
            let score = 0;
            if (liquidityScore === "excellent")
                score += 32;
            else if (liquidityScore === "good")
                score += 24;
            else if (liquidityScore === "fair")
                score += 14;
            else if (liquidityScore === "poor")
                score += 6;
            if (spreadCents <= 1) {
                score += 20;
                rationale.push("Tight quoted spread.");
            }
            else if (spreadCents <= 3) {
                score += 12;
                rationale.push("Manageable spread.");
            }
            else if (spreadCents <= 6) {
                score += 4;
            }
            else {
                rationale.push("Wide spread.");
            }
            if (totalDepthUsd >= 100_000) {
                score += 18;
                rationale.push("Deep displayed depth.");
            }
            else if (totalDepthUsd >= 25_000) {
                score += 12;
            }
            else if (totalDepthUsd >= 10_000) {
                score += 6;
            }
            else {
                rationale.push("Thin depth.");
            }
            if (slippage5kPercent <= 2) {
                score += 15;
                rationale.push("Low estimated $5k exit slippage.");
            }
            else if (slippage5kPercent <= 5) {
                score += 8;
            }
            else if (slippage5kPercent > 10) {
                rationale.push("High $5k exit slippage.");
            }
            if (whaleValue >= 50_000) {
                score += 10;
                rationale.push("Meaningful whale participation.");
            }
            else if (whaleValue >= 10_000) {
                score += 6;
            }
            if (whaleCount >= 5) {
                score += 4;
            }
            if (liveVolumeShare >= 0.2) {
                score += 8;
                rationale.push("Taking a large share of current event flow.");
            }
            else if (liveVolumeShare >= 0.1) {
                score += 4;
            }
            let classification;
            if (spreadCents <= 3 && totalDepthUsd >= 10_000 && slippage5kPercent <= 5) {
                classification = "tradable_now";
            }
            else if (spreadCents > 8 ||
                totalDepthUsd < 5_000 ||
                slippage5kPercent > 12) {
                classification = "headline_only";
            }
            else {
                classification = "watchlist";
            }
            return {
                matchedName,
                conditionId,
                currentPrice: Number(currentPrice.toFixed(4)),
                volume: Number(volume.toFixed(2)),
                spreadCents: Number(spreadCents.toFixed(2)),
                totalDepthUsd: Number(totalDepthUsd.toFixed(2)),
                slippage5kPercent: Number(slippage5kPercent.toFixed(2)),
                whaleValue: Number(whaleValue.toFixed(2)),
                whaleCount: Number(whaleCount.toFixed(0)),
                liveVolumeShare: Number(liveVolumeShare.toFixed(6)),
                tradabilityScore: Number(score.toFixed(1)),
                classification,
                rationale: rationale.length > 0
                    ? rationale
                    : ["Tradability score is driven mostly by price-level liquidity."],
            };
        })
            .sort((left, right) => right.tradabilityScore - left.tradabilityScore)
            .map((outcome, index) => ({
            rank: index + 1,
            ...outcome,
        }));
        const expensiveButUntradeable = rankedOutcomes
            .filter((outcome) => outcome.currentPrice >= 0.08 && outcome.classification === "headline_only")
            .map((outcome) => outcome.matchedName);
        const watchlistOutcomes = rankedOutcomes
            .filter((outcome) => outcome.classification === "watchlist")
            .map((outcome) => outcome.matchedName);
        const headlineOnlyOutcomes = rankedOutcomes
            .filter((outcome) => outcome.classification === "headline_only")
            .map((outcome) => outcome.matchedName);
        const analysisNotes = workflowStringArray(liquidityData.analysisNotes);
        if (liveShareByConditionId.size === 0) {
            analysisNotes.push("Live event-volume share was unavailable, so ranking leaned more heavily on quoted liquidity and whale participation.");
        }
        if (requestedOutcomes.length === 0 && selectedOutcomeNames.length > 0) {
            analysisNotes.push("Checked a bounded mixed shortlist that includes both active names and the highest-priced/front-runner rows, rather than only the first few volume-ranked outcomes.");
        }
        if (rankedOutcomes.length > 0 && rankedOutcomes.every((outcome) => outcome.whaleCount === 0)) {
            analysisNotes.push("No analyzed outcome showed live whale participation in this snapshot, so the ranking is mainly separating cleaner quotes from headline-only liquidity.");
        }
        return successResult({
            eventTitle,
            eventSlug,
            selectionReason: resolvedEvent.selectionReason,
            rankedOutcomes,
            bestCombinedOutcome: rankedOutcomes.length === 0
                ? null
                : {
                    matchedName: rankedOutcomes[0].matchedName,
                    tradabilityScore: rankedOutcomes[0].tradabilityScore,
                    classification: rankedOutcomes[0].classification,
                },
            analyzedOutcomeNames: selectedOutcomeNames,
            watchlistOutcomes,
            headlineOnlyOutcomes,
            expensiveButUntradeable,
            analysisNotes,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`rank_event_tradability failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleCompareMarketAgainstRelatedContracts(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    const explicitMarketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    const explicitEventQuery = typeof args?.eventQuery === "string" ? args.eventQuery.trim() : "";
    const explicitFocusOutcome = typeof args?.focusOutcome === "string" ? args.focusOutcome.trim() : "";
    const conditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const quotedFragments = workflowExtractQuotedFragments(rawQuery);
    const marketQuery = explicitMarketQuery || workflowExtractMarketQueryFromRawPrompt(rawQuery);
    let focusOutcome = explicitFocusOutcome ||
        (quotedFragments.length > 1 ? quotedFragments.at(-1) || "" : "");
    try {
        const directResolved = conditionId.length > 0 || slug.length > 0 || marketQuery.length > 0
            ? await resolveMarketReference({
                conditionId: conditionId || undefined,
                slug: slug || undefined,
                marketQuery: marketQuery || undefined,
            })
            : null;
        const resolvedEvent = await workflowResolveEventDataForAnalysis({
            eventQuery: explicitEventQuery || rawQuery || marketQuery,
            category,
            sortBy: "volume",
        });
        const eventData = resolvedEvent.eventData;
        const eventTitle = typeof eventData.eventTitle === "string"
            ? eventData.eventTitle
            : explicitEventQuery || marketQuery;
        const eventSlug = typeof eventData.eventSlug === "string" ? eventData.eventSlug : "";
        const eventOutcomes = workflowObjectArray(eventData.outcomes);
        if (eventOutcomes.length === 0) {
            return errorResult("No sibling outcomes were available for comparison.");
        }
        const matchedPrimaryOutcome = workflowPickBestOutcomeMatch(eventOutcomes, [
            focusOutcome,
            marketQuery,
            rawQuery,
            ...quotedFragments.slice(1),
        ]);
        const primaryOutcome = matchedPrimaryOutcome.outcome ?? eventOutcomes[0];
        const primaryOutcomeName = typeof primaryOutcome.name === "string" ? primaryOutcome.name : "";
        if (!focusOutcome) {
            focusOutcome = primaryOutcomeName;
        }
        const primaryResolved = typeof primaryOutcome.conditionId === "string" &&
            primaryOutcome.conditionId.trim().length > 0
            ? {
                conditionId: primaryOutcome.conditionId.trim(),
                marketTitle: primaryOutcomeName || directResolved?.marketTitle || marketQuery,
                slug: eventSlug || directResolved?.slug,
            }
            : directResolved;
        if (!primaryResolved) {
            return errorResult("Could not resolve the primary market for relative-value analysis.");
        }
        const efficiencyData = workflowExtractToolData(await handleCheckMarketEfficiency({
            conditionId: primaryResolved.conditionId,
            slug: primaryResolved.slug,
        }), "check_market_efficiency");
        const liquidityData = workflowExtractToolData(await handleAnalyzeMarketLiquidity({
            conditionId: primaryResolved.conditionId,
        }), "analyze_market_liquidity");
        const primaryTargets = extractPriceTargets(primaryOutcomeName);
        let selectedOutcomeNames = [];
        if (eventOutcomes.length <= 8) {
            selectedOutcomeNames = workflowUniqueStrings(eventOutcomes
                .map((outcome) => typeof outcome.name === "string" ? outcome.name : "")
                .filter((name) => name.length > 0));
        }
        else if (primaryTargets.length > 0) {
            const rankedByTarget = eventOutcomes
                .map((outcome) => ({
                outcome,
                target: extractPriceTargets(typeof outcome.name === "string" ? outcome.name : "")[0],
            }))
                .filter((entry) => typeof entry.target === "number")
                .sort((left, right) => Math.abs(left.target - primaryTargets[0]) -
                Math.abs(right.target - primaryTargets[0]))
                .slice(0, 5);
            selectedOutcomeNames = workflowUniqueStrings(rankedByTarget
                .map((entry) => typeof entry.outcome.name === "string" ? entry.outcome.name : "")
                .filter((name) => name.length > 0));
        }
        else {
            selectedOutcomeNames = workflowUniqueStrings(eventOutcomes
                .slice(0, 5)
                .map((outcome) => typeof outcome.name === "string" ? outcome.name : "")
                .filter((name) => name.length > 0));
            if (primaryOutcomeName.length > 0 &&
                !selectedOutcomeNames.includes(primaryOutcomeName)) {
                selectedOutcomeNames.push(primaryOutcomeName);
            }
        }
        const comparisonData = workflowExtractToolData(await handleCompareEventOutcomeQuotes({
            eventQuery: eventTitle,
            outcomes: selectedOutcomeNames,
            ...(category.length > 0 ? { category } : {}),
        }), "compare_event_outcome_quotes");
        const siblingOutcomes = workflowObjectArray(comparisonData.matchedOutcomes).map((outcome) => ({
            matchedName: typeof outcome.matchedName === "string" ? outcome.matchedName : "Unknown",
            currentPrice: Number(workflowToNumber(outcome.currentPrice, 0).toFixed(4)),
            spread: Number(workflowToNumber(outcome.spread, 0).toFixed(4)),
            volume: Number(workflowToNumber(outcome.volume, 0).toFixed(2)),
        }));
        const primarySibling = siblingOutcomes.find((outcome) => workflowScoreOutcomeMatch(primaryOutcomeName, outcome.matchedName) >= 120) ?? siblingOutcomes[0];
        const neighborOutcomes = siblingOutcomes.filter((outcome) => outcome.matchedName !== primarySibling?.matchedName);
        const eventPriceSum = eventOutcomes.reduce((sum, outcome) => sum + workflowToNumber(outcome.price, 0), 0);
        const marketEfficiency = workflowObject(efficiencyData.marketEfficiency);
        const spreadData = workflowObject(liquidityData.spread);
        const currentPrice = workflowToNumber(primarySibling?.currentPrice, workflowToNumber(primaryOutcome.price, 0));
        let richOrCheap = "roughly_fair";
        let relativeValueDifference = null;
        let relativeValueAssessment = "The sibling-event curve does not show an obvious simple relative-value dislocation.";
        if (neighborOutcomes.length > 0 && primarySibling) {
            const averageNeighborPrice = neighborOutcomes.reduce((sum, outcome) => sum + outcome.currentPrice, 0) /
                neighborOutcomes.length;
            const priceDifference = currentPrice - averageNeighborPrice;
            relativeValueDifference = Number(priceDifference.toFixed(4));
            if (currentPrice > averageNeighborPrice * 1.75 && currentPrice > 0.05) {
                richOrCheap = "rich";
                relativeValueAssessment =
                    `${primarySibling.matchedName} looks rich versus the nearby sibling set, so the market likely needs stronger event-specific conviction than the neighboring contracts imply.`;
            }
            else if (currentPrice < averageNeighborPrice * 0.6 &&
                averageNeighborPrice > 0.01) {
                richOrCheap = "cheap";
                relativeValueAssessment =
                    `${primarySibling.matchedName} screens cheap versus the nearby sibling set, but the quote still needs to be filtered through liquidity and resolution risk before calling it value.`;
            }
            else if (Math.abs(eventPriceSum - 1) <= 0.03 &&
                workflowToNumber(marketEfficiency.vig, 0) <= 0.02) {
                relativeValueAssessment =
                    `${primarySibling.matchedName} sits inside an internally coherent event curve, so there is no obvious blunt overpricing or underpricing from sibling quotes alone.`;
            }
        }
        let arbitrageAssessment = "No simple event-curve arbitrage stands out from the current sibling prices.";
        const efficiencyRecommendation = typeof efficiencyData.recommendation === "string"
            ? efficiencyData.recommendation
            : "";
        if (efficiencyRecommendation.includes("Arbitrage opportunity")) {
            arbitrageAssessment = efficiencyRecommendation;
        }
        else if (Math.abs(eventPriceSum - 1) > 0.03) {
            arbitrageAssessment =
                `Sibling outcome prices sum to ${eventPriceSum.toFixed(4)}, so the event curve is wide enough to justify a closer manual check.`;
        }
        const primaryMarket = primaryResolved.marketTitle ||
            (typeof efficiencyData.market === "string" ? efficiencyData.market : primaryOutcomeName);
        return successResult({
            primaryMarket: {
                title: primaryMarket,
                conditionId: primaryResolved.conditionId,
                eventTitle,
                primaryOutcome: primarySibling?.matchedName || primaryOutcomeName,
                currentPrice: Number(currentPrice.toFixed(4)),
                spreadCents: Number(workflowToNumber(spreadData.spreadCents, workflowToNumber(spreadData.absolute, 0)).toFixed(2)),
                liquidityScore: typeof liquidityData.liquidityScore === "string"
                    ? liquidityData.liquidityScore
                    : "unknown",
            },
            siblingOutcomes,
            eventPriceSum: Number(eventPriceSum.toFixed(4)),
            richOrCheap,
            relativeValueDifference,
            relativeValueAssessment,
            arbitrageAssessment,
            synthesisHint: "Use richOrCheap and relativeValueAssessment directly in the answer. Do not recompute the verdict from raw search rows because siblingOutcomes already normalizes currentPrice aliases.",
            analysisNotes: [
                resolvedEvent.selectionReason,
                typeof comparisonData.selectionReason === "string"
                    ? comparisonData.selectionReason
                    : "Compared the resolved outcome against its sibling contracts.",
            ],
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`compare_market_against_related_contracts failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleBuildMarketTradabilityMemo(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    const explicitMarketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const conditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
    const marketQuery = explicitMarketQuery || workflowExtractMarketQueryFromRawPrompt(rawQuery);
    try {
        let resolved = conditionId.length > 0 || slug.length > 0 || marketQuery.length > 0
            ? await resolveMarketReference({
                conditionId: conditionId || undefined,
                slug: slug || undefined,
                marketQuery: marketQuery || undefined,
            })
            : null;
        if (!resolved && (marketQuery.length > 0 || rawQuery.length > 0)) {
            const resolvedEvent = await workflowResolveEventDataForAnalysis({
                eventQuery: rawQuery || marketQuery,
                sortBy: "volume",
            });
            const eventData = resolvedEvent.eventData;
            const eventSlug = typeof eventData.eventSlug === "string" ? eventData.eventSlug : "";
            const eventOutcomes = workflowObjectArray(eventData.outcomes);
            const matchedOutcome = workflowPickBestOutcomeMatch(eventOutcomes, [
                marketQuery,
                rawQuery,
            ]);
            if (matchedOutcome.score >= 30 &&
                matchedOutcome.outcome &&
                typeof matchedOutcome.outcome.conditionId === "string" &&
                matchedOutcome.outcome.conditionId.trim().length > 0) {
                resolved = {
                    conditionId: matchedOutcome.outcome.conditionId.trim(),
                    marketTitle: matchedOutcome.matchedName || marketQuery || rawQuery,
                    slug: eventSlug || undefined,
                };
            }
        }
        if (!resolved) {
            return errorResult("Could not resolve the market for memo analysis.");
        }
        const rulesData = workflowExtractToolData(await handleCheckMarketRules({
            conditionId: resolved.conditionId,
        }), "check_market_rules");
        const liquidityData = workflowExtractToolData(await handleAnalyzeMarketLiquidity({
            conditionId: resolved.conditionId,
        }), "analyze_market_liquidity");
        const whaleData = workflowExtractToolData(await handleAnalyzeSingleMarketWhales({
            conditionId: resolved.conditionId,
            hoursBack,
        }), "analyze_single_market_whales");
        const activityData = workflowExtractToolData(await handleSummarizeLiveMarketActivity({
            conditionId: resolved.conditionId,
            tradeLimit: 40,
        }), "summarize_live_market_activity");
        const rulesSummary = workflowObject(rulesData.rulesSummary);
        const riskFactors = workflowStringArray(rulesData.riskFactors);
        const ambiguities = workflowStringArray(rulesSummary.ambiguities);
        const spreadData = workflowObject(liquidityData.spread);
        const whaleCost = workflowObject(liquidityData.whaleCost);
        const sell5k = workflowObject(whaleCost.sell5k);
        const tradesSummary = workflowObject(activityData.tradesSummary);
        const activityTradeCoverage = workflowObject(activityData.tradeCoverage);
        const holderAnalysis = workflowObject(whaleData.holderAnalysis);
        const marketConcentration = workflowObject(holderAnalysis.marketConcentration);
        const whaleFlow = workflowObject(whaleData.whaleFlow);
        const whaleTradeCoverage = workflowObject(whaleFlow.tradeCoverage ?? whaleFlow.tradeSample);
        const whaleActivity = workflowObject(whaleFlow.whaleActivity);
        const currentPrice = workflowToNumber(liquidityData.currentPrice, 0);
        const spreadCents = workflowToNumber(spreadData.spreadCents, 0);
        const slippage5kPercent = workflowToNumber(sell5k.slippagePercent, 0);
        const liquidityScore = typeof liquidityData.liquidityScore === "string"
            ? liquidityData.liquidityScore
            : "unknown";
        const whaleSentiment = typeof whaleActivity.sentiment === "string"
            ? whaleActivity.sentiment
            : "neutral";
        const canUseWhaleFlow = whaleTradeCoverage.canMakeWhaleClaim === true;
        const canUseActivityFlow = activityTradeCoverage.canMakeDirectionalClaim === true;
        const totalTrades = workflowToNumber(tradesSummary.totalTrades, 0);
        const openInterest = workflowObject(activityData.openInterest);
        const openInterestValue = workflowToNumber(openInterest.value, 0);
        const rulesRisk = ambiguities.length >= 2 || riskFactors.length >= 4
            ? "high"
            : ambiguities.length > 0 || riskFactors.length >= 2
                ? "moderate"
                : "low";
        const quoteQuality = liquidityScore === "excellent" || liquidityScore === "good"
            ? spreadCents <= 3 && slippage5kPercent <= 5
                ? "strong"
                : "mixed"
            : liquidityScore === "fair"
                ? "mixed"
                : "weak";
        const whalePositioning = !canUseWhaleFlow
            ? "Whale-flow tape is partial, so it is treated as an observed sample rather than a decisive setup signal."
            : whaleSentiment === "bullish"
                ? "Whale flow leans with the YES side."
                : whaleSentiment === "bearish"
                    ? "Whale flow leans against the YES side."
                    : "Whale flow is not showing a strong directional edge.";
        const recentActivity = !canUseActivityFlow
            ? "Recent trade summary is based on partial public tape; use it for recency context, not full-market buy/sell pressure."
            : totalTrades >= 25
                ? "Recent tape is active enough to treat the quote as live, not stale."
                : totalTrades >= 8
                    ? "Recent tape is present but not especially deep."
                    : "Recent tape is thin, so displayed prices deserve extra skepticism.";
        let decision = "pass";
        if (rulesRisk === "high" || quoteQuality === "weak") {
            decision = "avoid";
        }
        else if (rulesRisk === "low" &&
            quoteQuality === "strong" &&
            (!canUseWhaleFlow || whaleSentiment !== "bearish") &&
            canUseActivityFlow &&
            totalTrades >= 20) {
            decision = "buy";
        }
        else if (canUseWhaleFlow && whaleSentiment === "bullish") {
            decision = "speculative_buy";
        }
        const concentrationRisk = workflowToNumber(marketConcentration.concentrationPercent, 0);
        const memoParts = [
            `Rules risk is ${rulesRisk}.`,
            `Quote quality is ${quoteQuality} with ${spreadCents.toFixed(1)}c spread and estimated $5k exit slippage of ${slippage5kPercent.toFixed(1)}%.`,
            whalePositioning,
            recentActivity,
            openInterestValue > 0
                ? `Current open interest is $${openInterestValue.toFixed(2)}, but the available upstream endpoint is snapshot-only and does not prove a true OI change rate by itself.`
                : "Open-interest snapshot is unavailable or minimal.",
            concentrationRisk > 0
                ? `Top-holder concentration is elevated at ${concentrationRisk.toFixed(2)}%.`
                : "Holder concentration did not materially change the memo.",
            `Decision: ${decision.toUpperCase().replace(/_/g, " ")}.`,
        ];
        return successResult({
            market: {
                title: typeof rulesData.market === "string" ? rulesData.market : resolved.marketTitle,
                conditionId: resolved.conditionId,
                currentPrice: Number(currentPrice.toFixed(4)),
                spreadCents: Number(spreadCents.toFixed(2)),
                liquidityScore,
            },
            rulesRisk,
            quoteQuality,
            whalePositioning,
            recentActivity,
            tradeCoverage: {
                activity: activityTradeCoverage,
                whaleFlow: whaleTradeCoverage,
            },
            decision,
            memo: memoParts.join(" "),
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`build_market_tradability_memo failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
/**
 * Find moderate probability bets (40-75%) with decent liquidity
 * Dedicated tool for "more likely" outcomes with 1.3-2.5x returns
 */
async function handleFindModerateProbabilityBets(args) {
    const minPrice = args?.minPrice ?? 0.40;
    const maxPrice = args?.maxPrice ?? 0.75;
    const minLiquidity = args?.minLiquidity ?? 10000;
    const category = args?.category;
    const sortBy = args?.sortBy ?? "return_potential";
    const limit = args?.limit ?? 10;
    const categoryTagSlug = category && category !== "all"
        ? resolveDiscoveryCategoryTagSlug({ category })
        : undefined;
    const fetchLimit = categoryTagSlug ? 100 : 50;
    let endpoint = `/events?closed=false&limit=${fetchLimit}&order=liquidity&ascending=false`;
    if (categoryTagSlug) {
        endpoint += `&tag_slug=${categoryTagSlug}`;
    }
    const rawEvents = (await fetchGamma(endpoint, 10000, 2));
    const filteredEvents = categoryTagSlug
        ? rawEvents.filter((event) => eventMatchesDiscoveryCategoryTagSlug(event, categoryTagSlug))
        : rawEvents;
    const events = filteredEvents.length > 0 || !categoryTagSlug ? filteredEvents : rawEvents;
    const moderateBetQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(events.flatMap((event) => event.markets || []), {
        timeoutMs: "heavy",
    });
    const opportunities = [];
    let marketsScanned = 0;
    for (const event of events) {
        if (!event.markets || event.markets.length === 0)
            continue;
        const eventLiquidity = Number(event.liquidity || 0);
        const eventVolume24h = Number(event.volume24hr || 0);
        const eventSlug = event.slug || "";
        const eventCategory = categoryTagSlug && eventMatchesDiscoveryCategoryTagSlug(event, categoryTagSlug)
            ? categoryTagSlug
            : normalizeDiscoveryCategoryTagSlug(event.category || "") ||
                "other";
        const eventEndDate = event.endDate || event.endDateIso || "";
        for (const market of event.markets) {
            const yesPrice = resolveCurrentOutcomePrice(market, moderateBetQuoteSnapshots);
            const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
            const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
            const marketTitle = market.question || event.title || "Unknown";
            if (marketLiquidity < minLiquidity)
                continue;
            if (yesPrice <= 0)
                continue;
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
async function handleGetBetsByProbability(args) {
    const likelihood = args?.likelihood;
    const category = args?.category;
    const limit = args?.limit ?? 5;
    if (!likelihood) {
        return errorResult("likelihood parameter is required");
    }
    // Define probability ranges for each likelihood
    const likelihoodRanges = {
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
    const events = (await fetchGamma(endpoint, 10000));
    const probabilityBetQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(events.flatMap((event) => event.markets || []), {
        includeNoTokens: true,
        timeoutMs: "heavy",
    });
    const bets = [];
    for (const event of events) {
        if (!event.markets || event.markets.length === 0)
            continue;
        const eventLiquidity = Number(event.liquidity || 0);
        const eventVolume24h = Number(event.volume24hr || 0);
        const eventSlug = event.slug || "";
        const eventCategory = event.category || "other";
        for (const market of event.markets) {
            const { yesPrice, noPrice } = resolveCurrentBinaryPrices(market, probabilityBetQuoteSnapshots);
            const marketLiquidity = Number(market.liquidity || eventLiquidity || 0);
            const marketVolume24h = Number(market.volume24hr || eventVolume24h || 0);
            const marketTitle = market.question || event.title || "Unknown";
            // Minimum liquidity check
            if (marketLiquidity < 5000)
                continue;
            if (yesPrice === null || noPrice === null || yesPrice <= 0)
                continue;
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
async function handleDiscoverTrendingMarkets(args) {
    const category = args?.category;
    const sortBy = args?.sortBy || "volume";
    const limit = Math.min(args?.limit || 20, 50);
    const categoryTagSlug = resolveDiscoveryCategoryTagSlug({ category });
    const cacheKey = getDiscoverTrendingCacheKey({ category, sortBy, limit });
    const cachedPayload = readDiscoverTrendingCachedPayload(cacheKey);
    if (cachedPayload) {
        return successResult(cachedPayload);
    }
    try {
        // Map sortBy to API order parameter - respect user's choice
        let orderParam;
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
        const fetchLimit = categoryTagSlug
            ? Math.min(Math.max(limit * 4, 28), 48)
            : Math.min(Math.max(limit * 3, 36), 72);
        const endpoint = `/events?active=true&closed=false&limit=${fetchLimit}&order=${orderParam}&ascending=false${categoryTagSlug ? `&tag_slug=${categoryTagSlug}` : ""}`;
        // Keep the trend snapshot fast enough that Query mode can recover from a
        // transient Gamma timeout without exhausting the full execution budget.
        let events = (await fetchGamma(endpoint, 8_000, 2));
        // Apply client-side category filtering if category is specified
        if (categoryTagSlug) {
            const filteredEvents = events.filter((event) => eventMatchesDiscoveryCategoryTagSlug(event, categoryTagSlug));
            if (filteredEvents.length > 0) {
                events = filteredEvents;
            }
        }
        const quoteSampleEvents = events.slice(0, Math.min(Math.max(limit * 2, 10), 20));
        const trendingQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(getRepresentativeGammaMarkets(quoteSampleEvents, {
            preference: "tradable",
        }), {
            timeoutMs: "default",
        });
        const trendingMarkets = [];
        const categoryBreakdown = {};
        const tagBreakdown = {};
        for (const event of events) {
            const market = getRepresentativeGammaMarket(event, {
                preference: "tradable",
            });
            if (!market)
                continue;
            const volume = Number(event.volume || market.volume || 0);
            const volume24h = Number(event.volume24hr || market.volume24hr || 0);
            const liquidity = Number(event.liquidity || market.liquidity || 0);
            // Skip low activity markets or near-resolved markets (for meaningful whale analysis)
            if (volume24h < 1000 || liquidity < 1000)
                continue;
            const yesPrice = resolveCurrentOutcomePrice(market, trendingQuoteSnapshots);
            // Skip near-resolved markets (>95% or <5%) - no meaningful position building
            if (yesPrice > 0.95 || yesPrice < 0.05) {
                continue; // Near-resolved, skip for whale analysis
            }
            // Calculate trend score (weighted)
            let trendScore = 0;
            // Volume weight
            if (volume24h > 100000)
                trendScore += 40;
            else if (volume24h > 50000)
                trendScore += 30;
            else if (volume24h > 10000)
                trendScore += 20;
            else if (volume24h > 1000)
                trendScore += 10;
            // Liquidity weight
            if (liquidity > 100000)
                trendScore += 30;
            else if (liquidity > 50000)
                trendScore += 20;
            else if (liquidity > 10000)
                trendScore += 10;
            // Volume relative to liquidity (high turnover = active trading)
            const volumeToLiquidity = liquidity > 0 ? volume24h / liquidity : 0;
            if (volumeToLiquidity > 0.5)
                trendScore += 20;
            else if (volumeToLiquidity > 0.2)
                trendScore += 10;
            // Volume change estimate (comparing 24h to average daily)
            const avgDailyVolume = volume > 0 ? volume / 30 : volume24h;
            const volumeVsAvg = avgDailyVolume > 0 ? volume24h / avgDailyVolume : 1;
            let volumeVsAverage;
            if (volumeVsAvg > 3) {
                volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average - SURGING`;
                trendScore += 25;
            }
            else if (volumeVsAvg > 2) {
                volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average - HIGH`;
                trendScore += 15;
            }
            else if (volumeVsAvg > 1.2) {
                volumeVsAverage = `${volumeVsAvg.toFixed(1)}x above average`;
                trendScore += 5;
            }
            else {
                volumeVsAverage = "Normal activity";
            }
            // Determine price direction signal
            let priceDirection;
            let signal;
            if (yesPrice > 0.85) {
                priceDirection = "Strong YES";
                signal = `YES favored at ${(yesPrice * 100).toFixed(0)}%`;
            }
            else if (yesPrice > 0.65) {
                priceDirection = "Leaning YES";
                signal = `Moderate YES at ${(yesPrice * 100).toFixed(0)}%`;
            }
            else if (yesPrice < 0.15) {
                priceDirection = "Strong NO";
                signal = `NO favored at ${((1 - yesPrice) * 100).toFixed(0)}%`;
            }
            else if (yesPrice < 0.35) {
                priceDirection = "Leaning NO";
                signal = `Moderate NO at ${((1 - yesPrice) * 100).toFixed(0)}%`;
            }
            else {
                priceDirection = "Contested";
                signal = `Toss-up at ${(yesPrice * 100).toFixed(0)}% YES`;
            }
            // Generate why trending explanation
            let whyTrending;
            if (volumeVsAvg > 2) {
                whyTrending = "Unusual volume spike - likely news event or price movement";
            }
            else if (volumeToLiquidity > 0.3) {
                whyTrending = "High turnover rate - active price discovery in progress";
            }
            else if (liquidity > 50000 && volume24h > 20000) {
                whyTrending = "Deep liquid market with sustained interest";
            }
            else {
                whyTrending = "Steady trading activity";
            }
            const cat = event.category ||
                event.tags?.[0]?.label ||
                event.tags?.[0]?.slug ||
                "other";
            categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + 1;
            for (const tag of event.tags || []) {
                const tagSlug = (tag.slug || "").trim();
                const tagLabel = (tag.label || tagSlug).trim();
                const key = (tagSlug || tagLabel).toLowerCase();
                if (key.length === 0) {
                    continue;
                }
                if (!tagBreakdown[key]) {
                    tagBreakdown[key] = {
                        label: tagLabel || tagSlug,
                        slug: tagSlug,
                        count: 0,
                    };
                }
                tagBreakdown[key].count += 1;
            }
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
        trendingMarkets.forEach((market, index) => {
            market.rank = index + 1;
        });
        const finalMarkets = trendingMarkets.slice(0, limit);
        const topTags = Object.values(tagBreakdown)
            .sort((a, b) => b.count - a.count)
            .slice(0, 10);
        const topLiquidMarketsByCategory = {};
        for (const market of [...finalMarkets].sort((a, b) => b.liquidity - a.liquidity)) {
            const key = market.category || "other";
            if (!topLiquidMarketsByCategory[key]) {
                topLiquidMarketsByCategory[key] = [];
            }
            if (topLiquidMarketsByCategory[key].length >= 3) {
                continue;
            }
            topLiquidMarketsByCategory[key].push({
                title: market.title,
                url: market.url,
                slug: market.slug,
                conditionId: market.conditionId,
                liquidity: market.liquidity,
                volume24h: market.volume24h,
            });
        }
        // Generate market summary
        const surgingCount = finalMarkets.filter((market) => market.volumeVsAverage.includes("SURGING")).length;
        const contestedCount = finalMarkets.filter((market) => market.priceDirection === "Contested").length;
        let marketSummary;
        if (surgingCount > 3) {
            marketSummary = `🔥 Active day across the sampled live set: ${surgingCount} markets show surging volume. News events are likely driving activity.`;
        }
        else if (contestedCount > 5) {
            marketSummary = `⚖️ Many contested markets in the sampled live set. Good opportunities for traders with information edge.`;
        }
        else if (finalMarkets.length > 0) {
            marketSummary = `📊 Normal market conditions across the sampled live set. ${finalMarkets.length} active markets identified.`;
        }
        else {
            marketSummary = "😴 Low market activity. Consider checking back during US market hours.";
        }
        const response = {
            marketSummary,
            trendingMarkets: finalMarkets,
            categories: categoryBreakdown,
            topTags,
            topLiquidMarketsByCategory,
            totalActive: events.length,
            hotnessMethodology: "Per-market trendScore blends: 24h volume tier (up to 40 pts), liquidity tier (up to 30 pts), volume÷liquidity turnover bonus (up to 20 pts), and 24h volume vs ~30d average multiple (up to 25 pts). topTags counts how often each tag appears on sampled active events — not a separate proprietary index.",
            fetchedAt: new Date().toISOString(),
        };
        writeDiscoverTrendingCachedPayload(cacheKey, response);
        return successResult(response);
    }
    catch (error) {
        const stalePayload = readDiscoverTrendingCachedPayload(cacheKey, {
            allowStaleOnError: true,
        });
        if (stalePayload) {
            console.warn("[discover_trending_markets] serving stale cached snapshot", {
                category,
                sortBy,
                limit,
                error: error instanceof Error ? error.message : String(error),
            });
            return successResult(stalePayload);
        }
        throw error;
    }
}
/**
 * Get top markets sorted by volume, liquidity, etc. - mirrors Polymarket UI filters
 * This is the GO-TO tool for "highest volume markets" type questions.
 */
async function handleGetTopMarkets(args) {
    const sortBy = args?.sortBy || "total_volume"; // Default to total volume (biggest markets)
    const category = args?.category;
    let minTotalVolume = args?.minTotalVolume;
    let maxTotalVolume = args?.maxTotalVolume;
    let minLiquidity = args?.minLiquidity;
    // Sanitize numeric range filters before they hit GAMMA. The /events endpoint returns
    // 422 "error validating query argument \"volume\": invalid range" whenever min >= max
    // (e.g. minTotalVolume=0 + maxTotalVolume=0, an LLM sentinel pattern). Treat values <= 0
    // as "no filter" (no real Polymarket market has volume/liquidity <= 0) and collapse
    // inverted ranges by dropping the broken upper bound, preserving the more-informative
    // lower bound. Without this, get_top_markets propagates a hard 422 and the planner
    // silently falls back to discover_trending_markets, returning a less-relevant list.
    const sanitizeNotes = [];
    if (typeof minTotalVolume === "number" &&
        (!Number.isFinite(minTotalVolume) || minTotalVolume <= 0)) {
        sanitizeNotes.push(`minTotalVolume=${minTotalVolume} dropped (<=0 sentinel)`);
        minTotalVolume = undefined;
    }
    if (typeof maxTotalVolume === "number" &&
        (!Number.isFinite(maxTotalVolume) || maxTotalVolume <= 0)) {
        sanitizeNotes.push(`maxTotalVolume=${maxTotalVolume} dropped (<=0 sentinel)`);
        maxTotalVolume = undefined;
    }
    if (typeof minLiquidity === "number" &&
        (!Number.isFinite(minLiquidity) || minLiquidity <= 0)) {
        sanitizeNotes.push(`minLiquidity=${minLiquidity} dropped (<=0 sentinel)`);
        minLiquidity = undefined;
    }
    if (typeof minTotalVolume === "number" &&
        typeof maxTotalVolume === "number" &&
        minTotalVolume >= maxTotalVolume) {
        sanitizeNotes.push(`maxTotalVolume=${maxTotalVolume} dropped (<= minTotalVolume=${minTotalVolume}, inverted range)`);
        maxTotalVolume = undefined;
    }
    if (sanitizeNotes.length > 0) {
        console.warn("[get_top_markets] sanitized inputs", { notes: sanitizeNotes });
    }
    const endDateBefore = args?.endDateBefore;
    const endDateAfter = args?.endDateAfter;
    const includeNearResolved = args?.includeNearResolved ?? false;
    const includeEnded = args?.includeEnded ?? false;
    const offset = Math.max(args?.offset || 0, 0);
    const limit = Math.min(Math.max(args?.limit || 15, 1), 100);
    const nowMs = Date.now();
    const categoryLower = category?.toLowerCase().trim();
    const categoryTagSlug = resolveDiscoveryCategoryTagSlug({ category });
    // Map sortBy to API order parameter
    let orderParam;
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
    const markets = [];
    const seenMarketKeys = new Set();
    const hasStrongServerFilters = minTotalVolume !== undefined ||
        maxTotalVolume !== undefined ||
        minLiquidity !== undefined ||
        endDateBefore !== undefined ||
        endDateAfter !== undefined;
    const pageSize = category
        ? hasStrongServerFilters
            ? Math.min(Math.max(limit * 2, 12), 24)
            : Math.min(Math.max(limit * 3, 15), 30)
        : Math.min(Math.max(limit * 2, 20), 100);
    const maxPagesToScan = category ? 2 : 4;
    const categoryAliases = {
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
    let effectiveIncludeNearResolved = includeNearResolved;
    let usedNearResolvedFallback = false;
    let lastRawBatchSize = 0;
    let pagesScanned = 0;
    let finalScanOffset = offset;
    while (true) {
        markets.length = 0;
        seenMarketKeys.clear();
        let scanOffset = offset;
        pagesScanned = 0;
        lastRawBatchSize = 0;
        const currentMaxPagesToScan = effectiveIncludeNearResolved && (categoryTagSlug || categoryMatchers.length > 0)
            ? Math.max(maxPagesToScan, 5)
            : maxPagesToScan;
        while (pagesScanned < currentMaxPagesToScan && markets.length < limit) {
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
            if (categoryTagSlug) {
                endpoint += `&tag_slug=${categoryTagSlug}`;
            }
            let rawEvents;
            try {
                rawEvents = (await fetchGamma(endpoint, 10000, 2));
            }
            catch (error) {
                // Belt-and-suspenders: even after input sanitization, GAMMA can still return
                // 422 if the API ever tightens validation on a different argument. Salvage
                // the call by retrying once without the volume/liquidity range filters
                // (the only fields here that produce "invalid range" errors). Returning a
                // ranked list is strictly better than propagating a hard error, which
                // causes the planner to fall back to discover_trending_markets.
                if (error instanceof UpstreamHttpError && error.status === 422) {
                    let salvageEndpoint = `/events?active=true&closed=false&limit=${pageSize}` +
                        `&offset=${scanOffset}&order=${orderParam}&ascending=${ascending}`;
                    if (endDateBefore) {
                        salvageEndpoint += `&end_date_max=${endDateBefore}`;
                    }
                    if (endDateAfter) {
                        salvageEndpoint += `&end_date_min=${endDateAfter}`;
                    }
                    if (categoryTagSlug) {
                        salvageEndpoint += `&tag_slug=${categoryTagSlug}`;
                    }
                    console.warn("[get_top_markets] gamma_422_salvage_retry", {
                        originalEndpoint: endpoint.slice(0, 200),
                        salvageEndpoint: salvageEndpoint.slice(0, 200),
                        droppedFilters: { minTotalVolume, maxTotalVolume, minLiquidity },
                    });
                    rawEvents = (await fetchGamma(salvageEndpoint, 10000, 2));
                }
                else {
                    throw error;
                }
            }
            pagesScanned += 1;
            lastRawBatchSize = rawEvents.length;
            if (rawEvents.length === 0) {
                break;
            }
            const events = categoryTagSlug
                ? (() => {
                    const filteredEvents = rawEvents.filter((event) => eventMatchesDiscoveryCategoryTagSlug(event, categoryTagSlug));
                    return filteredEvents.length > 0 ? filteredEvents : rawEvents;
                })()
                : rawEvents;
            const topMarketQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(getRepresentativeGammaMarkets(events.slice(0, Math.min(Math.max(limit * 2, 10), 20)), {
                preference: "tradable",
            }), {
                timeoutMs: "default",
            });
            for (const event of events) {
                if (categoryMatchers.length > 0) {
                    const normalizedCategory = (event.category || "").toLowerCase();
                    const hasCategoryMatch = categoryMatchers.some((matcher) => normalizedCategory.includes(matcher)) ||
                        (event.tags || []).some((tag) => {
                            const tagSlug = (tag.slug || "").toLowerCase();
                            const tagLabel = (tag.label || "").toLowerCase();
                            return categoryMatchers.some((matcher) => tagSlug === matcher ||
                                tagLabel === matcher ||
                                tagSlug.includes(matcher) ||
                                tagLabel.includes(matcher));
                        });
                    if (!hasCategoryMatch) {
                        continue;
                    }
                }
                const market = selectMarketForTopMarkets(event, sortBy) ??
                    getRepresentativeGammaMarket(event, {
                        preference: "tradable",
                    });
                if (!market)
                    continue;
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
                const yesPrice = resolveCurrentOutcomePrice(market, topMarketQuoteSnapshots);
                if (!effectiveIncludeNearResolved &&
                    (yesPrice > 0.95 || yesPrice < 0.05)) {
                    continue;
                }
                // For competitive sort, only include markets between 35-65%
                if (sortBy === "competitive" && (yesPrice < 0.35 || yesPrice > 0.65))
                    continue;
                const eventSlug = event.slug || "";
                const conditionId = market.conditionId || event.id || "";
                const [yesTokenId, noTokenId] = extractGammaMarketTokenIds(market);
                const dedupeKey = conditionId ||
                    `${eventSlug}:${market.question || market.title || event.title || "unknown"}`;
                if (seenMarketKeys.has(dedupeKey)) {
                    continue;
                }
                seenMarketKeys.add(dedupeKey);
                const normalizedCategoryForOutput = categoryLower && categoryLower.length > 0
                    ? categoryLower
                    : (event.category || "other");
                // ALWAYS provide a URL - use slug if available, otherwise construct from conditionId
                const url = eventSlug
                    ? `https://polymarket.com/event/${eventSlug}`
                    : (conditionId ? `https://polymarket.com/event/${conditionId}` : "");
                markets.push({
                    rank: 0,
                    pageRank: 0,
                    title: market.question || market.title || event.title || "Unknown",
                    eventTitle: event.title || market.title || market.question || "Unknown",
                    eventId: event.id !== undefined && event.id !== null ? String(event.id) : "",
                    url,
                    slug: eventSlug,
                    conditionId,
                    yesTokenId,
                    noTokenId,
                    currentPrice: yesPrice,
                    yesPrice,
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
            scanOffset += rawEvents.length;
            finalScanOffset = scanOffset;
            // Fewer rows than requested means we've exhausted this sorted slice.
            if (rawEvents.length < pageSize) {
                break;
            }
        }
        if (markets.length > 0 ||
            usedNearResolvedFallback ||
            effectiveIncludeNearResolved ||
            (!categoryTagSlug && categoryMatchers.length === 0)) {
            break;
        }
        effectiveIncludeNearResolved = true;
        usedNearResolvedFallback = true;
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
        m.pageRank = idx + 1;
        m.rank = offset + idx + 1;
    });
    // Generate summary based on sortBy
    const topTotalVol = finalMarkets[0]?.totalVolume || 0;
    const topVol24h = finalMarkets[0]?.volume24h || 0;
    const combinedTotalVol = finalMarkets.reduce((sum, m) => sum + m.totalVolume, 0);
    // Format volume as human-readable (e.g., $507M, $6.2M)
    const formatVol = (v) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(1)}M`;
    let summary;
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
    if (usedNearResolvedFallback) {
        summary += " Category fallback included near-resolved live markets because the strict live screen returned no matches.";
    }
    // Add pagination info
    const paginationInfo = offset > 0 ? ` (showing results ${offset + 1}-${offset + finalMarkets.length})` : "";
    const hasMore = lastRawBatchSize === pageSize;
    const paginationGuidance = offset === 0
        ? "For highest/top/biggest matching-market questions, use markets[0] from this first page; do not call later offsets unless the user asked for more results or a deeper audit."
        : "This is a deeper page. Do not treat pageRank=1 as the overall top market; compare rank/global position before using it as a highest-volume result.";
    return successResult({
        sortedBy: sortBy,
        markets: finalMarkets,
        summary: summary + paginationInfo,
        paginationGuidance,
        pagination: {
            offset,
            returned: finalMarkets.length,
            hasMore,
            nextOffset: finalScanOffset,
            scannedToOffset: finalScanOffset,
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
            includeNearResolved: effectiveIncludeNearResolved,
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
async function handleAnalyzeMyPositions(args) {
    const portfolio = args?.portfolio;
    const focusMarket = args?.focus_market;
    if (!portfolio || !portfolio.positions) {
        return errorResult("Portfolio context is required. The Context app should inject this automatically.");
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
        ? portfolio.positions.filter((p) => p.conditionId === focusMarket)
        : portfolio.positions;
    const positionAnalyses = [];
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
            const liquidityData = JSON.parse(liquidityResult.content[0].text);
            const currentPrice = liquidityData.currentPrice || position.avgEntryPrice;
            const positionValue = position.shares * currentPrice;
            const costBasis = position.shares * position.avgEntryPrice;
            const unrealizedPnL = positionValue - costBasis;
            const unrealizedPnLPercent = costBasis > 0 ? (unrealizedPnL / costBasis) * 100 : 0;
            // Simulate exit for this specific position size
            const exitSimulation = simulatePositionExit(liquidityData.whaleCost, positionValue);
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
        }
        catch (error) {
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
    const totalCostBasis = positionAnalyses.reduce((sum, p) => sum + p.shares * p.avgEntryPrice, 0);
    const totalUnrealizedPnLPercent = totalCostBasis > 0 ? (totalUnrealizedPnL / totalCostBasis) * 100 : 0;
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
function simulatePositionExit(whaleCost, positionValue) {
    if (!whaleCost) {
        return { slippage: 0 };
    }
    // Interpolate slippage based on position size
    if (positionValue <= 1000) {
        return { slippage: Number(whaleCost.sell1k?.slippagePercent || 0) };
    }
    else if (positionValue <= 5000) {
        return { slippage: Number(whaleCost.sell5k?.slippagePercent || 0) };
    }
    else {
        return { slippage: Number(whaleCost.sell10k?.slippagePercent || 0) };
    }
}
/**
 * Helper: Generate recommendation for a single position
 */
function generatePositionRecommendation(params) {
    const { unrealizedPnLPercent, currentPrice, liquidityScore, canExitCleanly, slippage } = params;
    const parts = [];
    // P&L commentary
    if (unrealizedPnLPercent > 50) {
        parts.push("🎉 Strong gains! Consider taking some profit.");
    }
    else if (unrealizedPnLPercent > 20) {
        parts.push("📈 Position is profitable.");
    }
    else if (unrealizedPnLPercent < -20) {
        parts.push("📉 Position underwater. Evaluate if thesis still holds.");
    }
    // Price commentary
    if (currentPrice > 0.9) {
        parts.push("Price near max - limited upside remaining.");
    }
    else if (currentPrice < 0.1) {
        parts.push("Price near floor - high risk/reward if thesis is correct.");
    }
    // Liquidity commentary
    if (!canExitCleanly) {
        parts.push(`⚠️ Exit liquidity is ${liquidityScore}. Expect ~${slippage.toFixed(1)}% slippage on exit.`);
    }
    else if (liquidityScore === "excellent" || liquidityScore === "good") {
        parts.push("✅ Good exit liquidity available.");
    }
    return parts.length > 0 ? parts.join(" ") : "No specific recommendations.";
}
/**
 * Helper: Generate overall portfolio recommendation
 */
function generateOverallRecommendation(params) {
    const { totalPositions, totalUnrealizedPnLPercent, riskyPositions, positionAnalyses } = params;
    const parts = [];
    // Overall P&L
    if (totalUnrealizedPnLPercent > 30) {
        parts.push(`Portfolio up ${totalUnrealizedPnLPercent.toFixed(1)}% overall. Strong performance!`);
    }
    else if (totalUnrealizedPnLPercent < -20) {
        parts.push(`Portfolio down ${Math.abs(totalUnrealizedPnLPercent).toFixed(1)}%. Review positions carefully.`);
    }
    else {
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
        }
        else if (yesPercent < 20) {
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
async function handlePlacePolymarketOrder(args) {
    const conditionId = args?.conditionId;
    const slug = args?.slug;
    const outcome = args?.outcome;
    const side = args?.side;
    const amount = args?.amount;
    const price = args?.price;
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
    let marketData;
    if (!marketConditionId && slug) {
        try {
            marketData = await fetchGamma(`/events/slug/${slug}`);
            const representativeMarket = getRepresentativeGammaMarket(marketData, {
                preference: "tradable",
            });
            marketConditionId = representativeMarket?.conditionId;
        }
        catch {
            return errorResult(`Market not found for slug: ${slug}`);
        }
    }
    if (!marketConditionId) {
        return errorResult("Either conditionId or slug is required to identify the market");
    }
    // Fetch market details from CLOB
    let clobMarket;
    try {
        clobMarket = await fetchClob(`/markets/${marketConditionId}`);
    }
    catch {
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
            const gammaMarkets = await fetchGamma(`/markets?condition_ids=${marketConditionId}&limit=1`, 5000);
            if (Array.isArray(gammaMarkets) && gammaMarkets.length > 0) {
                // Create a minimal event-like object with the market data
                marketData = { title: gammaMarkets[0].question, slug: gammaMarkets[0].slug };
            }
        }
        catch {
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
        const orderbook = await fetchClob(`/book?token_id=${tokenId}`);
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
            }
            else {
                suggestedPrice = Math.max(currentBestBid * 0.98, 0.01);
            }
        }
    }
    catch (error) {
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
function extractKeywords(text) {
    const stopWords = new Set([
        'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is',
        'will', 'be', 'by', 'this', 'that', 'it', 'with', 'from', 'as', 'are',
        'was', 'were', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'but',
        'if', 'than', 'so', 'what', 'which', 'who', 'whom', 'when', 'where', 'why',
        'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other',
        'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'too', 'very',
        'can', 'just', 'should', 'now', 'before', 'after', 'during', 'while',
        'market', 'markets', 'price', 'prices', 'current', 'today', 'live',
        'win', 'wins', 'winner', 'winners', 'final', 'finals', 'champion',
        'championship', 'control', 'party', 'vote', 'votes',
    ]);
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 &&
        !stopWords.has(word) &&
        !/^\d+$/.test(word))
        .slice(0, 15); // Limit to 15 keywords
}
/**
 * Extract team names from sports-related text
 */
function extractTeams(text) {
    const teams = [];
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
function categorizeMarket(title, category) {
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
function extractKalshiOutcomeMeanings(rules, marketTitle) {
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
function buildKalshiSearchQueries(params) {
    const queries = new Set();
    const title = params.title?.trim() || "";
    const keywords = params.keywords?.trim() || "";
    const slugKeywords = params.polymarketSlug
        ? params.polymarketSlug
            .split("-")
            .map((part) => part.trim())
            .filter((part) => part.length > 2)
        : [];
    if (keywords) {
        queries.add(keywords);
    }
    if (title) {
        const keywordQuery = [...extractKeywords(title), ...slugKeywords]
            .slice(0, 8)
            .join(" ");
        if (keywordQuery) {
            queries.add(keywordQuery);
        }
        const normalizedTitle = normalizeMarketQueryText(title);
        const year = title.match(/\b20\d{2}\b/)?.[0];
        if (normalizedTitle.includes("presidential election")) {
            queries.add(year ? `presidential election ${year}` : "presidential election");
            queries.add(year ? `white house ${year}` : "white house");
        }
        if (normalizedTitle.includes("election")) {
            queries.add(year ? `election ${year}` : "election");
        }
        if (normalizedTitle.includes("senate")) {
            queries.add(year ? `senate ${year}` : "senate");
        }
    }
    return [...queries]
        .map((query) => query.replace(/\s+/g, " ").trim())
        .filter((query, index, all) => query.length > 0 && all.indexOf(query) === index);
}
// Cross-platform search on Kalshi
async function handleSearchOnKalshi(args) {
    let title = typeof args?.title === "string" ? args.title.trim() : "";
    let keywords = typeof args?.keywords === "string" ? args.keywords.trim() : "";
    let polymarketSlug = typeof args?.polymarketSlug === "string" ? args.polymarketSlug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    const limit = Math.min(args?.limit || 10, 25);
    let resolvedPolymarket = null;
    const genericMarketQuery = title.length === 0 &&
        marketQuery.length > 0 &&
        isGenericMarketReferenceQuery(marketQuery);
    if (title.length === 0 && marketQuery.length > 0) {
        const resolvedFromQuery = genericMarketQuery
            ? null
            : await resolveMarketReference({ marketQuery });
        if (resolvedFromQuery) {
            resolvedPolymarket = resolvedFromQuery;
            title = resolvedFromQuery.marketTitle;
            keywords = keywords || resolvedFromQuery.marketTitle;
            polymarketSlug = polymarketSlug || resolvedFromQuery.slug || "";
        }
        else {
            const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                sortBy: "volume",
                preferSingleOutcome: true,
            });
            if (fallbackCandidate) {
                title = fallbackCandidate.title || fallbackCandidate.eventTitle;
                keywords = keywords || title;
                polymarketSlug = polymarketSlug || fallbackCandidate.slug;
            }
        }
    }
    if (title.length === 0 && marketQuery.length === 0) {
        const fallbackCandidate = await resolveFallbackTopMarketCandidate({
            sortBy: "volume",
            preferSingleOutcome: true,
        });
        if (fallbackCandidate) {
            title = fallbackCandidate.title || fallbackCandidate.eventTitle;
            keywords = keywords || title;
            polymarketSlug = polymarketSlug || fallbackCandidate.slug;
        }
    }
    if (!resolvedPolymarket) {
        resolvedPolymarket = await resolveMarketReference({
            slug: polymarketSlug || undefined,
            marketQuery: title || undefined,
        });
    }
    const searchQueries = buildKalshiSearchQueries({
        title: title || undefined,
        keywords: keywords || undefined,
        polymarketSlug: polymarketSlug || undefined,
    });
    const searchQuery = searchQueries[0] || "";
    if (!searchQuery || searchQueries.length === 0) {
        return errorResult("Either 'title' or 'keywords' is required to search Kalshi.");
    }
    try {
        const fetchKalshiJson = async (url, timeoutMs = 8000) => {
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
                return (await response.json());
            }
            finally {
                clearTimeout(timeoutId);
            }
        };
        // Note: Kalshi API doesn't support server-side text search, so we fetch markets and filter client-side.
        // Try both known hosts; deployments can differ by region/environment.
        const marketFetchLimit = Math.min(Math.max(limit * 20, 120), 200);
        const kalshiUrls = [
            `https://api.elections.kalshi.com/trade-api/v2/markets?limit=${marketFetchLimit}&status=open`,
            `https://api.kalshi.com/trade-api/v2/markets?limit=${marketFetchLimit}&status=open`,
        ];
        const sourcesTried = [];
        let data = null;
        for (const kalshiUrl of kalshiUrls) {
            sourcesTried.push(kalshiUrl.includes("api.elections.kalshi.com") ? "api.elections.kalshi.com" : "api.kalshi.com");
            try {
                data = await fetchKalshiJson(kalshiUrl, 8000);
                if (Array.isArray(data?.markets)) {
                    break;
                }
            }
            catch {
                // Try next host.
            }
        }
        if (!data || !Array.isArray(data.markets)) {
            return successResult({
                searchedFor: {
                    keywords: searchQuery,
                    polymarketSlug: polymarketSlug || "",
                },
                kalshiResults: [],
                hint: "Kalshi lookup is temporarily unavailable. Try again shortly or refine keywords.",
                comparisonNote: "",
                searchExhausted: true,
                noResultsReason: "kalshi_unavailable",
                sourcesTried,
                fetchedAt: new Date().toISOString(),
            });
        }
        const markets = data.markets || [];
        // Score and filter results based on keyword matching
        const queryContexts = searchQueries.map((query) => ({
            normalized: normalizeMarketQueryText(query),
            words: Array.from(new Set(query
                .toLowerCase()
                .split(/\s+/)
                .filter((word) => word.length > 2))),
        }));
        const scoredResults = markets.map(market => {
            const marketTitle = market.title || market.yes_sub_title || market.ticker;
            const searchText = normalizeMarketQueryText(`${marketTitle} ${market.subtitle || ""} ${market.event_ticker || ""} ${market.ticker || ""}`);
            let matchScore = 0;
            for (const context of queryContexts) {
                if (context.words.length === 0) {
                    continue;
                }
                let matchCount = 0;
                for (const word of context.words) {
                    if (searchText.includes(word)) {
                        matchCount++;
                    }
                }
                const queryWordSet = new Set(context.words);
                const titleWordSet = new Set(searchText.split(/\s+/).filter((word) => word.length > 2));
                const exactOverlap = Array.from(titleWordSet).filter((word) => queryWordSet.has(word)).length;
                const titlePhraseBonus = context.normalized.length > 0 &&
                    (searchText.includes(context.normalized) ||
                        context.normalized.includes(searchText))
                    ? 0.35
                    : 0;
                const score = Math.min(1, matchCount / context.words.length +
                    titlePhraseBonus +
                    Math.min(exactOverlap, 4) * 0.08);
                if (score > matchScore) {
                    matchScore = score;
                }
            }
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
                noOutcomeMeans: '', // Will be computed after fetching rules
            };
        })
            .filter(r => r.matchScore > 0.25)
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
                    const marketData = await fetchKalshiJson(marketUrl, 5000);
                    const rules = marketData.market?.rules_secondary || marketData.market?.rules_primary || '';
                    result.rules = rules;
                    // Extract outcome meanings
                    const { yesOutcomeMeans, noOutcomeMeans } = extractKalshiOutcomeMeanings(rules, result.title);
                    result.yesOutcomeMeans = yesOutcomeMeans;
                    result.noOutcomeMeans = noOutcomeMeans;
                }
                catch {
                    const fallbackUrl = `https://api.kalshi.com/trade-api/v2/markets/${result.ticker}`;
                    sourcesTried.push("api.kalshi.com");
                    const marketData = await fetchKalshiJson(fallbackUrl, 5000);
                    const rules = marketData.market?.rules_secondary || marketData.market?.rules_primary || "";
                    result.rules = rules;
                    const { yesOutcomeMeans, noOutcomeMeans } = extractKalshiOutcomeMeanings(rules, result.title);
                    result.yesOutcomeMeans = yesOutcomeMeans;
                    result.noOutcomeMeans = noOutcomeMeans;
                }
            }
            catch {
                // Ignore individual fetch failures
            }
        }));
        const hint = scoredResults.length > 0
            ? `Found ${scoredResults.length} potential matches on Kalshi. ⚠️ CRITICAL: Check 'yesOutcomeMeans' and 'noOutcomeMeans' to ensure you're comparing equivalent outcomes!`
            : `No strong matches found on Kalshi for "${searchQuery}". Try broader election keywords. Note: Kalshi has NO sports markets.`;
        // Build comparison guidance
        const comparisonNote = scoredResults.length > 0
            ? `⚠️ CROSS-PLATFORM COMPARISON GUIDE:
1. Kalshi prices are in cents (29 = 29%), Polymarket prices are decimals (0.29 = 29%)
2. READ 'yesOutcomeMeans' for each market - they may be INVERTED!
3. Example: If Kalshi YES means "Court rules IN FAVOR" and Polymarket YES means "Court rules AGAINST", then Kalshi YES ≈ Polymarket NO
4. Only compare prices AFTER confirming outcomes align!`
            : null;
        let polymarketMarket = null;
        if (resolvedPolymarket) {
            try {
                const [efficiencyData, rulesData] = await Promise.all([
                    workflowExtractToolData(await handleCheckMarketEfficiency({
                        conditionId: resolvedPolymarket.conditionId,
                        slug: resolvedPolymarket.slug || undefined,
                    }), "check_market_efficiency"),
                    workflowExtractToolData(await handleCheckMarketRules({
                        conditionId: resolvedPolymarket.conditionId,
                        slug: resolvedPolymarket.slug || undefined,
                    }), "check_market_rules"),
                ]);
                const yesOutcome = workflowObjectArray(efficiencyData.outcomes).find((outcome) => typeof outcome.name === "string" &&
                    outcome.name.toUpperCase() === "YES");
                const rulesSummary = workflowObject(rulesData.rulesSummary);
                polymarketMarket = {
                    title: resolvedPolymarket.marketTitle,
                    slug: resolvedPolymarket.slug || polymarketSlug || "",
                    conditionId: resolvedPolymarket.conditionId,
                    url: getPolymarketUrl(resolvedPolymarket.slug || polymarketSlug, resolvedPolymarket.conditionId),
                    currentYesPrice: workflowToNumber(yesOutcome?.price, 0),
                    resolutionSource: typeof rulesData.resolutionSource === "string"
                        ? rulesData.resolutionSource
                        : "",
                    resolvesYesIf: typeof rulesSummary.resolvesYesIf === "string"
                        ? rulesSummary.resolvesYesIf
                        : "",
                };
            }
            catch {
                polymarketMarket = {
                    title: resolvedPolymarket.marketTitle,
                    slug: resolvedPolymarket.slug || polymarketSlug || "",
                    conditionId: resolvedPolymarket.conditionId,
                    url: getPolymarketUrl(resolvedPolymarket.slug || polymarketSlug, resolvedPolymarket.conditionId),
                    currentYesPrice: 0,
                    resolutionSource: "",
                    resolvesYesIf: "",
                };
            }
        }
        return successResult({
            searchedFor: {
                title: title || "",
                keywords: searchQuery,
                polymarketSlug: polymarketSlug || "",
            },
            polymarketMarket,
            kalshiResults: scoredResults,
            hint,
            comparisonNote: comparisonNote || "",
            searchExhausted: scoredResults.length === 0,
            noResultsReason: scoredResults.length === 0 ? "no_kalshi_match_found" : "",
            sourcesTried: [...new Set(sourcesTried)],
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to search Kalshi: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}
// ============================================================================
// TIER 2: RAW DATA TOOL HANDLERS
// ============================================================================
async function handleGetEvents(args) {
    const active = args?.active !== false;
    const closed = args?.closed === true;
    const limit = Math.min(args?.limit || 50, 100);
    const offset = args?.offset || 0;
    const endpoint = `/events?closed=${closed}&limit=${limit}&offset=${offset}&order=id&ascending=false`;
    const events = (await fetchGamma(endpoint, 10000));
    const filteredEvents = active ? events.filter((e) => e.active !== false) : events;
    const simplified = filteredEvents
        .filter((e) => e.slug) // Only include events with valid slugs (for URL generation)
        .map((e) => ({
        id: e.id,
        title: e.title,
        url: `https://polymarket.com/event/${e.slug}`, // Always include URL
        slug: e.slug,
        category: e.category,
        volume: Number(e.volume || 0),
        liquidity: Number(e.liquidity || 0),
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
async function handleGetEventBySlug(args) {
    const slug = args?.slug;
    if (!slug) {
        return errorResult("slug is required");
    }
    const event = (await fetchGamma(`/events/slug/${slug}`));
    if (!event) {
        return errorResult(`Event not found: ${slug}`);
    }
    const marketQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(event.markets || [], {
        includeNoTokens: true,
        timeoutMs: "heavy",
    });
    // Transform markets to include tokens array in the expected format
    const markets = (event.markets || []).map((m) => {
        const yesTokenId = extractGammaYesTokenId(m);
        const noTokenId = extractGammaNoTokenId(m);
        const { yesPrice, noPrice } = resolveCurrentBinaryPrices(m, marketQuoteSnapshots);
        const safeYesPrice = yesPrice ?? 0.5;
        const safeNoPrice = noPrice ?? 0.5;
        // Build tokens array - use token_id (not id) to match schema
        const tokens = [];
        if (yesTokenId) {
            tokens.push({ token_id: yesTokenId, outcome: "Yes" });
        }
        if (noTokenId) {
            tokens.push({ token_id: noTokenId, outcome: "No" });
        }
        return {
            conditionId: m.conditionId,
            question: m.question,
            outcomePrices: [safeYesPrice, safeNoPrice],
            volume: Number(m.volume || 0),
            liquidity: Number(m.liquidity || 0),
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
            volume: Number(event.volume || 0),
            liquidity: Number(event.liquidity || 0),
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
 * Uses Polymarket's website-backed /search-v2 endpoint first, then local
 * reranking and fallbacks if needed.
 */
async function handleSearchAndGetOutcomes(args) {
    const query = args?.query;
    const category = args?.category;
    const includeInactiveExplicit = args?.includeInactive === true;
    const sortByRaw = typeof args?.sortBy === "string" ? args.sortBy : "volume";
    const sortBy = sortByRaw === "price" || sortByRaw === "name" ? sortByRaw : "volume";
    if (!query) {
        return errorResult("query is required - provide a search term like 'NBA Champion' or 'Super Bowl Winner'");
    }
    try {
        const eventSearchSeed = deriveEventSearchQuery(query);
        const searchQuery = eventSearchSeed
            .replace(/[.]{3,}/g, " ")
            .replace(/[?]+$/g, "")
            .replace(/\s+/g, " ")
            .trim() || query;
        const normalizedQuery = normalizeMarketQueryText(searchQuery);
        const headToHeadSides = workflowExtractHeadToHeadSides(searchQuery);
        const wantsOutcomeStateView = /\b(expired|future buckets?|still live|remaining live|after the expired dates?)\b/i.test(query);
        const wantsResolvedOutcomeLookup = /^will\s+.+?\s+win\s+on\s+\d{4}-\d{2}-\d{2}\??$/i.test(query.trim());
        const queryTokens = buildMarketQueryScoringTokens(searchQuery);
        const queryTargets = extractPriceTargets(searchQuery);
        const categoryTagSlug = resolveDiscoveryCategoryTagSlug({
            category,
            query: searchQuery,
        });
        let searchResults = [];
        let searchMethod = "website-search-v2";
        let bestSearchCandidate = null;
        try {
            const websiteSearch = await searchGammaWebsiteEventCandidates({
                query: searchQuery,
                category,
                limit: 24,
                eventsStatus: "active",
            });
            if (websiteSearch.candidates.length > 0) {
                const topCandidates = pickTopIndexedCandidatesByEvent(websiteSearch.candidates, 12);
                searchResults = topCandidates.map((candidate) => candidate.event);
                bestSearchCandidate = topCandidates[0] ?? null;
                searchMethod = websiteSearch.source;
            }
        }
        catch (err) {
            console.error("Website-backed search failed, falling back:", err);
        }
        try {
            if (searchResults.length === 0) {
                const indexedSearch = await searchIndexedActiveEventCandidates({
                    query: searchQuery,
                    category,
                    limit: 24,
                });
                if (indexedSearch.candidates.length > 0) {
                    const topCandidates = pickTopIndexedCandidatesByEvent(indexedSearch.candidates, 12);
                    searchResults = topCandidates.map((candidate) => candidate.event);
                    bestSearchCandidate = topCandidates[0] ?? null;
                    searchMethod = indexedSearch.source;
                }
            }
        }
        catch (err) {
            console.error("Active events index search failed, falling back:", err);
        }
        // FALLBACK 1: Use /public-search endpoint for server-side text search.
        try {
            if (searchResults.length === 0) {
                const searchEvents = await searchGammaEventsByVariants({
                    query: searchQuery,
                    limitPerType: 12,
                    eventsStatus: "active",
                });
                if (searchEvents.length > 0) {
                    searchResults = searchEvents;
                    searchMethod = "public-search";
                }
            }
        }
        catch (err) {
            console.error('Public search failed, falling back to events listing:', err);
        }
        // FALLBACK 2: Use /events endpoint with client-side filtering if search fails
        if (searchResults.length === 0) {
            searchMethod = "events-fallback";
            const eventParams = new URLSearchParams({
                active: "true",
                closed: "false",
                limit: "30",
            });
            if (categoryTagSlug) {
                eventParams.set("tag_slug", categoryTagSlug);
            }
            const events = (await fetchGamma(`/events?${eventParams.toString()}`));
            if (Array.isArray(events) && events.length > 0) {
                // Filter events by query terms client-side
                const queryTerms = searchQuery
                    .toLowerCase()
                    .split(/\s+/)
                    .filter((t) => t.length > 2);
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
        const scoredMatches = searchResults.map((result) => {
            const candidateText = [
                result.title || "",
                result.slug || "",
                ...(Array.isArray(result.markets)
                    ? result.markets.flatMap((market) => [
                        market.question || "",
                        market.title || "",
                    ])
                    : []),
            ].join(" ");
            const score = scoreMarketCandidate({
                queryText: normalizedQuery,
                queryTokens,
                queryTargets,
                candidateText,
            });
            return { result, score };
        });
        scoredMatches.sort((a, b) => b.score - a.score ||
            Number(b.result.volume || 0) - Number(a.result.volume || 0));
        const orderedSearchEntries = [];
        const seenCandidateIds = new Set();
        const pushOrderedSearchEntry = (entry) => {
            const candidateId = entry.event.slug ||
                entry.matchedMarket?.conditionId ||
                entry.event.conditionId ||
                entry.event.id ||
                normalizeMarketQueryText(entry.event.title || query);
            if (!candidateId || seenCandidateIds.has(candidateId)) {
                return;
            }
            seenCandidateIds.add(candidateId);
            orderedSearchEntries.push({
                candidateId,
                event: entry.event,
                score: entry.score,
                source: entry.source,
                matchedMarket: entry.matchedMarket,
            });
        };
        if (bestSearchCandidate) {
            pushOrderedSearchEntry({
                event: bestSearchCandidate.event,
                score: bestSearchCandidate.score,
                source: searchMethod,
                matchedMarket: bestSearchCandidate.market,
            });
        }
        for (const match of scoredMatches) {
            pushOrderedSearchEntry({
                event: match.result,
                score: match.score,
                source: searchMethod,
            });
        }
        const searchResolution = await resolvePolymarketContributorSearch({
            rawRequest: searchQuery,
            traceLabel: "polymarket:search_and_get_outcomes",
            instructions: "Pick the exact Polymarket market family the user is asking about before returning all its outcomes. Prefer direct ground-entry or invasion contracts over broader ceasefire, strike, or macro-risk proxies when the query is specifically about boots on the ground.",
            candidates: orderedSearchEntries.map((entry, index) => buildPolymarketEventSearchCandidate({
                query: searchQuery,
                rank: index + 1,
                source: entry.source,
                score: entry.score,
                event: entry.event,
                matchedMarket: entry.matchedMarket,
            })),
        });
        const resolvedCandidateId = searchResolution?.selectedCandidate?.candidateId ?? null;
        const resolvedSearchEntry = resolvedCandidateId === null
            ? null
            : orderedSearchEntries.find((entry) => entry.candidateId === resolvedCandidateId) ?? null;
        const bestMatch = resolvedSearchEntry?.event ??
            bestSearchCandidate?.event ??
            scoredMatches[0]?.result ??
            searchResults[0];
        const bestScore = resolvedSearchEntry?.score ??
            bestSearchCandidate?.score ??
            scoredMatches[0]?.score ??
            0;
        const matchConfidence = bestScore >= (queryTargets.length > 0 ? 140 : 90)
            ? "exact"
            : bestScore >= (queryTargets.length > 0 ? 100 : 55)
                ? "high"
                : bestScore >= (queryTargets.length > 0 ? 60 : 25)
                    ? "medium"
                    : "low";
        const slug = resolvedSearchEntry?.event.slug || bestMatch.slug;
        if (!slug) {
            return errorResult(`Found market "${bestMatch.title}" but it has no slug for fetching outcomes.`);
        }
        // Step 2: Fetch the event with all its outcomes if the indexed event payload
        // didn't already include them.
        let event = resolvedSearchEntry?.event ?? bestMatch;
        const shouldRefreshFullEvent = wantsOutcomeStateView ||
            headToHeadSides.length >= 2 ||
            !event ||
            !Array.isArray(event.markets) ||
            event.markets.length <= 1;
        if (shouldRefreshFullEvent) {
            event = (await fetchGamma(`/events/slug/${slug}`));
        }
        if (!event) {
            return errorResult(`Could not fetch event details for slug: ${slug}`);
        }
        const markets = event.markets || [];
        if (markets.length === 0) {
            return errorResult(`Event "${event.title}" has no markets/outcomes.`);
        }
        const { outcomes: eventOutcomeRows } = await buildEventOutcomeRows({
            event,
            includeInactive: includeInactiveExplicit ||
                wantsOutcomeStateView ||
                wantsResolvedOutcomeLookup,
        });
        const allOutcomes = eventOutcomeRows
            .map((row) => ({
            name: row.name,
            price: Number(row.price.toFixed(4)),
            currentPrice: Number(row.currentPrice.toFixed(4)),
            impliedProbability: row.impliedProbability,
            pricePercent: `${(row.price * 100).toFixed(1)}%`,
            volume: row.volume,
            conditionId: row.conditionId,
            tokenId: row.tokenId,
            active: row.active,
            closed: row.closed,
            endDate: row.endDate,
            dateStatus: row.dateStatus,
        }))
            .sort((left, right) => {
            if (sortBy === "name") {
                return left.name.localeCompare(right.name);
            }
            if (sortBy === "price") {
                if (right.price !== left.price) {
                    return right.price - left.price;
                }
                return right.volume - left.volume;
            }
            if (right.volume !== left.volume) {
                return right.volume - left.volume;
            }
            return right.price - left.price;
        });
        const liveOutcomes = allOutcomes.filter((outcome) => outcome.active);
        const expiredOutcomes = allOutcomes.filter((outcome) => outcome.dateStatus === "expired");
        const highestLiveOutcomeByPrice = liveOutcomes.length > 0
            ? [...liveOutcomes].sort((left, right) => {
                if (right.currentPrice !== left.currentPrice) {
                    return right.currentPrice - left.currentPrice;
                }
                return right.volume - left.volume;
            })[0]
            : null;
        const highestLiveOutcomeByVolume = liveOutcomes.length > 0
            ? [...liveOutcomes].sort((left, right) => {
                if (right.volume !== left.volume) {
                    return right.volume - left.volume;
                }
                return right.currentPrice - left.currentPrice;
            })[0]
            : null;
        const datedOutcomeCount = allOutcomes.filter((outcome) => outcome.dateStatus !== "undated").length;
        const isDateLadderEvent = datedOutcomeCount >= 3;
        const outcomes = (wantsOutcomeStateView || isDateLadderEvent) && !includeInactiveExplicit
            ? liveOutcomes
            : allOutcomes;
        const totalVolume = outcomes.reduce((sum, outcome) => sum + outcome.volume, 0);
        const primaryOutcome = outcomes.length === 1 && (matchConfidence === "exact" || matchConfidence === "high")
            ? outcomes[0]
            : (() => {
                const inferredPrimaryMatch = workflowPickBestOutcomeMatch(outcomes, [query, searchQuery]);
                return inferredPrimaryMatch.score >= 120 &&
                    inferredPrimaryMatch.outcome
                    ? inferredPrimaryMatch.outcome
                    : null;
            })();
        const baseSynthesisHintSearch = "Use outcomes[*].currentPrice as the numeric price alias when downstream code expects currentPrice. If primaryOutcome is present, reuse primaryTokenId/primaryConditionId directly for get_market_parameters, get_spreads, or get_orderbook instead of semantic reranking. For date-bucket prompts, trust the explicit active, closed, and dateStatus fields — or stateSummary.liveOutcomes / stateSummary.expiredOutcomes when present — instead of inferring status from label text alone.";
        const resolvedTitleForSubstituteCheck = event.title || slug;
        const titleMismatchFromQuery = matchConfidence !== "exact" &&
            requestedEntityDiffersMeaningfullyFromTitle(query, resolvedTitleForSubstituteCheck);
        const isSubstituteSearch = (matchConfidence !== "exact" && matchConfidence !== "high") ||
            titleMismatchFromQuery;
        const substituteConfidence = titleMismatchFromQuery && matchConfidence === "high"
            ? "medium"
            : matchConfidence;
        const substitutePayloadSearch = isSubstituteSearch
            ? buildCommittedSubstitutePayload({
                requestedEntity: query,
                substitutedEventTitle: resolvedTitleForSubstituteCheck,
                substitutedEventSlug: slug,
                matchConfidence: substituteConfidence,
                reason: `Closest live Polymarket event match (matchConfidence=${matchConfidence}) via ${resolvedSearchEntry?.source ?? searchMethod}. Handler committed to this substitute and returned its real live outcome data rather than asking the user to clarify.`,
            })
            : null;
        const responseData = {
            eventTitle: event.title || slug,
            eventSlug: slug,
            eventUrl: `https://polymarket.com/event/${slug}`,
            totalVolume,
            totalOutcomes: outcomes.length,
            sortedBy: sortBy,
            synthesisHint: substitutePayloadSearch
                ? `${substitutePayloadSearch.synthesisHint} ${baseSynthesisHintSearch}`
                : baseSynthesisHintSearch,
            outcomes,
            primaryOutcome,
            primaryTokenId: primaryOutcome?.tokenId || "",
            primaryConditionId: primaryOutcome?.conditionId || "",
            stateSummary: wantsOutcomeStateView || includeInactiveExplicit
                ? {
                    liveOutcomeCount: liveOutcomes.length,
                    expiredOutcomeCount: expiredOutcomes.length,
                    liveOutcomeNames: liveOutcomes.map((outcome) => outcome.name),
                    expiredOutcomeNames: expiredOutcomes.map((outcome) => outcome.name),
                    liveOutcomes,
                    expiredOutcomes,
                    highestLiveOutcomeByPrice,
                    highestLiveOutcomeByVolume,
                }
                : undefined,
            searchQuery: query,
            searchMethod: resolvedSearchEntry?.source ?? searchMethod,
            matchConfidence,
            note: substitutePayloadSearch
                ? substitutePayloadSearch.note
                : matchConfidence === "exact"
                    ? "Found exact match for your search query."
                    : "Found high-confidence match. Verify this is the market you wanted.",
            fetchedAt: new Date().toISOString(),
        };
        if (substitutePayloadSearch) {
            responseData.assumption = substitutePayloadSearch.assumption;
        }
        return successResult(searchResolution
            ? attachContributorSearchMetadata(responseData, searchResolution)
            : responseData);
    }
    catch (error) {
        return errorResult(`Search and get outcomes failed: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
/**
 * Get all outcomes/candidates in a multi-outcome event with individual volumes
 * Perfect for "which candidate has the highest volume" type questions
 */
async function handleGetEventOutcomes(args) {
    const slug = args?.slug;
    const sortBy = args?.sortBy || "volume";
    const limit = args?.limit;
    const includeInactive = args?.includeInactive || false;
    if (!slug) {
        return errorResult("slug is required. Example: 'democratic-presidential-nominee-2028'");
    }
    const event = (await fetchGamma(`/events/slug/${slug}`));
    if (!event) {
        return errorResult(`Event not found: ${slug}`);
    }
    if (!event.markets || event.markets.length === 0) {
        return errorResult(`Event has no markets/outcomes: ${slug}`);
    }
    const { outcomes: builtOutcomeRows, rawOutcomeCount, filteredPlaceholderCount, filteredInactiveCount, } = await buildEventOutcomeRows({
        event,
        includeInactive,
    });
    let outcomes = builtOutcomeRows.map(({ active: _active, ...row }) => ({
        ...row,
    }));
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
        totalVolume: Number(event.volume || 0),
        totalOutcomes,
        returnedOutcomes: outcomes.length,
        filteredPlaceholders: filteredPlaceholderCount,
        filteredInactive: filteredInactiveCount,
        sortedBy: sortBy,
        outcomes,
        url: `https://polymarket.com/event/${event.slug}`,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetOrderbook(args) {
    const tokenId = args?.tokenId;
    const merged = args?.merged;
    if (!tokenId) {
        return errorResult("tokenId is required");
    }
    let orderbook;
    try {
        // Fetch direct orderbook for this token
        orderbook = (await fetchClob(`/book?token_id=${tokenId}`));
    }
    catch (error) {
        return successResult({
            market: "",
            assetId: tokenId,
            view: "raw",
            warning: "No orderbook currently available for this token (likely resolved, inactive, or not quoting on CLOB).",
            bids: [],
            asks: [],
            bestBid: 0,
            bestAsk: 1,
            midPrice: 0.5,
            spread: 1,
            fetchedAt: new Date().toISOString(),
            error: error instanceof Error
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
                const market = (await fetchClob(`/markets/${conditionId}`));
                if (market?.tokens) {
                    const otherToken = market.tokens.find((t) => t.token_id !== tokenId);
                    if (otherToken) {
                        complementTokenId = otherToken.token_id;
                    }
                }
            }
            if (complementTokenId) {
                const complementBook = (await fetchClob(`/book?token_id=${complementTokenId}`));
                // Build merged orderbook
                const mergedBids = [];
                const mergedAsks = [];
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
        }
        catch {
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
async function handleGetPrices(args) {
    const tokenIds = args?.tokenIds;
    if (!tokenIds || tokenIds.length === 0) {
        return errorResult("tokenIds array is required");
    }
    const prices = {};
    try {
        const quoteSnapshots = await fetchClobQuoteSnapshots(tokenIds);
        for (const tokenId of tokenIds) {
            const quote = quoteSnapshots[tokenId];
            const buy = quote?.bestAsk || 0;
            const sell = quote?.bestBid || 0;
            const mid = quote?.midpoint || 0;
            const spread = quote?.spread || 0;
            prices[tokenId] = {
                buy: Number(buy.toFixed(4)),
                sell: Number(sell.toFixed(4)),
                mid: Number(mid.toFixed(4)),
                spread: Number(spread.toFixed(4)),
            };
        }
    }
    catch {
        // If CLOB fails, return zeros (market may be settled)
        for (const tokenId of tokenIds) {
            prices[tokenId] = { buy: 0, sell: 0, mid: 0, spread: 0 };
        }
    }
    return successResult({
        prices,
        note: "buy = best ask (what you pay to acquire shares), sell = best bid (what you receive when exiting), spread = best ask - best bid",
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetPriceHistory(args) {
    const tokenId = args?.tokenId;
    const interval = args?.interval || "1d";
    const fidelity = args?.fidelity;
    if (!tokenId) {
        return errorResult("tokenId is required");
    }
    let endpoint = `/prices-history?market=${tokenId}&interval=${interval}`;
    if (fidelity) {
        endpoint += `&fidelity=${fidelity}`;
    }
    const historyResp = (await fetchClob(endpoint));
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
async function handleGetBatchOrderbooks(args) {
    const tokenIds = args?.tokenIds;
    if (!tokenIds || tokenIds.length === 0) {
        return errorResult("tokenIds array is required");
    }
    if (tokenIds.length > 150) {
        return errorResult("Maximum 150 tokens per batch request");
    }
    const orderbooks = {};
    const summarizeOrderbook = (orderbook) => {
        const bids = orderbook.bids || [];
        const asks = orderbook.asks || [];
        const bestBid = bids.length > 0 ? Number(bids[0].price) : 0;
        const bestAsk = asks.length > 0 ? Number(asks[0].price) : 1;
        const midpoint = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        const bidDepth = bids.length > 0 ? Number(bids[0].size) : 0;
        const askDepth = asks.length > 0 ? Number(asks[0].size) : 0;
        return {
            view: "raw",
            warning: "Direct raw CLOB book only. Raw spread can be misleading on neg-risk markets and should NOT be ranked across outcomes. Use get_prices/get_spreads for quote snapshots or get_orderbook with merged=true for a UI-equivalent book.",
            bestBid: Number(bestBid.toFixed(4)),
            bestAsk: Number(bestAsk.toFixed(4)),
            midpoint: Number(midpoint.toFixed(4)),
            spread: Number(spread.toFixed(4)),
            bidDepth: Number(bidDepth.toFixed(2)),
            askDepth: Number(askDepth.toFixed(2)),
            bids: bids.slice(0, 5).map((bid) => ({
                price: Number(bid.price),
                size: Number(bid.size),
            })),
            asks: asks.slice(0, 5).map((ask) => ({
                price: Number(ask.price),
                size: Number(ask.size),
            })),
        };
    };
    try {
        const batchedOrderbooks = (await fetchClobPost("/books", tokenIds.map((tokenId) => ({ token_id: tokenId })), tokenIds.length > 50 ? "heavy" : "default"));
        for (const orderbook of Array.isArray(batchedOrderbooks) ? batchedOrderbooks : []) {
            if (!orderbook.asset_id) {
                continue;
            }
            orderbooks[orderbook.asset_id] = summarizeOrderbook(orderbook);
        }
    }
    catch {
        // Fallback to one-by-one fetches if the batch route errors.
        const batchSize = 5;
        for (let i = 0; i < tokenIds.length; i += batchSize) {
            const batch = tokenIds.slice(i, i + batchSize);
            await Promise.all(batch.map(async (tokenId) => {
                try {
                    const orderbook = (await fetchClob(`/book?token_id=${tokenId}`));
                    orderbooks[tokenId] = summarizeOrderbook(orderbook);
                }
                catch {
                    orderbooks[tokenId] = {
                        view: "raw",
                        warning: "Direct raw CLOB book only. Raw spread can be misleading on neg-risk markets and should NOT be ranked across outcomes. Use get_prices/get_spreads for quote snapshots or get_orderbook with merged=true for a UI-equivalent book.",
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
            }));
        }
    }
    for (const tokenId of tokenIds) {
        if (!orderbooks[tokenId]) {
            orderbooks[tokenId] = {
                view: "raw",
                warning: "Direct raw CLOB book only. Raw spread can be misleading on neg-risk markets and should NOT be ranked across outcomes. Use get_prices/get_spreads for quote snapshots or get_orderbook with merged=true for a UI-equivalent book.",
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
    }
    const spreads = tokenIds
        .map((tokenId) => orderbooks[tokenId]?.spread)
        .filter((spread) => typeof spread === "number");
    const uniqueSpreads = Array.from(new Set(spreads));
    const identicalSpreadSummary = uniqueSpreads.length === 1 && spreads.length > 0
        ? {
            spread: uniqueSpreads[0],
            count: spreads.length,
        }
        : undefined;
    const tightestRows = identicalSpreadSummary
        ? tokenIds.filter((tokenId) => orderbooks[tokenId]?.spread === identicalSpreadSummary.spread)
        : tokenIds
            .filter((tokenId) => typeof orderbooks[tokenId]?.spread === "number")
            .sort((left, right) => (orderbooks[left]?.spread ?? Number.POSITIVE_INFINITY) - (orderbooks[right]?.spread ?? Number.POSITIVE_INFINITY));
    const comparisonGuidance = {
        view: "raw_direct_only",
        spreadRankingSafeAcrossOutcomes: false,
        shouldDeclareSingleTightestOutcome: false,
        reason: identicalSpreadSummary !== undefined
            ? `All returned raw direct-book spreads are identical at ${identicalSpreadSummary.spread.toFixed(4)} across ${identicalSpreadSummary.count} token(s). Do not pick a single "tightest" outcome from this response.`
            : "Raw direct-book spreads can be misleading on neg-risk markets. Do not rank one outcome as having the tightest spread from this response alone.",
        recommendedAlternatives: [
            "get_prices",
            "get_spreads",
            "get_orderbook(tokenId, merged=true)",
        ],
        identicalSpreadSummary,
    };
    const tightestDirectBookSpread = tightestRows.length === 0
        ? {
            status: "unavailable",
            spread: 0,
            tokenIds: [],
            outcomeCount: 0,
            reason: "No usable raw direct-book spreads were returned.",
        }
        : identicalSpreadSummary !== undefined
            ? {
                status: "tie",
                spread: identicalSpreadSummary.spread,
                tokenIds: tightestRows,
                outcomeCount: tightestRows.length,
                reason: `All ${tightestRows.length} compared outcomes share the same raw direct-book spread. Report a tie instead of selecting one outcome.`,
            }
            : {
                status: "unique",
                spread: orderbooks[tightestRows[0]]?.spread ?? 0,
                tokenIds: [tightestRows[0]],
                outcomeCount: 1,
                reason: "A unique lowest raw direct-book spread was found in this batch snapshot.",
            };
    return successResult({
        orderbooks,
        count: Object.keys(orderbooks).length,
        comparisonGuidance,
        tightestDirectBookSpread,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetMarketParameters(args) {
    const inputTokenId = typeof args?.tokenId === "string" ? args.tokenId.trim() : "";
    const inputConditionId = typeof args?.conditionId === "string" ? args.conditionId.trim() : "";
    const slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : "";
    let tokenId = inputTokenId;
    let conditionId = inputConditionId;
    if (!tokenId) {
        if (!conditionId && marketQuery) {
            try {
                const searchData = workflowExtractToolData(await handleSearchAndGetOutcomes({
                    query: marketQuery,
                    sortBy: "volume",
                }), "search_and_get_outcomes");
                const matchConfidence = typeof searchData.matchConfidence === "string"
                    ? searchData.matchConfidence
                    : "";
                const directTokenId = typeof searchData.primaryTokenId === "string"
                    ? searchData.primaryTokenId.trim()
                    : "";
                const directConditionId = typeof searchData.primaryConditionId === "string"
                    ? searchData.primaryConditionId.trim()
                    : "";
                if ((matchConfidence === "exact" || matchConfidence === "high") &&
                    (directTokenId.length > 0 || directConditionId.length > 0)) {
                    tokenId = directTokenId;
                    conditionId = directConditionId;
                }
            }
            catch {
                // Fall through to the direct market resolver below.
            }
        }
        if (!conditionId) {
            const resolved = await resolveMarketReference({
                slug: slug || undefined,
                marketQuery: marketQuery || undefined,
            });
            if (!resolved?.conditionId) {
                return errorResult("Provide tokenId, conditionId, slug, or marketQuery so the tool can resolve a market.");
            }
            conditionId = resolved.conditionId;
        }
        try {
            const market = (await fetchClob(`/markets/${conditionId}`, undefined, 8_000));
            tokenId = market.tokens?.[0]?.token_id || "";
        }
        catch {
            // Fall through to Gamma fallback below.
        }
        if (!tokenId) {
            try {
                const gammaMarkets = (await fetchGamma(`/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`, 8_000));
                tokenId =
                    gammaMarkets.length > 0 ? extractGammaYesTokenId(gammaMarkets[0]) : "";
            }
            catch {
                // Keep the eventual resolution error below.
            }
        }
    }
    if (!tokenId) {
        return errorResult("Could not resolve tokenId for the requested market");
    }
    try {
        // Get orderbook which includes tick_size and neg_risk
        const orderbook = (await fetchClob(`/book?token_id=${tokenId}`));
        // Try to get market info for fee rate
        let feeRateBps = 0;
        let minOrderSize = 1;
        let tickSize = orderbook.tick_size || "0.01";
        let negRisk = orderbook.neg_risk || false;
        if (orderbook.market) {
            try {
                const market = (await fetchClob(`/markets/${orderbook.market}`));
                feeRateBps = Number(market.taker_base_fee || 0) * 100; // Convert to bps
                minOrderSize = Number(market.minimum_order_size || orderbook.min_order_size || 1);
                tickSize =
                    market.minimum_tick_size !== undefined
                        ? String(market.minimum_tick_size)
                        : tickSize;
                negRisk =
                    typeof market.neg_risk === "boolean"
                        ? market.neg_risk
                        : negRisk;
            }
            catch {
                // Continue with defaults
            }
        }
        return successResult({
            tokenId,
            tickSize,
            feeRateBps,
            negRisk,
            minOrderSize,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return successResult({
            tokenId,
            tickSize: "0.01",
            feeRateBps: 0,
            negRisk: false,
            minOrderSize: 1,
            warning: "Could not read live CLOB parameters for this token (likely resolved, inactive, or not quoting). Returned conservative defaults.",
            fetchedAt: new Date().toISOString(),
            error: error instanceof Error
                ? error.message.slice(0, 200)
                : String(error).slice(0, 200),
        });
    }
}
async function handleGetMidpoints(args) {
    const tokenIds = args?.tokenIds;
    if (!tokenIds || tokenIds.length === 0) {
        return errorResult("tokenIds array is required");
    }
    if (tokenIds.length > 50) {
        return errorResult("Maximum 50 tokens per request");
    }
    const midpoints = {};
    try {
        const quoteSnapshots = await fetchClobQuoteSnapshots(tokenIds);
        for (const tokenId of tokenIds) {
            const midpoint = quoteSnapshots[tokenId]?.midpoint ?? 0.5;
            midpoints[tokenId] = Number(midpoint.toFixed(4));
        }
    }
    catch {
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
async function handleGetSpreads(args) {
    const tokenIds = args?.tokenIds;
    if (!tokenIds || tokenIds.length === 0) {
        return errorResult("tokenIds array is required");
    }
    if (tokenIds.length > 50) {
        return errorResult("Maximum 50 tokens per request");
    }
    const spreads = {};
    try {
        const quoteSnapshots = await fetchClobQuoteSnapshots(tokenIds);
        for (const tokenId of tokenIds) {
            const quote = quoteSnapshots[tokenId];
            const bestBid = quote?.bestBid ?? 0;
            const bestAsk = quote?.bestAsk ?? 1;
            const spread = quote?.spread ?? 1;
            const mid = quote?.midpoint ?? (bestBid + bestAsk) / 2;
            const spreadPercent = mid > 0 ? (spread / mid) * 100 : 0;
            spreads[tokenId] = {
                spread: Number(spread.toFixed(4)),
                spreadPercent: Number(spreadPercent.toFixed(2)),
                bestBid: Number(bestBid.toFixed(4)),
                bestAsk: Number(bestAsk.toFixed(4)),
            };
        }
    }
    catch {
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
async function handleSearchMarkets(args) {
    const query = args?.query;
    const category = args?.category;
    const status = args?.status || "live"; // Default to live (tradeable) markets
    const limit = Math.min(args?.limit || 12, 40);
    const categoryTagSlug = resolveDiscoveryCategoryTagSlug({
        category,
        query,
    });
    const normalizedQuery = (query || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
    // Build query words for matching specific candidates/outcomes in multi-outcome events.
    // Use the same trimmed scoring vocabulary as the market resolver so long natural-language
    // prompts can degrade to entity-focused search without rewriting the original intent.
    const searchQueryWords = query
        ? buildMarketQueryScoringTokens(query).filter((word) => word.length > 2 || word === "us")
        : [];
    const rankingWords = query ? buildMarketQueryScoringTokens(query) : [];
    let allEvents = [];
    let searchUsed = false;
    let searchMethod = "events listing";
    let rankedCandidates = [];
    let activeIndexBuiltAt;
    // PRIMARY STRATEGY: Use the same website-backed search surface the live UI hits,
    // then locally rerank the returned candidates.
    if (query) {
        try {
            if (status === "all") {
                const [activeWebsiteSearch, closedWebsiteSearch] = await Promise.all([
                    searchGammaWebsiteEventCandidates({
                        query,
                        category,
                        limit: Math.min(limit * 4, 40),
                        eventsStatus: "active",
                    }),
                    searchGammaWebsiteEventCandidates({
                        query,
                        category,
                        limit: Math.min(limit * 4, 40),
                        eventsStatus: "closed",
                    }),
                ]);
                const combinedCandidates = [
                    ...activeWebsiteSearch.candidates,
                    ...closedWebsiteSearch.candidates,
                ].sort((a, b) => {
                    if (b.score !== a.score) {
                        return b.score - a.score;
                    }
                    if (b.volume !== a.volume) {
                        return b.volume - a.volume;
                    }
                    return a.marketTitle.localeCompare(b.marketTitle);
                });
                if (combinedCandidates.length > 0) {
                    rankedCandidates = pickTopIndexedCandidatesByEvent(combinedCandidates, Math.min(limit * 2, 24));
                    allEvents = rankedCandidates.map((candidate) => candidate.event);
                    searchUsed = true;
                    searchMethod = "website-search-v2";
                }
            }
            else {
                const websiteSearch = await searchGammaWebsiteEventCandidates({
                    query,
                    category,
                    limit: Math.min(limit * 4, 40),
                    eventsStatus: status === "resolved" ? "closed" : "active",
                });
                if (websiteSearch.candidates.length > 0) {
                    rankedCandidates = pickTopIndexedCandidatesByEvent(websiteSearch.candidates, Math.min(limit * 2, 24));
                    allEvents = rankedCandidates.map((candidate) => candidate.event);
                    searchUsed = true;
                    searchMethod = websiteSearch.source;
                }
            }
        }
        catch (err) {
            console.error("Website-backed search failed, falling back:", err);
        }
    }
    // FALLBACK 1: Search the locally ranked active events index for live queries.
    if (!searchUsed && query && status === "live") {
        try {
            const indexedSearch = await searchIndexedActiveEventCandidates({
                query,
                category,
                limit: Math.min(limit * 4, 24),
            });
            if (indexedSearch.candidates.length > 0) {
                rankedCandidates = pickTopIndexedCandidatesByEvent(indexedSearch.candidates, Math.min(limit * 2, 24));
                allEvents = rankedCandidates.map((candidate) => candidate.event);
                searchUsed = true;
                searchMethod = indexedSearch.source;
                activeIndexBuiltAt = indexedSearch.searchIndex.builtAt;
            }
        }
        catch (err) {
            console.error("Active events index search failed, falling back:", err);
        }
    }
    // FALLBACK 2: Use the /public-search endpoint for server-side text search.
    if (!searchUsed && query) {
        try {
            const searchEvents = await searchGammaEventsByVariants({
                query,
                limitPerType: Math.min(limit * 2, 24),
                eventsStatus: status === "resolved"
                    ? "closed"
                    : status === "live"
                        ? "active"
                        : undefined,
                includeClosed: status === "resolved",
            });
            if (searchEvents.length > 0) {
                allEvents = searchEvents;
                searchUsed = true;
                searchMethod = "public-search API";
            }
        }
        catch (err) {
            // Fall through to events listing if search fails
            console.error('Public search failed, falling back to events listing:', err);
        }
    }
    // FALLBACK 3: Use events listing only if search wasn't used or returned nothing.
    if (!searchUsed) {
        const fetchLimit = Math.min(limit * 4, 60);
        const orderParams = "&order=volume&ascending=false";
        const categoryParams = categoryTagSlug
            ? `&tag_slug=${encodeURIComponent(categoryTagSlug)}`
            : "";
        if (status === "all") {
            const [liveEvents, resolvedEvents] = await Promise.all([
                fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${categoryParams}`),
                fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${categoryParams}`),
            ]);
            allEvents = [...(liveEvents || []), ...(resolvedEvents || [])];
        }
        else if (status === "resolved") {
            allEvents = (await fetchGamma(`/events?closed=true&limit=${fetchLimit}${orderParams}${categoryParams}`));
        }
        else {
            allEvents = (await fetchGamma(`/events?closed=false&limit=${fetchLimit}${orderParams}${categoryParams}`));
        }
    }
    let filtered = allEvents || [];
    // Apply status filter if search was used (search may return mixed status)
    if (searchUsed && status !== "all") {
        filtered = filtered.filter(e => {
            const isClosed = e.closed === true;
            if (status === "live")
                return !isClosed;
            if (status === "resolved")
                return isClosed;
            return true;
        });
    }
    if (query && rankingWords.length > 0 && rankedCandidates.length === 0) {
        const tokenizedWordRegex = rankingWords.map((word) => new RegExp(`\\b${word}\\b`, "i"));
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
                }
                else if (eventText.includes(word)) {
                    score += 2;
                }
            }
            if (compactQuery.length > 6 && compactText.includes(compactQuery)) {
                score += 8;
            }
            if (exactWordHits === rankingWords.length) {
                score += 6;
            }
            if (rankingWords.length >= 2 &&
                eventText.includes(`${rankingWords[0]} ${rankingWords[1]}`)) {
                score += 3;
            }
            return { event, score };
        });
        scored.sort((a, b) => b.score - a.score ||
            Number(b.event.volume || 0) - Number(a.event.volume || 0));
        filtered = scored.map((entry) => entry.event);
    }
    // Count by status for breakdown
    let liveCount = 0;
    let resolvedCount = 0;
    const searchResultQuoteSnapshots = await fetchGammaMarketQuoteSnapshots([
        ...rankedCandidates.map((candidate) => candidate.market),
        ...filtered
            .slice(0, limit)
            .flatMap((event) => event.markets || []),
    ], {
        timeoutMs: "heavy",
    });
    const results = rankedCandidates.length > 0
        ? rankedCandidates.slice(0, limit).map((candidate) => {
            const isResolved = candidate.event.closed === true;
            const marketStatus = isResolved ? "resolved" : "live";
            if (isResolved) {
                resolvedCount++;
            }
            else {
                liveCount++;
            }
            return {
                title: candidate.event.title,
                url: getPolymarketUrl(candidate.event.slug, candidate.conditionId),
                slug: candidate.event.slug,
                status: marketStatus,
                category: candidate.event.category,
                conditionId: candidate.conditionId,
                yesTokenId: extractGammaYesTokenId(candidate.market),
                tokenId: extractGammaYesTokenId(candidate.market),
                matchedOutcome: candidate.market.groupItemTitle ||
                    candidate.market.question ||
                    candidate.market.title,
                outcomePrice: resolveCurrentOutcomePrice(candidate.market, searchResultQuoteSnapshots).toFixed(4),
                volume: candidate.event.volume,
                liquidity: candidate.event.liquidity,
                endDate: candidate.event.endDate || candidate.event.endDateIso,
                score: candidate.score,
            };
        })
        : filtered
            .slice(0, limit)
            .map((e) => {
            const isResolved = e.closed === true;
            const marketStatus = isResolved ? "resolved" : "live";
            if (isResolved) {
                resolvedCount++;
            }
            else {
                liveCount++;
            }
            const marketPreference = status === "resolved"
                ? "resolved"
                : status === "all"
                    ? "any"
                    : "tradable";
            // Find the specific market matching the search query (e.g., "Gavin Newsom")
            let matchedMarket = getRepresentativeGammaMarket(e, {
                preference: marketPreference,
            });
            let matchedOutcomePrice = null;
            if (searchQueryWords.length > 0 && e.markets && e.markets.length > 1) {
                const matchingMarkets = [];
                for (const market of e.markets) {
                    const marketText = ((market.question || '') + ' ' + (market.title || '')).toLowerCase();
                    const matches = searchQueryWords.some(word => marketText.includes(word));
                    if (matches) {
                        matchingMarkets.push(market);
                    }
                }
                const preferredMatch = selectPreferredGammaMarket(matchingMarkets, {
                    preference: marketPreference,
                });
                if (preferredMatch) {
                    matchedMarket = preferredMatch;
                    matchedOutcomePrice = resolveCurrentOutcomePrice(preferredMatch, searchResultQuoteSnapshots).toFixed(4);
                }
            }
            if (!matchedOutcomePrice && matchedMarket) {
                matchedOutcomePrice = resolveCurrentOutcomePrice(matchedMarket, searchResultQuoteSnapshots).toFixed(4);
            }
            return {
                title: e.title,
                url: `https://polymarket.com/event/${e.slug}`,
                slug: e.slug,
                status: marketStatus,
                category: e.category,
                conditionId: matchedMarket?.conditionId,
                yesTokenId: matchedMarket ? extractGammaYesTokenId(matchedMarket) : "",
                tokenId: matchedMarket ? extractGammaYesTokenId(matchedMarket) : "",
                matchedOutcome: matchedMarket?.question || matchedMarket?.title,
                outcomePrice: matchedOutcomePrice,
                volume: e.volume,
                liquidity: e.liquidity,
                endDate: e.endDate || e.endDateIso,
            };
        });
    const hint = rankedCandidates.length > 0 && searchMethod.startsWith("website-search-v2")
        ? `✅ Website-backed Polymarket search used. Found ${results.length} results for "${query}".`
        : rankedCandidates.length > 0
            ? `✅ Active events index fallback used. Found ${results.length} results for "${query}".`
            : searchUsed
                ? `✅ Server-side search used. Found ${results.length} results for "${query}".`
                : (query
                    ? `⚠️ Search fallback: browsing events listing. Results may not be comprehensive.`
                    : `Browsing ${status} markets by volume.`);
    const statusHint = status === "live"
        ? " Showing LIVE markets only (open for trading)."
        : status === "resolved"
            ? " Showing RESOLVED markets only (already finished)."
            : " Showing ALL markets (both live and resolved).";
    const searchResolution = query && results.length > 0
        ? await resolvePolymarketContributorSearch({
            rawRequest: query,
            traceLabel: "polymarket:search_markets",
            candidates: results.map((result, index) => buildPolymarketResultSearchCandidate({
                query,
                rank: index + 1,
                source: searchMethod,
                result,
            })),
        })
        : null;
    const fetchedAt = new Date().toISOString();
    const responseData = {
        results,
        count: results.length,
        searchMethod,
        statusBreakdown: {
            live: liveCount,
            resolved: resolvedCount,
        },
        hint: hint + statusHint,
        dataProvenanceNote: `Fresh Polymarket search snapshot at ${fetchedAt} (ISO UTC). Each row below is from this tool response — cite slugs, liquidity, volume, and endDate from these fields; do not attribute rows to prior chat context.`,
        indexBuiltAt: activeIndexBuiltAt,
        fetchedAt,
    };
    return successResult(searchResolution
        ? attachContributorSearchMetadata(responseData, searchResolution)
        : responseData);
}
// ============================================================================
// NEW TIER 2 RAW DATA HANDLERS
// ============================================================================
async function handleGetMarketTrades(args) {
    const conditionId = args?.conditionId;
    const limit = Math.min(args?.limit || 50, 500);
    const hoursBack = workflowToBoundedInteger(args?.hoursBack, 24, 1, 168);
    const coverageModeRaw = typeof args?.coverageMode === "string" ? args.coverageMode : "quick";
    const coverageMode = coverageModeRaw === "standard" || coverageModeRaw === "deep"
        ? coverageModeRaw
        : "quick";
    const minNotional = workflowToBoundedInteger(args?.minNotional, 0, 0, 1_000_000);
    const sideFilter = args?.side === "BUY" || args?.side === "SELL" ? args.side : undefined;
    const userFilter = typeof args?.user === "string" ? args.user.trim() : "";
    if (!conditionId) {
        return errorResult("conditionId is required");
    }
    try {
        const { recentTrades: trades, tradeCoverage } = await fetchMarketTradesWindow({
            conditionId,
            hoursBack,
            coverageMode,
            ...(minNotional > 0
                ? {
                    tradeFilter: {
                        filterType: "CASH",
                        filterAmount: minNotional,
                        description: `trades >= ${formatUsdThreshold(minNotional)} notional`,
                    },
                }
                : {}),
            ...(sideFilter ? { side: sideFilter } : {}),
            ...(userFilter.length > 0 ? { user: userFilter } : {}),
        });
        if (!trades || !Array.isArray(trades)) {
            return successResult({
                market: conditionId,
                trades: [],
                summary: { totalTrades: 0, totalVolume: 0, buyVolume: 0, sellVolume: 0, avgPrice: 0 },
                tradeCoverage,
                fetchedAt: new Date().toISOString(),
            });
        }
        let totalVolume = 0;
        let buyVolume = 0;
        let sellVolume = 0;
        let priceSum = 0;
        const formattedTrades = trades.slice(0, limit).map((t) => {
            const price = Number(t.price || 0);
            const size = Number(t.size || 0);
            const notional = price * size;
            const side = t.side?.toUpperCase() || "BUY";
            return {
                id: t.id || "",
                timestamp: t.timestamp || t.matchTime || t.match_time || "",
                side,
                outcome: t.outcome || "YES",
                price,
                size,
                notional: Number(notional.toFixed(2)),
                trader: t.trader || t.proxyWallet || "",
            };
        });
        for (const trade of trades) {
            const price = Number(trade.price || 0);
            const size = Number(trade.size || 0);
            const notional = price * size;
            const side = trade.side?.toUpperCase() || "BUY";
            totalVolume += notional;
            priceSum += price;
            if (side === "BUY") {
                buyVolume += notional;
            }
            else {
                sellVolume += notional;
            }
        }
        return successResult({
            market: conditionId,
            trades: formattedTrades,
            summary: {
                totalTrades: trades.length,
                totalVolume: Number(totalVolume.toFixed(2)),
                buyVolume: Number(buyVolume.toFixed(2)),
                sellVolume: Number(sellVolume.toFixed(2)),
                avgPrice: trades.length > 0 ? Number((priceSum / trades.length).toFixed(4)) : 0,
                note: tradeCoverage.coverageScope === "filtered_public_tape"
                    ? `Summary covers filtered public trade tape (${[
                        minNotional > 0 ? `>=${formatUsdThreshold(minNotional)}` : "",
                        sideFilter ?? "",
                        userFilter.length > 0 ? "wallet-filtered" : "",
                    ]
                        .filter((value) => value.length > 0)
                        .join(", ")}); do not compare it to full-market volume.`
                    : tradeCoverage.canMakeDirectionalClaim === true
                        ? `Summary covers ${hoursBack}h public trade tape with ${String(tradeCoverage.coverageLevel)} coverage.`
                        : `Summary is based on ${hoursBack}h sampled public trade tape; do not treat raw BUY/SELL totals as full-market direction.`,
            },
            tradeCoverage,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to fetch trades: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetUserPositions(args) {
    const address = args?.address;
    const sizeThreshold = args?.sizeThreshold || 0;
    const limit = Math.min(args?.limit || 50, 100);
    if (!address) {
        return errorResult("address is required");
    }
    try {
        // Fetch BOTH open positions AND closed positions in parallel
        const [openPositions, closedPositions] = await Promise.all([
            fetchDataApi(`/positions?user=${address}&limit=${limit}${sizeThreshold > 0 ? `&sizeThreshold=${sizeThreshold}` : ""}`)
                .catch(() => []),
            fetchDataApi(`/closed-positions?user=${address}&limit=${limit}`)
                .catch(() => []),
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
            if (pnl > 0.01)
                profitableCount++;
            else if (pnl < -0.01)
                underwaterCount++;
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
        const recentTrades = [];
        for (const p of closedArray) {
            const realizedPnL = Number(p.realizedPnl || 0);
            totalRealizedPnL += realizedPnL;
            if (realizedPnL > 0.01)
                wins++;
            else if (realizedPnL < -0.01)
                losses++;
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
    }
    catch (error) {
        return errorResult(`Failed to fetch positions: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetUserActivity(args) {
    const address = args?.address || "";
    const limit = Math.min(args?.limit || 100, 500);
    const offset = Math.max(args?.offset || 0, 0);
    const conditionId = args?.conditionId;
    const side = args?.side;
    const types = Array.isArray(args?.types)
        ? (args?.types).filter((value) => typeof value === "string")
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
        const activity = (await fetchDataApi(`/activity?${params.toString()}`));
        const normalized = Array.isArray(activity) ? activity : [];
        let buyCount = 0;
        let sellCount = 0;
        let totalUsdcFlow = 0;
        const byType = {};
        const formatted = normalized.map((entry) => {
            const entryType = (entry.type || "UNKNOWN").toUpperCase();
            const entrySide = (entry.side || "").toUpperCase();
            const usdcSize = Number(entry.usdcSize || 0);
            const size = Number(entry.size || 0);
            const price = Number(entry.price || 0);
            byType[entryType] = (byType[entryType] ?? 0) + 1;
            if (entrySide === "BUY")
                buyCount += 1;
            if (entrySide === "SELL")
                sellCount += 1;
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
    }
    catch (error) {
        return errorResult(`Failed to fetch user activity: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetUserTotalValue(args) {
    const address = args?.address || "";
    const conditionIds = Array.isArray(args?.conditionIds)
        ? (args?.conditionIds).filter((value) => typeof value === "string" && value.length > 0)
        : [];
    if (!address) {
        return errorResult("address is required");
    }
    const params = new URLSearchParams({ user: address });
    if (conditionIds.length > 0) {
        params.set("market", conditionIds.join(","));
    }
    try {
        const valueResponse = (await fetchDataApi(`/value?${params.toString()}`));
        const rows = Array.isArray(valueResponse) ? valueResponse : [];
        const first = rows[0];
        const totalValue = Number(first?.value || 0);
        return successResult({
            address,
            totalValue: Number.isFinite(totalValue) ? Number(totalValue.toFixed(2)) : 0,
            conditionIds,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to fetch total user value: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetMarketOpenInterest(args) {
    const conditionId = args?.conditionId;
    const conditionIds = Array.isArray(args?.conditionIds)
        ? (args?.conditionIds).filter((value) => typeof value === "string" && value.length > 0)
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
        const oiResponse = (await fetchDataApi(`/oi?market=${encodeURIComponent(uniqueConditionIds.join(","))}`));
        const rows = Array.isArray(oiResponse) ? oiResponse : [];
        const openInterest = rows.map((row) => ({
            conditionId: row.market || "",
            value: Number(row.value || 0),
        }));
        const totalOpenInterest = openInterest.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0);
        return successResult({
            openInterest,
            totalOpenInterest: Number(totalOpenInterest.toFixed(2)),
            changeRateAvailable: false,
            note: "This upstream endpoint is a point-in-time open-interest snapshot. It can answer current OI level, but not a true rate-of-change without a second time-separated snapshot.",
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to fetch open interest: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetEventLiveVolume(args) {
    const rawEventId = args?.eventId;
    let eventId = typeof rawEventId === "number"
        ? rawEventId
        : typeof rawEventId === "string" && rawEventId.trim().length > 0
            ? Number(rawEventId)
            : Number.NaN;
    let eventTitle = "";
    let eventSlug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const eventQuery = typeof args?.eventQuery === "string" ? args.eventQuery.trim() : "";
    let selectionReason = Number.isFinite(eventId) && eventId > 0
        ? "Used the provided eventId."
        : eventSlug.length > 0
            ? "Resolved from the provided slug."
            : "";
    if (!Number.isFinite(eventId) || eventId <= 0) {
        if (eventSlug.length > 0) {
            try {
                const event = (await fetchGamma(`/events/slug/${eventSlug}`, 8_000));
                const eventIdValue = event?.id !== undefined && event?.id !== null ? Number(event.id) : Number.NaN;
                if (Number.isFinite(eventIdValue) && eventIdValue > 0) {
                    eventId = eventIdValue;
                    eventTitle = event.title || "";
                    selectionReason = "Resolved eventId from the provided slug.";
                }
            }
            catch {
                // fall through to broader resolution
            }
        }
    }
    if ((!Number.isFinite(eventId) || eventId <= 0) && eventQuery.length > 0) {
        try {
            const searchData = workflowExtractToolData(await handleSearchAndGetOutcomes({ query: eventQuery }), "search_and_get_outcomes");
            if (typeof searchData.eventSlug === "string" && searchData.eventSlug.trim().length > 0) {
                eventSlug = searchData.eventSlug.trim();
                const event = (await fetchGamma(`/events/slug/${eventSlug}`, 8_000));
                const eventIdValue = event?.id !== undefined && event?.id !== null ? Number(event.id) : Number.NaN;
                if (Number.isFinite(eventIdValue) && eventIdValue > 0) {
                    eventId = eventIdValue;
                    eventTitle =
                        typeof searchData.eventTitle === "string" && searchData.eventTitle.trim().length > 0
                            ? searchData.eventTitle
                            : event.title || "";
                    selectionReason = "Resolved the target event from the provided eventQuery.";
                }
            }
        }
        catch {
            // fall through to fallback
        }
    }
    if (!Number.isFinite(eventId) || eventId <= 0) {
        const fallbackCandidate = await resolveFallbackTopMarketCandidate({
            sortBy: "volume",
            preferMultiOutcome: true,
        });
        if (fallbackCandidate) {
            const fallbackEventId = Number(fallbackCandidate.eventId);
            if (Number.isFinite(fallbackEventId) && fallbackEventId > 0) {
                eventId = fallbackEventId;
                eventSlug = fallbackCandidate.slug;
                eventTitle = fallbackCandidate.eventTitle;
                selectionReason =
                    "Committed to the strongest live multi-outcome Polymarket event as a best-effort substitute when an explicit event identifier was absent.";
            }
        }
    }
    if (!Number.isFinite(eventId) || eventId <= 0) {
        return errorResult("eventId, slug, or eventQuery is required");
    }
    try {
        let eventDetail = null;
        if (eventSlug.length > 0) {
            try {
                eventDetail = (await fetchGamma(`/events/slug/${eventSlug}`, 8_000));
            }
            catch {
                eventDetail = null;
            }
        }
        const liveVolumeResponse = (await fetchDataApi(`/live-volume?id=${eventId}`));
        const first = Array.isArray(liveVolumeResponse)
            ? liveVolumeResponse[0]
            : liveVolumeResponse;
        const firstRecord = workflowObject(first);
        const markets = Array.isArray(first?.markets)
            ? first.markets.map((row) => {
                const value = Number(row.value || 0);
                const safeTotal = Number(first?.total || 0);
                const matchedMarket = eventDetail?.markets?.find((market) => typeof market.conditionId === "string" &&
                    market.conditionId === row.market) || null;
                return {
                    market: row.market || "",
                    conditionId: row.market || "",
                    title: matchedMarket?.question ||
                        matchedMarket?.title ||
                        matchedMarket?.groupItemTitle ||
                        "",
                    value,
                    shareOfEventTotal: Number.isFinite(safeTotal) && safeTotal > 0 ? Number((value / safeTotal).toFixed(6)) : 0,
                };
            })
            : [];
        const total = Number(first?.total || 0);
        const volumeBreakdownAvailable = markets.length > 0 && total > 0;
        const warning = volumeBreakdownAvailable
            ? undefined
            : "No live-volume breakdown is currently available for share calculations. Do not infer top submarkets or percentage shares from this response.";
        return successResult({
            eventId,
            eventTitle: eventTitle ||
                eventDetail?.title ||
                (typeof firstRecord.eventTitle === "string" ? firstRecord.eventTitle : "") ||
                "",
            eventSlug,
            total: Number.isFinite(total) ? Number(total.toFixed(2)) : 0,
            markets,
            volumeBreakdownAvailable,
            warning,
            selectionReason,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to fetch live event volume: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetTopHolders(args) {
    const rawConditionId = getNonEmptyString(args?.conditionId) || "";
    const rawSlug = getNonEmptyString(args?.slug) || "";
    const rawMarketQuery = getNonEmptyString(args?.marketQuery) || "";
    const outcome = args?.outcome || "BOTH";
    // User-requested limit (we can return more than 20 via multi-tier fetching)
    const requestedLimit = args?.limit || 50;
    // Whether to use deep fetching (multiple API calls with different minBalance tiers)
    const deepFetch = args?.deepFetch !== false; // Default to true for thorough results
    const upstreamTimeoutProfile = deepFetch
        ? "heavy"
        : "default";
    const validConditionIdPattern = /^0x[0-9a-f]{64}$/i;
    let conditionId = "";
    let resolvedVia = null;
    if (rawConditionId && validConditionIdPattern.test(rawConditionId.trim())) {
        conditionId = rawConditionId.trim();
    }
    else {
        // Either no conditionId, or a placeholder like "0xthunder" / "will-okc-win".
        // Try to resolve from slug or marketQuery (or treat the placeholder as a
        // freeform marketQuery hint) instead of failing closed or returning an
        // all-zero shell that looks like a real "no whales" answer.
        const queryHint = rawMarketQuery ||
            (rawConditionId && !validConditionIdPattern.test(rawConditionId)
                ? rawConditionId
                : "");
        const resolved = await resolveMarketReference({
            slug: rawSlug || undefined,
            marketQuery: queryHint || undefined,
        });
        if (resolved?.conditionId && validConditionIdPattern.test(resolved.conditionId)) {
            conditionId = resolved.conditionId;
            resolvedVia = rawSlug
                ? "slug"
                : rawMarketQuery
                    ? "marketQuery"
                    : "conditionId-fallback-as-query";
        }
    }
    if (!conditionId) {
        return errorResult(`Could not resolve a valid Polymarket conditionId. ` +
            `Provide one of: conditionId (0x-prefixed 66-char hex), slug, or marketQuery (natural-language market title). ` +
            `Received: conditionId='${rawConditionId}', slug='${rawSlug}', marketQuery='${rawMarketQuery}'. ` +
            `Hint: call search_markets or search_and_get_outcomes first to get a real conditionId, or pass the market title as marketQuery and let this tool resolve it.`);
    }
    try {
        // Get current prices and token IDs first
        let yesPrice = 0.5;
        let noPrice = 0.5;
        let yesTokenId = "";
        let noTokenId = "";
        try {
            const market = (await fetchClob(`/markets/${conditionId}`, undefined, upstreamTimeoutProfile));
            const tokens = market?.tokens;
            if (tokens && tokens.length >= 2) {
                yesTokenId = tokens[0].token_id;
                noTokenId = tokens[1].token_id;
                const quoteSnapshots = await fetchClobQuoteSnapshots([tokens[0].token_id, tokens[1].token_id], upstreamTimeoutProfile);
                yesPrice = quoteSnapshots[tokens[0].token_id]?.midpoint || yesPrice;
                noPrice = quoteSnapshots[tokens[1].token_id]?.midpoint || noPrice;
            }
        }
        catch {
            // Use defaults
        }
        // Maps to deduplicate holders by address
        const yesHoldersMap = new Map();
        const noHoldersMap = new Map();
        // Fetch holders. Primary path: single `limit=DEEP_HOLDER_SCAN_LIMIT`
        // request. Fallback path (only if upstream regresses to the doc'd
        // 20-cap): the legacy paced `minBalance` tier sweep.
        const tierResults = [];
        let scanMode = "shallow";
        let perCallLimit = SHALLOW_HOLDER_SCAN_LIMIT;
        let perSideScanCeilingHit = false;
        if (deepFetch) {
            const primary = (await fetchDataApi(`/holders?market=${conditionId}&limit=${DEEP_HOLDER_SCAN_LIMIT}&minBalance=1`, upstreamTimeoutProfile).catch(() => []));
            const primaryOk = Array.isArray(primary) &&
                primary.some((token) => (token.holders?.length ?? 0) > LEGACY_HOLDER_PAGE_SIZE);
            if (primaryOk) {
                scanMode = "deep-single-call";
                perCallLimit = DEEP_HOLDER_SCAN_LIMIT;
                perSideScanCeilingHit = primary.some((token) => (token.holders?.length ?? 0) >= DEEP_HOLDER_SCAN_LIMIT);
                tierResults.push(primary);
            }
            else {
                scanMode = "legacy-tier-sweep";
                perCallLimit = LEGACY_HOLDER_PAGE_SIZE;
                const minBalanceTiers = [100000, 10000, 5000, 2000, 1000, 500, 100, 10, 1];
                const tierBatchSize = 3;
                for (let i = 0; i < minBalanceTiers.length; i += tierBatchSize) {
                    const tierBatch = minBalanceTiers.slice(i, i + tierBatchSize);
                    const batchResults = await Promise.all(tierBatch.map((minBal) => fetchDataApi(`/holders?market=${conditionId}&limit=${LEGACY_HOLDER_PAGE_SIZE}&minBalance=${minBal}`, upstreamTimeoutProfile).catch(() => [])));
                    tierResults.push(...batchResults);
                    if (i + tierBatchSize < minBalanceTiers.length) {
                        await sleep(120);
                    }
                }
            }
        }
        else {
            scanMode = "shallow";
            perCallLimit = SHALLOW_HOLDER_SCAN_LIMIT;
            const shallow = (await fetchDataApi(`/holders?market=${conditionId}&limit=${SHALLOW_HOLDER_SCAN_LIMIT}&minBalance=1`, upstreamTimeoutProfile).catch(() => []));
            tierResults.push(shallow);
        }
        // Process all tier results
        for (const holdersResponse of tierResults) {
            if (!Array.isArray(holdersResponse))
                continue;
            for (const tokenHolders of holdersResponse) {
                const isYesToken = tokenHolders.token === yesTokenId ||
                    (tokenHolders.holders?.[0]?.outcomeIndex === 0);
                const isNoToken = tokenHolders.token === noTokenId ||
                    (tokenHolders.holders?.[0]?.outcomeIndex === 1);
                for (const h of (tokenHolders.holders || [])) {
                    const address = h.proxyWallet || "";
                    if (!address)
                        continue;
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
                    }
                    else if (isNoToken || h.outcomeIndex === 1) {
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
        const yesTotalValue = yesHolders.reduce((sum, holder) => sum + holder.size * yesPrice, 0);
        const noTotalValue = noHolders.reduce((sum, holder) => sum + holder.size * noPrice, 0);
        const yesLargeHolderCount = yesHolders.filter((holder) => holder.size * yesPrice >= HOLDER_LARGE_MIN_USD).length;
        const noLargeHolderCount = noHolders.filter((holder) => holder.size * noPrice >= HOLDER_LARGE_MIN_USD).length;
        const yesWhaleCount = yesHolders.filter((holder) => isMeaningfulHolderWhale(holder.size * yesPrice, totalYes > 0 ? (holder.size / totalYes) * 100 : 0)).length;
        const noWhaleCount = noHolders.filter((holder) => isMeaningfulHolderWhale(holder.size * noPrice, totalNo > 0 ? (holder.size / totalNo) * 100 : 0)).length;
        const yesWhaleValue = yesHolders.reduce((sum, holder) => {
            const value = holder.size * yesPrice;
            const percentOfSupply = totalYes > 0 ? (holder.size / totalYes) * 100 : 0;
            if (isMeaningfulHolderWhale(value, percentOfSupply)) {
                return sum + value;
            }
            return sum;
        }, 0);
        const noWhaleValue = noHolders.reduce((sum, holder) => {
            const value = holder.size * noPrice;
            const percentOfSupply = totalNo > 0 ? (holder.size / totalNo) * 100 : 0;
            if (isMeaningfulHolderWhale(value, percentOfSupply)) {
                return sum + value;
            }
            return sum;
        }, 0);
        const formatHolders = (holders, total, price) => {
            return holders
                .slice(0, requestedLimit)
                .map((p, idx) => {
                const value = p.size * price;
                const percentOfSupply = total > 0 ? Number(((p.size / total) * 100).toFixed(2)) : 0;
                let positionTier = "small";
                if (isMeaningfulHolderWhale(value, percentOfSupply)) {
                    positionTier = "whale";
                }
                else if (value >= HOLDER_LARGE_MIN_USD) {
                    positionTier = "large";
                }
                return {
                    rank: idx + 1,
                    address: p.address,
                    name: p.name || undefined,
                    profileImage: p.profileImage || undefined,
                    size: Number(p.size.toFixed(2)),
                    value: Number(value.toFixed(2)),
                    percentOfSupply,
                    positionTier,
                };
            });
        };
        const topYes = outcome === "NO" ? [] : formatHolders(yesHolders, totalYes, yesPrice);
        const topNo = outcome === "YES" ? [] : formatHolders(noHolders, totalNo, noPrice);
        // Calculate concentration
        const top10YesPercent = topYes.slice(0, 10).reduce((sum, h) => sum + h.percentOfSupply, 0);
        const top10NoPercent = topNo.slice(0, 10).reduce((sum, h) => sum + h.percentOfSupply, 0);
        // Track how many unique holders we found
        const totalUniqueHolders = yesHolders.length + noHolders.length;
        // Get market title - use direct Gamma /markets?condition_ids= lookup instead of
        // brute-force searching through 50 events (which was adding 5-10s to response time)
        let marketTitle = conditionId;
        try {
            const markets = (await fetchGamma(`/markets?condition_ids=${conditionId}&limit=1`, 5000));
            if (Array.isArray(markets) && markets.length > 0) {
                marketTitle = markets[0].question || conditionId;
            }
        }
        catch {
            // Use conditionId as title
        }
        const fetchMethod = scanMode === "deep-single-call"
            ? `deep-single-call (/holders limit=${perCallLimit} per side, sorted desc by share balance)`
            : scanMode === "legacy-tier-sweep"
                ? `legacy-tier-sweep (fallback: 9 /holders calls at limit=${perCallLimit} across minBalance tiers)`
                : `shallow (single /holders call limit=${perCallLimit} per side)`;
        const note = scanMode === "deep-single-call"
            ? `Deep holder scan returned ${totalUniqueHolders} unique holders (up to ${perCallLimit} per side) via a single /holders call sorted descending by share balance. Whale counts use >=${formatUsdThreshold(HOLDER_WHALE_MIN_USD)} current value or >=${HOLDER_WHALE_MIN_SUPPLY_PERCENT}% of scanned side supply; >=${formatUsdThreshold(HOLDER_LARGE_MIN_USD)} is reported separately as large-holder participation.${perSideScanCeilingHit ? ` NOTE: at least one side hit the ${DEEP_HOLDER_SCAN_LIMIT} per-call ceiling; additional long-tail holders may exist below the scan floor, but the top holder set and material whale-sized positions should be captured.` : ""}`
            : scanMode === "legacy-tier-sweep"
                ? `Fallback holder scan: the upstream appears to be enforcing the doc'd 20-per-call cap, so we swept 9 minBalance tiers [$100k…$1] and deduplicated. Whale counts use >=${formatUsdThreshold(HOLDER_WHALE_MIN_USD)} current value or >=${HOLDER_WHALE_MIN_SUPPLY_PERCENT}% of scanned side supply; response samples may still be truncated for payload size.`
                : "Single API call (limit 20 per side). Use deepFetch=true for deep scan (up to 500 per side).";
        return successResult({
            market: marketTitle,
            conditionId,
            topHolders: { yes: topYes, no: topNo },
            totalUniqueHolders,
            holdersReturned: { yes: topYes.length, no: topNo.length },
            holdersScanned: { yes: yesHolders.length, no: noHolders.length },
            positionValueSummary: {
                yesTotalValue: Number(yesTotalValue.toFixed(2)),
                noTotalValue: Number(noTotalValue.toFixed(2)),
                yesWhaleCount,
                noWhaleCount,
                yesLargeHolderCount,
                noLargeHolderCount,
                yesWhaleValue: Number(yesWhaleValue.toFixed(2)),
                noWhaleValue: Number(noWhaleValue.toFixed(2)),
            },
            concentration: {
                top10YesPercent: Number(top10YesPercent.toFixed(2)),
                top10NoPercent: Number(top10NoPercent.toFixed(2)),
                whaleCount: yesWhaleCount + noWhaleCount,
                largeHolderCount: yesLargeHolderCount + noLargeHolderCount,
            },
            scanMode,
            perCallLimit,
            perSideScanCeilingHit,
            fetchMethod,
            note,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to fetch top holders: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetMarketComments(args) {
    const slug = args?.slug;
    const limit = Math.min(args?.limit || 50, 100);
    if (!slug) {
        return errorResult("slug is required");
    }
    try {
        const event = (await fetchGamma(`/events/slug/${slug}`));
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
        const comments = (await fetchGamma(`/comments?parent_entity_type=Event&parent_entity_id=${eventId}&limit=${limit}&order=createdAt&ascending=false`));
        const normalized = Array.isArray(comments) ? comments : [];
        const formattedComments = normalized.map((comment) => ({
            id: comment.id || "",
            author: comment.profile?.pseudonym ||
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
    }
    catch {
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
async function handleGetAllCategories(args) {
    const limit = args?.limit || 50;
    try {
        // Fetch categories from Gamma API
        const categories = await fetchGamma(`/categories?limit=${limit}`);
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
    }
    catch (error) {
        return errorResult(`Failed to get categories: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetAllTags(args) {
    const limit = args?.limit || 100;
    try {
        // Fetch tags from Gamma API
        const tags = await fetchGamma(`/tags?limit=${limit}`);
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
    }
    catch (error) {
        return errorResult(`Failed to get tags: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleBrowseCategory(args) {
    // Accept both "category" and "slug" parameters for flexibility (AI sometimes uses wrong name)
    const category = (args?.category || args?.slug);
    const limit = args?.limit || 50;
    const sortBy = args?.sortBy || "volume";
    const includeResolved = args?.includeResolved === true;
    if (!category) {
        return errorResult("category parameter is required. Use get_all_categories to find available categories.");
    }
    try {
        const closed = includeResolved ? "true" : "false";
        const orderField = sortBy === "endDate" ? "endDate" : sortBy === "liquidity" ? "liquidity" : "volume";
        const tagSlug = normalizeDiscoveryCategoryTagSlug(category) ??
            normalizeMarketQueryText(category).replace(/\s+/g, "-");
        const eventParams = new URLSearchParams({
            closed,
            limit: String(limit),
            order: orderField,
            ascending: "false",
            tag_slug: tagSlug,
        });
        const filteredEvents = (await fetchGamma(`/events?${eventParams.toString()}`));
        const browseCategoryQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(getRepresentativeGammaMarkets(filteredEvents, {
            preference: includeResolved ? "any" : "tradable",
        }), {
            timeoutMs: "heavy",
        });
        const formatted = filteredEvents
            .filter((e) => e.slug)
            .slice(0, limit) // Apply limit after filtering
            .map((e) => {
            const market = getRepresentativeGammaMarket(e, {
                preference: includeResolved ? "any" : "tradable",
            });
            const yesPrice = market
                ? resolveCurrentOutcomePrice(market, browseCategoryQuoteSnapshots)
                : 0.5;
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
            category: tagSlug,
            events: formatted,
            totalCount: formatted.length,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to browse category: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleBrowseByTag(args) {
    const tag_id = args?.tag_id;
    const limit = args?.limit || 50;
    const includeResolved = args?.includeResolved === true;
    if (!tag_id) {
        return errorResult("tag_id parameter is required. Use get_all_tags to find available tags.");
    }
    try {
        const closed = includeResolved ? "true" : "false";
        const events = await fetchGamma(`/events?tag_id=${tag_id}&closed=${closed}&limit=${limit}&order=volume&ascending=false`);
        const browseTagQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(getRepresentativeGammaMarkets(events, {
            preference: includeResolved ? "any" : "tradable",
        }), {
            timeoutMs: "heavy",
        });
        const formatted = (events || [])
            .filter((e) => e.slug)
            .map((e) => {
            const market = getRepresentativeGammaMarket(e, {
                preference: includeResolved ? "any" : "tradable",
            });
            const yesPrice = market
                ? resolveCurrentOutcomePrice(market, browseTagQuoteSnapshots)
                : 0.5;
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
    }
    catch (error) {
        return errorResult(`Failed to browse by tag: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
// ============================================================================
// NEW TIER 1 INTELLIGENCE HANDLER: analyze_top_holders
// ============================================================================
async function handleAnalyzeTopHolders(args) {
    const conditionId = args?.conditionId;
    const slug = args?.slug;
    const marketQuery = args?.marketQuery;
    const deepFetch = args?.deepFetch !== false;
    const limit = typeof args?.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(args.limit, 1), 100)
        : deepFetch
            ? 50
            : 20;
    if (!conditionId && !slug && !marketQuery) {
        return errorResult("Provide one of: conditionId, slug, or marketQuery");
    }
    const resolved = await resolveMarketReference({
        conditionId,
        slug,
        marketQuery,
    });
    if (!resolved?.conditionId) {
        return errorResult(marketQuery
            ? `Could not resolve marketQuery '${marketQuery}' to a market conditionId (searched active and resolved markets). Try adding a date or a more specific title.`
            : "Could not resolve conditionId from provided inputs");
    }
    const resolvedConditionId = resolved.conditionId;
    let marketTitle = resolved.marketTitle;
    // Get top holders using the raw data handler with an optional shallow mode
    // so composite workflows can stay within query-mode latency bounds.
    const holdersResult = await handleGetTopHolders({
        conditionId: resolvedConditionId,
        outcome: "BOTH",
        limit,
        deepFetch,
    });
    if (holdersResult.isError) {
        return holdersResult;
    }
    const holdersData = JSON.parse(holdersResult.content[0].text);
    // Get current market price
    let currentPrice = 0.5;
    let noPrice = 0.5;
    try {
        const market = (await fetchClob(`/markets/${resolvedConditionId}`, undefined, "heavy"));
        const tokens = market?.tokens;
        if (tokens && tokens.length >= 2) {
            const quoteSnapshots = await fetchClobQuoteSnapshots([tokens[0].token_id, tokens[1].token_id], "heavy");
            currentPrice = quoteSnapshots[tokens[0].token_id]?.midpoint || currentPrice;
            noPrice = quoteSnapshots[tokens[1].token_id]?.midpoint || noPrice;
        }
    }
    catch {
        // Use defaults
    }
    // Analyze YES whales
    const yesWhales = (holdersData.topHolders?.yes || []).slice(0, 10).map((h) => {
        // Estimate if they're in profit based on current price vs typical entry
        // If price is high, assume early holders are in profit
        const estimatedEntry = currentPrice * 0.7; // Rough estimate
        const currentValue = h.size * currentPrice;
        const estimatedInitial = h.size * estimatedEntry;
        const unrealizedPnL = currentValue - estimatedInitial;
        const convictionScore = getHolderConvictionScore(h.value, h.percentOfSupply);
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
    const noWhales = (holdersData.topHolders?.no || []).slice(0, 10).map((h) => {
        const estimatedEntry = noPrice * 0.7;
        const currentValue = h.size * noPrice;
        const estimatedInitial = h.size * estimatedEntry;
        const unrealizedPnL = currentValue - estimatedInitial;
        const convictionScore = getHolderConvictionScore(h.value, h.percentOfSupply);
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
    const top5YesPercent = holdersData.topHolders?.yes?.slice(0, 5).reduce((sum, h) => sum + h.percentOfSupply, 0) || 0;
    const top5NoPercent = holdersData.topHolders?.no?.slice(0, 5).reduce((sum, h) => sum + h.percentOfSupply, 0) || 0;
    let concentrationRisk;
    if (top5YesPercent > 50 || top5NoPercent > 50)
        concentrationRisk = "high";
    else if (top5YesPercent > 30 || top5NoPercent > 30)
        concentrationRisk = "moderate";
    else
        concentrationRisk = "low";
    // Determine smart money signal
    const totalYesValue = yesWhales.reduce((sum, w) => sum + w.positionValue, 0);
    const totalNoValue = noWhales.reduce((sum, w) => sum + w.positionValue, 0);
    const yesExtreme = yesWhales.filter((w) => w.convictionScore === "extreme" || w.convictionScore === "high").length;
    const noExtreme = noWhales.filter((w) => w.convictionScore === "extreme" || w.convictionScore === "high").length;
    let direction;
    let confidence;
    let reasoning;
    if (totalYesValue > totalNoValue * 1.5 && yesExtreme > noExtreme) {
        direction = "YES";
        confidence = yesExtreme >= 3 ? "high" : "medium";
        reasoning = `${yesWhales.length} top holders with $${totalYesValue.toFixed(0)} in YES positions vs $${totalNoValue.toFixed(0)} in NO. ${yesExtreme} high-conviction YES holders.`;
    }
    else if (totalNoValue > totalYesValue * 1.5 && noExtreme > yesExtreme) {
        direction = "NO";
        confidence = noExtreme >= 3 ? "high" : "medium";
        reasoning = `${noWhales.length} top holders with $${totalNoValue.toFixed(0)} in NO positions vs $${totalYesValue.toFixed(0)} in YES. ${noExtreme} high-conviction NO holders.`;
    }
    else {
        direction = "NEUTRAL";
        confidence = "low";
        reasoning = `Whale positions roughly balanced. YES: $${totalYesValue.toFixed(0)}, NO: $${totalNoValue.toFixed(0)}. No clear smart money consensus.`;
    }
    // Generate recommendation
    let recommendation;
    if (direction !== "NEUTRAL" && confidence !== "low") {
        recommendation = `Smart money appears to favor ${direction}. Consider aligning with whale positions, but verify with your own research.`;
    }
    else if (concentrationRisk === "high") {
        recommendation = `⚠️ High concentration risk - top 5 holders control ${Math.max(top5YesPercent, top5NoPercent).toFixed(0)}% of supply. Large exits could move price significantly.`;
    }
    else {
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
            largeHolderCount: holdersData.concentration?.largeHolderCount || 0,
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
async function handleAnalyzeEventWhaleBreakdown(args) {
    const rawQuery = typeof args?.query === "string" ? args.query.trim() : "";
    let slug = typeof args?.slug === "string" ? args.slug.trim() : "";
    const marketQuery = typeof args?.marketQuery === "string" ? args.marketQuery.trim() : rawQuery;
    const requestedOutcomes = workflowUniqueStrings([
        ...workflowStringArray(args?.outcomes),
        ...workflowExtractComparisonOutcomesFromQuery(rawQuery || marketQuery),
    ]).slice(0, 20);
    const maxOutcomes = Math.min(args?.maxOutcomes || 10, 20);
    let selectionReason = slug.length > 0 ? "Used the provided event slug." : "";
    if (!slug && !marketQuery) {
        const fallbackCandidate = await resolveFallbackTopMarketCandidate({
            sortBy: "volume",
            preferMultiOutcome: true,
        });
        if (!fallbackCandidate?.slug) {
            return errorResult("Either 'slug' or 'marketQuery' is required. Provide an event slug (e.g., '2026-fifa-world-cup-winner-595') or a natural-language query (e.g., '2026 FIFA World Cup winner').");
        }
        slug = fallbackCandidate.slug;
        selectionReason =
            "Committed to analyzing the strongest live multi-outcome Polymarket event as a best-effort substitute when an explicit event reference was absent.";
    }
    try {
        if (!slug && marketQuery) {
            const resolvedEvent = await workflowResolveEventDataForAnalysis({
                eventQuery: marketQuery,
                sortBy: "volume",
            });
            const searchData = resolvedEvent.eventData;
            slug =
                typeof searchData.eventSlug === "string" ? searchData.eventSlug.trim() : "";
            if (!slug) {
                const fallbackCandidate = await resolveFallbackTopMarketCandidate({
                    sortBy: "volume",
                    preferMultiOutcome: true,
                });
                if (!fallbackCandidate?.slug) {
                    return errorResult(`Could not resolve an event from query: "${marketQuery}". Try providing the event slug directly.`);
                }
                slug = fallbackCandidate.slug;
                selectionReason =
                    "Committed to analyzing the strongest live multi-outcome Polymarket event as a best-effort substitute for the user's event query.";
            }
            else {
                selectionReason = resolvedEvent.selectionReason;
            }
        }
        // Fetch the event with all its markets
        const event = (await fetchGamma(`/events/slug/${slug}`, "heavy"));
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
        const selectedMarkets = [];
        const usedConditionIds = new Set();
        const unmatchedOutcomes = [];
        if (requestedOutcomes.length > 0) {
            for (const requestedName of requestedOutcomes) {
                let bestMatch = null;
                let bestScore = 0;
                for (const market of sortedMarkets) {
                    const conditionId = typeof market.conditionId === "string" ? market.conditionId : "";
                    const candidateName = deriveGammaOutcomeName(market);
                    if (!conditionId || usedConditionIds.has(conditionId) || candidateName.length === 0) {
                        continue;
                    }
                    const score = workflowScoreOutcomeMatch(requestedName, candidateName);
                    if (score > bestScore) {
                        bestMatch = market;
                        bestScore = score;
                    }
                }
                if (!bestMatch || bestScore < 30 || !bestMatch.conditionId) {
                    unmatchedOutcomes.push(requestedName);
                    continue;
                }
                usedConditionIds.add(bestMatch.conditionId);
                selectedMarkets.push(bestMatch);
            }
        }
        const fallbackMarketBudget = selectedMarkets.length > 0 ? maxOutcomes : Math.min(maxOutcomes, 6);
        const mixedFallbackMarkets = [];
        const fallbackConditionIds = new Set();
        const pushFallbackMarket = (market) => {
            const conditionId = typeof market.conditionId === "string" ? market.conditionId : "";
            if (!conditionId || fallbackConditionIds.has(conditionId)) {
                return;
            }
            fallbackConditionIds.add(conditionId);
            mixedFallbackMarkets.push(market);
        };
        if (selectedMarkets.length === 0) {
            const topByPrice = [...sortedMarkets]
                .sort((left, right) => resolveCurrentOutcomePrice(right) - resolveCurrentOutcomePrice(left))
                .slice(0, Math.min(fallbackMarketBudget, 5));
            for (const market of topByPrice) {
                pushFallbackMarket(market);
            }
            for (const market of sortedMarkets) {
                if (mixedFallbackMarkets.length >= fallbackMarketBudget) {
                    break;
                }
                pushFallbackMarket(market);
            }
        }
        const marketsToAnalyze = selectedMarkets.length > 0 ? selectedMarkets : mixedFallbackMarkets;
        const selectionMode = selectedMarkets.length > 0 ? "requested_outcomes" : "top_volume_outcomes";
        if (selectionMode === "requested_outcomes") {
            selectionReason = `${selectionReason || "Resolved the requested event."} Bounded whale analysis to the named shortlist instead of scanning the whole event.`;
        }
        else {
            selectionReason = `${selectionReason || "Resolved the requested event."} Used a bounded mixed shortlist of high-price and high-volume outcomes to avoid timing out on large events.`;
        }
        const whaleQuoteSnapshots = await fetchGammaMarketQuoteSnapshots(marketsToAnalyze, {
            timeoutMs: marketsToAnalyze.length <= 6 ? "default" : "heavy",
        });
        // Fetch holders for each market in parallel (with rate limiting)
        const whaleResults = [];
        // Process in batches of 3 to avoid overwhelming the API
        const batchSize = 3;
        for (let i = 0; i < marketsToAnalyze.length; i += batchSize) {
            const batch = marketsToAnalyze.slice(i, i + batchSize);
            const batchPromises = batch.map(async (market) => {
                const conditionId = market.conditionId;
                if (!conditionId)
                    return null;
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
                    const holdersData = workflowExtractToolData(holdersResult, "get_top_holders");
                    const topHolders = workflowObject(holdersData.topHolders);
                    const yesHolders = workflowObjectArray(topHolders.yes);
                    const positionValueSummary = workflowObject(holdersData.positionValueSummary);
                    const holdersReturned = workflowObject(holdersData.holdersReturned);
                    const holdersScanned = workflowObject(holdersData.holdersScanned);
                    const totalWhaleValue = workflowToNumber(positionValueSummary.yesWhaleValue, yesHolders.reduce((sum, holder) => {
                        const value = workflowToNumber(holder.value, 0);
                        if (isMeaningfulHolderWhale(value, workflowToNumber(holder.percentOfSupply, 0))) {
                            return sum + value;
                        }
                        return sum;
                    }, 0));
                    const topWhaleHolder = yesHolders.find((holder) => isMeaningfulHolderWhale(workflowToNumber(holder.value, 0), workflowToNumber(holder.percentOfSupply, 0)));
                    const topWhalePosition = workflowToNumber(topWhaleHolder?.value, 0);
                    const whaleCount = workflowToNumber(positionValueSummary.yesWhaleCount, yesHolders.filter((holder) => isMeaningfulHolderWhale(workflowToNumber(holder.value, 0), workflowToNumber(holder.percentOfSupply, 0))).length);
                    const scannedHolderCount = workflowToNumber(holdersScanned.yes, yesHolders.length);
                    const returnedHolderSampleCount = workflowToNumber(holdersReturned.yes, yesHolders.length);
                    const currentPrice = resolveCurrentOutcomePrice(market, whaleQuoteSnapshots);
                    return {
                        outcome: outcomeName,
                        conditionId,
                        currentPrice,
                        totalWhaleValue,
                        topWhalePosition,
                        whaleCount,
                        holdersScanned: scannedHolderCount,
                        returnedHolderSampleCount,
                    };
                }
                catch {
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
            let convictionLevel;
            if (r.totalWhaleValue > 50000)
                convictionLevel = "extreme";
            else if (r.totalWhaleValue > 10000)
                convictionLevel = "high";
            else if (r.totalWhaleValue > 1000)
                convictionLevel = "moderate";
            else
                convictionLevel = "low";
            return {
                rank: idx + 1,
                outcome: r.outcome,
                conditionId: r.conditionId,
                currentPrice: Number(r.currentPrice.toFixed(4)),
                totalWhaleValue: Number(r.totalWhaleValue.toFixed(2)),
                topWhalePosition: Number(r.topWhalePosition.toFixed(2)),
                whaleCount: Number(r.whaleCount.toFixed(0)),
                holdersScanned: Number(r.holdersScanned.toFixed(0)),
                returnedHolderSampleCount: Number(r.returnedHolderSampleCount.toFixed(0)),
                convictionLevel,
            };
        });
        // Determine top whale outcome
        const topOutcome = whalesByOutcome[0];
        const secondOutcome = whalesByOutcome[1];
        let confidence = "low";
        if (topOutcome && secondOutcome) {
            if (topOutcome.totalWhaleValue > secondOutcome.totalWhaleValue * 2) {
                confidence = "high";
            }
            else if (topOutcome.totalWhaleValue > secondOutcome.totalWhaleValue * 1.3) {
                confidence = "medium";
            }
        }
        else if (topOutcome && topOutcome.totalWhaleValue > 10000) {
            confidence = "medium";
        }
        // Generate smart money consensus
        let smartMoneyConsensus;
        if (!topOutcome || topOutcome.totalWhaleValue < 1000) {
            smartMoneyConsensus = "No significant whale positions detected across outcomes. Market may be too new or lack smart money interest.";
        }
        else if (confidence === "high") {
            smartMoneyConsensus = `Strong whale consensus on "${topOutcome.outcome}" with $${topOutcome.totalWhaleValue.toFixed(0)} in positions (${topOutcome.whaleCount} whales). This is ${(topOutcome.totalWhaleValue / (secondOutcome?.totalWhaleValue || 1)).toFixed(1)}x the next closest outcome.`;
        }
        else if (confidence === "medium") {
            smartMoneyConsensus = `Moderate whale preference for "${topOutcome.outcome}" ($${topOutcome.totalWhaleValue.toFixed(0)}) over "${secondOutcome?.outcome || 'others'}" ($${secondOutcome?.totalWhaleValue.toFixed(0) || 0}). Not a strong consensus.`;
        }
        else {
            smartMoneyConsensus = `Whale positions spread across multiple outcomes. "${topOutcome.outcome}" has slight edge ($${topOutcome.totalWhaleValue.toFixed(0)}) but no clear smart money consensus.`;
        }
        return successResult({
            eventTitle,
            eventSlug: slug,
            totalMarketsInEvent,
            totalMarketsAnalyzed: whaleResults.length,
            selectionMode,
            whalesByOutcome,
            unmatchedOutcomes,
            topWhaleOutcome: topOutcome ? {
                outcome: topOutcome.outcome,
                totalValue: topOutcome.totalWhaleValue,
                confidence,
            } : null,
            smartMoneyConsensus,
            selectionReason,
            synthesisHint: "Use whalesByOutcome as the only grounded whale-backing evidence. If whalesByOutcome is empty or requested outcomes appear in unmatchedOutcomes, say whale data was unavailable for those names instead of substituting plain trading volume as a whale proxy.",
            note: `Analyzed ${whaleResults.length} of ${totalMarketsInEvent} markets. Whale totals and whale counts use the full deep holder scan for each outcome (single /holders call with limit=500 per side; falls back to a paced minBalance tier sweep only if the upstream regresses). Returned holder samples may still be truncated for payload size. The outcome with the most whale money suggests smart money's pick.`,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to analyze event whale breakdown: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
// PolymarketContext and PolymarketPosition are imported from @ctxprotocol/sdk
// ============================================================================
// EXPRESS SERVER
// ============================================================================
const app = express();
app.use(express.json());
// Store transports for Streamable HTTP
const transports = {};
// Auth middleware using @ctxprotocol/sdk - 1 line!
const verifyContextAuth = createContextMiddleware();
const allowUnauthenticatedMcp = process.env.POLYMARKET_ALLOW_UNAUTH_MCP === "true";
const mcpAuthMiddleware = allowUnauthenticatedMcp
    ? (_req, _res, next) => {
        next();
    }
    : verifyContextAuth;
if (allowUnauthenticatedMcp) {
    console.warn("[polymarket-auth] POLYMARKET_ALLOW_UNAUTH_MCP=true (auth disabled for /mcp; use only for temporary debugging).");
}
app.get("/health", (_req, res) => {
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
app.post("/mcp", mcpAuthMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
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
    }
    else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Invalid session. Send initialize request first." },
            id: null,
        });
        return;
    }
    await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", mcpAuthMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = transports[sessionId];
    if (transport) {
        await transport.handleRequest(req, res);
    }
    else {
        res.status(400).json({ error: "Invalid session" });
    }
});
app.delete("/mcp", mcpAuthMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = transports[sessionId];
    if (transport) {
        await transport.handleRequest(req, res);
    }
    else {
        res.status(400).json({ error: "Invalid session" });
    }
});
app.get("/debug-tools", (_req, res) => {
    const analyzePos = TOOLS_WITH_METADATA.find((t) => t.name === "analyze_my_positions");
    const toolMeta = analyzePos?._meta && typeof analyzePos._meta === "object"
        ? analyzePos._meta
        : undefined;
    res.json({
        name: analyzePos?.name,
        _meta: toolMeta,
        contextRequirements: toolMeta && Array.isArray(toolMeta.contextRequirements)
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
