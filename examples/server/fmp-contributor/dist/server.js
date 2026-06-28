/**
 * Financial Modeling Prep (FMP) MCP Server v1.0
 *
 * Read-only equities and market intelligence over the official FMP "stable" REST API
 * (https://financialmodelingprep.com/stable). Covers symbol discovery, quotes,
 * company profiles, financial statements, ratios/key-metrics, analyst consensus,
 * historical prices, technical indicators, market movers, screening, and news.
 *
 * Auth model: a single contributor-hosted FMP API key (FMP_API_KEY) is appended as
 * the `apikey` query parameter on every upstream request. There is no per-user context
 * injection, so every tool advertises an empty `_meta.contextRequirements`.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import express from "express";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PORT = 4011;
const FMP_BASE_URL = "https://financialmodelingprep.com/stable";
const DEFAULT_EXECUTE_USD = process.env.FMP_DEFAULT_EXECUTE_USD?.trim() || "0.001";
const DEFAULT_STATEMENT_LIMIT = getConfiguredNumber("FMP_DEFAULT_STATEMENT_LIMIT", 8, 1, 50);
const DEFAULT_NEWS_LIMIT = getConfiguredNumber("FMP_DEFAULT_NEWS_LIMIT", 25, 1, 250);
const REQUEST_TIMEOUT_MS = getConfiguredNumber("FMP_REQUEST_TIMEOUT_MS", 20_000, 1_000, 120_000);
const PLACEHOLDER_API_KEY = "replace-with-your-fmp-api-key";
const STATEMENT_SLUGS = {
    income: "income-statement",
    balance: "balance-sheet-statement",
    cash: "cash-flow-statement",
};
const MOVER_SLUGS = {
    gainers: "biggest-gainers",
    losers: "biggest-losers",
    actives: "most-actives",
};
const NEWS_CATEGORIES = new Set([
    "stock",
    "press-releases",
    "crypto",
    "forex",
    "general",
]);
const TECHNICAL_INDICATORS = new Set([
    "sma",
    "ema",
    "wma",
    "dema",
    "tema",
    "rsi",
    "standarddeviation",
    "williams",
    "adx",
]);
const TECHNICAL_TIMEFRAMES = new Set([
    "1min",
    "5min",
    "15min",
    "30min",
    "1hour",
    "4hour",
    "1day",
]);
function getConfiguredNumber(name, fallback, min, max) {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}
function getFmpApiKey() {
    const apiKey = process.env.FMP_API_KEY?.trim();
    if (!apiKey || apiKey === PLACEHOLDER_API_KEY) {
        throw new Error("FMP_API_KEY is required. Put your Financial Modeling Prep API key in fmp-contributor/.env.");
    }
    return apiKey;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toJsonValue(value) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return value;
    }
    if (value === undefined) {
        return null;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (Array.isArray(value)) {
        return value.map((item) => toJsonValue(item));
    }
    if (isRecord(value)) {
        const output = {};
        for (const [key, entry] of Object.entries(value)) {
            output[key] = toJsonValue(entry);
        }
        return output;
    }
    return String(value);
}
function toJsonObject(value) {
    const converted = toJsonValue(value);
    return isJsonObject(converted) ? converted : { value: converted };
}
function toJsonObjectArray(value) {
    if (Array.isArray(value)) {
        return value.map((item) => (isJsonObject(item) ? item : { value: item }));
    }
    if (value === null) {
        return [];
    }
    return [isJsonObject(value) ? value : { value }];
}
function getArgs(request) {
    const args = request.params.arguments;
    return isRecord(args) ? args : {};
}
function getString(args, key) {
    const value = args[key];
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : null;
}
function getBoolean(args, key) {
    return args[key] === true || args[key] === "true";
}
function getNumber(args, key, fallback, min, max) {
    const value = args[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
}
function getOptionalNumber(args, key) {
    if (!(key in args)) {
        return null;
    }
    const value = args[key];
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function getStringArray(args, key, fallback = []) {
    const value = args[key];
    if (Array.isArray(value)) {
        const values = [];
        for (const item of value) {
            if (typeof item === "string" && item.trim().length > 0) {
                values.push(item.trim());
            }
        }
        return values;
    }
    if (typeof value === "string" && value.trim().length > 0) {
        return value
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item.length > 0);
    }
    return fallback;
}
function getSymbols(args) {
    const fromList = getStringArray(args, "symbols");
    if (fromList.length > 0) {
        return fromList.map((symbol) => symbol.toUpperCase());
    }
    const single = getString(args, "symbol");
    if (single) {
        return [single.toUpperCase()];
    }
    throw new Error("A symbol is required. Pass `symbol` or `symbols`.");
}
function requireSymbol(args) {
    const single = getString(args, "symbol") ?? getStringArray(args, "symbols")[0];
    if (!single) {
        throw new Error("`symbol` is required.");
    }
    return single.toUpperCase();
}
function extractFmpError(parsed) {
    if (typeof parsed === "string") {
        return parsed;
    }
    if (isRecord(parsed)) {
        const candidate = parsed["Error Message"] ?? parsed["error"] ?? parsed["message"];
        if (typeof candidate === "string") {
            return candidate;
        }
    }
    return null;
}
function formatFmpError(status, message, path) {
    if (status === 401 || status === 403) {
        return `FMP rejected the request for ${path} (HTTP ${status}). The FMP_API_KEY is missing, invalid, or not authorized for this endpoint. Upstream message: ${message}`;
    }
    if (status === 402) {
        return `FMP endpoint ${path} requires a higher subscription tier (HTTP 402). Upstream message: ${message}`;
    }
    if (status === 429) {
        return `FMP rate limit hit for ${path} (HTTP 429). Reduce request frequency or upgrade the plan. Upstream message: ${message}`;
    }
    return `FMP request to ${path} failed (HTTP ${status}): ${message}`;
}
async function fmpGet(path, query = {}) {
    const apiKey = getFmpApiKey();
    const url = new URL(`${FMP_BASE_URL}${path}`);
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") {
            continue;
        }
        url.searchParams.set(key, String(value));
    }
    url.searchParams.set("apikey", apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(url, {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
    }
    catch (error) {
        const err = error;
        if (err.name === "AbortError") {
            throw new Error(`FMP request timed out after ${REQUEST_TIMEOUT_MS}ms for ${path}.`);
        }
        // Never echo the URL (it carries the apikey); surface only the path.
        throw new Error(`FMP request failed for ${path}: ${err.message}`);
    }
    finally {
        clearTimeout(timeout);
    }
    const bodyText = await response.text();
    let parsed = null;
    if (bodyText.length > 0) {
        try {
            parsed = JSON.parse(bodyText);
        }
        catch {
            if (!response.ok) {
                throw new Error(formatFmpError(response.status, bodyText.slice(0, 200), path));
            }
            throw new Error(`FMP returned a non-JSON response for ${path}: ${bodyText.slice(0, 200)}`);
        }
    }
    if (!response.ok) {
        const message = extractFmpError(parsed) ?? `HTTP ${response.status}`;
        throw new Error(formatFmpError(response.status, message, path));
    }
    const inlineError = extractFmpError(parsed);
    if (inlineError && isRecord(parsed) && !Array.isArray(parsed)) {
        throw new Error(formatFmpError(response.status, inlineError, path));
    }
    return toJsonValue(parsed);
}
async function fmpGetArray(path, query = {}) {
    return toJsonObjectArray(await fmpGet(path, query));
}
async function fmpTryArray(path, query = {}) {
    try {
        return { data: await fmpGetArray(path, query), error: null };
    }
    catch (error) {
        return {
            data: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
// ============================================================================
// Result helpers
// ============================================================================
function successResult(text, structuredContent) {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}
function errorResult(error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        structuredContent: { ok: false, error: message },
    };
}
function applyLatestLimit(rows, limit) {
    if (limit === null || limit <= 0 || rows.length <= limit) {
        return rows;
    }
    return rows.slice(0, limit);
}
function jsonString(row, key) {
    const value = row[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function jsonNumber(row, key) {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function dateBounds(rows) {
    let earliest = null;
    let latest = null;
    for (const row of rows) {
        const date = jsonString(row, "date") ?? jsonString(row, "publishedDate");
        if (!date) {
            continue;
        }
        if (earliest === null || date < earliest) {
            earliest = date;
        }
        if (latest === null || date > latest) {
            latest = date;
        }
    }
    return { earliest, latest };
}
function toolMeta(latencyClass, notes, options = {}) {
    const rateLimitNotes = [
        "Contributor-hosted Financial Modeling Prep API key (FMP_API_KEY); no user wallet/portfolio context is injected.",
        "FMP per-plan rate and daily request limits apply; some endpoints and non-US coverage require a paid tier.",
        notes,
    ]
        .filter((entry) => entry.trim().length > 0)
        .join(" ");
    return {
        surface: "answer",
        queryEligible: true,
        latencyClass,
        // Pure market-data provider: no per-user context types are required.
        contextRequirements: [],
        rateLimit: {
            maxConcurrency: options.maxConcurrency ?? 2,
            ...(options.supportsBulk === true ? { supportsBulk: true } : {}),
            ...(options.recommendedBatchTools
                ? { recommendedBatchTools: options.recommendedBatchTools }
                : {}),
            notes: rateLimitNotes,
        },
        ...(options.executeUsd
            ? { pricing: { executeUsd: options.executeUsd } }
            : {}),
    };
}
const genericObjectSchema = {
    type: "object",
    additionalProperties: true,
};
const objectArraySchema = {
    type: "array",
    items: genericObjectSchema,
};
// ============================================================================
// Tool definitions
// ============================================================================
const TOOLS = [
    {
        name: "check_api_status",
        description: "Check Financial Modeling Prep connectivity and validate the configured FMP API key. Use this first when diagnosing auth or upstream availability before other FMP tools.",
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: {
            type: "object",
            properties: {
                status: { type: "string" },
                probeSymbol: { type: "string" },
                sample: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["status", "probeSymbol", "sample", "fetchedAt"],
        },
        _meta: toolMeta("instant", "Single lightweight quote probe to FMP."),
    },
    {
        name: "search_symbols",
        description: "Search for tradable symbols by ticker (default) or company name. Use to resolve a company or ETF to its FMP symbol and exchange before requesting quotes, statements, or analysis. Set byName=true to search by company name instead of ticker.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Ticker fragment or company name, e.g. AAPL or Apple.",
                    default: "AAPL",
                    examples: ["AAPL", "Apple", "NVDA"],
                },
                byName: {
                    type: "boolean",
                    description: "Search by company name (search-name) instead of ticker (search-symbol).",
                    default: false,
                    examples: [false, true],
                },
                exchange: {
                    type: "string",
                    description: "Optional exchange filter such as NASDAQ or NYSE.",
                    examples: ["NASDAQ", "NYSE"],
                },
                limit: {
                    type: "number",
                    description: "Maximum matches to return (default 20).",
                    default: 20,
                    examples: [10, 20, 50],
                },
            },
            required: ["query"],
        },
        outputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                matchCount: { type: "number" },
                matches: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["query", "matchCount", "matches", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Symbol/name discovery request."),
    },
    {
        name: "get_company_profile",
        description: "Fetch company profile data for one or more symbols: sector, industry, market cap, beta, exchange, CEO, description, employee count, website, and identifiers. Use for company overviews and fundamental context.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Single ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                symbols: {
                    type: "array",
                    items: { type: "string", default: "AAPL", examples: ["AAPL", "MSFT", "NVDA"] },
                    description: "Multiple tickers (capped at 10 per call). Use instead of symbol for several companies.",
                    examples: [["AAPL", "MSFT"], ["NVDA", "AMD"]],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                profileCount: { type: "number" },
                profiles: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["profileCount", "profiles", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Company profile lookup (one upstream call per symbol)."),
    },
    {
        name: "get_stock_quote",
        description: "Fetch full real-time quotes for one or more symbols: price, change, day/year range, volume, average volume, market cap, PE, EPS, and previous close. Pass several symbols to use FMP batch-quote in a single call. Use for current price/market-state questions.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Single ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                symbols: {
                    type: "array",
                    items: { type: "string", default: "AAPL", examples: ["AAPL", "MSFT", "NVDA"] },
                    description: "Multiple tickers for a batch quote, such as AAPL, MSFT, NVDA.",
                    examples: [["AAPL", "MSFT", "NVDA"]],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                quoteCount: { type: "number" },
                quotes: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["quoteCount", "quotes", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Real-time quote lookup; batches multiple symbols.", {
            supportsBulk: true,
        }),
    },
    {
        name: "get_historical_prices",
        description: "Fetch end-of-day historical OHLCV prices for a symbol over an optional date range (from/to as YYYY-MM-DD). series=full returns OHLCV plus change, changePercent, and VWAP; series=light returns date/open/high/low/close/volume. Use for price history, returns, drawdowns, or charting.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                from: { type: "string", description: "Start date YYYY-MM-DD (optional).", examples: ["2025-01-01"] },
                to: { type: "string", description: "End date YYYY-MM-DD (optional).", examples: ["2025-12-31"] },
                series: {
                    type: "string",
                    enum: ["full", "light"],
                    description: "full (default) or light EOD series.",
                    default: "full",
                },
                limit: {
                    type: "number",
                    description: "Optional cap on the most recent rows returned.",
                    default: 30,
                    examples: [30, 90, 250],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                rowCount: { type: "number" },
                earliestDate: { type: ["string", "null"] },
                latestDate: { type: ["string", "null"] },
                rows: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "rowCount", "earliestDate", "latestDate", "rows", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Historical EOD price series; can be large for long ranges.", {
            executeUsd: DEFAULT_EXECUTE_USD,
            supportsBulk: true,
        }),
    },
    {
        name: "get_financial_statements",
        description: "Fetch reported financial statements for a symbol. statement=income returns the income statement, balance returns the balance sheet, cash returns the cash flow statement. period=annual or quarter; limit controls how many periods are returned (most recent first). Use for revenue, margins, assets, liabilities, equity, operating/free cash flow analysis.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                statement: {
                    type: "string",
                    enum: ["income", "balance", "cash"],
                    description: "income (income-statement), balance (balance-sheet-statement), or cash (cash-flow-statement).",
                    default: "income",
                },
                period: {
                    type: "string",
                    enum: ["annual", "quarter"],
                    description: "Reporting period (default annual).",
                    default: "annual",
                },
                limit: {
                    type: "number",
                    description: "Number of periods to return (default 8).",
                    default: 8,
                    examples: [4, 8, 12],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                statement: { type: "string" },
                period: { type: "string" },
                periodCount: { type: "number" },
                statements: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "statement", "period", "periodCount", "statements", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Reported financial statement rows.", {
            executeUsd: DEFAULT_EXECUTE_USD,
        }),
    },
    {
        name: "get_financial_ratios",
        description: "Fetch valuation, profitability, liquidity, and leverage ratios plus key metrics for a symbol. Set ttm=true for trailing-twelve-month snapshots (ratios-ttm + key-metrics-ttm); otherwise returns period series (annual/quarter). Use for PE, PB, ROE, ROIC, margins, current ratio, debt ratios, and per-share metrics.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                ttm: {
                    type: "boolean",
                    description: "Return trailing-twelve-month snapshot instead of period series.",
                    default: false,
                    examples: [false, true],
                },
                period: {
                    type: "string",
                    enum: ["annual", "quarter"],
                    description: "Reporting period for non-TTM series (default annual).",
                    default: "annual",
                },
                limit: {
                    type: "number",
                    description: "Number of periods for non-TTM series (default 8).",
                    default: 8,
                    examples: [4, 8, 12],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                ttm: { type: "boolean" },
                ratios: objectArraySchema,
                keyMetrics: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "ttm", "ratios", "keyMetrics", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Ratios and key metrics (two upstream calls)."),
    },
    {
        name: "get_analyst_insights",
        description: "Fetch a composite analyst view for a symbol: price-target consensus and summary, analyst grade consensus (buy/hold/sell distribution), and forward analyst estimates. Use for Wall Street sentiment, target prices, and rating distributions. Subsections that require a higher FMP tier are reported with their error rather than failing the call.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                estimateLimit: {
                    type: "number",
                    description: "Number of forward analyst-estimate periods to include (default 4).",
                    default: 4,
                    examples: [4, 8],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                priceTargetConsensus: objectArraySchema,
                priceTargetSummary: objectArraySchema,
                gradesConsensus: objectArraySchema,
                analystEstimates: objectArraySchema,
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "priceTargetConsensus", "priceTargetSummary", "gradesConsensus", "analystEstimates", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Composite analyst consensus across several endpoints.", {
            executeUsd: DEFAULT_EXECUTE_USD,
        }),
    },
    {
        name: "get_market_news",
        description: "Fetch market news by category: stock, press-releases, crypto, forex, or general. Provide symbols to filter stock/press-releases/crypto/forex news to specific tickers; omit symbols for the latest feed. Use page/limit for pagination. Pair with quotes or statements for event-aware analysis.",
        inputSchema: {
            type: "object",
            properties: {
                category: {
                    type: "string",
                    enum: ["stock", "press-releases", "crypto", "forex", "general"],
                    description: "News category (default stock). general ignores symbol filters.",
                    default: "stock",
                },
                symbols: {
                    type: "array",
                    items: { type: "string", default: "AAPL", examples: ["AAPL", "BTCUSD"] },
                    description: "Optional ticker filters such as AAPL or BTCUSD (not applicable to general).",
                    examples: [["AAPL"], ["AAPL", "MSFT"]],
                },
                page: { type: "number", description: "Zero-based page index (default 0).", default: 0, examples: [0, 1] },
                limit: {
                    type: "number",
                    description: "Maximum stories to return (default 25).",
                    default: 25,
                    examples: [10, 25, 50],
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                category: { type: "string" },
                storyCount: { type: "number" },
                stories: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["category", "storyCount", "stories", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Market news feed request."),
    },
    {
        name: "get_market_movers",
        description: "Fetch the day's biggest market movers: direction=gainers (biggest-gainers), losers (biggest-losers), or actives (most-actives). Use for momentum scans, watchlist seeding, and 'what is moving today' questions.",
        inputSchema: {
            type: "object",
            properties: {
                direction: {
                    type: "string",
                    enum: ["gainers", "losers", "actives"],
                    description: "Which mover list to return (default gainers).",
                    default: "gainers",
                },
                limit: {
                    type: "number",
                    description: "Maximum rows to return (default 25).",
                    default: 25,
                    examples: [10, 25, 50],
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                direction: { type: "string" },
                moverCount: { type: "number" },
                movers: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["direction", "moverCount", "movers", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Market movers snapshot."),
    },
    {
        name: "screen_stocks",
        description: "Screen the equity universe with the FMP company screener. Filter by market cap, price, beta, volume, dividend, sector, industry, exchange, country, and ETF/actively-trading flags. Use for discovery: 'large-cap technology stocks', 'high-dividend value names', etc. Returns matching symbols with basic profile fields.",
        inputSchema: {
            type: "object",
            properties: {
                marketCapMoreThan: { type: "number", examples: [1000000000, 10000000000] },
                marketCapLowerThan: { type: "number", examples: [500000000000] },
                priceMoreThan: { type: "number", examples: [10] },
                priceLowerThan: { type: "number", examples: [1000] },
                betaMoreThan: { type: "number", examples: [0.5] },
                betaLowerThan: { type: "number", examples: [2] },
                volumeMoreThan: { type: "number", examples: [1000000] },
                volumeLowerThan: { type: "number", examples: [100000000] },
                dividendMoreThan: { type: "number", examples: [0.5] },
                dividendLowerThan: { type: "number", examples: [20] },
                sector: { type: "string", description: "Sector such as Technology or Healthcare.", examples: ["Technology", "Healthcare"] },
                industry: { type: "string", description: "Industry such as Semiconductors.", examples: ["Semiconductors", "Software"] },
                exchange: { type: "string", description: "Exchange such as NASDAQ or NYSE.", examples: ["NASDAQ", "NYSE"] },
                country: { type: "string", description: "ISO country code such as US.", examples: ["US"] },
                isEtf: { type: "boolean", examples: [false, true] },
                isFund: { type: "boolean", examples: [false, true] },
                isActivelyTrading: { type: "boolean", examples: [true] },
                limit: {
                    type: "number",
                    description: "Maximum matches (default 50).",
                    default: 50,
                    examples: [25, 50, 100],
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                matchCount: { type: "number" },
                filters: genericObjectSchema,
                matches: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["matchCount", "filters", "matches", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Equity screener query."),
    },
    {
        name: "get_technical_indicator",
        description: "Fetch a technical indicator time series for a symbol. indicator is one of sma, ema, wma, dema, tema, rsi, standarddeviation, williams, adx. timeframe is one of 1min, 5min, 15min, 30min, 1hour, 4hour, 1day. periodLength sets the lookback window (e.g. 14 for RSI). Use for momentum, trend, and volatility signals.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                indicator: {
                    type: "string",
                    enum: ["sma", "ema", "wma", "dema", "tema", "rsi", "standarddeviation", "williams", "adx"],
                    description: "Indicator name (default rsi).",
                    default: "rsi",
                },
                periodLength: {
                    type: "number",
                    description: "Indicator lookback length (default 14).",
                    default: 14,
                    examples: [10, 14, 50, 200],
                },
                timeframe: {
                    type: "string",
                    enum: ["1min", "5min", "15min", "30min", "1hour", "4hour", "1day"],
                    description: "Bar timeframe (default 1day).",
                    default: "1day",
                },
                from: { type: "string", description: "Start date YYYY-MM-DD (optional).", examples: ["2025-01-01"] },
                to: { type: "string", description: "End date YYYY-MM-DD (optional).", examples: ["2025-12-31"] },
                limit: {
                    type: "number",
                    description: "Optional cap on the most recent rows.",
                    default: 30,
                    examples: [30, 90, 250],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                indicator: { type: "string" },
                timeframe: { type: "string" },
                periodLength: { type: "number" },
                rowCount: { type: "number" },
                rows: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "indicator", "timeframe", "periodLength", "rowCount", "rows", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Technical indicator series.", {
            executeUsd: DEFAULT_EXECUTE_USD,
        }),
    },
    {
        name: "build_company_financial_brief",
        description: "Build a compact, buyer-facing company brief for a single symbol by combining profile, real-time quote, TTM ratios and key metrics, analyst price-target and grade consensus, and recent stock news. Use when a question needs a multi-signal snapshot of a company rather than one data family. Sections that require a higher FMP tier are reported as partial errors instead of failing the brief.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: {
                    type: "string",
                    description: "Ticker such as AAPL.",
                    default: "AAPL",
                    examples: ["AAPL", "MSFT", "NVDA"],
                },
                newsLimit: {
                    type: "number",
                    description: "Number of recent stock-news stories to include (default 5).",
                    default: 5,
                    examples: [3, 5, 10],
                },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                brief: { type: "string" },
                profile: { type: ["object", "null"], additionalProperties: true },
                quote: { type: ["object", "null"], additionalProperties: true },
                ratiosTtm: { type: ["object", "null"], additionalProperties: true },
                keyMetricsTtm: { type: ["object", "null"], additionalProperties: true },
                priceTargetConsensus: { type: ["object", "null"], additionalProperties: true },
                gradesConsensus: { type: ["object", "null"], additionalProperties: true },
                news: objectArraySchema,
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "brief", "news", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite company brief across several FMP endpoints.", {
            executeUsd: DEFAULT_EXECUTE_USD,
        }),
    },
    {
        name: "get_earnings",
        description: "Fetch earnings data for a symbol. mode=surprises (default) returns actual vs estimated EPS and revenue with surprise deltas from /earnings; mode=calendar returns upcoming earnings report dates from /earnings-calendar (symbol optional, date-range filterable). Use for 'did X beat earnings?' and 'when does X report next?'.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as AAPL. Required for mode=surprises; optional for mode=calendar.", default: "AAPL", examples: ["AAPL", "NVDA", "TSLA"] },
                mode: { type: "string", enum: ["surprises", "calendar"], description: "surprises (default) or calendar.", default: "surprises" },
                from: { type: "string", description: "Start date YYYY-MM-DD (calendar mode).", examples: ["2026-06-27"] },
                to: { type: "string", description: "End date YYYY-MM-DD (calendar mode).", examples: ["2026-07-11"] },
                limit: { type: "number", description: "Maximum rows (default 20).", default: 20, examples: [10, 20, 50] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: ["string", "null"] },
                mode: { type: "string" },
                rowCount: { type: "number" },
                rows: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["mode", "rowCount", "rows", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Earnings surprises or earnings calendar lookup."),
    },
    {
        name: "get_dividends",
        description: "Fetch dividend data. mode=history (default) returns per-symbol dividend history (date, dividend, record/payment/declaration dates) from /dividends; mode=calendar returns upcoming ex-dividend dates from /dividends-calendar (symbol optional, date-range filterable). Use for dividend yield, history, and next ex-div date questions.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as AAPL. Required for mode=history; optional for mode=calendar.", default: "AAPL", examples: ["AAPL", "MSFT"] },
                mode: { type: "string", enum: ["history", "calendar"], description: "history (default) or calendar.", default: "history" },
                from: { type: "string", description: "Start date YYYY-MM-DD (calendar mode).", examples: ["2026-06-27"] },
                to: { type: "string", description: "End date YYYY-MM-DD (calendar mode).", examples: ["2026-07-11"] },
                limit: { type: "number", description: "Maximum rows (default 20).", default: 20, examples: [10, 20, 50] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: ["string", "null"] },
                mode: { type: "string" },
                rowCount: { type: "number" },
                rows: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["mode", "rowCount", "rows", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Dividend history or ex-dividend calendar lookup."),
    },
    {
        name: "get_insider_activity",
        description: "Fetch insider trading activity. With a symbol, returns insider transactions (filer, transaction type, securities, value) from /insider-trading/search; without a symbol, returns the latest insider trades across the market from /insider-trading/latest. Use for 'are insiders buying or selling X?' and 'biggest recent insider transactions'.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Optional ticker such as NVDA. Omit for the latest market-wide insider feed.", examples: ["NVDA", "AAPL"] },
                transactionType: { type: "string", description: "Optional client-side filter such as P-Purchase or S-Sale.", examples: ["P-Purchase", "S-Sale"] },
                limit: { type: "number", description: "Maximum rows (default 25).", default: 25, examples: [10, 25, 100] },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: ["string", "null"] },
                transactionCount: { type: "number" },
                transactions: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "transactionCount", "transactions", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Insider trading search or latest feed."),
    },
    {
        name: "get_ownership",
        description: "Fetch ownership structure and institutional holders for a symbol. Returns shares float (free float, float shares, outstanding) from /shares-float plus the latest 13F institutional holders (resolved via CIK -> filing dates -> holder extract). Use for 'who are the top institutional holders of X?', 'did institutions add or trim?', and 'what is the float?'. Institutional subsections that require a higher tier are reported as partial errors.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as TSLA.", default: "AAPL", examples: ["AAPL", "TSLA", "NVDA"] },
                holderLimit: { type: "number", description: "Maximum institutional holders to return (default 20).", default: 20, examples: [10, 20, 50] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                sharesFloat: { type: ["object", "null"], additionalProperties: true },
                institutionalHolders: objectArraySchema,
                filingPeriod: { type: ["object", "null"], additionalProperties: true },
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "institutionalHolders", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite ownership view: shares float + 13F institutional holders (multi-step)."),
    },
    {
        name: "get_sec_filings",
        description: "Fetch SEC filings. With a symbol, returns that company's recent filings from /sec-filings-search/symbol (form type, filing date, links) over the last 120 days by default (override with from/to); without a symbol, returns the latest 8-K (material event) filings across the market from /sec-filings-8k (date-range filterable). Use for 'what 8-Ks did X file this week?' and 'latest material-event filings'.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Optional ticker such as META. Omit for the latest market-wide 8-K feed.", examples: ["META", "AAPL"] },
                type: { type: "string", description: "Optional form-type filter for company mode (e.g. 10-K, 10-Q, 8-K).", examples: ["10-K", "8-K"] },
                from: { type: "string", description: "Start date YYYY-MM-DD (8-K feed mode).", examples: ["2026-06-20"] },
                to: { type: "string", description: "End date YYYY-MM-DD (8-K feed mode).", examples: ["2026-06-27"] },
                limit: { type: "number", description: "Maximum rows (default 25).", default: 25, examples: [10, 25, 100] },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: ["string", "null"] },
                mode: { type: "string" },
                rowCount: { type: "number" },
                filings: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["mode", "rowCount", "filings", "fetchedAt"],
        },
        _meta: toolMeta("fast", "SEC filings by company or latest 8-K feed."),
    },
    {
        name: "get_peers",
        description: "Fetch the peer group for a symbol from /stock-peers (FMP-computed comparable companies). Use for 'who are X's closest peers?' and as a precursor to cross-company valuation/fundamental comparisons.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as NVDA.", default: "AAPL", examples: ["AAPL", "NVDA", "MSFT"] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                peers: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "peers", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Stock peer group lookup."),
    },
    {
        name: "get_growth",
        description: "Fetch financial growth rates for a symbol from /financial-growth (revenue, gross profit, EBITDA, net income, EPS, operating cash flow, free cash flow growth by period). Use for 'what is X's revenue and earnings growth trend?' and momentum/quality screens.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as AMZN.", default: "AAPL", examples: ["AAPL", "AMZN", "NVDA"] },
                period: { type: "string", enum: ["annual", "quarter"], description: "Reporting period (default annual).", default: "annual" },
                limit: { type: "number", description: "Number of periods (default 8).", default: 8, examples: [4, 8, 12] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                period: { type: "string" },
                periodCount: { type: "number" },
                growth: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "period", "periodCount", "growth", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Financial growth-rate series."),
    },
    {
        name: "get_revenue_segments",
        description: "Fetch revenue segmentation for a symbol. segment=geographic returns revenue by region from /revenue-geographic-segmentation; segment=product returns revenue by product line from /revenue-product-segmentation; segment=both (default) returns both. Use for 'how is X's revenue split by geography and product?'.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as AAPL.", default: "AAPL", examples: ["AAPL", "MSFT"] },
                segment: { type: "string", enum: ["geographic", "product", "both"], description: "Which segmentation to return (default both).", default: "both" },
                limit: { type: "number", description: "Maximum rows per segment (default 20).", default: 20, examples: [10, 20, 50] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                geographic: objectArraySchema,
                product: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "geographic", "product", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Revenue segmentation (geographic and/or product)."),
    },
    {
        name: "get_congressional_trades",
        description: "Fetch US congressional trading activity. chamber=house returns House representative trades from /house-trades; chamber=senate returns Senate trades from /senate-trades; chamber=both (default) returns both. symbol is optional (filter to a ticker; omit for recent trades across all names). Use for 'which senators/representatives recently traded X?'.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Optional ticker filter such as NVDA.", examples: ["NVDA", "AAPL"] },
                chamber: { type: "string", enum: ["house", "senate", "both"], description: "Which chamber(s) to return (default both).", default: "both" },
                limit: { type: "number", description: "Maximum rows per chamber (default 25).", default: 25, examples: [10, 25, 100] },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: ["string", "null"] },
                chamber: { type: "string" },
                houseTrades: objectArraySchema,
                senateTrades: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["chamber", "houseTrades", "senateTrades", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Congressional (House/Senate) trading activity."),
    },
    {
        name: "get_index_constituents",
        description: "Fetch the constituent list of a major US index. index=sp500 (default) returns S&P 500 members from /sp500-constituent; nasdaq returns Nasdaq 100 from /nasdaq-constituent; dowjones returns Dow Jones 30 from /dowjones-constituent. Use for universe definition and index-membership questions.",
        inputSchema: {
            type: "object",
            properties: {
                index: { type: "string", enum: ["sp500", "nasdaq", "dowjones"], description: "Which index constituents to return (default sp500).", default: "sp500" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                index: { type: "string" },
                constituentCount: { type: "number" },
                constituents: objectArraySchema,
                fetchedAt: { type: "string" },
            },
            required: ["index", "constituentCount", "constituents", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Index constituent list (S&P 500 / Nasdaq 100 / Dow 30)."),
    },
    {
        name: "get_valuation",
        description: "Fetch a composite valuation snapshot for a symbol: DCF fair value from /discounted-cash-flow, enterprise values (EV, EV/EBITDA, EV/Sales) from /enterprise-values, market capitalization from /market-capitalization, and period price changes (1D/1W/1M/3M/6M/YTD/1Y) from /stock-price-change. Use for 'what is X's DCF fair value vs current price?', 'EV/EBITDA?', and 'recent returns?'. Subsections requiring a higher tier are reported as partial errors.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as NVDA.", default: "AAPL", examples: ["AAPL", "NVDA", "TSLA"] },
                period: { type: "string", enum: ["annual", "quarter"], description: "Enterprise-values period (default annual).", default: "annual" },
                limit: { type: "number", description: "Enterprise-values periods to return (default 4).", default: 4, examples: [4, 8] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                dcf: { type: ["object", "null"], additionalProperties: true },
                enterpriseValues: objectArraySchema,
                marketCap: { type: ["object", "null"], additionalProperties: true },
                priceChange: { type: ["object", "null"], additionalProperties: true },
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "enterpriseValues", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite valuation: DCF + enterprise value + market cap + price change."),
    },
    {
        name: "get_quality_scores",
        description: "Fetch quality and distress signals for a symbol: Altman Z, Piotroski F, Beneish M and other financial scores from /financial-scores, plus the FMP rating snapshot from /ratings-snapshot. Use for 'what is X's Altman Z / Piotroski score?', 'is any name at bankruptcy risk?', and quality screens. Subsections requiring a higher tier are reported as partial errors.",
        inputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "Ticker such as NVDA.", default: "AAPL", examples: ["AAPL", "NVDA", "TSLA"] },
            },
            required: ["symbol"],
        },
        outputSchema: {
            type: "object",
            properties: {
                symbol: { type: "string" },
                financialScores: { type: ["object", "null"], additionalProperties: true },
                rating: { type: ["object", "null"], additionalProperties: true },
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["symbol", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Composite quality view: financial scores + FMP rating."),
    },
    {
        name: "get_sector_performance",
        description: "Fetch a market-wide sector and industry rotation snapshot: sector and industry performance (1D/5D/1M/YTD returns) from /sector-performance-snapshot and /industry-performance-snapshot, plus sector and industry P/E from /sector-pe-snapshot and /industry-pe-snapshot. date is optional (defaults to latest). No symbol. Use for 'which sectors are outperforming this month?' and 'what is the average P/E of the Technology sector?'.",
        inputSchema: {
            type: "object",
            properties: {
                date: { type: "string", description: "Optional snapshot date YYYY-MM-DD (defaults to latest).", examples: ["2026-06-27"] },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                date: { type: ["string", "null"] },
                sectorPerformance: objectArraySchema,
                industryPerformance: objectArraySchema,
                sectorPe: objectArraySchema,
                industryPe: objectArraySchema,
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["sectorPerformance", "industryPerformance", "sectorPe", "industryPe", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite sector/industry rotation snapshot (performance + P/E)."),
    },
    {
        name: "get_macro_calendar",
        description: "Fetch a macro snapshot: upcoming economic events (Fed, CPI, NFP, etc.) from /economic-calendar over a date range (defaults to the next 14 days), plus the latest US Treasury yield curve from /treasury-rates. No symbol. Use for 'what major economic events are scheduled this week?' and 'what is the current 10Y Treasury yield?'.",
        inputSchema: {
            type: "object",
            properties: {
                from: { type: "string", description: "Start date YYYY-MM-DD (defaults to today).", examples: ["2026-06-27"] },
                to: { type: "string", description: "End date YYYY-MM-DD (defaults to from + 14 days).", examples: ["2026-07-11"] },
                limit: { type: "number", description: "Maximum economic events (default 100).", default: 100, examples: [50, 100, 250] },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                from: { type: "string" },
                to: { type: "string" },
                economicEvents: objectArraySchema,
                treasuryRates: { type: ["object", "null"], additionalProperties: true },
                partialErrors: { type: "object", additionalProperties: true },
                fetchedAt: { type: "string" },
            },
            required: ["from", "to", "economicEvents", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Composite macro view: economic calendar + treasury yields."),
    },
];
// ============================================================================
// Tool handlers
// ============================================================================
async function handleToolCall(request) {
    const name = request.params.name;
    const args = getArgs(request);
    switch (name) {
        case "check_api_status":
            return handleCheckApiStatus();
        case "search_symbols":
            return handleSearchSymbols(args);
        case "get_company_profile":
            return handleGetCompanyProfile(args);
        case "get_stock_quote":
            return handleGetStockQuote(args);
        case "get_historical_prices":
            return handleGetHistoricalPrices(args);
        case "get_financial_statements":
            return handleGetFinancialStatements(args);
        case "get_financial_ratios":
            return handleGetFinancialRatios(args);
        case "get_analyst_insights":
            return handleGetAnalystInsights(args);
        case "get_market_news":
            return handleGetMarketNews(args);
        case "get_market_movers":
            return handleGetMarketMovers(args);
        case "screen_stocks":
            return handleScreenStocks(args);
        case "get_technical_indicator":
            return handleGetTechnicalIndicator(args);
        case "build_company_financial_brief":
            return handleBuildCompanyFinancialBrief(args);
        case "get_earnings":
            return handleGetEarnings(args);
        case "get_dividends":
            return handleGetDividends(args);
        case "get_insider_activity":
            return handleGetInsiderActivity(args);
        case "get_ownership":
            return handleGetOwnership(args);
        case "get_sec_filings":
            return handleGetSecFilings(args);
        case "get_peers":
            return handleGetPeers(args);
        case "get_growth":
            return handleGetGrowth(args);
        case "get_revenue_segments":
            return handleGetRevenueSegments(args);
        case "get_congressional_trades":
            return handleGetCongressionalTrades(args);
        case "get_index_constituents":
            return handleGetIndexConstituents(args);
        case "get_valuation":
            return handleGetValuation(args);
        case "get_quality_scores":
            return handleGetQualityScores(args);
        case "get_sector_performance":
            return handleGetSectorPerformance(args);
        case "get_macro_calendar":
            return handleGetMacroCalendar(args);
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
async function handleCheckApiStatus() {
    const sample = await fmpGetArray("/quote-short", { symbol: "AAPL" });
    return successResult("FMP API reachable and the configured key was accepted.", {
        status: "ok",
        probeSymbol: "AAPL",
        sample: sample.slice(0, 1),
        fetchedAt: new Date().toISOString(),
    });
}
async function handleSearchSymbols(args) {
    const query = getString(args, "query");
    if (!query) {
        throw new Error("`query` is required.");
    }
    const limit = getNumber(args, "limit", 20, 1, 100);
    const exchange = getString(args, "exchange");
    const path = getBoolean(args, "byName") ? "/search-name" : "/search-symbol";
    const matches = await fmpGetArray(path, {
        query,
        limit,
        exchange: exchange ?? undefined,
    });
    return successResult(`Found ${matches.length} symbol matches for "${query}".`, {
        query,
        matchCount: matches.length,
        matches,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetCompanyProfile(args) {
    const symbols = getSymbols(args).slice(0, 10);
    const profiles = [];
    for (const symbol of symbols) {
        const result = await fmpGetArray("/profile", { symbol });
        profiles.push(...result);
    }
    return successResult(`Fetched ${profiles.length} company profiles.`, {
        profileCount: profiles.length,
        profiles,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetStockQuote(args) {
    const symbols = getSymbols(args);
    const quotes = symbols.length === 1
        ? await fmpGetArray("/quote", { symbol: symbols[0] })
        : await fmpGetArray("/batch-quote", { symbols: symbols.join(",") });
    return successResult(`Fetched ${quotes.length} quotes.`, {
        quoteCount: quotes.length,
        quotes,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetHistoricalPrices(args) {
    const symbol = requireSymbol(args);
    const series = getString(args, "series") === "light" ? "light" : "full";
    const from = getString(args, "from");
    const to = getString(args, "to");
    const limit = getOptionalNumber(args, "limit");
    const allRows = await fmpGetArray(`/historical-price-eod/${series}`, {
        symbol,
        from: from ?? undefined,
        to: to ?? undefined,
    });
    const rows = applyLatestLimit(allRows, limit);
    const { earliest, latest } = dateBounds(rows);
    return successResult(`Fetched ${rows.length} EOD price rows for ${symbol} (${series} series).`, {
        symbol,
        rowCount: rows.length,
        earliestDate: earliest,
        latestDate: latest,
        rows,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetFinancialStatements(args) {
    const symbol = requireSymbol(args);
    const statementKey = (getString(args, "statement") ?? "income").toLowerCase();
    const slug = STATEMENT_SLUGS[statementKey];
    if (!slug) {
        throw new Error("`statement` must be one of: income, balance, cash.");
    }
    const period = getString(args, "period") === "quarter" ? "quarter" : "annual";
    const limit = getNumber(args, "limit", DEFAULT_STATEMENT_LIMIT, 1, 50);
    const statements = await fmpGetArray(`/${slug}`, { symbol, period, limit });
    return successResult(`Fetched ${statements.length} ${period} ${statementKey}-statement periods for ${symbol}.`, {
        symbol,
        statement: statementKey,
        period,
        periodCount: statements.length,
        statements,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetFinancialRatios(args) {
    const symbol = requireSymbol(args);
    const ttm = getBoolean(args, "ttm");
    if (ttm) {
        const [ratios, keyMetrics] = await Promise.all([
            fmpGetArray("/ratios-ttm", { symbol }),
            fmpGetArray("/key-metrics-ttm", { symbol }),
        ]);
        return successResult(`Fetched TTM ratios and key metrics for ${symbol}.`, {
            symbol,
            ttm: true,
            ratios,
            keyMetrics,
            fetchedAt: new Date().toISOString(),
        });
    }
    const period = getString(args, "period") === "quarter" ? "quarter" : "annual";
    const limit = getNumber(args, "limit", DEFAULT_STATEMENT_LIMIT, 1, 50);
    const [ratios, keyMetrics] = await Promise.all([
        fmpGetArray("/ratios", { symbol, period, limit }),
        fmpGetArray("/key-metrics", { symbol, period, limit }),
    ]);
    return successResult(`Fetched ${period} ratios and key metrics for ${symbol}.`, {
        symbol,
        ttm: false,
        ratios,
        keyMetrics,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetAnalystInsights(args) {
    const symbol = requireSymbol(args);
    const estimateLimit = getNumber(args, "estimateLimit", 4, 1, 40);
    const [consensus, summary, grades, estimates] = await Promise.all([
        fmpTryArray("/price-target-consensus", { symbol }),
        fmpTryArray("/price-target-summary", { symbol }),
        fmpTryArray("/grades-consensus", { symbol }),
        fmpTryArray("/analyst-estimates", { symbol, period: "annual", limit: estimateLimit }),
    ]);
    const partialErrors = {};
    if (consensus.error)
        partialErrors.priceTargetConsensus = consensus.error;
    if (summary.error)
        partialErrors.priceTargetSummary = summary.error;
    if (grades.error)
        partialErrors.gradesConsensus = grades.error;
    if (estimates.error)
        partialErrors.analystEstimates = estimates.error;
    return successResult(`Fetched analyst insights for ${symbol}.`, {
        symbol,
        priceTargetConsensus: consensus.data,
        priceTargetSummary: summary.data,
        gradesConsensus: grades.data,
        analystEstimates: estimates.data,
        partialErrors,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetMarketNews(args) {
    const category = (getString(args, "category") ?? "stock").toLowerCase();
    if (!NEWS_CATEGORIES.has(category)) {
        throw new Error("`category` must be one of: stock, press-releases, crypto, forex, general.");
    }
    const symbols = getStringArray(args, "symbols");
    const page = getNumber(args, "page", 0, 0, 10_000);
    const limit = getNumber(args, "limit", DEFAULT_NEWS_LIMIT, 1, 250);
    const useSymbolFeed = symbols.length > 0 && category !== "general";
    const path = useSymbolFeed ? `/news/${category}` : `/news/${category}-latest`;
    const stories = await fmpGetArray(path, {
        page,
        limit,
        symbols: useSymbolFeed ? symbols.join(",") : undefined,
    });
    return successResult(`Fetched ${stories.length} ${category} news stories.`, {
        category,
        storyCount: stories.length,
        stories,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetMarketMovers(args) {
    const direction = (getString(args, "direction") ?? "gainers").toLowerCase();
    const slug = MOVER_SLUGS[direction];
    if (!slug) {
        throw new Error("`direction` must be one of: gainers, losers, actives.");
    }
    const limit = getNumber(args, "limit", 25, 1, 250);
    const movers = applyLatestLimit(await fmpGetArray(`/${slug}`), limit);
    return successResult(`Fetched ${movers.length} ${direction}.`, {
        direction,
        moverCount: movers.length,
        movers,
        fetchedAt: new Date().toISOString(),
    });
}
const SCREENER_NUMERIC_FILTERS = [
    "marketCapMoreThan",
    "marketCapLowerThan",
    "priceMoreThan",
    "priceLowerThan",
    "betaMoreThan",
    "betaLowerThan",
    "volumeMoreThan",
    "volumeLowerThan",
    "dividendMoreThan",
    "dividendLowerThan",
];
const SCREENER_STRING_FILTERS = ["sector", "industry", "exchange", "country"];
const SCREENER_BOOLEAN_FILTERS = ["isEtf", "isFund", "isActivelyTrading"];
async function handleScreenStocks(args) {
    const query = {};
    const filters = {};
    for (const key of SCREENER_NUMERIC_FILTERS) {
        const value = getOptionalNumber(args, key);
        if (value !== null) {
            query[key] = value;
            filters[key] = value;
        }
    }
    for (const key of SCREENER_STRING_FILTERS) {
        const value = getString(args, key);
        if (value) {
            query[key] = value;
            filters[key] = value;
        }
    }
    for (const key of SCREENER_BOOLEAN_FILTERS) {
        if (key in args) {
            const value = getBoolean(args, key);
            query[key] = value;
            filters[key] = value;
        }
    }
    const limit = getNumber(args, "limit", 50, 1, 1_000);
    query.limit = limit;
    filters.limit = limit;
    const matches = await fmpGetArray("/company-screener", query);
    return successResult(`Screener returned ${matches.length} matching symbols.`, {
        matchCount: matches.length,
        filters,
        matches,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetTechnicalIndicator(args) {
    const symbol = requireSymbol(args);
    const indicator = (getString(args, "indicator") ?? "rsi").toLowerCase();
    if (!TECHNICAL_INDICATORS.has(indicator)) {
        throw new Error(`\`indicator\` must be one of: ${[...TECHNICAL_INDICATORS].join(", ")}.`);
    }
    const timeframe = getString(args, "timeframe") ?? "1day";
    if (!TECHNICAL_TIMEFRAMES.has(timeframe)) {
        throw new Error(`\`timeframe\` must be one of: ${[...TECHNICAL_TIMEFRAMES].join(", ")}.`);
    }
    const periodLength = getNumber(args, "periodLength", 14, 1, 400);
    const from = getString(args, "from");
    const to = getString(args, "to");
    const limit = getOptionalNumber(args, "limit");
    const allRows = await fmpGetArray(`/technical-indicators/${indicator}`, {
        symbol,
        periodLength,
        timeframe,
        from: from ?? undefined,
        to: to ?? undefined,
    });
    const rows = applyLatestLimit(allRows, limit);
    return successResult(`Fetched ${rows.length} ${indicator.toUpperCase()} rows for ${symbol} (${timeframe}, length ${periodLength}).`, {
        symbol,
        indicator,
        timeframe,
        periodLength,
        rowCount: rows.length,
        rows,
        fetchedAt: new Date().toISOString(),
    });
}
function firstOrNull(rows) {
    return rows.length > 0 ? rows[0] : null;
}
async function handleBuildCompanyFinancialBrief(args) {
    const symbol = requireSymbol(args);
    const newsLimit = getNumber(args, "newsLimit", 5, 1, 50);
    const [profile, quote, ratiosTtm, keyMetricsTtm, consensus, grades, news] = await Promise.all([
        fmpTryArray("/profile", { symbol }),
        fmpTryArray("/quote", { symbol }),
        fmpTryArray("/ratios-ttm", { symbol }),
        fmpTryArray("/key-metrics-ttm", { symbol }),
        fmpTryArray("/price-target-consensus", { symbol }),
        fmpTryArray("/grades-consensus", { symbol }),
        fmpTryArray("/news/stock", { symbols: symbol, page: 0, limit: newsLimit }),
    ]);
    const partialErrors = {};
    if (profile.error)
        partialErrors.profile = profile.error;
    if (quote.error)
        partialErrors.quote = quote.error;
    if (ratiosTtm.error)
        partialErrors.ratiosTtm = ratiosTtm.error;
    if (keyMetricsTtm.error)
        partialErrors.keyMetricsTtm = keyMetricsTtm.error;
    if (consensus.error)
        partialErrors.priceTargetConsensus = consensus.error;
    if (grades.error)
        partialErrors.gradesConsensus = grades.error;
    if (news.error)
        partialErrors.news = news.error;
    const profileRow = firstOrNull(profile.data);
    const quoteRow = firstOrNull(quote.data);
    const consensusRow = firstOrNull(consensus.data);
    const gradesRow = firstOrNull(grades.data);
    const companyName = (profileRow && jsonString(profileRow, "companyName")) ?? symbol;
    const price = quoteRow ? jsonNumber(quoteRow, "price") : null;
    const changePct = quoteRow
        ? jsonNumber(quoteRow, "changePercentage") ?? jsonNumber(quoteRow, "changesPercentage")
        : null;
    const marketCap = profileRow
        ? jsonNumber(profileRow, "marketCap") ?? (quoteRow ? jsonNumber(quoteRow, "marketCap") : null)
        : quoteRow
            ? jsonNumber(quoteRow, "marketCap")
            : null;
    const sector = profileRow ? jsonString(profileRow, "sector") : null;
    const targetConsensus = consensusRow
        ? jsonNumber(consensusRow, "targetConsensus")
        : null;
    const consensusRating = gradesRow ? jsonString(gradesRow, "consensus") : null;
    const briefParts = [
        `${companyName} (${symbol})${sector ? ` — ${sector}` : ""}.`,
        price !== null
            ? `Last price ${price}${changePct !== null ? ` (${changePct >= 0 ? "+" : ""}${changePct}% today)` : ""}.`
            : "Quote unavailable.",
        marketCap !== null ? `Market cap ~${marketCap}.` : "",
        targetConsensus !== null ? `Analyst target consensus ${targetConsensus}.` : "",
        consensusRating ? `Analyst rating consensus: ${consensusRating}.` : "",
        `Includes TTM ratios/key metrics and ${news.data.length} recent news stories. Cross-check ratios, analyst targets, and news before drawing a conclusion.`,
    ].filter((part) => part.trim().length > 0);
    return successResult(briefParts.join(" "), {
        symbol,
        brief: briefParts.join(" "),
        profile: profileRow,
        quote: quoteRow,
        ratiosTtm: firstOrNull(ratiosTtm.data),
        keyMetricsTtm: firstOrNull(keyMetricsTtm.data),
        priceTargetConsensus: consensusRow,
        gradesConsensus: gradesRow,
        news: news.data,
        partialErrors,
        fetchedAt: new Date().toISOString(),
    });
}
// ============================================================================
// Additional tool handlers (earnings, dividends, ownership, filings, etc.)
// ============================================================================
function isoDate(d) {
    return d.toISOString().slice(0, 10);
}
function resolveDateRange(args, defaultSpanDays) {
    const fromArg = getString(args, "from");
    const toArg = getString(args, "to");
    const today = new Date();
    const from = fromArg ?? isoDate(today);
    const toDate = toArg
        ? new Date(`${toArg}T00:00:00Z`)
        : new Date(today.getTime() + defaultSpanDays * 24 * 60 * 60 * 1000);
    return { from, to: toArg ?? isoDate(toDate) };
}
function pickLatestFilingPeriod(rows) {
    let best = null;
    for (const row of rows) {
        const raw = jsonString(row, "date") ?? jsonString(row, "filingDate") ?? jsonString(row, "acceptedDate");
        if (!raw)
            continue;
        const dateStr = raw.slice(0, 10);
        if (dateStr.length < 4)
            continue;
        const year = dateStr.slice(0, 4);
        const month = Number(dateStr.slice(5, 7));
        if (!year || !Number.isFinite(month) || month < 1 || month > 12)
            continue;
        const quarter = String(Math.ceil(month / 3));
        if (!best || dateStr > best.date) {
            best = { date: dateStr, year, quarter };
        }
    }
    return best ? { year: best.year, quarter: best.quarter } : null;
}
async function handleGetEarnings(args) {
    const mode = getString(args, "mode") === "calendar" ? "calendar" : "surprises";
    const limit = getNumber(args, "limit", 20, 1, 250);
    const fetchedAt = new Date().toISOString();
    if (mode === "calendar") {
        const { from, to } = resolveDateRange(args, 14);
        const symbol = getString(args, "symbol");
        const rows = await fmpGetArray("/earnings-calendar", { from, to, limit: Math.max(limit, 100) });
        const filtered = symbol
            ? rows.filter((r) => (jsonString(r, "symbol") ?? "").toUpperCase() === symbol.toUpperCase())
            : rows;
        const limited = applyLatestLimit(filtered, limit);
        return successResult(`Fetched ${limited.length} earnings-calendar rows${symbol ? ` for ${symbol}` : ""} between ${from} and ${to}.`, { symbol: symbol ?? null, mode, rowCount: limited.length, rows: limited, fetchedAt });
    }
    const symbol = requireSymbol(args);
    const rows = applyLatestLimit(await fmpGetArray("/earnings", { symbol, limit }), limit);
    return successResult(`Fetched ${rows.length} earnings surprises for ${symbol}.`, {
        symbol,
        mode,
        rowCount: rows.length,
        rows,
        fetchedAt,
    });
}
async function handleGetDividends(args) {
    const mode = getString(args, "mode") === "calendar" ? "calendar" : "history";
    const limit = getNumber(args, "limit", 20, 1, 250);
    const fetchedAt = new Date().toISOString();
    if (mode === "calendar") {
        const { from, to } = resolveDateRange(args, 14);
        const symbol = getString(args, "symbol");
        const rows = await fmpGetArray("/dividends-calendar", { from, to, limit: Math.max(limit, 100) });
        const filtered = symbol
            ? rows.filter((r) => (jsonString(r, "symbol") ?? "").toUpperCase() === symbol.toUpperCase())
            : rows;
        const limited = applyLatestLimit(filtered, limit);
        return successResult(`Fetched ${limited.length} dividend-calendar rows${symbol ? ` for ${symbol}` : ""} between ${from} and ${to}.`, { symbol: symbol ?? null, mode, rowCount: limited.length, rows: limited, fetchedAt });
    }
    const symbol = requireSymbol(args);
    const rows = applyLatestLimit(await fmpGetArray("/dividends", { symbol, limit }), limit);
    return successResult(`Fetched ${rows.length} dividend records for ${symbol}.`, {
        symbol,
        mode,
        rowCount: rows.length,
        rows,
        fetchedAt,
    });
}
async function handleGetInsiderActivity(args) {
    const symbol = getString(args, "symbol");
    const transactionType = getString(args, "transactionType");
    const limit = getNumber(args, "limit", 25, 1, 250);
    const fetchedAt = new Date().toISOString();
    const rows = symbol
        ? await fmpGetArray("/insider-trading/search", { symbol, page: 0, limit: Math.max(limit, 100) })
        : await fmpGetArray("/insider-trading/latest", { page: 0, limit: Math.max(limit, 100) });
    let filtered = rows;
    if (transactionType) {
        const needle = transactionType.toUpperCase();
        filtered = rows.filter((r) => (jsonString(r, "transactionType") ?? jsonString(r, "type") ?? "").toUpperCase() === needle);
    }
    const limited = applyLatestLimit(filtered, limit);
    return successResult(`Fetched ${limited.length} insider transactions${symbol ? ` for ${symbol}` : " (market-wide)"}.`, { symbol: symbol ?? null, transactionCount: limited.length, transactions: limited, fetchedAt });
}
async function handleGetOwnership(args) {
    const symbol = requireSymbol(args);
    const holderLimit = getNumber(args, "holderLimit", 20, 1, 100);
    const fetchedAt = new Date().toISOString();
    const partialErrors = {};
    const floatRes = await fmpTryArray("/shares-float", { symbol });
    if (floatRes.error)
        partialErrors.sharesFloat = floatRes.error;
    const profileRes = await fmpTryArray("/profile", { symbol });
    let institutionalHolders = [];
    let filingPeriod = null;
    if (profileRes.error) {
        partialErrors.profile = profileRes.error;
        partialErrors.institutionalHolders = "Profile lookup failed; cannot resolve CIK for 13F holders.";
    }
    else {
        const cik = jsonString(firstOrNull(profileRes.data) ?? {}, "cik");
        if (!cik) {
            partialErrors.institutionalHolders = "No CIK on profile; cannot resolve 13F holders.";
        }
        else {
            const datesRes = await fmpTryArray("/institutional-ownership/dates", { cik });
            if (datesRes.error) {
                partialErrors.institutionalHolders = datesRes.error;
            }
            else {
                const latest = pickLatestFilingPeriod(datesRes.data);
                if (!latest) {
                    partialErrors.institutionalHolders = "No 13F filing dates available for this CIK.";
                }
                else {
                    const holderRes = await fmpTryArray("/institutional-ownership/extract-analytics/holder", {
                        symbol,
                        year: latest.year,
                        quarter: latest.quarter,
                        page: 0,
                        limit: holderLimit,
                    });
                    if (holderRes.error) {
                        partialErrors.institutionalHolders = holderRes.error;
                    }
                    else {
                        institutionalHolders = applyLatestLimit(holderRes.data, holderLimit);
                        filingPeriod = { year: latest.year, quarter: latest.quarter };
                    }
                }
            }
        }
    }
    return successResult(`Ownership for ${symbol}: ${institutionalHolders.length} institutional holders${floatRes.data.length > 0 ? ", float loaded" : ""}.`, {
        symbol,
        sharesFloat: firstOrNull(floatRes.data),
        institutionalHolders,
        filingPeriod,
        partialErrors,
        fetchedAt,
    });
}
async function handleGetSecFilings(args) {
    const symbol = getString(args, "symbol");
    const type = getString(args, "type");
    const limit = getNumber(args, "limit", 25, 1, 250);
    const fetchedAt = new Date().toISOString();
    if (symbol) {
        const toArg = getString(args, "to");
        const fromArg = getString(args, "from");
        const today = new Date();
        const to = toArg ?? isoDate(today);
        const from = fromArg ?? isoDate(new Date(today.getTime() - 120 * 24 * 60 * 60 * 1000));
        const rows = applyLatestLimit(await fmpGetArray("/sec-filings-search/symbol", { symbol, type, from, to, page: 0, limit: Math.max(limit, 100) }), limit);
        return successResult(`Fetched ${rows.length} SEC filings for ${symbol} (${from} to ${to}).`, {
            symbol,
            mode: "company",
            rowCount: rows.length,
            filings: rows,
            fetchedAt,
        });
    }
    const { from, to } = resolveDateRange(args, 7);
    const rows = applyLatestLimit(await fmpGetArray("/sec-filings-8k", { from, to, page: 0, limit: Math.max(limit, 100) }), limit);
    return successResult(`Fetched ${rows.length} latest 8-K filings between ${from} and ${to}.`, {
        symbol: null,
        mode: "8k-feed",
        rowCount: rows.length,
        filings: rows,
        fetchedAt,
    });
}
async function handleGetPeers(args) {
    const symbol = requireSymbol(args);
    const peers = await fmpGetArray("/stock-peers", { symbol });
    return successResult(`Fetched peer group for ${symbol}.`, {
        symbol,
        peers,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetGrowth(args) {
    const symbol = requireSymbol(args);
    const period = getString(args, "period") === "quarter" ? "quarter" : "annual";
    const limit = getNumber(args, "limit", 8, 1, 40);
    const growth = applyLatestLimit(await fmpGetArray("/financial-growth", { symbol, period, limit }), limit);
    return successResult(`Fetched ${growth.length} ${period} growth periods for ${symbol}.`, {
        symbol,
        period,
        periodCount: growth.length,
        growth,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetRevenueSegments(args) {
    const symbol = requireSymbol(args);
    const seg = getString(args, "segment");
    const segment = (seg === "geographic" || seg === "product") ? seg : "both";
    const limit = getNumber(args, "limit", 20, 1, 100);
    const fetchedAt = new Date().toISOString();
    const wantGeo = segment === "geographic" || segment === "both";
    const wantProduct = segment === "product" || segment === "both";
    const [geo, product] = await Promise.all([
        wantGeo ? fmpTryArray("/revenue-geographic-segmentation", { symbol, limit }) : Promise.resolve({ data: [], error: null }),
        wantProduct ? fmpTryArray("/revenue-product-segmentation", { symbol, limit }) : Promise.resolve({ data: [], error: null }),
    ]);
    return successResult(`Fetched revenue segments (${segment}) for ${symbol}.`, {
        symbol,
        geographic: applyLatestLimit(geo.data, limit),
        product: applyLatestLimit(product.data, limit),
        fetchedAt,
    });
}
async function handleGetCongressionalTrades(args) {
    const symbol = getString(args, "symbol");
    const chamberArg = getString(args, "chamber");
    const chamber = (chamberArg === "house" || chamberArg === "senate") ? chamberArg : "both";
    const limit = getNumber(args, "limit", 25, 1, 250);
    const fetchedAt = new Date().toISOString();
    const wantHouse = chamber === "house" || chamber === "both";
    const wantSenate = chamber === "senate" || chamber === "both";
    const [house, senate] = await Promise.all([
        wantHouse ? fmpTryArray("/house-trades", { symbol, page: 0, limit: Math.max(limit, 100) }) : Promise.resolve({ data: [], error: null }),
        wantSenate ? fmpTryArray("/senate-trades", { symbol, page: 0, limit: Math.max(limit, 100) }) : Promise.resolve({ data: [], error: null }),
    ]);
    const houseTrades = applyLatestLimit(house.data, limit);
    const senateTrades = applyLatestLimit(senate.data, limit);
    return successResult(`Fetched ${houseTrades.length} House and ${senateTrades.length} Senate trades${symbol ? ` for ${symbol}` : ""}.`, { symbol: symbol ?? null, chamber, houseTrades, senateTrades, fetchedAt });
}
async function handleGetIndexConstituents(args) {
    const indexArg = getString(args, "index");
    const index = (indexArg === "nasdaq" || indexArg === "dowjones") ? indexArg : "sp500";
    const slug = index === "sp500" ? "sp500-constituent" : index === "nasdaq" ? "nasdaq-constituent" : "dowjones-constituent";
    const constituents = await fmpGetArray(`/${slug}`);
    return successResult(`Fetched ${constituents.length} ${index} constituents.`, {
        index,
        constituentCount: constituents.length,
        constituents,
        fetchedAt: new Date().toISOString(),
    });
}
async function handleGetValuation(args) {
    const symbol = requireSymbol(args);
    const period = getString(args, "period") === "quarter" ? "quarter" : "annual";
    const limit = getNumber(args, "limit", 4, 1, 20);
    const fetchedAt = new Date().toISOString();
    const partialErrors = {};
    const [dcf, ev, marketCap, priceChange] = await Promise.all([
        fmpTryArray("/discounted-cash-flow", { symbol }),
        fmpTryArray("/enterprise-values", { symbol, period, limit }),
        fmpTryArray("/market-capitalization", { symbol }),
        fmpTryArray("/stock-price-change", { symbol }),
    ]);
    if (dcf.error)
        partialErrors.dcf = dcf.error;
    if (ev.error)
        partialErrors.enterpriseValues = ev.error;
    if (marketCap.error)
        partialErrors.marketCap = marketCap.error;
    if (priceChange.error)
        partialErrors.priceChange = priceChange.error;
    return successResult(`Fetched valuation snapshot for ${symbol}.`, {
        symbol,
        dcf: firstOrNull(dcf.data),
        enterpriseValues: applyLatestLimit(ev.data, limit),
        marketCap: firstOrNull(marketCap.data),
        priceChange: firstOrNull(priceChange.data),
        partialErrors,
        fetchedAt,
    });
}
async function handleGetQualityScores(args) {
    const symbol = requireSymbol(args);
    const fetchedAt = new Date().toISOString();
    const partialErrors = {};
    const [scores, rating] = await Promise.all([
        fmpTryArray("/financial-scores", { symbol }),
        fmpTryArray("/ratings-snapshot", { symbol }),
    ]);
    if (scores.error)
        partialErrors.financialScores = scores.error;
    if (rating.error)
        partialErrors.rating = rating.error;
    return successResult(`Fetched quality scores and rating for ${symbol}.`, {
        symbol,
        financialScores: firstOrNull(scores.data),
        rating: firstOrNull(rating.data),
        partialErrors,
        fetchedAt,
    });
}
async function handleGetSectorPerformance(args) {
    const date = getString(args, "date") ?? isoDate(new Date());
    const fetchedAt = new Date().toISOString();
    const partialErrors = {};
    const [sectorPerf, industryPerf, sectorPe, industryPe] = await Promise.all([
        fmpTryArray("/sector-performance-snapshot", { date }),
        fmpTryArray("/industry-performance-snapshot", { date }),
        fmpTryArray("/sector-pe-snapshot", { date }),
        fmpTryArray("/industry-pe-snapshot", { date }),
    ]);
    if (sectorPerf.error)
        partialErrors.sectorPerformance = sectorPerf.error;
    if (industryPerf.error)
        partialErrors.industryPerformance = industryPerf.error;
    if (sectorPe.error)
        partialErrors.sectorPe = sectorPe.error;
    if (industryPe.error)
        partialErrors.industryPe = industryPe.error;
    return successResult(`Fetched sector/industry performance and P/E snapshot${date ? ` for ${date}` : ""}.`, {
        date: date ?? null,
        sectorPerformance: sectorPerf.data,
        industryPerformance: industryPerf.data,
        sectorPe: sectorPe.data,
        industryPe: industryPe.data,
        partialErrors,
        fetchedAt,
    });
}
async function handleGetMacroCalendar(args) {
    const { from, to } = resolveDateRange(args, 14);
    const limit = getNumber(args, "limit", 100, 1, 500);
    const fetchedAt = new Date().toISOString();
    const partialErrors = {};
    const [events, treasuries] = await Promise.all([
        fmpTryArray("/economic-calendar", { from, to, limit }),
        fmpTryArray("/treasury-rates", {}),
    ]);
    if (events.error)
        partialErrors.economicCalendar = events.error;
    if (treasuries.error)
        partialErrors.treasuryRates = treasuries.error;
    return successResult(`Fetched ${events.data.length} economic events (${from} to ${to}) and treasury yields.`, {
        from,
        to,
        economicEvents: applyLatestLimit(events.data, limit),
        treasuryRates: firstOrNull(treasuries.data),
        partialErrors,
        fetchedAt,
    });
}
// ============================================================================
// MCP server setup
// ============================================================================
function createMcpServer() {
    const server = new Server({ name: "fmp-contributor", version: SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
            return await handleToolCall(request);
        }
        catch (error) {
            return errorResult(error);
        }
    });
    return server;
}
const app = express();
app.use(express.json({ limit: "10mb" }));
const transports = {};
const verifyContextAuth = createContextMiddleware();
const allowUnauthenticatedMcp = process.env.FMP_ALLOW_UNAUTH_MCP === "true";
const mcpAuthMiddleware = allowUnauthenticatedMcp
    ? (_req, _res, next) => {
        next();
    }
    : verifyContextAuth;
if (allowUnauthenticatedMcp) {
    console.warn("[fmp-auth] FMP_ALLOW_UNAUTH_MCP=true (auth disabled for /mcp; use only for temporary debugging).");
}
app.get("/health", (_req, res) => {
    const configuredApiKey = process.env.FMP_API_KEY?.trim();
    res.json({
        status: "ok",
        server: "fmp-contributor",
        version: SERVER_VERSION,
        contextAuthEnabled: !allowUnauthenticatedMcp,
        mcpAuthBypassEnabled: allowUnauthenticatedMcp,
        hasFmpApiKey: Boolean(configuredApiKey && configuredApiKey !== PLACEHOLDER_API_KEY),
        toolCount: TOOLS.length,
        tools: TOOLS.map((tool) => tool.name),
    });
});
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
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };
        await createMcpServer().connect(transport);
    }
    else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
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
        return;
    }
    res.status(400).send("No transport found for sessionId");
});
app.delete("/mcp", mcpAuthMiddleware, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = transports[sessionId];
    if (transport) {
        await transport.handleRequest(req, res);
        return;
    }
    res.status(400).send("No transport found for sessionId");
});
const port = Number(process.env.PORT || DEFAULT_PORT);
app.listen(port, () => {
    console.log(`\nFinancial Modeling Prep MCP Server v${SERVER_VERSION}`);
    console.log("Equities, statements, ratios, analyst, technicals, screening, and news");
    console.log(`Context Protocol Security Enabled: ${!allowUnauthenticatedMcp}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`Available tools: ${TOOLS.map((tool) => tool.name).join(", ")}\n`);
});
