import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "normalized-data-provider";
const SERVER_VERSION = "1.0.0";
const INGESTION_INTERVAL_MS = 10_000;
const DEFAULT_EXECUTE_PRICE_USD = "0.001";
const UNPRICED_EXECUTE_METHODS = new Set(["get_supported_pairs"]);

const RATE_LIMIT_METADATA = {
  maxRequestsPerMinute: 600,
  maxConcurrency: 10,
  cooldownMs: 0,
  notes:
    "Served from local cache. No upstream rate limits at request time. Safe for high-frequency agent iteration.",
} as const;

interface NormalizedPrice {
  exchange: "binance" | "hyperliquid";
  symbol: string;
  price: number;
  volume24h: number;
  bid: number;
  ask: number;
  updatedAt: string;
}

interface BinanceTicker24h {
  symbol: string;
  lastPrice: string;
  volume: string;
  bidPrice: string;
  askPrice: string;
}

interface HyperliquidUniverseEntry {
  name: string;
}

interface HyperliquidAssetContext {
  dayNtlVlm?: string;
  bidPx?: string;
  askPx?: string;
  midPx?: string;
  markPx?: string;
}

const TOOLS = [
  {
    name: "get_prices",
    description:
      "Return normalized price snapshots from the local cache for selected symbols and exchanges.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbols: {
          type: "array",
          items: { type: "string" },
          description: "Trading pairs to fetch (omit for all tracked pairs)",
          default: ["BTC/USDT", "ETH/USDT"],
          examples: [
            ["BTC/USDT"],
            ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
          ],
        },
        exchanges: {
          type: "array",
          items: { type: "string" },
          description: "Exchanges to include (omit for all)",
          default: ["binance", "hyperliquid"],
          examples: [
            ["binance"],
            ["hyperliquid"],
            ["binance", "hyperliquid"],
          ],
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        prices: {
          type: "array",
          items: {
            type: "object",
            properties: {
              exchange: { type: "string" },
              symbol: { type: "string" },
              price: { type: "number" },
              volume24h: { type: "number" },
              bid: { type: "number" },
              ask: { type: "number" },
              updatedAt: { type: "string" },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["prices", "fetchedAt"],
    },
  },
  {
    name: "get_supported_pairs",
    description:
      "List tracked trading pairs and which exchanges currently have cached quotes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        exchange: {
          type: "string",
          description: "Filter by exchange (set 'all' or omit for all exchanges)",
          default: "all",
          examples: ["all", "binance", "hyperliquid"],
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        pairs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              symbol: { type: "string" },
              exchanges: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
      required: ["pairs"],
    },
  },
  {
    name: "get_price_spread",
    description:
      "Compare bid/ask spread by exchange for one symbol and report best bid/ask venues.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symbol: {
          type: "string",
          description: "Trading pair to compare across exchanges",
          default: "BTC/USDT",
          examples: ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
        },
      },
      required: ["symbol"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        symbol: { type: "string" },
        spreads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              exchange: { type: "string" },
              bid: { type: "number" },
              ask: { type: "number" },
              spread: { type: "number" },
              spreadBps: { type: "number" },
            },
          },
        },
        bestBid: {
          type: "object",
          properties: {
            exchange: { type: "string" },
            price: { type: "number" },
          },
        },
        bestAsk: {
          type: "object",
          properties: {
            exchange: { type: "string" },
            price: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["symbol", "spreads", "bestBid", "bestAsk", "fetchedAt"],
    },
  },
] as const;

const TOOLS_WITH_METADATA = TOOLS.map((tool) => {
  const pricing = UNPRICED_EXECUTE_METHODS.has(tool.name)
    ? {}
    : { executeUsd: DEFAULT_EXECUTE_PRICE_USD };

  return {
    ...tool,
    _meta: {
      surface: "both",
      queryEligible: true,
      latencyClass: "instant",
      pricing,
      rateLimit: RATE_LIMIT_METADATA,
    },
  };
});

let priceCache = new Map<string, NormalizedPrice[]>();
let lastCacheUpdateAt: string | null = null;
let lastIngestionError: string | null = null;

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

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

function normalizeSymbolFilter(value: string): string {
  const cleaned = value.trim().toUpperCase().replaceAll("-", "/");
  if (cleaned.includes("/")) {
    return cleaned;
  }
  if (cleaned.endsWith("USDT")) {
    return `${cleaned.slice(0, -4)}/USDT`;
  }
  return cleaned;
}

function normalizeBinanceSymbol(value: string): string | null {
  const upper = value.trim().toUpperCase();
  if (!upper.endsWith("USDT")) {
    return null;
  }
  const base = upper.slice(0, -4);
  if (base.length === 0) {
    return null;
  }
  return `${base}/USDT`;
}

function arrayFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0) {
      continue;
    }
    entries.push(trimmed);
  }
  return entries;
}

function flattenCache(cache: Map<string, NormalizedPrice[]>): NormalizedPrice[] {
  const flattened: NormalizedPrice[] = [];
  for (const group of cache.values()) {
    flattened.push(...group);
  }
  return flattened;
}

function buildPriceCache(prices: NormalizedPrice[]): Map<string, NormalizedPrice[]> {
  const next = new Map<string, NormalizedPrice[]>();
  for (const price of prices) {
    const existing = next.get(price.symbol);
    if (existing) {
      existing.push(price);
      continue;
    }
    next.set(price.symbol, [price]);
  }
  return next;
}

async function fetchBinancePrices(): Promise<NormalizedPrice[]> {
  const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
  if (!response.ok) {
    throw new Error(`Binance request failed with status ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Binance response did not return an array payload.");
  }

  const now = new Date().toISOString();
  const normalized: NormalizedPrice[] = [];
  for (const item of payload) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const ticker = item as Partial<BinanceTicker24h>;
    if (
      typeof ticker.symbol !== "string" ||
      typeof ticker.lastPrice !== "string" ||
      typeof ticker.volume !== "string" ||
      typeof ticker.bidPrice !== "string" ||
      typeof ticker.askPrice !== "string"
    ) {
      continue;
    }

    const symbol = normalizeBinanceSymbol(ticker.symbol);
    if (!symbol) {
      continue;
    }

    const price = parseNumber(ticker.lastPrice);
    const volume24h = parseNumber(ticker.volume);
    const bid = parseNumber(ticker.bidPrice);
    const ask = parseNumber(ticker.askPrice);
    if (price === null || volume24h === null || bid === null || ask === null) {
      continue;
    }

    normalized.push({
      exchange: "binance",
      symbol,
      price,
      volume24h,
      bid,
      ask,
      updatedAt: now,
    });
  }

  return normalized;
}

async function postHyperliquidInfo<T>(body: Record<string, string>): Promise<T> {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Hyperliquid request failed with status ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function fetchHyperliquidPrices(): Promise<NormalizedPrice[]> {
  const [midsPayload, metaPayload] = await Promise.all([
    postHyperliquidInfo<Record<string, string>>({ type: "allMids" }),
    postHyperliquidInfo<unknown>({ type: "metaAndAssetCtxs" }),
  ]);

  if (!Array.isArray(metaPayload) || metaPayload.length !== 2) {
    throw new Error("Hyperliquid metaAndAssetCtxs payload shape was invalid.");
  }

  const universeRaw = (
    metaPayload[0] as { universe?: unknown } | undefined
  )?.universe;
  const contextsRaw = metaPayload[1];

  if (!Array.isArray(universeRaw) || !Array.isArray(contextsRaw)) {
    throw new Error("Hyperliquid universe/context arrays were missing.");
  }

  const universe = universeRaw as HyperliquidUniverseEntry[];
  const contexts = contextsRaw as HyperliquidAssetContext[];

  const now = new Date().toISOString();
  const normalized: NormalizedPrice[] = [];
  const limit = Math.min(universe.length, contexts.length);

  for (let index = 0; index < limit; index += 1) {
    const asset = universe[index];
    const context = contexts[index];
    if (!asset || typeof asset.name !== "string") {
      continue;
    }

    const symbol = `${asset.name.toUpperCase()}/USDT`;
    const midsValue = midsPayload[asset.name] ?? midsPayload[asset.name.toUpperCase()];
    const price =
      parseNumber(midsValue) ??
      parseNumber(context?.midPx) ??
      parseNumber(context?.markPx);
    if (price === null) {
      continue;
    }

    const bid = parseNumber(context?.bidPx) ?? price;
    const ask = parseNumber(context?.askPx) ?? price;
    const volume24h = parseNumber(context?.dayNtlVlm) ?? 0;

    normalized.push({
      exchange: "hyperliquid",
      symbol,
      price,
      volume24h,
      bid,
      ask,
      updatedAt: now,
    });
  }

  return normalized;
}

async function refreshCacheFromUpstream(): Promise<void> {
  const [binanceResult, hyperliquidResult] = await Promise.allSettled([
    fetchBinancePrices(),
    fetchHyperliquidPrices(),
  ]);

  const merged: NormalizedPrice[] = [];
  const errors: string[] = [];

  if (binanceResult.status === "fulfilled") {
    merged.push(...binanceResult.value);
  } else {
    errors.push(`binance: ${binanceResult.reason instanceof Error ? binanceResult.reason.message : "unknown error"}`);
  }

  if (hyperliquidResult.status === "fulfilled") {
    merged.push(...hyperliquidResult.value);
  } else {
    errors.push(
      `hyperliquid: ${
        hyperliquidResult.reason instanceof Error
          ? hyperliquidResult.reason.message
          : "unknown error"
      }`
    );
  }

  if (merged.length > 0) {
    priceCache = buildPriceCache(merged);
    lastCacheUpdateAt = new Date().toISOString();
  }

  if (errors.length === 0) {
    lastIngestionError = null;
    return;
  }

  lastIngestionError = errors.join(" | ");
  if (merged.length === 0) {
    throw new Error(lastIngestionError);
  }
}

async function startIngestionLoop(): Promise<void> {
  await refreshCacheFromUpstream().catch((error: unknown) => {
    if (error instanceof Error) {
      lastIngestionError = error.message;
      return;
    }
    lastIngestionError = "Unknown ingestion error.";
  });

  setInterval(() => {
    void refreshCacheFromUpstream().catch((error: unknown) => {
      if (error instanceof Error) {
        lastIngestionError = error.message;
        return;
      }
      lastIngestionError = "Unknown ingestion error.";
    });
  }, INGESTION_INTERVAL_MS);
}

async function handleGetPrices(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const symbols = arrayFromUnknown(args?.symbols).map(normalizeSymbolFilter);
  const exchanges = arrayFromUnknown(args?.exchanges).map((value) =>
    value.toLowerCase()
  );

  const symbolFilter = symbols.length > 0 ? new Set(symbols) : null;
  const exchangeFilter = exchanges.length > 0 ? new Set(exchanges) : null;

  const filtered = flattenCache(priceCache).filter((price) => {
    if (symbolFilter && !symbolFilter.has(price.symbol)) {
      return false;
    }
    if (exchangeFilter && !exchangeFilter.has(price.exchange)) {
      return false;
    }
    return true;
  });

  return successResult({
    prices: filtered,
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetSupportedPairs(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const exchangeValue = typeof args?.exchange === "string" ? args.exchange : "all";
  const normalizedExchange = exchangeValue.toLowerCase();
  const shouldFilter = normalizedExchange !== "all";

  const pairs = new Map<string, Set<string>>();
  for (const price of flattenCache(priceCache)) {
    if (shouldFilter && price.exchange !== normalizedExchange) {
      continue;
    }
    const existing = pairs.get(price.symbol);
    if (existing) {
      existing.add(price.exchange);
      continue;
    }
    pairs.set(price.symbol, new Set([price.exchange]));
  }

  const output: Array<{ symbol: string; exchanges: string[] }> = [];
  for (const [symbol, exchanges] of pairs.entries()) {
    output.push({
      symbol,
      exchanges: [...exchanges].sort(),
    });
  }
  output.sort((left, right) => left.symbol.localeCompare(right.symbol));

  return successResult({
    pairs: output,
  });
}

async function handleGetPriceSpread(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const symbolInput = typeof args?.symbol === "string" ? args.symbol : "BTC/USDT";
  const symbol = normalizeSymbolFilter(symbolInput);
  const entries = priceCache.get(symbol) ?? [];

  if (entries.length === 0) {
    return errorResult(`No cached prices are currently available for ${symbol}.`);
  }

  const spreads = entries.map((entry) => {
    const spread = entry.ask - entry.bid;
    const midpoint = (entry.ask + entry.bid) / 2;
    const spreadBps = midpoint > 0 ? (spread / midpoint) * 10_000 : 0;
    return {
      exchange: entry.exchange,
      bid: entry.bid,
      ask: entry.ask,
      spread,
      spreadBps,
    };
  });

  const bestBid = spreads.reduce((current, next) =>
    next.bid > current.bid ? next : current
  );
  const bestAsk = spreads.reduce((current, next) =>
    next.ask < current.ask ? next : current
  );

  return successResult({
    symbol,
    spreads,
    bestBid: { exchange: bestBid.exchange, price: bestBid.bid },
    bestAsk: { exchange: bestAsk.exchange, price: bestAsk.ask },
    fetchedAt: new Date().toISOString(),
  });
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
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
        case "get_prices":
          return await handleGetPrices(args);
        case "get_supported_pairs":
          return await handleGetSupportedPairs(args);
        case "get_price_spread":
          return await handleGetPriceSpread(args);
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : "Unknown execution error."
      );
    }
  }
);

void startIngestionLoop();

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};
const verifyContextAuth = createContextMiddleware();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    trackedPairs: priceCache.size,
    ingestionIntervalMs: INGESTION_INTERVAL_MS,
    cacheUpdatedAt: lastCacheUpdateAt,
    ingestionWarning: lastIngestionError,
    methods: TOOLS.map((tool) => tool.name),
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
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize first." },
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
    return;
  }
  res.status(400).json({ error: "Invalid session" });
});

app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: "Invalid session" });
});

const port = Number(process.env.PORT) || 4011;
app.listen(port);
