/**
 * Velo Data MCP Server v1.0
 *
 * Read-only crypto market intelligence over the official Velo API.
 * Covers product discovery, historical rows, funding/open-interest/liquidation
 * analysis, futures term structure, order book depth, market caps, and news.
 */
import "dotenv/config";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, isInitializeRequest, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import express from "express";
const require = createRequire(import.meta.url);
const veloModule = require("velo-node");
const SERVER_VERSION = "1.0.0";
const DEFAULT_PORT = 4010;
const DEFAULT_LOOKBACK_HOURS = getConfiguredNumber("VELO_DEFAULT_LOOKBACK_HOURS", 24, 1, 24 * 90);
const DEFAULT_RESOLUTION = process.env.VELO_DEFAULT_RESOLUTION?.trim() || "1h";
const DEFAULT_EXECUTE_USD = process.env.VELO_DEFAULT_EXECUTE_USD?.trim() || "0.002";
const FUTURES_DEFAULT_COLUMNS = [
    "close_price",
    "dollar_volume",
    "funding_rate",
    "dollar_open_interest_close",
    "buy_liquidations_dollar_volume",
    "sell_liquidations_dollar_volume",
];
const SPOT_DEFAULT_COLUMNS = ["close_price", "dollar_volume"];
const OPTIONS_DEFAULT_COLUMNS = ["index_price", "iv_1w", "skew_1w", "dollar_volume"];
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
function getVeloClient() {
    const apiKey = process.env.VELO_API_KEY?.trim();
    if (!apiKey || apiKey === "replace-with-your-velo-api-key") {
        throw new Error("VELO_API_KEY is required. Put your Velo API key in velo-contributor/.env.");
    }
    return new veloModule.Client(apiKey);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function toJsonValue(value) {
    if (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return value;
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
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    return args[key] === true;
}
function getNumber(args, key, fallback, min, max) {
    const value = args[key];
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
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
function getMarketType(args) {
    const requested = getString(args, "type");
    if (requested === "spot" || requested === "options") {
        return requested;
    }
    return "futures";
}
function getTimeRange(args) {
    const end = getNumber(args, "end", Date.now(), 0, Number.MAX_SAFE_INTEGER);
    const explicitBegin = args.begin;
    const lookbackHours = getNumber(args, "lookbackHours", DEFAULT_LOOKBACK_HOURS, 1, 24 * 365);
    const begin = typeof explicitBegin === "number" && Number.isFinite(explicitBegin)
        ? explicitBegin
        : end - lookbackHours * 60 * 60 * 1000;
    return {
        begin,
        end,
        lookbackHours: Math.max(0, (end - begin) / (60 * 60 * 1000)),
    };
}
function defaultColumnsFor(type) {
    if (type === "spot") {
        return SPOT_DEFAULT_COLUMNS;
    }
    if (type === "options") {
        return OPTIONS_DEFAULT_COLUMNS;
    }
    return FUTURES_DEFAULT_COLUMNS;
}
function columnsForClient(client, type) {
    if (type === "spot") {
        return client.spotColumns();
    }
    if (type === "options") {
        return client.optionsColumns();
    }
    return client.futuresColumns();
}
function requestedColumns(client, type, args) {
    const availableColumns = new Set(columnsForClient(client, type));
    const requested = getStringArray(args, "columns", defaultColumnsFor(type));
    const selected = [];
    for (const column of requested) {
        if (availableColumns.has(column)) {
            selected.push(column);
        }
    }
    return selected.length > 0 ? selected : defaultColumnsFor(type);
}
async function collectAsyncRows(iterable, maxRows) {
    const rows = [];
    for await (const row of iterable) {
        rows.push(toJsonObject(row));
        if (rows.length >= maxRows) {
            break;
        }
    }
    return rows;
}
function jsonNumber(row, key) {
    const value = row[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function jsonString(row, key) {
    const value = row[key];
    return typeof value === "string" && value.trim().length > 0 ? value : null;
}
function marketKey(row) {
    const exchange = jsonString(row, "exchange") ?? "all";
    const product = jsonString(row, "product") ?? jsonString(row, "coin") ?? "unknown";
    return `${exchange}:${product}`;
}
function summarizeFuturesRows(rows) {
    const summaries = new Map();
    for (const row of rows) {
        const key = marketKey(row);
        const current = summaries.get(key);
        const funding = jsonNumber(row, "funding_rate");
        const volume = jsonNumber(row, "dollar_volume");
        const openInterest = jsonNumber(row, "dollar_open_interest_close");
        const buyLiq = jsonNumber(row, "buy_liquidations_dollar_volume") ?? 0;
        const sellLiq = jsonNumber(row, "sell_liquidations_dollar_volume") ?? 0;
        if (!current) {
            summaries.set(key, {
                market: key,
                firstTime: jsonString(row, "time"),
                latestTime: jsonString(row, "time"),
                latestFundingRate: funding,
                averageFundingRate: funding,
                latestOpenInterestUsd: openInterest,
                firstOpenInterestUsd: openInterest,
                latestDollarVolume: volume,
                totalDollarVolume: volume ?? 0,
                buyLiquidationsUsd: buyLiq,
                sellLiquidationsUsd: sellLiq,
                rowCount: 1,
            });
            continue;
        }
        current.latestTime = jsonString(row, "time");
        current.latestFundingRate = funding;
        current.latestOpenInterestUsd = openInterest;
        current.latestDollarVolume = volume;
        current.totalDollarVolume =
            (jsonNumber(current, "totalDollarVolume") ?? 0) + (volume ?? 0);
        current.buyLiquidationsUsd =
            (jsonNumber(current, "buyLiquidationsUsd") ?? 0) + buyLiq;
        current.sellLiquidationsUsd =
            (jsonNumber(current, "sellLiquidationsUsd") ?? 0) + sellLiq;
        current.averageFundingRate =
            ((jsonNumber(current, "averageFundingRate") ?? 0) * current.rowCount +
                (funding ?? 0)) /
                (current.rowCount + 1);
        current.rowCount += 1;
    }
    return [...summaries.values()].map((summary) => {
        const firstOi = jsonNumber(summary, "firstOpenInterestUsd");
        const latestOi = jsonNumber(summary, "latestOpenInterestUsd");
        return {
            ...summary,
            openInterestChangeUsd: firstOi !== null && latestOi !== null ? latestOi - firstOi : null,
            liquidationImbalanceUsd: (jsonNumber(summary, "buyLiquidationsUsd") ?? 0) -
                (jsonNumber(summary, "sellLiquidationsUsd") ?? 0),
        };
    });
}
function buildRowsParams(client, args) {
    const type = getMarketType(args);
    const range = getTimeRange(args);
    const products = getStringArray(args, "products");
    const coins = getStringArray(args, "coins", products.length > 0 ? [] : ["BTC"]);
    return {
        type,
        columns: requestedColumns(client, type, args),
        exchanges: getStringArray(args, "exchanges"),
        products,
        coins,
        begin: range.begin,
        end: range.end,
        resolution: getString(args, "resolution") ?? DEFAULT_RESOLUTION,
    };
}
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
        structuredContent: {
            ok: false,
            error: message,
        },
    };
}
function toolMeta(latencyClass, notes, executeUsd = null) {
    return {
        surface: "answer",
        queryEligible: true,
        latencyClass,
        contextRequirements: {
            requiresUserApiKey: true,
            upstream: "Velo Data API",
            notes,
        },
        rateLimit: {
            maxConcurrency: 1,
            notes: "Velo API key limits apply. Prefer narrow time windows and explicit coins/products.",
        },
        ...(executeUsd
            ? {
                pricing: {
                    executeUsd,
                },
            }
            : {}),
    };
}
const genericObjectSchema = {
    type: "object",
    additionalProperties: true,
};
const listProductsOutputSchema = {
    type: "object",
    properties: {
        productCount: { type: "number" },
        products: {
            type: "array",
            items: genericObjectSchema,
        },
        fetchedAt: { type: "string" },
    },
    required: ["productCount", "products", "fetchedAt"],
};
const TOOLS = [
    {
        name: "check_api_status",
        description: "Check Velo API connectivity and the velo-node client version. Use this first when validating the API key or diagnosing upstream availability.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                status: { type: "string" },
                clientVersion: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["status", "clientVersion", "fetchedAt"],
        },
        _meta: toolMeta("instant", "One status request to Velo."),
    },
    {
        name: "list_futures_products",
        description: "List Velo futures products across supported exchanges. Supports filtering by exchange, product substring, coin/product text, and including delisted contracts.",
        inputSchema: {
            type: "object",
            properties: {
                includeDelisted: { type: "boolean" },
                exchange: { type: "string" },
                search: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: listProductsOutputSchema,
        _meta: toolMeta("fast", "Product discovery request for futures instruments."),
    },
    {
        name: "list_spot_products",
        description: "List Velo spot products across supported exchanges. Useful for finding BTC, ETH, SOL, or exchange-specific spot pairs before requesting rows.",
        inputSchema: {
            type: "object",
            properties: {
                includeDelisted: { type: "boolean" },
                exchange: { type: "string" },
                search: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: listProductsOutputSchema,
        _meta: toolMeta("fast", "Product discovery request for spot instruments."),
    },
    {
        name: "list_options_products",
        description: "List Velo options products, currently centered on Deribit under the upstream API. Use before options IV/skew queries.",
        inputSchema: {
            type: "object",
            properties: {
                search: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: listProductsOutputSchema,
        _meta: toolMeta("fast", "Product discovery request for options instruments."),
    },
    {
        name: "get_available_columns",
        description: "Return Velo's available futures, spot, and options data columns so the caller can request valid row metrics.",
        inputSchema: {
            type: "object",
            properties: {},
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                futures: { type: "array", items: { type: "string" } },
                spot: { type: "array", items: { type: "string" } },
                options: { type: "array", items: { type: "string" } },
            },
            required: ["futures", "spot", "options"],
        },
        _meta: toolMeta("instant", "Local velo-node column metadata."),
    },
    {
        name: "get_market_rows",
        description: "Fetch historical futures, spot, or options rows from Velo. Defaults to BTC futures over the last 24 hours with funding, open interest, volume, and liquidation metrics.",
        inputSchema: {
            type: "object",
            properties: {
                type: { type: "string", enum: ["futures", "spot", "options"] },
                columns: { type: "array", items: { type: "string" } },
                exchanges: { type: "array", items: { type: "string" } },
                products: { type: "array", items: { type: "string" } },
                coins: { type: "array", items: { type: "string" } },
                begin: { type: "number" },
                end: { type: "number" },
                lookbackHours: { type: "number" },
                resolution: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                params: genericObjectSchema,
                rowCount: { type: "number" },
                rows: { type: "array", items: genericObjectSchema },
                fetchedAt: { type: "string" },
            },
            required: ["params", "rowCount", "rows", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Streams historical rows; narrow time windows are recommended.", DEFAULT_EXECUTE_USD),
    },
    {
        name: "analyze_futures_market_structure",
        description: "Analyze recent futures funding, open interest, dollar volume, and liquidation pressure for one or more coins/products across exchanges.",
        inputSchema: {
            type: "object",
            properties: {
                exchanges: { type: "array", items: { type: "string" } },
                products: { type: "array", items: { type: "string" } },
                coins: { type: "array", items: { type: "string" } },
                lookbackHours: { type: "number" },
                resolution: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                summary: { type: "string" },
                markets: { type: "array", items: genericObjectSchema },
                rowCount: { type: "number" },
                params: genericObjectSchema,
                fetchedAt: { type: "string" },
            },
            required: ["summary", "markets", "rowCount", "params", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite analysis over Velo futures rows.", DEFAULT_EXECUTE_USD),
    },
    {
        name: "get_market_caps",
        description: "Fetch Velo circulating-supply market cap rows for selected coins over a time window.",
        inputSchema: {
            type: "object",
            properties: {
                coins: { type: "array", items: { type: "string" } },
                begin: { type: "number" },
                end: { type: "number" },
                lookbackHours: { type: "number" },
                resolution: { type: "string" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                rows: { type: "array", items: genericObjectSchema },
                rowCount: { type: "number" },
                params: genericObjectSchema,
                fetchedAt: { type: "string" },
            },
            required: ["rows", "rowCount", "params", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Market cap request for selected coins."),
    },
    {
        name: "get_futures_term_structure",
        description: "Fetch Velo futures term structure data for selected coins. Useful for basis, carry, contango/backwardation, and curve-shape research.",
        inputSchema: {
            type: "object",
            properties: {
                coins: { type: "array", items: { type: "string" } },
                begin: { type: "number" },
                end: { type: "number" },
                lookbackHours: { type: "number" },
                resolution: { type: "string" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                rows: { type: "array", items: genericObjectSchema },
                rowCount: { type: "number" },
                params: genericObjectSchema,
                fetchedAt: { type: "string" },
            },
            required: ["rows", "rowCount", "params", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Term structure request for selected coins."),
    },
    {
        name: "get_order_book_depth",
        description: "Fetch Velo order book depth snapshots by exchange/product or by coin. Use for liquidity, depth, and market-impact analysis.",
        inputSchema: {
            type: "object",
            properties: {
                exchange: { type: "string" },
                product: { type: "string" },
                coin: { type: "string" },
                begin: { type: "number" },
                end: { type: "number" },
                lookbackHours: { type: "number" },
                resolution: { type: "number" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                rows: { type: "array", items: genericObjectSchema },
                rowCount: { type: "number" },
                latestMid: { type: ["number", "null"] },
                params: genericObjectSchema,
                fetchedAt: { type: "string" },
            },
            required: ["rows", "rowCount", "latestMid", "params", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Streams order book depth snapshots.", DEFAULT_EXECUTE_USD),
    },
    {
        name: "get_recent_news",
        description: "Fetch recent crypto news stories from Velo. Pair with market data tools when explaining funding, liquidation, open-interest, or volatility changes.",
        inputSchema: {
            type: "object",
            properties: {
                lookbackHours: { type: "number" },
                begin: { type: "number" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                stories: { type: "array", items: genericObjectSchema },
                storyCount: { type: "number" },
                fetchedAt: { type: "string" },
            },
            required: ["stories", "storyCount", "fetchedAt"],
        },
        _meta: toolMeta("fast", "Velo news stories request."),
    },
    {
        name: "build_crypto_market_memo",
        description: "Build a compact market memo for selected coins by combining futures structure, market caps, and recent news. Good for buyer-facing alpha summaries.",
        inputSchema: {
            type: "object",
            properties: {
                coins: { type: "array", items: { type: "string" } },
                exchanges: { type: "array", items: { type: "string" } },
                lookbackHours: { type: "number" },
                resolution: { type: "string" },
                limit: { type: "number" },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                memo: { type: "string" },
                futuresMarkets: { type: "array", items: genericObjectSchema },
                marketCaps: { type: "array", items: genericObjectSchema },
                news: { type: "array", items: genericObjectSchema },
                fetchedAt: { type: "string" },
            },
            required: ["memo", "futuresMarkets", "marketCaps", "news", "fetchedAt"],
        },
        _meta: toolMeta("slow", "Composite Velo market memo across several endpoints.", DEFAULT_EXECUTE_USD),
    },
];
const server = new Server({
    name: "velo-contributor",
    version: SERVER_VERSION,
}, {
    capabilities: {
        tools: {},
    },
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
        return await handleToolCall(request);
    }
    catch (error) {
        return errorResult(error);
    }
});
async function handleToolCall(request) {
    const name = request.params.name;
    const args = getArgs(request);
    const client = getVeloClient();
    switch (name) {
        case "check_api_status": {
            const status = await client.status();
            const structuredContent = {
                status,
                clientVersion: client.version(),
                fetchedAt: new Date().toISOString(),
            };
            return successResult(`Velo API status: ${status}`, structuredContent);
        }
        case "list_futures_products": {
            const products = await filterProducts(await client.futures(getBoolean(args, "includeDelisted")), args);
            return successResult(`Found ${products.length} Velo futures products after filters.`, {
                productCount: products.length,
                products,
                fetchedAt: new Date().toISOString(),
            });
        }
        case "list_spot_products": {
            const products = await filterProducts(await client.spot(getBoolean(args, "includeDelisted")), args);
            return successResult(`Found ${products.length} Velo spot products after filters.`, {
                productCount: products.length,
                products,
                fetchedAt: new Date().toISOString(),
            });
        }
        case "list_options_products": {
            const products = await filterProducts(await client.options(), args);
            return successResult(`Found ${products.length} Velo options products after filters.`, {
                productCount: products.length,
                products,
                fetchedAt: new Date().toISOString(),
            });
        }
        case "get_available_columns": {
            const structuredContent = {
                futures: client.futuresColumns(),
                spot: client.spotColumns(),
                options: client.optionsColumns(),
            };
            return successResult("Fetched Velo column metadata.", structuredContent);
        }
        case "get_market_rows": {
            const params = buildRowsParams(client, args);
            const rows = await collectAsyncRows(client.rows(params), getNumber(args, "limit", 100, 1, 1_000));
            return successResult(`Fetched ${rows.length} Velo market rows.`, {
                params: toJsonObject(params),
                rowCount: rows.length,
                rows,
                fetchedAt: new Date().toISOString(),
            });
        }
        case "analyze_futures_market_structure": {
            const params = {
                ...buildRowsParams(client, { ...args, type: "futures" }),
                type: "futures",
                columns: FUTURES_DEFAULT_COLUMNS.filter((column) => client.futuresColumns().includes(column)),
            };
            const rows = await collectAsyncRows(client.rows(params), getNumber(args, "limit", 500, 1, 2_000));
            const markets = summarizeFuturesRows(rows);
            const summary = `Analyzed ${rows.length} futures rows across ${markets.length} market groups. Compare latestFundingRate, openInterestChangeUsd, totalDollarVolume, and liquidationImbalanceUsd for directional pressure.`;
            return successResult(summary, {
                summary,
                markets,
                rowCount: rows.length,
                params: toJsonObject(params),
                fetchedAt: new Date().toISOString(),
            });
        }
        case "get_market_caps": {
            const range = getTimeRange(args);
            const params = {
                coins: getStringArray(args, "coins", ["BTC", "ETH", "SOL"]),
                begin: range.begin,
                end: range.end,
                resolution: getString(args, "resolution") ?? "1d",
            };
            const rows = (await client.marketCaps(params)).map((row) => toJsonObject(row));
            return successResult(`Fetched ${rows.length} Velo market cap rows.`, {
                rows,
                rowCount: rows.length,
                params: toJsonObject(params),
                fetchedAt: new Date().toISOString(),
            });
        }
        case "get_futures_term_structure": {
            const range = getTimeRange(args);
            const params = {
                coins: getStringArray(args, "coins", ["BTC", "ETH"]),
                begin: range.begin,
                end: range.end,
                resolution: getString(args, "resolution") ?? DEFAULT_RESOLUTION,
            };
            const rows = (await client.termStructure(params)).map((row) => toJsonObject(row));
            return successResult(`Fetched ${rows.length} Velo term structure rows.`, {
                rows,
                rowCount: rows.length,
                params: toJsonObject(params),
                fetchedAt: new Date().toISOString(),
            });
        }
        case "get_order_book_depth": {
            const range = getTimeRange(args);
            const coin = getString(args, "coin");
            const exchange = getString(args, "exchange") ?? "binance-futures";
            const product = getString(args, "product") ?? "BTCUSDT";
            const params = coin
                ? {
                    coin,
                    begin: range.begin,
                    end: range.end,
                    resolution: getNumber(args, "resolution", 5, 1, 1_440),
                }
                : {
                    exchange,
                    product,
                    begin: range.begin,
                    end: range.end,
                    resolution: getNumber(args, "resolution", 5, 1, 1_440),
                };
            const rows = await collectAsyncRows(client.depth(params), getNumber(args, "limit", 100, 1, 1_000));
            const latestRow = rows.at(-1);
            const latestMid = latestRow ? jsonNumber(latestRow, "mid") : null;
            return successResult(`Fetched ${rows.length} Velo depth rows.`, {
                rows,
                rowCount: rows.length,
                latestMid,
                params: toJsonObject(params),
                fetchedAt: new Date().toISOString(),
            });
        }
        case "get_recent_news": {
            const range = getTimeRange(args);
            const limit = getNumber(args, "limit", 20, 1, 100);
            const stories = (await client.news.stories({ begin: range.begin }))
                .map((story) => toJsonObject(story))
                .slice(-limit);
            return successResult(`Fetched ${stories.length} recent Velo news stories.`, {
                stories,
                storyCount: stories.length,
                fetchedAt: new Date().toISOString(),
            });
        }
        case "build_crypto_market_memo": {
            return buildCryptoMarketMemo(client, args);
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
async function filterProducts(rawProducts, args) {
    const exchangeFilter = getString(args, "exchange")?.toLowerCase() ?? null;
    const searchFilter = getString(args, "search")?.toLowerCase() ?? null;
    const limit = getNumber(args, "limit", 50, 1, 500);
    const products = [];
    for (const product of rawProducts) {
        const normalized = toJsonObject(product);
        const exchange = jsonString(normalized, "exchange")?.toLowerCase() ?? "";
        const text = JSON.stringify(normalized).toLowerCase();
        if (exchangeFilter && exchange !== exchangeFilter) {
            continue;
        }
        if (searchFilter && !text.includes(searchFilter)) {
            continue;
        }
        products.push(normalized);
        if (products.length >= limit) {
            break;
        }
    }
    return products;
}
async function buildCryptoMarketMemo(client, args) {
    const coins = getStringArray(args, "coins", ["BTC", "ETH"]);
    const limit = getNumber(args, "limit", 200, 1, 1_000);
    const futuresParams = {
        ...buildRowsParams(client, {
            ...args,
            type: "futures",
            coins,
            columns: FUTURES_DEFAULT_COLUMNS,
        }),
        type: "futures",
    };
    const futuresRows = await collectAsyncRows(client.rows(futuresParams), limit);
    const futuresMarkets = summarizeFuturesRows(futuresRows);
    const range = getTimeRange(args);
    const marketCaps = (await client.marketCaps({
        coins,
        begin: range.begin,
        end: range.end,
        resolution: "1d",
    })).map((row) => toJsonObject(row));
    const news = (await client.news.stories({ begin: range.begin }))
        .map((story) => toJsonObject(story))
        .slice(-10);
    const memo = [
        `Velo market memo for ${coins.join(", ")} over ${range.lookbackHours.toFixed(1)} hours.`,
        `Futures coverage: ${futuresRows.length} rows summarized into ${futuresMarkets.length} market groups.`,
        `Market-cap rows: ${marketCaps.length}. Recent news stories: ${news.length}.`,
        "Use futures funding, open-interest change, liquidation imbalance, market caps, and news together before making a directional claim.",
    ].join(" ");
    return successResult(memo, {
        memo,
        futuresMarkets,
        marketCaps,
        news,
        fetchedAt: new Date().toISOString(),
    });
}
const app = express();
app.use(express.json({ limit: "10mb" }));
const transports = {};
const verifyContextAuth = createContextMiddleware();
const allowUnauthenticatedMcp = process.env.VELO_ALLOW_UNAUTH_MCP === "true";
const mcpAuthMiddleware = allowUnauthenticatedMcp
    ? (_req, _res, next) => {
        next();
    }
    : verifyContextAuth;
if (allowUnauthenticatedMcp) {
    console.warn("[velo-auth] VELO_ALLOW_UNAUTH_MCP=true (auth disabled for /mcp; use only for temporary debugging).");
}
app.get("/health", (_req, res) => {
    const configuredApiKey = process.env.VELO_API_KEY?.trim();
    res.json({
        status: "ok",
        server: "velo-contributor",
        version: SERVER_VERSION,
        contextAuthEnabled: !allowUnauthenticatedMcp,
        mcpAuthBypassEnabled: allowUnauthenticatedMcp,
        hasVeloApiKey: Boolean(configuredApiKey && configuredApiKey !== "replace-with-your-velo-api-key"),
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
        await server.connect(transport);
    }
    else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
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
    console.log(`\nVelo Data MCP Server v${SERVER_VERSION}`);
    console.log("Crypto market data, derivatives structure, and news intelligence");
    console.log(`Context Protocol Security Enabled: ${!allowUnauthenticatedMcp}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);
    console.log(`Health check: http://localhost:${port}/health`);
    console.log(`Available tools: ${TOOLS.map((tool) => tool.name).join(", ")}\n`);
});
