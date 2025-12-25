/**
 * Dune Analytics MCP Server v1.0
 *
 * A streamlined MCP server for blockchain analytics using the Dune Analytics API.
 * Provides trending contract discovery, DEX insights, Farcaster trends, EigenLayer
 * metrics, and the ability to execute any of Dune's 750K+ community queries.
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 *
 * API Documentation: https://docs.dune.com/api-reference
 *
 * INTELLIGENCE LAYER
 * - discover_trending_contracts: Find trending smart contracts on any EVM chain
 * - get_dex_pair_stats: Get comprehensive DEX trading pair statistics
 * - get_farcaster_trends: Discover trending Farcaster users, channels, memecoins
 *
 * RAW DATA LAYER (Bridge to 750K+ Community Queries)
 * - execute_query: Execute any saved Dune query by ID
 * - get_query_results: Get cached results from a query
 * - get_execution_status: Check status of a query execution
 * - get_execution_results: Get results from specific execution
 * - get_eigenlayer_avs: Get EigenLayer AVS metadata and metrics
 * - get_eigenlayer_operators: Get EigenLayer operator data
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

// Supported blockchains for analytics
const SUPPORTED_CHAINS = [
  "ethereum",
  "polygon",
  "arbitrum",
  "optimism",
  "base",
  "avalanche_c",
  "bnb",
];

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

interface TrendingContract {
  contract_address: string;
  name: string;
  transaction_count_30d: number;
  unique_users_30d: number;
  category?: string;
}

interface DexPairStats {
  pair: string;
  dex: string;
  volume_1d: number;
  volume_7d: number;
  volume_30d: number;
  liquidity_usd: number;
  volume_to_liquidity_7d: number;
}

interface EigenlayerAVS {
  avs_address: string;
  name: string;
  tvl_usd: number;
  operator_count: number;
  staker_count: number;
}

interface EigenlayerOperator {
  operator_address: string;
  name: string;
  tvl_usd: number;
  staker_count: number;
  avs_count: number;
}

interface FarcasterUser {
  fid: number;
  username: string;
  display_name: string;
  follower_count: number;
  engagement_score: number;
}

interface FarcasterChannel {
  channel_id: string;
  name: string;
  follower_count: number;
  cast_count_24h: number;
  engagement_score: number;
}

interface FarcasterMemecoin {
  token_address: string;
  symbol: string;
  name: string;
  holder_count: number;
  volume_24h: number;
  liquidity_usd: number;
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ============================================================================
  // INTELLIGENCE LAYER
  // ============================================================================

  {
    name: "discover_trending_contracts",
    description: `🧠 INTELLIGENCE: Discover trending smart contracts on any EVM chain.
    
Identifies contracts with high activity in the last 30 days based on transaction
count and unique users. Great for finding emerging protocols and hot projects.

Supports: ethereum, polygon, arbitrum, optimism, base, avalanche, bnb, and more.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        chain: {
          type: "string",
          description: "EVM chain (e.g., ethereum, polygon, arbitrum, base)",
          enum: ["ethereum", "polygon", "arbitrum", "optimism", "base", "avalanche_c", "bnb"],
        },
        limit: {
          type: "number",
          description: "Max results (default: 20, max: 100)",
        },
      },
      required: ["chain"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        chain: { type: "string" },
        contracts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              contractAddress: { type: "string" },
              name: { type: "string" },
              transactionCount30d: { type: "number" },
              uniqueUsers30d: { type: "number" },
              category: { type: "string" },
              activityScore: { type: "number" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["chain", "contracts"],
    },
  },

  {
    name: "get_dex_pair_stats",
    description: `🧠 INTELLIGENCE: Get comprehensive DEX trading pair statistics.
    
Returns trading volumes (1d/7d/30d), liquidity, volume-to-liquidity ratio,
and pool addresses for any token pair. Aggregates data across multiple DEXs.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        blockchain: {
          type: "string",
          description: "Blockchain (e.g., ethereum, polygon)",
          enum: SUPPORTED_CHAINS,
        },
        tokenAddress: {
          type: "string",
          description: "Token contract address (0x...)",
        },
        pairedTokenAddress: {
          type: "string",
          description: "Paired token address (e.g., WETH, USDC). Optional.",
        },
      },
      required: ["blockchain", "tokenAddress"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        blockchain: { type: "string" },
        tokenAddress: { type: "string" },
        pairs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pairAddress: { type: "string" },
              dex: { type: "string" },
              token0: { type: "string" },
              token1: { type: "string" },
              volume1d: { type: "number" },
              volume7d: { type: "number" },
              volume30d: { type: "number" },
              liquidityUsd: { type: "number" },
              volumeToLiquidity7d: { type: "number" },
            },
          },
        },
        aggregatedStats: {
          type: "object",
          properties: {
            totalVolume24h: { type: "number" },
            totalLiquidity: { type: "number" },
            topDex: { type: "string" },
            pairCount: { type: "number" },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["blockchain", "pairs"],
    },
  },

  {
    name: "get_farcaster_trends",
    description: `🧠 INTELLIGENCE: Discover trending Farcaster users, channels, and memecoins.
    
Get curated lists of trending Farcaster ecosystem data based on engagement,
on-chain activity, and social signals. Includes trending users, channels, and memecoins.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        type: {
          type: "string",
          description: "Type of trends to fetch",
          enum: ["users", "channels", "memecoins"],
        },
        limit: {
          type: "number",
          description: "Max results (default: 20)",
        },
      },
      required: ["type"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        type: { type: "string" },
        data: {
          type: "array",
          description: "Trending items (users, channels, or memecoins)",
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["type", "data"],
    },
  },

  // ============================================================================
  // RAW DATA LAYER (Bridge to 750K+ Community Queries)
  // ============================================================================

  {
    name: "execute_query",
    description: `📊 RAW: Execute a saved Dune query by ID and return results.
    
Triggers execution of a saved query. For queries that take time to execute,
use get_execution_status and get_query_results to poll for completion.

Note: This is a write-heavy endpoint (15 RPM on free tier).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID (e.g., 1234567)",
        },
        parameters: {
          type: "object",
          description: "Query parameters as key-value pairs",
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
    description: `📊 RAW: Get results from a query by query ID.
    
Returns the latest cached results for a public query. For private queries,
you must be the owner. Results are cached for 90 days.

Note: This is a read-heavy endpoint (40 RPM on free tier).`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 100)",
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
          description: "SQL WHERE-like filter expression (optional)",
        },
        sortBy: {
          type: "string",
          description: "SQL ORDER BY-like sort expression (optional)",
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
                datapointCount: { type: "number" },
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
    description: `📊 RAW: Check the status of a query execution.
    
Poll this endpoint to check if a query execution is complete.
Use the executionId returned from execute_query.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        executionId: {
          type: "string",
          description: "Execution ID from execute_query",
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
    description: `📊 RAW: Get results from a specific query execution.
    
Returns results for a specific execution ID. Useful when you need results
from a particular run rather than the latest cached results.`,
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
    name: "get_eigenlayer_avs",
    description: `📊 RAW: Get EigenLayer AVS (Actively Validated Services) metadata and metrics.
    
Returns AVS data including name, TVL, operator count, and staker count.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
        sortBy: {
          type: "string",
          description: "Sort field (e.g., 'tvl desc')",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        avsData: {
          type: "array",
          items: {
            type: "object",
            properties: {
              avsAddress: { type: "string" },
              name: { type: "string" },
              tvlUsd: { type: "number" },
              operatorCount: { type: "number" },
              stakerCount: { type: "number" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["avsData"],
    },
  },

  {
    name: "get_eigenlayer_operators",
    description: `📊 RAW: Get EigenLayer operator metadata and metrics.
    
Returns operator data including name, TVL, staker count, and AVS registrations.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max results (default: 50)",
        },
        sortBy: {
          type: "string",
          description: "Sort field (e.g., 'tvl desc')",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        operators: {
          type: "array",
          items: {
            type: "object",
            properties: {
              operatorAddress: { type: "string" },
              name: { type: "string" },
              tvlUsd: { type: "number" },
              stakerCount: { type: "number" },
              avsCount: { type: "number" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["operators"],
    },
  },

  {
    name: "list_supported_chains",
    description: `📂 DISCOVERY: List all supported blockchain networks for analysis.
    
Returns the list of EVM chains supported by Dune for wallet analysis,
token tracking, and other blockchain-specific queries.`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        chains: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              displayName: { type: "string" },
              chainId: { type: "number" },
            },
          },
        },
        totalCount: { type: "number" },
        fetchedAt: { type: "string" },
      },
      required: ["chains"],
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

async function discoverTrendingContracts(args: {
  chain: string;
  limit?: number;
}): Promise<CallToolResult> {
  const limit = Math.min(args.limit || 20, 100);

  try {
    const data: DuneApiResponse<TrendingContract> = await duneApiRequest(
      `/trends/evm/contracts/${args.chain}`,
      {
        params: { limit },
      }
    );

    const contracts = (data.result?.rows || []).map((row, index) => ({
      contractAddress: row.contract_address,
      name: row.name || "Unknown",
      transactionCount30d: row.transaction_count_30d,
      uniqueUsers30d: row.unique_users_30d,
      category: row.category || "Unknown",
      activityScore: Math.round(
        (row.transaction_count_30d * 0.6 + row.unique_users_30d * 0.4) / 1000
      ),
      rank: index + 1,
    }));

    return successResult({
      chain: args.chain,
      contracts,
      totalCount: contracts.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get trending contracts: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getDexPairStats(args: {
  blockchain: string;
  tokenAddress: string;
  pairedTokenAddress?: string;
}): Promise<CallToolResult> {
  try {
    const params: Record<string, string> = {
      blockchain: args.blockchain,
      token_address: args.tokenAddress,
    };
    if (args.pairedTokenAddress) {
      params.paired_token_address = args.pairedTokenAddress;
    }

    const data: DuneApiResponse<DexPairStats> = await duneApiRequest("/dex/pair", {
      params,
    });

    const pairs = (data.result?.rows || []).map((row) => ({
      pairAddress: row.pair,
      dex: row.dex,
      token0: args.tokenAddress,
      token1: args.pairedTokenAddress || "Various",
      volume1d: row.volume_1d,
      volume7d: row.volume_7d,
      volume30d: row.volume_30d,
      liquidityUsd: row.liquidity_usd,
      volumeToLiquidity7d: row.volume_to_liquidity_7d,
    }));

    const totalVolume24h = pairs.reduce((sum, p) => sum + (p.volume1d || 0), 0);
    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidityUsd || 0), 0);
    const topDex =
      pairs.sort((a, b) => (b.volume1d || 0) - (a.volume1d || 0))[0]?.dex || "N/A";

    return successResult({
      blockchain: args.blockchain,
      tokenAddress: args.tokenAddress,
      pairs,
      aggregatedStats: {
        totalVolume24h,
        totalLiquidity,
        topDex,
        pairCount: pairs.length,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get DEX pair stats: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getFarcasterTrends(args: {
  type: "users" | "channels" | "memecoins";
  limit?: number;
}): Promise<CallToolResult> {
  const limit = args.limit || 20;

  try {
    let endpoint = "";
    switch (args.type) {
      case "users":
        endpoint = "/farcaster/users";
        break;
      case "channels":
        endpoint = "/farcaster/channels";
        break;
      case "memecoins":
        endpoint = "/farcaster/memecoins";
        break;
    }

    const data: DuneApiResponse<FarcasterUser | FarcasterChannel | FarcasterMemecoin> =
      await duneApiRequest(endpoint, { params: { limit } });

    return successResult({
      type: args.type,
      data: data.result?.rows || [],
      totalCount: data.result?.rows?.length || 0,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get Farcaster trends: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
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
              datapointCount: data.result.metadata?.datapoint_count,
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

async function getEigenlayerAVS(args: {
  limit?: number;
  sortBy?: string;
}): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse<EigenlayerAVS> = await duneApiRequest(
      "/eigenlayer/avs-stats",
      {
        params: {
          limit: args.limit || 50,
          sort_by: args.sortBy,
        },
      }
    );

    const avsData = (data.result?.rows || []).map((row) => ({
      avsAddress: row.avs_address,
      name: row.name,
      tvlUsd: row.tvl_usd,
      operatorCount: row.operator_count,
      stakerCount: row.staker_count,
    }));

    return successResult({
      avsData,
      totalCount: avsData.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get EigenLayer AVS data: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

async function getEigenlayerOperators(args: {
  limit?: number;
  sortBy?: string;
}): Promise<CallToolResult> {
  try {
    const data: DuneApiResponse<EigenlayerOperator> = await duneApiRequest(
      "/eigenlayer/operator-stats",
      {
        params: {
          limit: args.limit || 50,
          sort_by: args.sortBy,
        },
      }
    );

    const operators = (data.result?.rows || []).map((row) => ({
      operatorAddress: row.operator_address,
      name: row.name,
      tvlUsd: row.tvl_usd,
      stakerCount: row.staker_count,
      avsCount: row.avs_count,
    }));

    return successResult({
      operators,
      totalCount: operators.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(
      `Failed to get EigenLayer operators: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  }
}

function listSupportedChains(): CallToolResult {
  const chainData = [
    { name: "ethereum", displayName: "Ethereum", chainId: 1 },
    { name: "polygon", displayName: "Polygon", chainId: 137 },
    { name: "arbitrum", displayName: "Arbitrum One", chainId: 42161 },
    { name: "optimism", displayName: "Optimism", chainId: 10 },
    { name: "base", displayName: "Base", chainId: 8453 },
    { name: "avalanche_c", displayName: "Avalanche C-Chain", chainId: 43114 },
    { name: "bnb", displayName: "BNB Smart Chain", chainId: 56 },
    { name: "gnosis", displayName: "Gnosis", chainId: 100 },
    { name: "fantom", displayName: "Fantom", chainId: 250 },
    { name: "celo", displayName: "Celo", chainId: 42220 },
  ];

  return successResult({
    chains: chainData,
    totalCount: chainData.length,
    fetchedAt: new Date().toISOString(),
  });
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
        // Intelligence Layer
        case "discover_trending_contracts":
          return await discoverTrendingContracts(args as any);
        case "get_dex_pair_stats":
          return await getDexPairStats(args as any);
        case "get_farcaster_trends":
          return await getFarcasterTrends(args as any);

        // Raw Data Layer (Bridge to Community Queries)
        case "execute_query":
          return await executeQuery(args as any);
        case "get_query_results":
          return await getQueryResults(args as any);
        case "get_execution_status":
          return await getExecutionStatus(args as any);
        case "get_execution_results":
          return await getExecutionResults(args as any);
        case "get_eigenlayer_avs":
          return await getEigenlayerAVS(args as any);
        case "get_eigenlayer_operators":
          return await getEigenlayerOperators(args as any);

        // Discovery
        case "list_supported_chains":
          return listSupportedChains();

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
  console.log(`\n🛠️  Available tools (${TOOLS.length} total):`);
  console.log(`   Intelligence: ${TOOLS.filter((t) => t.description.includes("🧠")).map((t) => t.name).join(", ")}`);
  console.log(`   Raw Data: ${TOOLS.filter((t) => t.description.includes("📊")).map((t) => t.name).join(", ")}`);
  console.log(`   Discovery: ${TOOLS.filter((t) => t.description.includes("📂")).map((t) => t.name).join(", ")}`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   API Key: ${API_KEY ? "✅ Configured" : "❌ Missing (set DUNE_API_KEY)"}`);
  console.log(`\n💡 Use execute_query to run any of Dune's 750K+ community queries!\n`);
});

