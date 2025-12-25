/**
 * Dune Analytics MCP Server v1.0
 *
 * A streamlined MCP server for blockchain analytics using the Dune Analytics API.
 * Execute any of Dune's 750K+ community queries and retrieve results.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 *
 * API Documentation: https://docs.dune.com/api-reference
 *
 * TOOLS:
 * - execute_query: Execute any saved Dune query by ID
 * - get_query_results: Get cached results from a query (faster, 40 RPM)
 * - get_execution_status: Check status of a query execution
 * - get_execution_results: Get results from specific execution
 * - run_sql: Execute raw SQL directly (Premium feature)
 *
 * Rate Limits (Free Tier):
 * - Low limit endpoints (write-heavy): 15 RPM
 * - High limit endpoints (read-heavy): 40 RPM
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

// ============================================================================
// API CONFIGURATION
// ============================================================================

const DUNE_API_BASE = "https://api.dune.com/api/v1";
const API_KEY = process.env.DUNE_API_KEY || "";

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface DuneApiResponse<T = unknown> {
  execution_id?: string;
  query_id?: number;
  state?: string;
  submitted_at?: string;
  execution_started_at?: string;
  execution_ended_at?: string;
  expires_at?: string;
  is_execution_finished?: boolean;
  result?: {
    rows: T[];
    metadata?: {
      column_names: string[];
      column_types: string[];
      row_count: number;
      total_row_count: number;
      datapoint_count: number;
      execution_time_millis: number;
    };
  };
  error?: string;
}

// ============================================================================
// CURATED QUERY CATALOG
// ============================================================================
// Since Dune doesn't have a search API, we maintain a curated list of
// high-quality, working queries organized by category.
// These are DuneSQL queries that have been tested and are actively maintained.

interface CuratedQuery {
  id: number;
  name: string;
  description: string;
  category: string;
  params?: string[];
  author?: string;
}

const QUERY_CATALOG: CuratedQuery[] = [
  // DEX & Trading
  {
    id: 3358886,
    name: "DEX Volume by Chain (24h)",
    description: "Total DEX trading volume across all chains in the last 24 hours",
    category: "dex",
  },
  {
    id: 2803687,
    name: "Top DEX Protocols by Volume",
    description: "Ranking of DEX protocols by trading volume",
    category: "dex",
  },
  {
    id: 1324628,
    name: "Uniswap Daily Volume",
    description: "Daily trading volume on Uniswap across all chains",
    category: "dex",
  },
  
  // Wallet Analysis
  {
    id: 3352067,
    name: "Wallet Token Balances",
    description: "Get all token balances for a wallet address",
    category: "wallet",
    params: ["wallet_address"],
  },
  {
    id: 2898034,
    name: "Token Holder Analysis",
    description: "Analyze holders of a specific token",
    category: "wallet",
    params: ["token_address"],
  },
  
  // NFT
  {
    id: 3429556,
    name: "NFT Marketplace Volume",
    description: "Trading volume across NFT marketplaces",
    category: "nft",
  },
  {
    id: 2477537,
    name: "Top NFT Collections",
    description: "Most traded NFT collections by volume",
    category: "nft",
  },
  
  // Stablecoins
  {
    id: 3306394,
    name: "Stablecoin Market Cap",
    description: "Total market cap and distribution of stablecoins",
    category: "stablecoin",
  },
  {
    id: 2420432,
    name: "USDC vs USDT Volume",
    description: "Comparison of USDC and USDT trading activity",
    category: "stablecoin",
  },
  
  // Ethereum
  {
    id: 3298549,
    name: "ETH Gas Tracker",
    description: "Current Ethereum gas prices and trends",
    category: "ethereum",
  },
  {
    id: 2165698,
    name: "ETH Burned (EIP-1559)",
    description: "Total ETH burned since EIP-1559",
    category: "ethereum",
  },
  {
    id: 1610960,
    name: "ETH Staking Stats",
    description: "Ethereum staking statistics and validator count",
    category: "ethereum",
  },
  
  // Layer 2
  {
    id: 3357344,
    name: "L2 TVL Comparison",
    description: "Total Value Locked across Layer 2 networks",
    category: "l2",
  },
  {
    id: 3121877,
    name: "Base Chain Activity",
    description: "Transaction activity and growth on Base",
    category: "l2",
  },
  {
    id: 2904411,
    name: "Arbitrum Stats",
    description: "Key metrics for Arbitrum network",
    category: "l2",
  },
  
  // DeFi
  {
    id: 2635316,
    name: "Top DeFi Protocols by TVL",
    description: "Ranking of DeFi protocols by Total Value Locked",
    category: "defi",
  },
  {
    id: 3130886,
    name: "Lending Protocol Stats",
    description: "Aave, Compound, and other lending metrics",
    category: "defi",
  },
  
  // Bridge Activity
  {
    id: 2850663,
    name: "Bridge Volume",
    description: "Cross-chain bridge transfer volumes",
    category: "bridge",
  },
  
  // Memecoins
  {
    id: 3476890,
    name: "Top Memecoins by Volume",
    description: "Most traded memecoins in the last 24h",
    category: "memecoin",
  },
  
  // General/Utility
  {
    id: 1215383,
    name: "Test Query",
    description: "Simple test query to verify API connectivity",
    category: "utility",
  },
];

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  {
    name: "search_queries",
    description: `Search the curated catalog of high-quality Dune queries.

Returns query IDs that you can use with execute_query or get_query_results.

Categories: dex, wallet, nft, stablecoin, ethereum, l2, defi, bridge, memecoin, utility

Examples:
- "dex volume" → finds DEX trading queries
- "wallet balance" → finds wallet analysis queries  
- "ethereum gas" → finds ETH gas tracking queries
- "nft" → finds NFT marketplace queries

WORKFLOW:
1. FIRST: Search this curated catalog (fast, reliable queries)
2. IF NOT FOUND: Use the Exa Search tool to search "site:dune.com [your topic]" to discover more query IDs from Dune's 750K+ community dashboards
3. Extract the query ID from the Dune URL (e.g., dune.com/queries/1234567 → 1234567)
4. Use execute_query or get_query_results with that ID`,
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search term (e.g., 'dex volume', 'wallet balance', 'nft', 'ethereum')",
        },
        category: {
          type: "string",
          description: "Filter by category: dex, wallet, nft, stablecoin, ethereum, l2, defi, bridge, memecoin",
          enum: ["dex", "wallet", "nft", "stablecoin", "ethereum", "l2", "defi", "bridge", "memecoin", "utility"],
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        queries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              name: { type: "string" },
              description: { type: "string" },
              category: { type: "string" },
              params: { type: "array", items: { type: "string" } },
            },
          },
        },
        totalCount: { type: "number" },
        tip: { type: "string" },
      },
      required: ["queries"],
    },
  },

  {
    name: "execute_query",
    description: `Execute any saved Dune query by ID and return results.

This is your gateway to Dune's 750,000+ community queries! Find query IDs on dune.com.

How to find queries:
1. Go to dune.com and search for dashboards (e.g., "Uniswap Volume", "NFT Sales")
2. Click on a chart to see the underlying query
3. The query ID is in the URL: dune.com/queries/1234567 → use 1234567

Popular query IDs:
- 3237721: Top DEX traders by volume
- 2030664: Ethereum gas tracker  
- 1747157: NFT marketplace volumes
- 3296627: Wallet token balances (pass wallet_address param)

Note: This triggers a new execution (15 RPM limit). For cached data, use get_query_results (40 RPM).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID (e.g., 1234567)",
        },
        parameters: {
          type: "object",
          description: "Query parameters as key-value pairs (e.g., {wallet_address: '0x...'})",
        },
      },
      required: ["queryId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        executionId: { type: "string" },
        queryId: { type: "number" },
        state: { type: "string", enum: ["QUERY_STATE_PENDING", "QUERY_STATE_EXECUTING", "QUERY_STATE_COMPLETED", "QUERY_STATE_FAILED"] },
        submittedAt: { type: "string" },
        result: {
          type: "object",
          properties: {
            rows: { type: "array" },
            metadata: { type: "object" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["executionId", "state"],
    },
  },

  {
    name: "get_query_results",
    description: `Get the latest cached results from a Dune query WITHOUT triggering a new execution.

This is FASTER and has HIGHER rate limits (40 RPM vs 15 RPM for execute_query).
Results are cached for up to 90 days.

Use this when:
- You want quick results from a query that's been run recently
- You're hitting rate limits with execute_query
- You need to paginate through large result sets

Supports filtering, sorting, and pagination via parameters.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100, max: 10000)",
        },
        offset: {
          type: "number",
          description: "Row offset for pagination (default: 0)",
        },
        columns: {
          type: "string",
          description: "Comma-separated column names to return (optional)",
        },
        filters: {
          type: "string",
          description: "SQL WHERE-like filter (e.g., 'amount > 1000')",
        },
        sortBy: {
          type: "string",
          description: "Sort expression (e.g., 'amount desc')",
        },
      },
      required: ["queryId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        executionId: { type: "string" },
        queryId: { type: "number" },
        state: { type: "string" },
        isExecutionFinished: { type: "boolean" },
        result: {
          type: "object",
          properties: {
            rows: { type: "array" },
            metadata: {
              type: "object",
              properties: {
                columnNames: { type: "array", items: { type: "string" } },
                columnTypes: { type: "array", items: { type: "string" } },
                rowCount: { type: "number" },
                totalRowCount: { type: "number" },
              },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["queryId", "state"],
    },
  },

  {
    name: "get_execution_status",
    description: `Check the status of a query execution.

Use this to poll for completion after calling execute_query.
States: QUERY_STATE_PENDING → QUERY_STATE_EXECUTING → QUERY_STATE_COMPLETED (or FAILED)

Once isExecutionFinished is true, use get_execution_results to get the data.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        executionId: {
          type: "string",
          description: "Execution ID from execute_query response",
        },
      },
      required: ["executionId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        executionId: { type: "string" },
        queryId: { type: "number" },
        state: { type: "string" },
        isExecutionFinished: { type: "boolean" },
        submittedAt: { type: "string" },
        executionStartedAt: { type: "string" },
        executionEndedAt: { type: "string" },
        expiresAt: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["executionId", "state", "isExecutionFinished"],
    },
  },

  {
    name: "get_execution_results",
    description: `Get results from a specific query execution by executionId.

Use this after execute_query returns an executionId and the status shows completed.
Supports pagination with limit/offset for large result sets.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        executionId: {
          type: "string",
          description: "Execution ID",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100)",
        },
        offset: {
          type: "number",
          description: "Row offset for pagination",
        },
      },
      required: ["executionId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        executionId: { type: "string" },
        queryId: { type: "number" },
        state: { type: "string" },
        isExecutionFinished: { type: "boolean" },
        result: {
          type: "object",
          properties: {
            rows: { type: "array" },
            metadata: { type: "object" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["executionId", "state"],
    },
  },

  {
    name: "run_sql",
    description: `Execute raw SQL directly against Dune's data warehouse.

⚠️ PREMIUM FEATURE: Requires Plus tier or higher subscription.

This allows you to run arbitrary SQL without saving a query first.
Great for one-off analyses or dynamic queries.

Example SQL:
- SELECT * FROM dex.trades WHERE blockchain = 'ethereum' LIMIT 10
- SELECT SUM(amount_usd) FROM dex.trades WHERE block_time > now() - interval '24' hour`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "SQL query to execute",
        },
      },
      required: ["sql"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        executionId: { type: "string" },
        state: { type: "string" },
        result: {
          type: "object",
          properties: {
            rows: { type: "array" },
            metadata: { type: "object" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["state"],
    },
  },
];

// ============================================================================
// DUNE API CLIENT
// ============================================================================

async function duneApiRequest<T>(
  endpoint: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
    params?: Record<string, string | number | undefined>;
  } = {}
): Promise<T> {
  const { method = "GET", body, params } = options;

  if (!API_KEY) {
    throw new Error("DUNE_API_KEY is not configured. Get one at https://dune.com/settings/api");
  }

  const url = new URL(`${DUNE_API_BASE}${endpoint}`);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.append(key, String(value));
      }
    });
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "X-DUNE-API-KEY": API_KEY,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Dune API error (${response.status}): ${errorText.slice(0, 500)}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// TOOL HANDLERS
// ============================================================================

function searchQueries(args: {
  query?: string;
  category?: string;
}): CallToolResult {
  let results = [...QUERY_CATALOG];
  
  // Filter by category if provided
  if (args.category) {
    results = results.filter(q => q.category === args.category.toLowerCase());
  }
  
  // Search by query term if provided
  if (args.query) {
    const searchTerm = args.query.toLowerCase();
    results = results.filter(q => 
      q.name.toLowerCase().includes(searchTerm) ||
      q.description.toLowerCase().includes(searchTerm) ||
      q.category.toLowerCase().includes(searchTerm)
    );
  }
  
  // If no filters, return all
  if (!args.query && !args.category) {
    // Return first 10 as suggestions
    results = results.slice(0, 10);
  }
  
  const queries = results.map(q => ({
    id: q.id,
    name: q.name,
    description: q.description,
    category: q.category,
    params: q.params,
    usage: q.params 
      ? `execute_query(queryId: ${q.id}, parameters: {${q.params.map(p => `${p}: "..."`).join(", ")}})`
      : `execute_query(queryId: ${q.id})`,
  }));
  
  return successResult({
    queries,
    totalCount: queries.length,
    tip: queries.length > 0 
      ? `Found ${queries.length} queries. Use execute_query or get_query_results with the query ID.`
      : "No matching queries found. Try a different search term or browse categories: dex, wallet, nft, ethereum, l2, defi",
    categories: ["dex", "wallet", "nft", "stablecoin", "ethereum", "l2", "defi", "bridge", "memecoin"],
  });
}

async function executeQuery(args: {
  queryId: number;
  parameters?: Record<string, unknown>;
}): Promise<CallToolResult> {
  try {
    const body: Record<string, unknown> = {};
    if (args.parameters) {
      body.query_parameters = Object.entries(args.parameters).map(([key, value]) => ({
        key,
        value,
        type: typeof value === "number" ? "number" : "text",
      }));
    }

    const data: DuneApiResponse = await duneApiRequest(
      `/query/${args.queryId}/execute`,
      {
        method: "POST",
        body: Object.keys(body).length > 0 ? body : undefined,
      }
    );

    return successResult({
      executionId: data.execution_id,
      queryId: data.query_id || args.queryId,
      state: data.state || "QUERY_STATE_PENDING",
      submittedAt: data.submitted_at,
      result: data.result
        ? {
            rows: data.result.rows,
            metadata: data.result.metadata,
          }
        : undefined,
      note: "Query execution started. Use get_execution_status to check progress, then get_execution_results for data.",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to execute query: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getQueryResults(args: {
  queryId: number;
  limit?: number;
  offset?: number;
  columns?: string;
  filters?: string;
  sortBy?: string;
}): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse = await duneApiRequest(
      `/query/${args.queryId}/results`,
      {
        params: {
          limit: args.limit || 100,
          offset: args.offset,
          columns: args.columns,
          filters: args.filters,
          sort_by: args.sortBy,
        },
      }
    );

    return successResult({
      executionId: data.execution_id,
      queryId: data.query_id || args.queryId,
      state: data.state || "QUERY_STATE_COMPLETED",
      isExecutionFinished: data.is_execution_finished ?? true,
      result: data.result
        ? {
            rows: data.result.rows,
            metadata: {
              columnNames: data.result.metadata?.column_names,
              columnTypes: data.result.metadata?.column_types,
              rowCount: data.result.metadata?.row_count,
              totalRowCount: data.result.metadata?.total_row_count,
            },
          }
        : undefined,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get query results: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getExecutionStatus(args: { executionId: string }): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse = await duneApiRequest(
      `/execution/${args.executionId}/status`
    );

    return successResult({
      executionId: data.execution_id || args.executionId,
      queryId: data.query_id,
      state: data.state || "UNKNOWN",
      isExecutionFinished: data.is_execution_finished ?? false,
      submittedAt: data.submitted_at,
      executionStartedAt: data.execution_started_at,
      executionEndedAt: data.execution_ended_at,
      expiresAt: data.expires_at,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get execution status: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getExecutionResults(args: {
  executionId: string;
  limit?: number;
  offset?: number;
}): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse = await duneApiRequest(
      `/execution/${args.executionId}/results`,
      {
        params: {
          limit: args.limit || 100,
          offset: args.offset,
        },
      }
    );

    return successResult({
      executionId: data.execution_id || args.executionId,
      queryId: data.query_id,
      state: data.state || "QUERY_STATE_COMPLETED",
      isExecutionFinished: data.is_execution_finished ?? true,
      result: data.result
        ? {
            rows: data.result.rows,
            metadata: data.result.metadata,
          }
        : undefined,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get execution results: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function runSql(args: { sql: string }): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse = await duneApiRequest("/query/execute/sql", {
      method: "POST",
      body: {
        query_sql: args.sql,
      },
    });

    return successResult({
      executionId: data.execution_id,
      state: data.state || "QUERY_STATE_PENDING",
      result: data.result
        ? {
            rows: data.result.rows,
            metadata: data.result.metadata,
          }
        : undefined,
      note: data.execution_id
        ? "SQL execution started. Use get_execution_status to check progress."
        : "SQL executed successfully.",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    // Check if it's a premium feature error
    if (errorMsg.includes("402") || errorMsg.includes("Payment")) {
      return errorResult(
        "run_sql requires a Premium Dune subscription. Use execute_query with a saved query ID instead."
      );
    }
    return errorResult(`Failed to run SQL: ${errorMsg}`);
  }
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "dune-analytics", version: "1.0.0" },
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
        case "search_queries":
          return searchQueries(args as any);
        case "execute_query":
          return await executeQuery(args as any);
        case "get_query_results":
          return await getQueryResults(args as any);
        case "get_execution_status":
          return await getExecutionStatus(args as any);
        case "get_execution_results":
          return await getExecutionResults(args as any);
        case "run_sql":
          return await runSql(args as any);
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
// EXPRESS SERVER WITH STREAMABLE HTTP TRANSPORT
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

// Auth middleware using @ctxprotocol/sdk
const verifyContextAuth = createContextMiddleware();

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "dune-analytics",
    version: "1.0.0",
    apiKeyConfigured: !!API_KEY,
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

const port = Number(process.env.PORT || 4008);
app.listen(port, () => {
  console.log(`\n🔮 Dune Analytics MCP Server v1.0.0`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`\n🛠️  Available tools (${TOOLS.length}):`);
  TOOLS.forEach(t => console.log(`   - ${t.name}`));
  console.log(`\n⚙️  Configuration:`);
  console.log(`   API Key: ${API_KEY ? "✅ Configured" : "❌ Missing (set DUNE_API_KEY)"}`);
  console.log(`\n💡 TIP: Use get_query_results for cached data (40 RPM) vs execute_query (15 RPM)\n`);
  console.log(`📊 Popular query IDs to try:`);
  console.log(`   - 3237721: Top DEX traders`);
  console.log(`   - 2030664: ETH gas tracker`);
  console.log(`   - 1747157: NFT volumes\n`);
});
