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

// ⚠️ LIMITED SAMPLE CATALOG - NOT curated "best" queries
// These are random PUBLIC queries we found that work - NOT verified as popular/valuable
// Dune has 750K+ community queries - users should provide their own Query IDs
// for specific data they want. Find IDs at dune.com → click any chart → get ID from URL
const QUERY_CATALOG: CuratedQuery[] = [
  // ═══════════════════════════════════════════════════════════════
  // UTILITY & REFERENCE
  // ═══════════════════════════════════════════════════════════════
  {
    id: 1215383,
    name: "API Test Query",
    description: "Simple test query to verify Dune API connectivity - always works",
    category: "utility",
  },
  {
    id: 1747157,
    name: "Blockchain Explorers",
    description: "List of all 12 supported chains with block explorer URLs (ethereum, polygon, arbitrum, optimism, avalanche, etc.)",
    category: "ethereum",
  },
  {
    id: 2999200,
    name: "Labeled Addresses",
    description: "383 known addresses with names and blockchain labels (exchanges, protocols, whales)",
    category: "wallet",
  },

  // ═══════════════════════════════════════════════════════════════
  // ETHEREUM & GAS
  // ═══════════════════════════════════════════════════════════════
  {
    id: 2991700,
    name: "Daily Transaction Stats",
    description: "180 days of txn count, avg price USD, total gas used, average gas price",
    category: "ethereum",
  },
  {
    id: 2991800,
    name: "Ethereum Fees & Burn",
    description: "1134 records of total fees, ETH burned (EIP-1559), priority fees, slot utilization",
    category: "ethereum",
  },

  // ═══════════════════════════════════════════════════════════════
  // DEX & TRADING
  // ═══════════════════════════════════════════════════════════════
  {
    id: 1747600,
    name: "OHM/DAI Trading History",
    description: "1598 trades with block time, OHM amount, DAI amount, DAI per OHM price",
    category: "dex",
  },
  {
    id: 1756400,
    name: "DEX Solver Rankings",
    description: "171 solvers ranked by batches, trades, first batch date (CoW Protocol style)",
    category: "dex",
  },
  {
    id: 3506700,
    name: "Top DEX Traders",
    description: "89 traders ranked by total volume USD and number of trades",
    category: "dex",
  },
  {
    id: 3700000,
    name: "Trading Pair Rewards",
    description: "2388 epoch rewards by trading pair with token amounts and prices",
    category: "dex",
  },

  // ═══════════════════════════════════════════════════════════════
  // DEFI & STAKING
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3000000,
    name: "Self-Stakes by Address",
    description: "48533 addresses ranked by number of self-stakes",
    category: "defi",
  },
  {
    id: 3001900,
    name: "DeFi Markets List",
    description: "1662 markets with timestamp, name, symbol, underlying token address",
    category: "defi",
  },
  {
    id: 3003100,
    name: "Validator Bounties",
    description: "Total bounties, average bounties in USD, validator stats",
    category: "defi",
  },
  {
    id: 3695600,
    name: "Protocol Depositors",
    description: "152962 unique depositor addresses for a DeFi protocol",
    category: "defi",
  },
  {
    id: 3697500,
    name: "Token Shares by Date",
    description: "8526 records of daily shares, underlying token, symbol, price",
    category: "defi",
  },

  // ═══════════════════════════════════════════════════════════════
  // TOKEN & PROTOCOL METRICS
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3491000,
    name: "Total Protocol Users",
    description: "Cumulative unique users for a protocol",
    category: "defi",
  },
  {
    id: 3493600,
    name: "Token Holders & Supply",
    description: "Number of holders and circulating supply for a token",
    category: "wallet",
  },
  {
    id: 3500000,
    name: "Protocol Stats",
    description: "Total user count and transaction count for a protocol",
    category: "defi",
  },
  {
    id: 3696700,
    name: "Daily Token Transfers",
    description: "927 days of transfer activity by type and symbol",
    category: "wallet",
  },

  // ═══════════════════════════════════════════════════════════════
  // NFT & ENS
  // ═══════════════════════════════════════════════════════════════
  {
    id: 2993900,
    name: "ENS Name Registrations",
    description: "100 recent ENS name registrations with hash, cost, name, expiration",
    category: "nft",
  },

  // ═══════════════════════════════════════════════════════════════
  // BLOCKCHAIN ACTIVITY
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3145000,
    name: "Daily Transaction Stats",
    description: "1013 days of transactions succeeded/failed, unique senders/receivers",
    category: "ethereum",
  },
  {
    id: 2590100,
    name: "Daily Protocol Checks",
    description: "1072 days of checkForAll, checkForContract, checkForToken activity",
    category: "defi",
  },

  // ═══════════════════════════════════════════════════════════════
  // TOKEN PRICES (MASSIVE DATASET)
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3333000,
    name: "Token Prices by Epoch",
    description: "26.7 MILLION rows - token contract addresses, symbols, prices by epoch",
    category: "dex",
  },
  {
    id: 3185000,
    name: "Daily Price Groups",
    description: "771 days of grouped price summaries with deltas and max prices",
    category: "dex",
  },

  // ═══════════════════════════════════════════════════════════════
  // FUTURES & ETFs
  // ═══════════════════════════════════════════════════════════════
  {
    id: 3332000,
    name: "Open Interest by Date",
    description: "89 days of futures/options open interest data",
    category: "defi",
  },
  {
    id: 3382000,
    name: "Bitcoin ETF TVL",
    description: "7865 records of Bitcoin ETF TVL by issuer (Invesco, etc.) and date",
    category: "defi",
  },
];

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  {
    name: "search_queries",
    description: `Search our LIMITED catalog of 25 working Dune query IDs.

⚠️ IMPORTANT: This catalog contains random PUBLIC queries we verified work - NOT necessarily the most popular or valuable queries on Dune.

🎯 FOR BEST RESULTS: Provide your own Query ID!
1. Go to dune.com and find a dashboard you want to query
2. Click any chart → the query ID is in the URL (dune.com/queries/1234567)
3. Use execute_query(1234567) with that ID

OUR CATALOG (sample queries, not curated):
- ethereum: Gas, fees, transaction stats
- dex: Trading data, token prices
- defi: Staking, depositors, ETFs
- wallet: Addresses, transfers
- nft: ENS registrations

Dune has 750K+ community queries - our 25 are just a starting point.`,
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
    description: `Execute ANY Dune query by ID - this is the main tool!

🎯 BRING YOUR OWN QUERY ID for best results:
1. Browse dune.com dashboards (750K+ community queries)
2. Find a chart you want → click it → get ID from URL
3. URL: dune.com/queries/1234567 → use ID: 1234567

EXAMPLE IDS (from our small catalog):
- 1215383: API test (always works)
- 2991800: Ethereum fees
- 3333000: Token prices

EXECUTION FLOW:
1. execute_query(queryId) → executionId + state
2. If PENDING, wait 5-30s, then poll get_execution_status
3. get_execution_results(executionId) → data

Rate limit: 15 RPM (free tier).`,
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

⚠️ IMPORTANT: This only works if the query has been executed before and has cached results.
If you get "No execution found" error, use execute_query instead to trigger a fresh run.

Use this when:
- You want quick results from a popular/frequently-run query
- You're hitting rate limits with execute_query

If this fails with 404, fallback to: execute_query → get_execution_status → get_execution_results`,
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
    catalogSize: QUERY_CATALOG.length,
    tip: queries.length > 0 
      ? `Found ${queries.length} in our LIMITED catalog. For specific data, ask user for a Query ID from dune.com.`
      : "Not found in our small catalog (25 queries). Ask user for a specific Query ID from dune.com - there are 750K+ community queries!",
    howToGetMoreIds: "Browse dune.com → find dashboard → click chart → get ID from URL (dune.com/queries/1234567 → 1234567)",
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
