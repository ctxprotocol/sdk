/**
 * Dune Analytics MCP Server v5.0 - PERSONALIZED BLOCKCHAIN ANALYTICS
 *
 * A powerful MCP server for blockchain analytics using the official Dune SDK.
 * Now with PERSONALIZED WALLET TOOLS for connected wallets!
 *
 * v5.0 NEW - Personalized Wallet Analytics:
 * - analyze_my_portfolio: Complete portfolio dashboard for connected wallet
 * - my_trading_history: Full DEX trading history with filters
 * - my_token_pnl: Profit/Loss calculation per token
 * - wallets_like_mine: Find lookalike wallets (similar to FB/Twitter audiences)
 *
 * Built with @duneanalytics/client-sdk for:
 * - Auto-polling (queries return data, not just executionId)
 * - Type-safe query parameters
 * - Better error handling
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 * - contextRequirements (wallet injection via SDK)
 *
 * API Documentation: https://docs.dune.com/api-reference
 * SDK: https://github.com/duneanalytics/ts-dune-client
 * Spellbook: https://github.com/duneanalytics/spellbook
 *
 * DISCOVERY TOOLS:
 * - discover_tables: Query Dune API for 2,800+ community tables
 * - list_datasets: Browse datasets with filters (owner, type)
 * - get_dataset_schema: Get REAL columns from Dune API
 *
 * QUERY TOOLS:
 * - run_sql: Execute raw SQL (auto-detects freshness needs)
 * - execute_query: Execute saved Dune queries by ID
 * - get_query_results: Get results from a query ID
 * - get_credit_usage: Monitor your API credits
 *
 * 🎯 PERSONALIZED TOOLS (require wallet context):
 * - analyze_my_portfolio: Portfolio dashboard
 * - my_trading_history: Your DEX trades
 * - my_token_pnl: Your profit/loss
 * - wallets_like_mine: Find similar traders
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
import { DuneClient, QueryParameter } from "@duneanalytics/client-sdk";

// ============================================================================
// API CONFIGURATION
// ============================================================================

const API_KEY = process.env.DUNE_API_KEY || "";

// Initialize official Dune SDK client
const duneClient = API_KEY ? new DuneClient(API_KEY) : null;

// ============================================================================
// SMART CACHING & CREDIT ESTIMATION
// ============================================================================

/**
 * Freshness levels for queries - controls cache behavior
 */
type FreshnessLevel = "realtime" | "recent" | "cached" | "auto";

/**
 * Estimated credit costs per operation (approximate)
 * Actual costs vary by query complexity and data scanned
 */
const CREDIT_ESTIMATES = {
  CACHE_HIT: 1,            // Reading from cache is cheap
  SIMPLE_QUERY: 10,        // Basic aggregations
  MEDIUM_QUERY: 50,        // Joins, moderate data
  COMPLEX_QUERY: 200,      // Large scans, multiple joins
  SQL_EXECUTION: 100,      // Raw SQL base cost
};

/**
 * Credit usage tracking (in-memory, logs to console)
 */
let sessionCreditsUsed = 0;

function trackCredits(operation: string, credits: number, details: Record<string, unknown> = {}) {
  sessionCreditsUsed += credits;
  console.log(`💰 Credit estimate: ${credits} credits for ${operation}`, {
    ...details,
    sessionTotal: sessionCreditsUsed,
  });
}

/**
 * Detect required freshness level from SQL content
 * Returns how fresh the data needs to be based on time-sensitive keywords
 */
function detectFreshnessFromSql(sql: string): { 
  level: FreshnessLevel; 
  maxAgeHours: number; 
  reason: string;
} {
  const sqlLower = sql.toLowerCase();
  
  // REALTIME: Needs data from right now
  // Keywords: current_timestamp, now(), today's exact time queries
  const realtimePatterns = [
    /current_timestamp/i,
    /\bnow\s*\(\s*\)/i,
    /interval\s*['"]\s*[1-5]\s*['"]\s*minute/i,
    /interval\s*['"]\s*[1-9]\s*['"]\s*minute/i,
    /interval\s*['"]\s*[12]0?\s*['"]\s*minute/i,
  ];
  
  for (const pattern of realtimePatterns) {
    if (pattern.test(sqlLower)) {
      return { 
        level: "realtime", 
        maxAgeHours: 0, 
        reason: "SQL contains real-time functions (now(), current_timestamp, or <30 min intervals)" 
      };
    }
  }
  
  // RECENT (max 1 hour old): Today's data or short intervals
  const recentPatterns = [
    /current_date\b/i,                              // Queries for "today"
    /\btoday\b/i,
    /interval\s*['"]\s*[1-6]\s*['"]\s*hour/i,       // 1-6 hours
    /block_date\s*=\s*current_date/i,               // Today's blocks
    />=\s*current_date\s*-\s*interval\s*['"]\s*[1-2]\s*['"]\s*day/i,  // Last 1-2 days
  ];
  
  for (const pattern of recentPatterns) {
    if (pattern.test(sqlLower)) {
      return { 
        level: "recent", 
        maxAgeHours: 1, 
        reason: "SQL queries today's data or uses short time intervals (<=6 hours)" 
      };
    }
  }
  
  // SEMI-CACHED (max 6 hours): Weekly data
  const semiCachedPatterns = [
    /interval\s*['"]\s*[7-9]\s*['"]\s*day/i,        // 7-9 days
    /interval\s*['"]\s*[1-2]\s*['"]\s*week/i,       // 1-2 weeks
    />=\s*current_date\s*-\s*interval\s*['"]\s*[3-7]\s*['"]\s*day/i,
  ];
  
  for (const pattern of semiCachedPatterns) {
    if (pattern.test(sqlLower)) {
      return { 
        level: "cached", 
        maxAgeHours: 6, 
        reason: "SQL queries weekly data - 6 hour cache is acceptable" 
      };
    }
  }
  
  // FULLY CACHED (24 hours): Historical data, monthly+
  const historicalPatterns = [
    /interval\s*['"]\s*30\s*['"]\s*day/i,
    /interval\s*['"]\s*[1-9]\s*['"]\s*month/i,
    /interval\s*['"]\s*[1-9]\s*['"]\s*year/i,
  ];
  
  for (const pattern of historicalPatterns) {
    if (pattern.test(sqlLower)) {
      return { 
        level: "cached", 
        maxAgeHours: 24, 
        reason: "SQL queries historical data (30+ days) - 24 hour cache is fine" 
      };
    }
  }
  
  // DEFAULT: 6 hour cache for unknown patterns
  return { 
    level: "cached", 
    maxAgeHours: 6, 
    reason: "Default freshness - using 6 hour cache" 
  };
}

/**
 * Convert freshness level to maxAgeHours for cache
 */
function freshnessToMaxAge(level: FreshnessLevel): number {
  switch (level) {
    case "realtime": return 0;      // No cache
    case "recent": return 1;        // 1 hour cache
    case "cached": return 24;       // 24 hour cache
    case "auto": return 6;          // Default 6 hour cache (auto-detect will override)
    default: return 6;
  }
}

// ============================================================================
// SPELLBOOK TABLE CATALOG - Category-Based Discovery
// ============================================================================
// Based on https://github.com/duneanalytics/spellbook architecture:
// - Cross-chain aggregations (dex.trades, nft.trades) - unified data across ALL chains
// - Chain-specific tables ({chain}.transactions) - data for ONE chain
// - Project-specific tables ({project}_{chain}.{type}) - protocol data
// - Sector tables (lending.borrow) - aggregated by use case
//
// The AI agent should:
// 1. Call list_tables() to see categories + patterns
// 2. Pick the most relevant table based on semantic understanding
// 3. Call get_dataset_schema(table) to get REAL columns from Dune API
// 4. Write SQL using the exact column names returned

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ─────────────────────────────────────────────────────────────────────────
  // DISCOVERY TOOLS
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: "discover_tables",
    description: `🔍 DYNAMIC TABLE DISCOVERY - Query Dune's API for 2,800+ Spellbook tables!

This queries Dune's LIVE datasets API to find protocol-specific tables.
Returns real tables with their schemas - no guessing!

🎯 USE CASES:
• Find tables for a protocol: discover_tables(search: "opensea")
• Find tables for a blockchain: discover_tables(search: "arbitrum")  
• Find tables by sector: discover_tables(search: "lending")
• Browse available spells: discover_tables(limit: 100)
• Find TVL/reserve event tables: discover_tables(search: "{protocol} sync")

📊 RETURNS:
• Table names with full schemas (columns, types)
• Owner information (dune team vs community)
• Tags and metadata

⚠️ NOT ALL PROTOCOLS HAVE SPELLBOOK TABLES!
If discover_tables returns 0 results for a protocol (e.g., "pendle"):
1. Try unified tables: dex.trades WHERE project LIKE '%protocol%' 
2. Protocol may be under different name - check dex.trades DISTINCT project
3. If not in Spellbook, data only exists in raw event tables (advanced)

💡 WORKFLOW:
1. discover_tables(search: "protocol") → Find Spellbook tables
2. If 0 results: Try dex.trades or nft.trades with project filter
3. get_dataset_schema("table") → Verify columns if needed
4. run_sql("SELECT ... FROM table") → Execute query

⚠️ Uses ~5 credits per call. Search filters first 250 results.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        search: {
          type: "string",
          description: "Search term to filter tables (e.g., 'pendle', 'arbitrum', 'nft')",
        },
        type: {
          type: "string",
          enum: ["spell", "transformation_view", "uploaded_table", "materialized_view"],
          description: "Type of dataset. 'spell' = curated Spellbook tables (default and most useful). Other types are for advanced use.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 50, max: 250)",
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
        tables: { type: "array" },
        total: { type: "number" },
        nextOffset: { type: "number" },
      },
      required: ["tables"],
    },
  },

  {
    name: "list_datasets",
    description: `Browse available tables and datasets on Dune by owner.

🔍 DISCOVERY: Use this to find what data exists before writing SQL.

Filter by owner (defaults to "dune" for official tables):
- "dune": Official Dune-maintained datasets
- "uniswap": Uniswap team datasets
- Any username/team handle

Filter by type:
- spell: Curated cross-chain tables (dex.trades, nft.trades) - BEST for most queries
- decoded_table: Protocol-specific decoded events
- uploaded_table: User-uploaded data

Example: list_datasets(owner: "dune", type: "spell", limit: 10)
💡 TIP: For common tables, use suggest_table() instead - it's faster and has examples!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Max results (default: 50, max: 250)",
        },
        offset: {
          type: "number",
          description: "Pagination offset",
        },
        owner: {
          type: "string",
          description: "Filter by owner handle (e.g., 'dune')",
        },
        type: {
          type: "string",
          description: "Dataset type: spell, decoded_table, dune_table, uploaded_table",
          enum: ["spell", "decoded_table", "dune_table", "uploaded_table", "transformation_view", "transformation_table"],
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        datasets: { type: "array" },
        total: { type: "number" },
        tip: { type: "string" },
      },
      required: ["datasets", "total"],
    },
  },

  {
    name: "get_dataset_schema",
    description: `Get REAL column names from Dune API for ANY table.

⚠️ WHEN TO USE:
- For UNCOMMON tables not listed in run_sql's column hints
- For protocol-specific tables (e.g., uniswap_v3_ethereum.trades, aave_v3.borrow)
- When you're unsure if a column exists
- To verify exact column names and types

✅ SKIP THIS FOR COMMON TABLES (columns in run_sql description):
- dex.trades, nft.trades, prices.usd, {chain}.transactions

🔄 WORKFLOW:
1. discover_tables(search: "protocol") → Find tables for a protocol
2. get_dataset_schema("table.name") → Get REAL columns (if not a common table)
3. run_sql("SELECT columns FROM table") → Execute query

📋 RETURNS:
• columns: Array of {name, type} - THE ONLY valid column names for your SQL
• tips: Usage hints for this table

💡 Use this to CHECK if a table exists:
   - get_dataset_schema("uniswap_v3_ethereum.trades") → works if table exists
   - get_dataset_schema("fake_table") → returns error if not found`,
    inputSchema: {
      type: "object" as const,
      properties: {
        slug: {
          type: "string",
          description: "Full table name (e.g., 'dex.trades', 'nft.trades', 'ethereum.transactions', 'uniswap_v3_ethereum.trades')",
        },
      },
      required: ["slug"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        fullName: { type: "string" },
        columns: { type: "array" },
        columnCount: { type: "number" },
        tips: { type: "array" },
        relatedTables: { type: "array" },
        source: { type: "string" },
      },
      required: ["fullName", "columns"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // EXECUTION TOOLS (with auto-polling!)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: "execute_query",
    description: `Execute a saved Dune query by ID with SMART CACHING and ADVANCED OPTIONS.

🔄 CACHE-FIRST: Tries cached results first to save credits!
Only runs fresh execution if cache is too old for your freshness needs.

📊 Find query IDs at dune.com → click any chart → ID in URL.

⚡ PERFORMANCE TIERS:
- "medium": Standard execution (default, costs fewer credits)
- "large": High-performance for complex queries (costs more credits)

🔍 RESULT FILTERING (reduces data transfer):
- filters: SQL-like filter (e.g., "amount > 1000 AND chain = 'ethereum'")
- sort_by: Array of columns to sort (e.g., ["volume desc", "date asc"])
- columns: Select specific columns only (e.g., ["date", "volume", "chain"])
- limit: Max rows to return (default: 1000)
- offset: Skip first N rows (for pagination)

💡 FRESHNESS:
- "realtime": Always run fresh (uses most credits)
- "recent": Max 1 hour old cache (for today's data)
- "cached": Max 24 hour old cache (for historical - DEFAULT)

Example:
- execute_query(1215383) → uses cache if available
- execute_query(1215383, performance: "large") → use large engine
- execute_query(1215383, filters: "volume > 1000000", sort_by: ["volume desc"], limit: 50)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID (e.g., 1215383)",
        },
        parameters: {
          type: "object",
          description: "Query parameters as key-value pairs. Use for parameterized queries.",
          additionalProperties: true,
        },
        freshness: {
          type: "string",
          enum: ["realtime", "recent", "cached", "auto"],
          description: "How fresh the data needs to be. Default: 'cached' (24h)",
        },
        performance: {
          type: "string",
          enum: ["medium", "large"],
          description: "Query engine tier. 'large' for complex queries (costs more). Default: 'medium'",
        },
        filters: {
          type: "string",
          description: "SQL-like filter expression (e.g., \"amount > 1000 AND chain = 'ethereum'\")",
        },
        sort_by: {
          type: "array",
          items: { type: "string" },
          description: "Columns to sort by (e.g., [\"volume desc\", \"date asc\"])",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Select specific columns only (reduces response size)",
        },
        limit: {
          type: "number",
          description: "Max rows to return (default: 1000, max: 100000)",
        },
        offset: {
          type: "number",
          description: "Skip first N rows (for pagination through large results)",
        },
      },
      required: ["queryId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        queryId: { type: "number" },
        state: { type: "string" },
        rowCount: { type: "number" },
        totalRowCount: { type: "number" },
        rows: { type: "array" },
        metadata: { type: "object" },
        fromCache: { type: "boolean" },
        creditsEstimate: { type: "number" },
        pagination: { type: "object" },
      },
      required: ["queryId", "state"],
    },
  },

  {
    name: "get_query_results",
    description: `Get cached results from a Dune query (faster than execute_query).

⚡ USES CACHE: Returns results from the last execution without re-running.
Set maxAgeHours to control how fresh results must be.

Use when:
- You want instant results from a recently-run query
- You're hitting rate limits with execute_query
- Query has been run by someone else and cached`,
    inputSchema: {
      type: "object" as const,
      properties: {
        queryId: {
          type: "number",
          description: "Dune query ID",
        },
        maxAgeHours: {
          type: "number",
          description: "Max age of cached results in hours (default: 24). If older, triggers re-execution.",
        },
        limit: {
          type: "number",
          description: "Max rows (default: 1000)",
        },
      },
      required: ["queryId"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        queryId: { type: "number" },
        rows: { type: "array" },
        metadata: { type: "object" },
        executedAt: { type: "string" },
      },
      required: ["queryId"],
    },
  },

  {
    name: "run_sql",
    description: `Execute raw SQL directly with SMART FRESHNESS DETECTION and PERFORMANCE OPTIONS.

📋 COMMON TABLE COLUMNS (use these EXACT names - tested and verified):

═══════════════════════════════════════════════════════════════════════
🔹 DEX TRADING
═══════════════════════════════════════════════════════════════════════
dex.trades (ALL DEX trades across ALL chains):
  blockchain, project, version, block_date, block_time, block_number,
  token_bought_symbol, token_sold_symbol, token_pair,
  token_bought_amount, token_sold_amount, amount_usd,
  token_bought_address, token_sold_address,
  taker, maker, project_contract_address, tx_hash, tx_from, tx_to
  
  🔍 To find valid project names, first run:
     SELECT DISTINCT project FROM dex.trades WHERE block_date >= current_date - interval '1' day
  
  Common projects: uniswap, sushiswap, curve, balancer, pancakeswap, trader_joe, camelot

dex_aggregator.trades (1inch, Cowswap, Paraswap etc):
  blockchain, project, version, block_date, block_time,
  token_bought_symbol, token_sold_symbol, token_pair,
  token_bought_amount, token_sold_amount, amount_usd,
  taker, maker, tx_hash, tx_from, tx_to

dex.pools (Liquidity pool METADATA - NOT TVL!):
  blockchain, project, version, pool, fee, token0, token1,
  creation_block_time, creation_block_number, contract_address
  ⚠️ NOTE: This table has pool addresses and tokens, but NO TVL or reserves!

═══════════════════════════════════════════════════════════════════════
🔹 NFT TRADING
═══════════════════════════════════════════════════════════════════════
nft.trades (ALL NFT SALES across ALL chains):
  blockchain, project, version, block_date, block_time, block_number,
  nft_contract_address, collection, token_id, token_standard,
  trade_type, buyer, seller, amount_original, amount_usd,
  currency_symbol, currency_contract, tx_hash, tx_from, tx_to

  ⚠️ CRITICAL: nft.trades contains COMPLETED SALES, NOT current listings!
  
  🚨 FLOOR PRICE WARNING:
  - MIN(amount_usd) is NOT floor price - it's the minimum SALE (could be outliers)
  - AVG(amount_usd) is NOT floor price - rare items heavily skew averages UP
  - Floor price = lowest CURRENT LISTING, which requires live marketplace APIs
  
  ✅ USE nft.trades FOR:
  - Volume analysis (SUM(amount_usd))
  - Trade counts and trends
  - Marketplace comparison (OpenSea vs Blur)
  - Historical price ranges (approx_percentile for median)
  
  ❌ DO NOT USE nft.trades TO CLAIM "FLOOR PRICE" - it's misleading!
  
  📊 FOR PRICE ANALYSIS, USE MEDIAN (more accurate than average):
  SELECT 
    collection,
    approx_percentile(amount_usd, 0.5) as median_price,  -- 50th percentile
    approx_percentile(amount_usd, 0.1) as floor_estimate -- 10th percentile
  FROM nft.trades
  WHERE block_date >= current_date - interval '7' day
  GROUP BY 1

nft.mints (NFT mints):
  blockchain, project, collection, token_id, block_date,
  amount_usd, buyer, seller, tx_hash

nft.fees (Trading fees & royalties):
  blockchain, project, collection, block_date, amount_usd,
  platform_fee_amount_usd, platform_fee_percentage,
  royalty_fee_amount_usd, royalty_fee_percentage

═══════════════════════════════════════════════════════════════════════
🔹 PRICES & TOKENS
═══════════════════════════════════════════════════════════════════════
prices.usd (Historical token prices by minute):
  blockchain, contract_address, symbol, minute, price

prices.usd_latest (Latest token prices):
  blockchain, contract_address, decimals, symbol, minute, price

tokens.transfers (Token transfers - ALL chains):
  blockchain, block_date, block_time, tx_hash,
  token_standard, "from", "to", contract_address, symbol,
  amount, amount_usd, price_usd

tokens.erc20 (Token metadata):
  blockchain, contract_address, symbol, name, decimals

═══════════════════════════════════════════════════════════════════════
🔹 DEFI LENDING (Aave, Compound, etc.)
═══════════════════════════════════════════════════════════════════════
lending.borrow (Borrows & repayments):
  blockchain, project, version, transaction_type, loan_type,
  symbol, token_address, borrower, repayer, liquidator,
  amount, amount_usd, block_time, tx_hash

lending.supply (Deposits & withdrawals):
  blockchain, project, version, transaction_type,
  symbol, token_address, depositor, withdrawn_to,
  amount, amount_usd, block_time, tx_hash

lending.flashloans:
  blockchain, project, symbol, recipient,
  amount, amount_usd, fee, block_time, tx_hash

═══════════════════════════════════════════════════════════════════════
🔹 TRANSACTIONS BY CHAIN (for gas analysis, tx counts)
═══════════════════════════════════════════════════════════════════════
ethereum.transactions:
  block_time, block_date, block_number, hash, "from", "to",
  value, gas_limit, gas_price, gas_used, success,
  max_fee_per_gas, max_priority_fee_per_gas, type, nonce

arbitrum.transactions (+ gas_used_for_l1):
  block_time, block_date, "from", "to", value, gas_price, gas_used, success, hash

optimism.transactions (+ L1 fee columns):
  block_time, block_date, "from", "to", value, gas_used, success,
  l1_gas_used, l1_gas_price, l1_fee

base.transactions (+ L1 fee columns):
  block_time, block_date, "from", "to", value, gas_used, success,
  l1_gas_used, l1_fee

polygon.transactions:
  block_time, block_date, "from", "to", value, gas_price, gas_used, success

solana.transactions:
  block_time, block_date, signature, fee, success, signer, compute_units_consumed

═══════════════════════════════════════════════════════════════════════
🔹 TVL / LIQUIDITY / POOL RESERVES
═══════════════════════════════════════════════════════════════════════
⚠️ NO UNIFIED TVL TABLE EXISTS! Reserves live in protocol-specific event tables.

To get pool TVL/reserves, you need to:
1. Use discover_tables("{protocol} sync") or discover_tables("{protocol} reserve")
   to find the protocol's event tables
2. Look for these common patterns:
   - V2-style AMMs: "Sync" events with reserve0, reserve1 columns
   - V3-style AMMs: liquidity position events (Mint, Burn)
   - Curve/Balancer: pool-specific balance queries

Example workflow for TVL:
1. discover_tables("curve reserve") → find curve event tables
2. get_dataset_schema("curve_ethereum.StableSwap_evt_*") → check columns
3. Query latest reserves and join with prices.usd for USD value

Common TVL event tables (use discover_tables to find others):
- {protocol}_v2_{chain}.Pair_evt_Sync → reserve0, reserve1
- {protocol}_v3_{chain}.*_evt_Mint → liquidity positions

═══════════════════════════════════════════════════════════════════════

⚠️ For protocol-specific tables (uniswap_v3_ethereum.*, aave_v3_*.*, etc.),
   call get_dataset_schema("table") first to get exact columns!

🧠 AUTO-FRESHNESS DETECTION:
- "current_date", "now()" → realtime
- "today", "last 24h" → recent (1h cache)
- "last 7 days" → 6h cache
- "last 30+ days" → 24h cache

⚡ PERFORMANCE: Use "large" for complex queries with multiple JOINs.

💡 SQL TIPS:
- ALWAYS filter by block_date (e.g., WHERE block_date >= current_date - interval '7' day)
- Quote reserved words: SELECT "from", "to" FROM ethereum.transactions
- Add LIMIT for faster results

🔑 WALLET ADDRESS QUERIES (CRITICAL!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Address columns (tx_from, taker, maker, buyer, seller, "from", "to") are VARBINARY, not varchar!

❌ WRONG (will error):
  WHERE lower(tx_from) = lower('0xd8dA...')  -- lower() doesn't work on varbinary!
  WHERE tx_from = '0xd8dA...'                -- string comparison fails!

✅ CORRECT (use FROM_HEX without 0x prefix):
  WHERE tx_from = FROM_HEX('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
  WHERE taker = FROM_HEX('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045')

📊 WALLET TRADING HISTORY EXAMPLE:
SELECT 
  blockchain, project, token_bought_symbol, token_sold_symbol,
  amount_usd, block_time, tx_hash
FROM dex.trades
WHERE (tx_from = FROM_HEX('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045') 
   OR taker = FROM_HEX('d8dA6BF26964aF9D7eEd9e03E53415D37aA96045'))
  AND block_date >= current_date - interval '90' day
ORDER BY block_time DESC
LIMIT 100
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️ TRINO SYNTAX (NOT PostgreSQL!):
- ❌ ILIKE does NOT exist in Trino! Use: lower(column) LIKE lower('%pattern%')
- ❌ || for string concat - Use: concat(a, b) instead
- ✅ Case-insensitive: WHERE lower(project) LIKE '%pendle%'
- ✅ Date arithmetic: current_date - interval '7' day (this DOES work)
- ✅ Pattern matching: column LIKE '%pattern%' (case-sensitive)

🎨 NFT PRICE ANALYSIS WARNING (CRITICAL!):
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ FLOOR PRICE ≠ AVERAGE SALE PRICE ≠ MIN SALE PRICE

The nft.trades table contains COMPLETED SALES, not current listings.
This means you CANNOT accurately determine floor prices from this data!

WRONG approaches (do NOT use for "floor price"):
❌ MIN(amount_usd) → Returns minimum sale (could be wash trades, errors)
❌ AVG(amount_usd) → Heavily skewed by rare items (a $10K rare sale makes avg look 10x floor)
❌ "today's avg vs 7-day avg" → Does NOT reflect floor price movements

RIGHT approaches for NFT price analysis:
✅ approx_percentile(amount_usd, 0.1) → 10th percentile as floor ESTIMATE
✅ approx_percentile(amount_usd, 0.5) → Median price (more stable than avg)
✅ SUM(amount_usd) → Volume analysis (accurate)
✅ COUNT(*) → Trade count trends (accurate)

Example: If Sappy Seals floor is $377 on OpenSea, but someone buys a rare one 
for $3,000 today, AVG() will show $888 while the actual floor stays at $377.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🚨 FAKE VOLUME WARNING (CRITICAL FOR ANY VOLUME/RANKING QUERY!):
BNB Chain and other low-gas chains have MASSIVE fake volume from:
- Wash trading (same wallet trading with itself)
- Illiquid shitcoins with manipulated prices  
- Scam tokens showing "$48 BILLION volume" but traded by only 50 wallets

⚡ FOR ANY QUERY INVOLVING VOLUME, RANKINGS, OR NEW TOKENS:
1. ALWAYS include COUNT(DISTINCT tx_from) as unique_traders in your SELECT
2. ALWAYS filter with HAVING COUNT(DISTINCT tx_from) >= 100
3. Show unique_traders in results so users can assess legitimacy

📊 STANDARD PATTERN FOR VOLUME QUERIES:
SELECT 
  token_pair,
  blockchain,
  SUM(amount_usd) as volume_usd,
  COUNT(DISTINCT tx_from) as unique_traders,  -- ALWAYS INCLUDE THIS!
  COUNT(*) as trade_count
FROM dex.trades
WHERE block_date >= current_date - interval '30' day
GROUP BY 1, 2
HAVING COUNT(DISTINCT tx_from) >= 100  -- FILTER OUT WASH TRADING!
ORDER BY volume_usd DESC

📊 FOR "NEW PAIRS" OR "TRENDING" QUERIES:
WITH pair_stats AS (
  SELECT 
    blockchain, project, token_pair,
    MIN(block_date) as first_seen,
    SUM(amount_usd) as volume_30d,
    COUNT(DISTINCT tx_from) as unique_traders  -- CRITICAL!
  FROM dex.trades
  WHERE block_date >= current_date - interval '120' day
  GROUP BY 1, 2, 3
  HAVING COUNT(DISTINCT tx_from) >= 100  -- REMOVE WASH TRADING
)
SELECT * FROM pair_stats
WHERE first_seen >= current_date - interval '90' day
ORDER BY volume_30d DESC LIMIT 10

Why 100 unique traders?
✅ Real tokens have diverse trader bases
❌ Wash trading typically involves <50 wallets trading back-and-forth
❌ Scam tokens like "ChadZhao" show $48B volume but only ~60 unique wallets

⚠️ WITHOUT THIS FILTER, BNB CHAIN RESULTS WILL BE 90% SCAMS!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sql: {
          type: "string",
          description: "SQL query to execute (DuneSQL/Trino syntax)",
        },
        name: {
          type: "string",
          description: "Optional name for the query",
        },
        freshness: {
          type: "string",
          enum: ["realtime", "recent", "cached", "auto"],
          description: "Override auto-detection. 'auto' (default) analyzes SQL for time-sensitivity",
        },
        performance: {
          type: "string",
          enum: ["medium", "large"],
          description: "Query engine tier. 'large' for complex queries with JOINs. Default: 'medium'",
        },
      },
      required: ["sql"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        state: { type: "string" },
        rowCount: { type: "number" },
        totalRowCount: { type: "number" },
        rows: { type: "array" },
        metadata: { type: "object" },
        freshness: { type: "object" },
        creditsEstimate: { type: "number" },
        performance: { type: "string" },
      },
      required: ["state"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // CREDIT & USAGE TOOLS
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: "get_credit_usage",
    description: `Check your Dune API credit usage and limits.

💰 MONITOR YOUR CREDITS: See how many credits you've used and how many remain.

Returns:
- Credits used this billing period
- Credits remaining
- Storage usage
- Private query/dashboard counts

Use this to avoid hitting credit limits!`,
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        creditsUsed: { type: "number" },
        creditsRemaining: { type: "number" },
        creditsLimit: { type: "number" },
        usagePercent: { type: "number" },
        billingPeriodEnd: { type: "string" },
        storageUsed: { type: "number" },
        storageLimit: { type: "number" },
      },
      required: ["creditsUsed", "creditsRemaining"],
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // 🎯 PERSONALIZED WALLET TOOLS (require connected wallet via SDK context)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: "analyze_my_portfolio",
    description: `🎯 PERSONALIZED PORTFOLIO ANALYSIS using your connected wallet!

Analyzes YOUR wallet's on-chain activity:
• Recent DEX trades (buys/sells with USD values)
• NFT activity (purchases/sales)
• DeFi interactions (lending, borrowing)
• Gas spending analysis
• Most traded tokens

⚡ REQUIRES: Connected wallet (auto-injected by client app)

📊 RETURNS:
• Trading summary (volume, trade count, avg trade size)
• Top tokens by volume
• Recent transactions
• Chain activity breakdown
• Performance metrics

💡 This is YOUR personalized blockchain dashboard!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        timeframe: {
          type: "string",
          enum: ["7d", "30d", "90d", "365d"],
          description: "Analysis timeframe (default: 30d)",
        },
        chain: {
          type: "string",
          description: "Filter by chain (ethereum, arbitrum, base, etc.) or 'all'",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string" },
        timeframe: { type: "string" },
        tradingSummary: { type: "object" },
        topTokens: { type: "array" },
        recentTrades: { type: "array" },
        chainBreakdown: { type: "array" },
      },
      required: ["wallet", "tradingSummary"],
    },
    // ✅ Context requirements in _meta (MCP spec)
    // The Context platform reads this to inject user's wallet data
    _meta: {
      contextRequirements: ["wallet"],
    },
  },

  {
    name: "my_trading_history",
    description: `📊 YOUR COMPLETE DEX TRADING HISTORY across ALL chains!

Shows every DEX swap you've made:
• Token pairs traded
• Exact amounts and USD values
• DEX used (Uniswap, Curve, Sushi, etc.)
• Timestamps and transaction links

⚡ REQUIRES: Connected wallet

🔍 FILTER OPTIONS:
• By token (show only ETH trades)
• By chain (Ethereum only, Arbitrum only, etc.)
• By DEX (Uniswap only)
• By time range

Perfect for tax reporting, trade analysis, or reviewing your history!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Number of trades to return (default: 50, max: 500)",
        },
        token: {
          type: "string",
          description: "Filter by token symbol (e.g., 'ETH', 'USDC')",
        },
        chain: {
          type: "string",
          description: "Filter by blockchain (ethereum, arbitrum, base, polygon)",
        },
        dex: {
          type: "string",
          description: "Filter by DEX (uniswap, curve, sushiswap)",
        },
        days: {
          type: "number",
          description: "Only show trades from last N days (default: 90)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string" },
        totalTrades: { type: "number" },
        totalVolumeUsd: { type: "number" },
        trades: { type: "array" },
      },
      required: ["wallet", "trades"],
    },
    _meta: {
      contextRequirements: ["wallet"],
    },
  },

  {
    name: "my_token_pnl",
    description: `💰 CALCULATE YOUR PROFIT/LOSS on tokens you've traded!

For any token, calculates:
• Total amount bought vs sold
• Average buy price
• Total USD spent vs received
• Realized P&L (from completed sells)
• Unrealized P&L (if you still hold)
• ROI percentage

⚡ REQUIRES: Connected wallet

📈 Finally know if you're actually profitable on a token!

Use 'all' to see P&L across ALL tokens you've traded.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        token: {
          type: "string",
          description: "Token symbol to analyze (e.g., 'PEPE', 'ARB') or 'all' for summary",
        },
        chain: {
          type: "string",
          description: "Filter by chain (default: all chains)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        wallet: { type: "string" },
        token: { type: "string" },
        totalBought: { type: "number" },
        totalSold: { type: "number" },
        avgBuyPrice: { type: "number" },
        avgSellPrice: { type: "number" },
        usdSpent: { type: "number" },
        usdReceived: { type: "number" },
        realizedPnl: { type: "number" },
        realizedPnlPercent: { type: "number" },
      },
      required: ["wallet", "realizedPnl"],
    },
    _meta: {
      contextRequirements: ["wallet"],
    },
  },

  {
    name: "wallets_like_mine",
    description: `🔍 FIND WALLETS WITH SIMILAR TRADING PATTERNS (Lookalike Audiences)

Discovers wallets that trade like you based on:
• Similar tokens traded
• Similar trading volume
• Similar trading frequency
• Similar chain preferences

🎯 WHY THIS IS POWERFUL:
• See what similar traders are buying NOW
• Discover alpha from wallets like yours
• Find smart money with your style
• Learn from successful similar traders

⚡ REQUIRES: Connected wallet

📊 RETURNS:
• Top 10 lookalike wallets
• Their recent trades (what are they buying?)
• Overlap score (how similar)
• Their performance vs yours

Like Facebook/Twitter lookalike audiences, but for crypto trading!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        similarity_type: {
          type: "string",
          enum: ["tokens", "volume", "frequency", "balanced"],
          description: "What to match on: 'tokens' (same coins), 'volume' (similar size), 'frequency' (similar activity), 'balanced' (all factors)",
        },
        min_trades: {
          type: "number",
          description: "Minimum trades for lookalike wallets (default: 10)",
        },
        timeframe: {
          type: "string",
          enum: ["7d", "30d", "90d"],
          description: "Time window for finding similar traders (default: 30d)",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        yourWallet: { type: "string" },
        yourProfile: { type: "object" },
        lookalikeWallets: { type: "array" },
        alphaOpportunities: { type: "array" },
      },
      required: ["yourWallet", "lookalikeWallets"],
    },
    _meta: {
      contextRequirements: ["wallet"],
    },
  },
];

// ============================================================================
// TOOL HANDLERS
// ============================================================================

async function listDatasets(args: {
  limit?: number;
  offset?: number;
  owner?: string;
  type?: string;
}): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  // IMPORTANT: Dune API has a bug - you CANNOT filter by owner when type="spell"
  // The API returns: "when filtering by ownerHandle you can only filter by the following types: 
  // transformation_view, uploaded_table, materialized_view, transformation_table"
  const requestedType = args.type;
  const validOwnerTypes = ["transformation_view", "uploaded_table", "materialized_view", "transformation_table"];
  
  try {
    // Build params object carefully to avoid API 400 errors
    const params: Record<string, any> = {
      limit: args.limit || 50,
    };
    
    // Only add owner if type is compatible (NOT spell)
    if (requestedType && !validOwnerTypes.includes(requestedType)) {
      // For spell type, don't add owner - let API return all spells
      params.type = requestedType;
    } else if (args.owner || !requestedType) {
      // For valid types or no type specified, include owner
      params.owner_handle = args.owner || "dune";
      if (requestedType) params.type = requestedType;
    }
    
    if (args.offset !== undefined) params.offset = args.offset;
    
    const data = await duneClient.dataset.list(params);

    const datasets = data.datasets.map((d: any) => ({
      fullName: d.full_name || `${d.namespace}.${d.table_name}`,
      type: d.type,
      owner: d.owner?.handle || "unknown",
      name: d.name,
    }));

    return successResult({
      datasets,
      total: data.total,
      returnedCount: datasets.length,
      tip: requestedType === "spell"
        ? "Spells are curated tables - best for most analyses. Use get_dataset_schema('table.name') for columns."
        : "💡 Use list_tables() for a better organized view of available data!",
      nextStep: "Call get_dataset_schema('table_name') to see columns before writing SQL.",
      note: requestedType === "spell" 
        ? "For Spellbook tables, list_tables() provides a better organized catalog!"
        : undefined,
    });
  } catch (error) {
    return errorResult(`Failed to list datasets: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * NEW: Dynamic table discovery from Dune API
 * Queries the live datasets endpoint to find ALL available community tables
 * This is the key to accessing the FULL Spellbook!
 */
async function discoverTables(args: {
  search?: string;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  const requestedLimit = Math.min(args.limit || 50, 250);
  const offset = args.offset || 0;
  // Valid Dune dataset types - 'all' is NOT valid, default to 'spell'
  const validTypes = ["spell", "transformation_view", "uploaded_table", "materialized_view", "transformation_table"];
  const datasetType = validTypes.includes(args.type || "") ? args.type : "spell";

  // If searching, fetch max results to have better chance of finding matches
  // Then filter and return only what was requested
  const fetchLimit = args.search ? 250 : requestedLimit;

  try {
    // Query Dune's datasets API - WITHOUT owner_handle to get ALL spells!
    // This is the key insight: owner_handle + spell = 400 error, but spell alone works!
    const params: Record<string, any> = {
      limit: fetchLimit,
      offset,
      type: datasetType, // Always provide type - Dune requires at least one filter
    };
    
    console.log(`🔍 Discovering tables from Dune API (type: ${datasetType || 'all'}, limit: ${fetchLimit}, search: ${args.search || 'none'})...`);
    
    const response = await duneClient.dataset.list(params);
    
    // Filter by search term if provided (client-side filtering)
    let datasets = response.datasets || [];
    
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      datasets = datasets.filter((d: any) => {
        const fullName = (d.full_name || `${d.namespace}.${d.table_name}` || "").toLowerCase();
        const name = (d.name || "").toLowerCase();
        const description = (d.description || "").toLowerCase();
        const tags = (d.tags || []).join(" ").toLowerCase();
        
        return fullName.includes(searchLower) ||
               name.includes(searchLower) ||
               description.includes(searchLower) ||
               tags.includes(searchLower);
      });
      
      // Limit results after filtering
      datasets = datasets.slice(0, requestedLimit);
    }
    
    // Transform to useful format with columns
    const tables = datasets.map((d: any) => ({
      slug: d.full_name || `${d.namespace}.${d.table_name}`,
      name: d.name,
      type: d.type,
      owner: d.owner?.handle || "unknown",
      description: d.description || "",
      tags: d.tags || [],
      // Include columns directly - this is the magic!
      columns: (d.columns || []).map((c: any) => ({
        name: c.name,
        type: c.type,
        description: c.metadata?.description,
      })),
      columnCount: (d.columns || []).length,
      isPublic: !d.is_private,
      updatedAt: d.updated_at,
    }));
    
    // Track credits
    trackCredits("discover_tables", 5, { 
      search: args.search, 
      type: datasetType,
      resultsCount: tables.length,
    });

    return successResult({
      tables,
      total: response.total || tables.length,
      returnedCount: tables.length,
      offset,
      nextOffset: offset + tables.length < (response.total || 0) ? offset + requestedLimit : undefined,
      hasMore: offset + tables.length < (response.total || 0),
      
      // If search was used, show what was searched
      searchTerm: args.search || undefined,
      
      tip: tables.length > 0
        ? `Found ${tables.length} tables${args.search ? ` matching "${args.search}"` : ""}. Each includes columns - you can write SQL directly!`
        : args.search
        ? `No Spellbook tables found for "${args.search}". This protocol may not have curated tables yet.`
        : "No tables found. Try searching with a specific protocol name.",
      
      // If search returns no results, give comprehensive guidance
      tryDirectLookup: tables.length === 0 && args.search ? {
        message: `"${args.search}" has no Spellbook tables. Here are alternatives:`,
        
        // Direct table name guesses
        tryTheseFirst: [
          `get_dataset_schema("${args.search}.trades")`,
          `get_dataset_schema("${args.search}_v2_ethereum.trades")`,
        ],
        
        // Unified table approach
        checkUnifiedTables: {
          dex: `run_sql: SELECT DISTINCT project FROM dex.trades WHERE lower(project) LIKE '%${args.search.toLowerCase()}%' LIMIT 10`,
          explanation: "Check if protocol trades are aggregated in dex.trades under a different name",
        },
        
        // Raw tables approach (for advanced users)
        rawTableAlternative: {
          message: "If no Spellbook coverage, query raw contract events:",
          example: `SELECT * FROM ethereum.logs WHERE contract_address = '0x...' -- Find ${args.search} contract address`,
          hint: `Search "${args.search} ethereum contract address" to find the contract, then query its raw events`,
        },
        
        reality: `Not all protocols have Spellbook tables. ${args.search} might be a newer protocol or have low community coverage.`,
      } : undefined,
      
      workflow: tables.length > 0
        ? "Pick a table above, then use run_sql() with the columns shown. Or call get_dataset_schema('table.name') for more details."
        : "Try unified tables first (dex.trades, nft.trades), then raw contract tables if needed.",
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    // If we hit the owner+spell error, provide helpful guidance
    if (errorMsg.includes("400") && errorMsg.includes("ownerHandle")) {
      return errorResult(
        "Dune API limitation: Cannot combine owner filter with spell type. " +
        "Use discover_tables() without owner filter, or use list_tables() for curated tables."
      );
    }
    
    return errorResult(`Failed to discover tables: ${errorMsg}`);
  }
}

/**
 * List all available tables organized by category (static curated list)
 * Fast, no API calls, good for common tables
 */
async function getDatasetSchema(args: { slug: string }): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Cannot get schema without API access.");
  }

  // ALWAYS query Dune API for real schema - this is the ONLY source of truth!
  try {
    const schemaQuery = `SELECT * FROM ${args.slug} LIMIT 1`;
    console.log(`🔍 Fetching LIVE schema for ${args.slug} from Dune API...`);
    
    const result = await duneClient.runSql({
      query_sql: schemaQuery,
      isPrivate: false,
      archiveAfter: true,
    });
    
    // Extract column names and types from the result metadata
    const columnNames = result.result?.metadata?.column_names || [];
    const columnTypes = (result.result?.metadata as any)?.column_types || [];
    
    const columns = columnNames.map((name: string, i: number) => ({
      name,
      type: columnTypes[i] || "unknown",
    }));

    // Estimate credits used
    trackCredits("get_dataset_schema", 5, { table: args.slug, columns: columns.length });

    // Highlight important columns for common tables
    let importantColumns: string[] = [];
    if (args.slug.includes("nft.trades")) {
      importantColumns = columns
        .filter((c: any) => ["collection", "project", "amount_usd", "blockchain", "block_date", "buyer", "seller"].includes(c.name))
        .map((c: any) => c.name);
    } else if (args.slug.includes("dex.trades")) {
      importantColumns = columns
        .filter((c: any) => ["blockchain", "project", "amount_usd", "token_bought_symbol", "token_sold_symbol", "block_date"].includes(c.name))
        .map((c: any) => c.name);
    }

    return successResult({
      fullName: args.slug,
      tableExists: true,
      source: "dune_api_live",
      
      // REAL columns from Dune API - this is the source of truth!
      columns,
      columnCount: columns.length,
      
      // Highlight key columns if available
      importantColumns: importantColumns.length > 0 ? importantColumns : undefined,
      
      // General tips
      tips: [
        "⚠️ Use ONLY the column names listed above in your SQL!",
        "Filter by block_date for better query performance",
        "Add LIMIT during development for faster results",
      ],
      
      // Example SQL template
      exampleSql: `SELECT ${columns.slice(0, 5).map((c: any) => c.name).join(", ")} FROM ${args.slug} WHERE block_date >= current_date - interval '7' day LIMIT 100`,
      
      nextStep: "Now write SQL using run_sql() with these EXACT column names!",
      warning: "⚠️ Column names come from Dune's live API. Use them exactly as shown - any typos will cause SQL errors!",
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    // Check if it's a "table not found" error
    if (errorMsg.includes("does not exist") || errorMsg.includes("not found") || errorMsg.includes("SYNTAX_ERROR")) {
      return errorResult(
        `Table "${args.slug}" does not exist in Dune. ` +
        `\n\n💡 SUGGESTIONS:` +
        `\n• Call discover_tables(search: "keyword") to find tables dynamically` +
        `\n• Common patterns: dex.trades, nft.trades, {chain}.transactions` +
        `\n• For protocols: {protocol}_{version}_{chain}.trades (e.g., uniswap_v3_ethereum.trades)` +
        `\n• Try: discover_tables(search: "opensea") or discover_tables(limit: 100)`
      );
    }
    
    return errorResult(`Failed to get schema for "${args.slug}": ${errorMsg}`);
  }
}

async function executeQuery(args: {
  queryId: number;
  parameters?: Record<string, unknown>;
  freshness?: FreshnessLevel;
  performance?: "medium" | "large";
  filters?: string;
  sort_by?: string[];
  columns?: string[];
  limit?: number;
  offset?: number;
}): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  const freshness = args.freshness || "cached";
  const maxAgeHours = freshnessToMaxAge(freshness);
  const performance = args.performance || "medium";
  const limit = Math.min(args.limit || 1000, 100000);
  const offset = args.offset || 0;

  // Helper to apply client-side filtering/sorting/column selection
  const processResults = (rows: any[]): any[] => {
    let processed = [...rows];
    
    // Apply filters (client-side for cached results)
    if (args.filters && processed.length > 0) {
      try {
        // Simple filter parsing for common patterns
        const filterExpr = args.filters.toLowerCase();
        processed = processed.filter(row => {
          // Handle simple comparisons like "amount > 1000"
          const match = args.filters!.match(/(\w+)\s*(>|<|>=|<=|=|!=)\s*(['"]?)(\w+)\3/i);
          if (match) {
            const [, field, op, , value] = match;
            const fieldValue = row[field];
            const compareValue = isNaN(Number(value)) ? value : Number(value);
            switch (op) {
              case ">": return fieldValue > compareValue;
              case "<": return fieldValue < compareValue;
              case ">=": return fieldValue >= compareValue;
              case "<=": return fieldValue <= compareValue;
              case "=": return fieldValue == compareValue;
              case "!=": return fieldValue != compareValue;
            }
          }
          return true;
        });
      } catch {
        // If filter parsing fails, return all rows
      }
    }
    
    // Apply sorting
    if (args.sort_by && args.sort_by.length > 0) {
      processed.sort((a, b) => {
        for (const sortSpec of args.sort_by!) {
          const [field, direction] = sortSpec.split(" ");
          const aVal = a[field];
          const bVal = b[field];
          const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
          if (cmp !== 0) return direction?.toLowerCase() === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    
    // Apply column selection
    if (args.columns && args.columns.length > 0) {
      processed = processed.map(row => {
        const selected: Record<string, unknown> = {};
        for (const col of args.columns!) {
          if (col in row) selected[col] = row[col];
        }
        return selected;
      });
    }
    
    // Apply pagination
    return processed.slice(offset, offset + limit);
  };

  try {
    // ═══════════════════════════════════════════════════════════════════════
    // STEP 1: Try cache first (unless realtime is requested)
    // ═══════════════════════════════════════════════════════════════════════
    if (freshness !== "realtime") {
      try {
        console.log(`🔍 Trying cache for query ${args.queryId} (maxAge: ${maxAgeHours}h)`);
        
        const cachedResult = await duneClient.getLatestResult({
          queryId: args.queryId,
          opts: { maxAgeHours },
        });
        
        if (cachedResult?.result?.rows && cachedResult.result.rows.length > 0) {
          const allRows = cachedResult.result.rows;
          const processedRows = processResults(allRows);
          
          const credits = CREDIT_ESTIMATES.CACHE_HIT;
          trackCredits("execute_query (CACHE HIT)", credits, { 
            queryId: args.queryId, 
            freshness,
            cachedAt: cachedResult.execution_ended_at,
          });
          
          return successResult({
            queryId: args.queryId,
            executionId: cachedResult.execution_id,
            state: cachedResult.state || "COMPLETED",
            fromCache: true,
            cacheAge: cachedResult.execution_ended_at,
            rowCount: processedRows.length,
            totalRowCount: allRows.length,
            rows: processedRows,
            metadata: {
              columnNames: cachedResult.result?.metadata?.column_names,
              columnTypes: (cachedResult.result?.metadata as any)?.column_types,
            },
            executedAt: cachedResult.execution_ended_at,
            creditsEstimate: credits,
            pagination: {
              limit,
              offset,
              hasMore: offset + processedRows.length < allRows.length,
              totalAvailable: allRows.length,
            },
            note: `✅ Used cached results (${maxAgeHours}h max age). Saved credits!`,
          });
        }
      } catch (cacheError) {
        console.log(`📭 Cache miss for query ${args.queryId}, running fresh...`);
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // STEP 2: Run fresh execution (cache miss or realtime requested)
    // ═══════════════════════════════════════════════════════════════════════
    console.log(`🚀 Running fresh execution for query ${args.queryId} (freshness: ${freshness}, performance: ${performance})`);
    
    // Build query parameters if provided
    const queryParams: any[] = [];
    if (args.parameters) {
      for (const [key, value] of Object.entries(args.parameters)) {
        if (typeof value === "number") {
          queryParams.push(QueryParameter.number(key, value));
        } else if (typeof value === "string") {
          if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
            queryParams.push(QueryParameter.date(key, value));
          } else {
            queryParams.push(QueryParameter.text(key, value));
          }
        } else {
          queryParams.push(QueryParameter.text(key, String(value)));
        }
      }
    }

    // Use SDK's runQuery with performance tier
    const result = await duneClient.runQuery({
      queryId: args.queryId,
      query_parameters: queryParams.length > 0 ? queryParams : undefined,
      performance: performance as any,
    });

    const allRows = result.result?.rows || [];
    const processedRows = processResults(allRows);
    
    const credits = performance === "large" ? CREDIT_ESTIMATES.COMPLEX_QUERY : CREDIT_ESTIMATES.MEDIUM_QUERY;
    trackCredits("execute_query (FRESH)", credits, { 
      queryId: args.queryId, 
      freshness,
      performance,
      rowCount: processedRows.length,
    });

    return successResult({
      queryId: args.queryId,
      executionId: result.execution_id,
      state: result.state || "COMPLETED",
      fromCache: false,
      rowCount: processedRows.length,
      totalRowCount: result.result?.metadata?.total_row_count || allRows.length,
      rows: processedRows,
      metadata: {
        columnNames: result.result?.metadata?.column_names,
        columnTypes: (result.result?.metadata as any)?.column_types,
        executionTimeMs: result.result?.metadata?.execution_time_millis,
      },
      executedAt: result.execution_ended_at,
      creditsEstimate: credits,
      performance,
      pagination: {
        limit,
        offset,
        hasMore: offset + processedRows.length < allRows.length,
        totalAvailable: allRows.length,
      },
      note: freshness === "realtime" 
        ? `🔴 Fresh execution (realtime requested, ${performance} engine)` 
        : `🟡 Fresh execution (cache was empty/stale, ${performance} engine)`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    // Provide helpful context for common errors
    if (errorMsg.includes("404") || errorMsg.includes("not found")) {
      return errorResult(`Query ${args.queryId} not found. Make sure the query ID exists and is public. Find IDs at dune.com → click any chart → ID in URL.`);
    }
    if (errorMsg.includes("403") || errorMsg.includes("permission")) {
      return errorResult(`Query ${args.queryId} is private or archived. Try a different public query.`);
    }
    
    return errorResult(`Failed to execute query ${args.queryId}: ${errorMsg}`);
  }
}

async function getQueryResults(args: {
  queryId: number;
  maxAgeHours?: number;
  limit?: number;
}): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  const maxAge = args.maxAgeHours || 24;
  
  try {
    console.log(`📦 Getting cached results for query ${args.queryId} (maxAge: ${maxAge}h)`);
    
    // Use SDK's getLatestResult - handles cache logic
    const result = await duneClient.getLatestResult({
      queryId: args.queryId,
      opts: {
        maxAgeHours: maxAge,
        batchSize: args.limit || 1000,
      },
    });

    const credits = CREDIT_ESTIMATES.CACHE_HIT;
    trackCredits("get_query_results (CACHE)", credits, { 
      queryId: args.queryId,
      maxAgeHours: maxAge,
      rowCount: result.result?.rows?.length,
    });

    return successResult({
      queryId: args.queryId,
      executionId: result.execution_id,
      state: result.state || "COMPLETED",
      fromCache: true,
      rowCount: result.result?.rows?.length || 0,
      rows: result.result?.rows || [],
      metadata: {
        columnNames: result.result?.metadata?.column_names,
        columnTypes: (result.result?.metadata as any)?.column_types,
      },
      executedAt: result.execution_ended_at,
      creditsEstimate: credits,
      note: `✅ Returned cached results (max age: ${maxAge}h). This is the cheapest option!`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    if (errorMsg.includes("404") || errorMsg.includes("not found")) {
      return errorResult(`No cached results for query ${args.queryId}. Use execute_query(${args.queryId}) to run it first.`);
    }
    
    return errorResult(`Failed to get results for query ${args.queryId}: ${errorMsg}`);
  }
}

async function runSql(args: { 
  sql: string; 
  name?: string; 
  freshness?: FreshnessLevel;
  performance?: "medium" | "large";
}): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  const performance = args.performance || "medium";

  // ═══════════════════════════════════════════════════════════════════════
  // AUTO-DETECT FRESHNESS from SQL content
  // ═══════════════════════════════════════════════════════════════════════
  let freshnessInfo: { level: FreshnessLevel; maxAgeHours: number; reason: string };
  
  if (args.freshness && args.freshness !== "auto") {
    freshnessInfo = {
      level: args.freshness,
      maxAgeHours: freshnessToMaxAge(args.freshness),
      reason: `User specified: ${args.freshness}`,
    };
  } else {
    freshnessInfo = detectFreshnessFromSql(args.sql);
  }
  
  // Auto-detect if large engine is needed
  const sqlLower = args.sql.toLowerCase();
  const needsLargeEngine = (
    (sqlLower.match(/join/gi) || []).length >= 2 ||
    sqlLower.includes("cross join") ||
    (sqlLower.match(/group by/gi) || []).length >= 2 ||
    sqlLower.includes("window") ||
    sqlLower.includes("partition by")
  );
  const effectivePerformance = performance === "large" || needsLargeEngine ? "large" : "medium";
  
  console.log(`🔎 SQL analysis:`, {
    freshness: freshnessInfo.level,
    performance: effectivePerformance,
    autoDetectedLarge: needsLargeEngine,
    reason: freshnessInfo.reason,
    sqlPreview: args.sql.substring(0, 100) + "...",
  });

  try {
    // Use SDK's runSql with performance tier
    const result = await duneClient.runSql({
      query_sql: args.sql,
      name: args.name,
      isPrivate: false,
      archiveAfter: true,
      performance: effectivePerformance as any,
    });

    // Estimate credits based on performance tier and complexity
    let credits = effectivePerformance === "large" 
      ? CREDIT_ESTIMATES.COMPLEX_QUERY 
      : CREDIT_ESTIMATES.SQL_EXECUTION;
    const rowCount = result.result?.rows?.length || 0;
    if (rowCount > 10000) {
      credits *= 2;
    }
    
    trackCredits("run_sql", credits, { 
      freshness: freshnessInfo.level,
      performance: effectivePerformance,
      rowCount,
      sqlPreview: args.sql.substring(0, 50),
    });

    return successResult({
      state: result.state || "COMPLETED",
      executionId: result.execution_id,
      rowCount: result.result?.rows?.length || 0,
      totalRowCount: result.result?.metadata?.total_row_count,
      rows: result.result?.rows || [],
      metadata: {
        columnNames: result.result?.metadata?.column_names,
        columnTypes: (result.result?.metadata as any)?.column_types,
        executionTimeMs: result.result?.metadata?.execution_time_millis,
      },
      executedAt: result.execution_ended_at,
      freshness: {
        detected: freshnessInfo.level,
        reason: freshnessInfo.reason,
        maxAgeHours: freshnessInfo.maxAgeHours,
      },
      performance: effectivePerformance,
      creditsEstimate: credits,
      note: freshnessInfo.level === "realtime" 
        ? `🔴 Fresh execution (${effectivePerformance} engine) - SQL contains time-sensitive functions` 
        : freshnessInfo.level === "recent"
        ? `🟡 Fresh execution (${effectivePerformance} engine) - SQL queries recent data`
        : `🟢 SQL executed (${effectivePerformance} engine)`,
      tip: needsLargeEngine && performance !== "large"
        ? "💡 Auto-upgraded to large engine for complex query"
        : "💡 Save frequently-used queries at dune.com to enable caching via execute_query()",
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    
    // ═══════════════════════════════════════════════════════════════════════
    // FETCH ACTUAL ERROR from Dune API when query fails
    // The SDK only returns "QUERY_STATE_FAILED" without the real reason
    // ═══════════════════════════════════════════════════════════════════════
    if (errorMsg.includes("QUERY_STATE_FAILED") || errorMsg.includes("incomplete terminal state")) {
      // Extract execution ID from error message
      const execIdMatch = errorMsg.match(/execution_id=([A-Z0-9]+)/);
      if (execIdMatch && execIdMatch[1]) {
        try {
          // Fetch actual error from Dune API
          const statusResponse = await fetch(
            `https://api.dune.com/api/v1/execution/${execIdMatch[1]}/status`,
            { headers: { "X-Dune-Api-Key": API_KEY } }
          );
          const statusData = await statusResponse.json();
          
          if (statusData.error?.message) {
            const duneError = statusData.error.message;
            
            // Check for common column name errors
            if (duneError.includes("Column") && duneError.includes("cannot be resolved")) {
              return errorResult(
                `❌ SQL ERROR: ${duneError}\n\n` +
                `💡 FIX: Call get_dataset_schema("table_name") first to get the REAL column names!\n` +
                `The dex.trades table uses: taker, maker, token_bought_symbol, token_sold_symbol, amount_usd, blockchain, block_date, etc.`
              );
            }
            
            // Check for syntax errors
            if (duneError.includes("mismatched input") || duneError.includes("Expecting")) {
              return errorResult(
                `❌ SQL SYNTAX ERROR: ${duneError}\n\n` +
                `💡 TIP: DuneSQL uses Trino syntax. For intervals, use: date_add('day', -7, current_date) instead of current_date - interval '7' day`
              );
            }
            
            return errorResult(
              `❌ QUERY FAILED: ${duneError}\n\n` +
              `💡 Call get_dataset_schema() to verify column names before writing SQL.`
            );
          }
        } catch (fetchError) {
          console.log("Failed to fetch execution status:", fetchError);
        }
      }
    }
    
    // Provide helpful context for billing errors
    if (errorMsg.includes("402") || errorMsg.includes("Payment") || errorMsg.includes("upgrade")) {
      return errorResult(
        "run_sql may require a Dune Plus subscription. Workaround: Create a saved query at dune.com, then use execute_query(queryId)."
      );
    }
    if (errorMsg.includes("syntax") || errorMsg.includes("SQL")) {
      return errorResult(
        `SQL syntax error: ${errorMsg}. Tips: Use get_dataset_schema() to verify column names. DuneSQL uses Trino syntax.`
      );
    }
    
    return errorResult(`Failed to run SQL: ${errorMsg}`);
  }
}

async function getCreditUsage(): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured. Get one at https://dune.com/settings/api");
  }

  try {
    // Use the SDK's usage API
    const usage = await (duneClient as any).usage.getUsage();
    
    // Handle various response formats from Dune API
    const currentPeriod = usage.billing_periods?.[0] || usage;
    const creditsUsed = currentPeriod?.credits_used ?? usage.credits_used ?? 0;
    
    // Analyst tier = 4000 credits, Plus = 25000, Free = 2500
    // The API might not return credits_available, so we estimate based on tier
    let creditsLimit = currentPeriod?.credits_available ?? currentPeriod?.credits_limit ?? 0;
    
    // If limit is 0, try to infer from tier or use default
    if (creditsLimit === 0) {
      // Check if there's tier info, otherwise assume Analyst (4000)
      creditsLimit = usage.tier === "plus" ? 25000 : usage.tier === "free" ? 2500 : 4000;
    }
    
    const creditsRemaining = Math.max(0, creditsLimit - creditsUsed);
    const usagePercent = creditsLimit > 0 ? (creditsUsed / creditsLimit) * 100 : 0;

    trackCredits("get_credit_usage (CHECK)", 0, { creditsUsed, creditsRemaining });

    return successResult({
      creditsUsed: Math.round(creditsUsed * 100) / 100,
      creditsRemaining: Math.round(creditsRemaining * 100) / 100,
      creditsLimit,
      usagePercent: Math.round(usagePercent * 10) / 10,
      billingPeriodEnd: currentPeriod?.end_date || usage.billing_period_end,
      storageUsed: usage.bytes_used,
      storageLimit: usage.bytes_allowed,
      privateQueries: usage.private_queries,
      privateDashboards: usage.private_dashboards,
      warning: usagePercent > 80 ? `⚠️ ${usagePercent.toFixed(1)}% of credits used! Consider caching more.` : undefined,
      tip: "Use execute_query with cached freshness and get_query_results to save credits.",
      note: creditsLimit === 4000 ? "Assuming Analyst tier (4000 credits). Actual limit may vary." : undefined,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to get credit usage: ${errorMsg}. Note: Usage API may require Analyst tier or above.`);
  }
}

// ============================================================================
// PERSONALIZED WALLET TOOLS - Handlers
// ============================================================================

/**
 * Wallet context type - injected by client SDK
 */
interface WalletContext {
  address: string;
  chainId?: number;
}

/**
 * Quick pre-check to see if a wallet has ANY DEX trades
 * Returns immediately if no trades found, saving time and credits
 */
async function checkWalletHasDexTrades(walletAddress: string): Promise<{ hasTrades: boolean; totalCount?: number; error?: string }> {
  if (!duneClient) {
    return { hasTrades: false, error: "DUNE_API_KEY not configured" };
  }

  try {
    const checkSql = `
      SELECT COUNT(*) as trade_count
      FROM dex.trades
      WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
        AND amount_usd > 0
      LIMIT 1
    `;

    const result = await duneClient.runSql({
      query_sql: checkSql,
      isPrivate: false,
    });

    const count = result.result?.rows?.[0]?.trade_count || 0;
    return { hasTrades: count > 0, totalCount: count };
  } catch (error) {
    // If pre-check fails, proceed with main query anyway
    console.error("[dune] Pre-check failed:", error);
    return { hasTrades: true }; // Assume trades exist to proceed with main query
  }
}

/**
 * Analyze connected wallet's portfolio
 */
async function analyzeMyPortfolio(
  args: { timeframe?: string; chain?: string },
  context?: { wallet?: WalletContext }
): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured.");
  }

  if (!context?.wallet?.address) {
    return errorResult(
      "🔐 WALLET NOT CONNECTED\n\n" +
      "This tool requires a connected wallet to analyze YOUR portfolio.\n" +
      "Please connect your wallet in the client app to use personalized tools."
    );
  }

  // Convert address to proper format (varbinary comparison - case insensitive in Dune)
  const walletAddress = context.wallet.address.toLowerCase();
  const days = args.timeframe === "7d" ? 7 : args.timeframe === "90d" ? 90 : args.timeframe === "365d" ? 365 : 30;
  const chainFilter = args.chain && args.chain !== "all" ? `AND blockchain = '${args.chain}'` : "";

  // Quick pre-check: Does this wallet have ANY DEX trades?
  const preCheck = await checkWalletHasDexTrades(walletAddress);
  if (!preCheck.hasTrades && !preCheck.error) {
    trackCredits("analyze_my_portfolio", 10, { wallet: walletAddress, preCheck: true });
    return successResult({
      wallet: context.wallet.address,
      timeframe: `${days} days`,
      tradingSummary: {
        totalTrades: 0,
        totalVolumeUsd: 0,
        avgTradeSize: 0,
        chainsUsed: 0,
        dexesUsed: 0,
      },
      topTokens: [],
      chainBreakdown: [],
      note: "🔍 No DEX trading activity found for this wallet.\n\n" +
        "This wallet hasn't made any swaps on decentralized exchanges.\n" +
        "Possible reasons:\n" +
        "• Wallet primarily uses centralized exchanges (Binance, Coinbase)\n" +
        "• Wallet is used for transfers/holding only\n" +
        "• Try connecting a different wallet with DEX activity",
    });
  }

  try {
    // Query trading summary
    // Note: taker and tx_from are varbinary (addresses) - compare with 0x prefix, case-insensitive
    const tradingSql = `
      WITH trades AS (
        SELECT 
          blockchain,
          project as dex,
          token_bought_symbol,
          token_sold_symbol,
          amount_usd,
          block_time
        FROM dex.trades
        WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
          AND block_date >= current_date - interval '${days}' day
          AND amount_usd > 0
          ${chainFilter}
      )
      SELECT 
        COUNT(*) as total_trades,
        COALESCE(SUM(amount_usd), 0) as total_volume_usd,
        COALESCE(AVG(amount_usd), 0) as avg_trade_size,
        COUNT(DISTINCT blockchain) as chains_used,
        COUNT(DISTINCT dex) as dexes_used,
        MIN(block_time) as first_trade,
        MAX(block_time) as last_trade
      FROM trades
    `;

    const tradingResult = await duneClient.runSql({
      query_sql: tradingSql,
      isPrivate: false,
    });

    // Query top tokens
    const tokensSql = `
      SELECT 
        token_bought_symbol as token,
        COUNT(*) as buy_count,
        SUM(amount_usd) as total_volume
      FROM dex.trades
      WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
        AND block_date >= current_date - interval '${days}' day
        AND amount_usd > 0
        AND token_bought_symbol IS NOT NULL
        ${chainFilter}
      GROUP BY 1
      ORDER BY total_volume DESC
      LIMIT 10
    `;

    const tokensResult = await duneClient.runSql({
      query_sql: tokensSql,
      isPrivate: false,
    });

    // Query chain breakdown
    const chainSql = `
      SELECT 
        blockchain,
        COUNT(*) as trade_count,
        SUM(amount_usd) as volume_usd
      FROM dex.trades
      WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
        AND block_date >= current_date - interval '${days}' day
        AND amount_usd > 0
      GROUP BY 1
      ORDER BY volume_usd DESC
    `;

    const chainResult = await duneClient.runSql({
      query_sql: chainSql,
      isPrivate: false,
    });

    const summary = tradingResult.result?.rows?.[0] || {};
    const topTokens = tokensResult.result?.rows || [];
    const chainBreakdown = chainResult.result?.rows || [];

    trackCredits("analyze_my_portfolio", 150, { wallet: walletAddress, days });

    return successResult({
      wallet: context.wallet.address,
      timeframe: `${days} days`,
      tradingSummary: {
        totalTrades: summary.total_trades || 0,
        totalVolumeUsd: Math.round((summary.total_volume_usd || 0) * 100) / 100,
        avgTradeSize: Math.round((summary.avg_trade_size || 0) * 100) / 100,
        chainsUsed: summary.chains_used || 0,
        dexesUsed: summary.dexes_used || 0,
        firstTrade: summary.first_trade,
        lastTrade: summary.last_trade,
      },
      topTokens: topTokens.map((t: any) => ({
        token: t.token,
        buyCount: t.buy_count,
        volumeUsd: Math.round(t.total_volume * 100) / 100,
      })),
      chainBreakdown: chainBreakdown.map((c: any) => ({
        chain: c.blockchain,
        trades: c.trade_count,
        volumeUsd: Math.round(c.volume_usd * 100) / 100,
      })),
      note: topTokens.length === 0 
        ? `No DEX trades found for this wallet in the last ${days} days.`
        : `Found ${summary.total_trades} trades across ${summary.chains_used} chains.`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to analyze portfolio: ${errorMsg}`);
  }
}

/**
 * Get connected wallet's DEX trading history
 */
async function myTradingHistory(
  args: { limit?: number; token?: string; chain?: string; dex?: string; days?: number },
  context?: { wallet?: WalletContext }
): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured.");
  }

  if (!context?.wallet?.address) {
    return errorResult(
      "🔐 WALLET NOT CONNECTED\n\n" +
      "This tool requires a connected wallet to show YOUR trading history.\n" +
      "Please connect your wallet in the client app."
    );
  }

  const walletAddress = context.wallet.address.toLowerCase();
  const limit = Math.min(args.limit || 50, 500);
  const days = args.days || 30; // Default to 30 days instead of 90 for faster queries

  // Quick pre-check: Does this wallet have ANY DEX trades?
  const preCheck = await checkWalletHasDexTrades(walletAddress);
  if (!preCheck.hasTrades && !preCheck.error) {
    trackCredits("my_trading_history", 10, { wallet: walletAddress, preCheck: true });
    return successResult({
      wallet: context.wallet.address,
      totalTrades: 0,
      totalVolumeUsd: 0,
      filters: {
        token: args.token || "all",
        chain: args.chain || "all",
        dex: args.dex || "all",
        days,
      },
      trades: [],
      note: "🔍 No DEX trades found for this wallet.\n\n" +
        "This wallet hasn't made any swaps on decentralized exchanges (Uniswap, Curve, etc.).\n" +
        "Possible reasons:\n" +
        "• Wallet primarily uses centralized exchanges (Binance, Coinbase)\n" +
        "• Wallet is used for transfers/holding only\n" +
        "• Try connecting a different wallet that has DEX activity",
    });
  }

  // Build filters
  const filters: string[] = [];
  if (args.token) {
    filters.push(`(token_bought_symbol = '${args.token.toUpperCase()}' OR token_sold_symbol = '${args.token.toUpperCase()}')`);
  }
  if (args.chain) {
    filters.push(`blockchain = '${args.chain.toLowerCase()}'`);
  }
  if (args.dex) {
    filters.push(`lower(project) = '${args.dex.toLowerCase()}'`);
  }

  const filterClause = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";

  try {
    const sql = `
      SELECT 
        block_time,
        blockchain,
        project as dex,
        token_bought_symbol,
        token_bought_amount,
        token_sold_symbol,
        token_sold_amount,
        amount_usd,
        tx_hash
      FROM dex.trades
      WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
        AND block_date >= current_date - interval '${days}' day
        AND amount_usd > 0
        ${filterClause}
      ORDER BY block_time DESC
      LIMIT ${limit}
    `;

    const result = await duneClient.runSql({
      query_sql: sql,
      isPrivate: false,
    });

    const trades = result.result?.rows || [];
    const totalVolume = trades.reduce((sum: number, t: any) => sum + (t.amount_usd || 0), 0);

    trackCredits("my_trading_history", 100, { wallet: walletAddress, trades: trades.length });

    return successResult({
      wallet: context.wallet.address,
      totalTrades: trades.length,
      totalVolumeUsd: Math.round(totalVolume * 100) / 100,
      filters: {
        token: args.token || "all",
        chain: args.chain || "all",
        dex: args.dex || "all",
        days,
      },
      trades: trades.map((t: any) => ({
        time: t.block_time,
        chain: t.blockchain,
        dex: t.dex,
        bought: `${t.token_bought_amount} ${t.token_bought_symbol}`,
        sold: `${t.token_sold_amount} ${t.token_sold_symbol}`,
        valueUsd: Math.round(t.amount_usd * 100) / 100,
        txHash: t.tx_hash,
      })),
      note: trades.length === 0 
        ? `No trades found matching your filters in the last ${days} days. Try increasing the 'days' parameter.`
        : `Showing ${trades.length} most recent trades.`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to get trading history: ${errorMsg}`);
  }
}

/**
 * Calculate P&L for tokens traded by connected wallet
 */
async function myTokenPnl(
  args: { token?: string; chain?: string },
  context?: { wallet?: WalletContext }
): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured.");
  }

  if (!context?.wallet?.address) {
    return errorResult(
      "🔐 WALLET NOT CONNECTED\n\n" +
      "This tool requires a connected wallet to calculate YOUR profit/loss.\n" +
      "Please connect your wallet in the client app."
    );
  }

  const walletAddress = context.wallet.address.toLowerCase();
  const chainFilter = args.chain ? `AND blockchain = '${args.chain.toLowerCase()}'` : "";
  const isAllTokens = !args.token || args.token.toLowerCase() === "all";

  // Quick pre-check: Does this wallet have ANY DEX trades?
  const preCheck = await checkWalletHasDexTrades(walletAddress);
  if (!preCheck.hasTrades && !preCheck.error) {
    trackCredits("my_token_pnl", 10, { wallet: walletAddress, preCheck: true });
    return successResult({
      wallet: context.wallet.address,
      tokens: [],
      totalRealizedPnl: 0,
      note: "🔍 No DEX trading activity found for this wallet.\n\n" +
        "Cannot calculate P&L without trading history.\n" +
        "This wallet hasn't made any swaps on decentralized exchanges.",
    });
  }

  try {
    let sql: string;

    if (isAllTokens) {
      // Get P&L summary for all tokens
      sql = `
        WITH buys AS (
          SELECT 
            token_bought_symbol as token,
            SUM(token_bought_amount) as amount,
            SUM(amount_usd) as usd_value
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND block_date >= current_date - interval '365' day
            AND amount_usd > 0
            AND token_bought_symbol IS NOT NULL
            ${chainFilter}
          GROUP BY 1
        ),
        sells AS (
          SELECT 
            token_sold_symbol as token,
            SUM(token_sold_amount) as amount,
            SUM(amount_usd) as usd_value
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND block_date >= current_date - interval '365' day
            AND amount_usd > 0
            AND token_sold_symbol IS NOT NULL
            ${chainFilter}
          GROUP BY 1
        )
        SELECT 
          COALESCE(b.token, s.token) as token,
          COALESCE(b.amount, 0) as total_bought,
          COALESCE(b.usd_value, 0) as usd_spent,
          COALESCE(s.amount, 0) as total_sold,
          COALESCE(s.usd_value, 0) as usd_received,
          COALESCE(s.usd_value, 0) - COALESCE(b.usd_value, 0) as realized_pnl
        FROM buys b
        FULL OUTER JOIN sells s ON b.token = s.token
        WHERE COALESCE(b.usd_value, 0) + COALESCE(s.usd_value, 0) > 100
        ORDER BY ABS(COALESCE(s.usd_value, 0) - COALESCE(b.usd_value, 0)) DESC
        LIMIT 20
      `;
    } else {
      // Get detailed P&L for specific token
      const tokenUpper = args.token!.toUpperCase();
      sql = `
        WITH buys AS (
          SELECT 
            SUM(token_bought_amount) as total_bought,
            SUM(amount_usd) as usd_spent,
            COUNT(*) as buy_count,
            AVG(amount_usd / NULLIF(token_bought_amount, 0)) as avg_buy_price
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND token_bought_symbol = '${tokenUpper}'
            AND block_date >= current_date - interval '365' day
            AND amount_usd > 0
            ${chainFilter}
        ),
        sells AS (
          SELECT 
            SUM(token_sold_amount) as total_sold,
            SUM(amount_usd) as usd_received,
            COUNT(*) as sell_count,
            AVG(amount_usd / NULLIF(token_sold_amount, 0)) as avg_sell_price
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND token_sold_symbol = '${tokenUpper}'
            AND block_date >= current_date - interval '365' day
            AND amount_usd > 0
            ${chainFilter}
        )
        SELECT 
          '${tokenUpper}' as token,
          b.total_bought,
          b.usd_spent,
          b.buy_count,
          b.avg_buy_price,
          s.total_sold,
          s.usd_received,
          s.sell_count,
          s.avg_sell_price,
          (COALESCE(s.usd_received, 0) - COALESCE(b.usd_spent, 0)) as realized_pnl
        FROM buys b, sells s
      `;
    }

    const result = await duneClient.runSql({
      query_sql: sql,
      isPrivate: false,
    });

    const rows = result.result?.rows || [];
    trackCredits("my_token_pnl", 100, { wallet: walletAddress, token: args.token || "all" });

    if (isAllTokens) {
      const totalPnl = rows.reduce((sum: number, r: any) => sum + (r.realized_pnl || 0), 0);
      const profitable = rows.filter((r: any) => r.realized_pnl > 0).length;
      const unprofitable = rows.filter((r: any) => r.realized_pnl < 0).length;

      return successResult({
        wallet: context.wallet.address,
        summary: {
          totalRealizedPnl: Math.round(totalPnl * 100) / 100,
          profitableTokens: profitable,
          unprofitableTokens: unprofitable,
          winRate: rows.length > 0 ? Math.round((profitable / rows.length) * 100) : 0,
        },
        tokenBreakdown: rows.map((r: any) => ({
          token: r.token,
          usdSpent: Math.round((r.usd_spent || 0) * 100) / 100,
          usdReceived: Math.round((r.usd_received || 0) * 100) / 100,
          realizedPnl: Math.round((r.realized_pnl || 0) * 100) / 100,
          status: r.realized_pnl > 0 ? "✅ PROFIT" : r.realized_pnl < 0 ? "❌ LOSS" : "➖ BREAK-EVEN",
        })),
        note: rows.length === 0 
          ? "No significant trading activity found (min $100 volume per token)."
          : `Analyzed ${rows.length} tokens with significant volume.`,
      });
    } else {
      const pnl = rows[0] || {};
      const pnlPercent = pnl.usd_spent > 0 
        ? ((pnl.realized_pnl || 0) / pnl.usd_spent) * 100 
        : 0;

      return successResult({
        wallet: context.wallet.address,
        token: args.token!.toUpperCase(),
        buySide: {
          totalBought: pnl.total_bought || 0,
          usdSpent: Math.round((pnl.usd_spent || 0) * 100) / 100,
          buyCount: pnl.buy_count || 0,
          avgBuyPrice: Math.round((pnl.avg_buy_price || 0) * 10000) / 10000,
        },
        sellSide: {
          totalSold: pnl.total_sold || 0,
          usdReceived: Math.round((pnl.usd_received || 0) * 100) / 100,
          sellCount: pnl.sell_count || 0,
          avgSellPrice: Math.round((pnl.avg_sell_price || 0) * 10000) / 10000,
        },
        pnl: {
          realizedPnl: Math.round((pnl.realized_pnl || 0) * 100) / 100,
          realizedPnlPercent: Math.round(pnlPercent * 100) / 100,
          status: pnl.realized_pnl > 0 ? "✅ PROFIT" : pnl.realized_pnl < 0 ? "❌ LOSS" : "➖ BREAK-EVEN",
        },
        note: !pnl.total_bought && !pnl.total_sold
          ? `No trades found for ${args.token!.toUpperCase()} in the last year.`
          : undefined,
      });
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to calculate P&L: ${errorMsg}`);
  }
}

/**
 * Find wallets with similar trading patterns (lookalike audiences)
 */
async function walletsLikeMine(
  args: { similarity_type?: string; min_trades?: number; timeframe?: string },
  context?: { wallet?: WalletContext }
): Promise<CallToolResult> {
  if (!duneClient) {
    return errorResult("DUNE_API_KEY not configured.");
  }

  if (!context?.wallet?.address) {
    return errorResult(
      "🔐 WALLET NOT CONNECTED\n\n" +
      "This tool requires a connected wallet to find similar traders.\n" +
      "Please connect your wallet in the client app."
    );
  }

  const walletAddress = context.wallet.address.toLowerCase();
  const similarityType = args.similarity_type || "balanced";
  const minTrades = args.min_trades || 10;
  const days = args.timeframe === "7d" ? 7 : args.timeframe === "90d" ? 90 : 30;

  // Quick pre-check: Does this wallet have ANY DEX trades?
  const preCheck = await checkWalletHasDexTrades(walletAddress);
  if (!preCheck.hasTrades && !preCheck.error) {
    trackCredits("wallets_like_mine", 10, { wallet: walletAddress, preCheck: true });
    return successResult({
      wallet: context.wallet.address,
      yourProfile: { tradeCount: 0, totalVolume: 0, uniqueTokens: 0 },
      lookalikeWallets: [],
      alphaOpportunities: [],
      note: "🔍 No DEX trading activity found for this wallet.\n\n" +
        "Cannot find similar traders without your trading history.\n" +
        "Try connecting a wallet that has DEX trading activity.",
    });
  }

  try {
    // Step 1: Get your trading profile
    const profileSql = `
      SELECT 
        COUNT(*) as trade_count,
        SUM(amount_usd) as total_volume,
        COUNT(DISTINCT token_bought_symbol) as unique_tokens,
        ARRAY_AGG(DISTINCT token_bought_symbol) as tokens_traded
      FROM dex.trades
      WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
        AND block_date >= current_date - interval '${days}' day
        AND amount_usd > 0
        AND token_bought_symbol IS NOT NULL
    `;

    const profileResult = await duneClient.runSql({
      query_sql: profileSql,
      isPrivate: false,
    });

    const yourProfile = profileResult.result?.rows?.[0] || {};
    
    if (!yourProfile.trade_count || yourProfile.trade_count === 0) {
      return successResult({
        yourWallet: context.wallet.address,
        message: `No trading activity found in the last ${days} days. Trade more to find lookalikes!`,
        yourProfile: { trades: 0, volume: 0 },
        lookalikeWallets: [],
      });
    }

    // Step 2: Find similar wallets based on similarity type
    let lookalikeQuery: string;
    
    if (similarityType === "tokens") {
      // Find wallets trading the same tokens
      lookalikeQuery = `
        WITH your_tokens AS (
          SELECT DISTINCT token_bought_symbol as token
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND block_date >= current_date - interval '${days}' day
            AND token_bought_symbol IS NOT NULL
        ),
        other_wallets AS (
          SELECT 
            taker as wallet,
            COUNT(*) as trade_count,
            SUM(amount_usd) as volume,
            COUNT(DISTINCT token_bought_symbol) as tokens_count,
            COUNT(DISTINCT CASE WHEN token_bought_symbol IN (SELECT token FROM your_tokens) THEN token_bought_symbol END) as overlap_tokens
          FROM dex.trades
          WHERE taker != from_hex('${walletAddress.replace('0x', '')}')
            AND block_date >= current_date - interval '${days}' day
            AND amount_usd > 0
            AND taker IS NOT NULL
          GROUP BY 1
          HAVING COUNT(*) >= ${minTrades}
        )
        SELECT 
          wallet,
          trade_count,
          volume,
          tokens_count,
          overlap_tokens,
          CAST(overlap_tokens AS DOUBLE) / NULLIF(tokens_count, 0) * 100 as overlap_score
        FROM other_wallets
        WHERE overlap_tokens >= 2
        ORDER BY overlap_score DESC, volume DESC
        LIMIT 10
      `;
    } else if (similarityType === "volume") {
      // Find wallets with similar trading volume
      const targetVolume = yourProfile.total_volume || 0;
      lookalikeQuery = `
        SELECT 
          taker as wallet,
          COUNT(*) as trade_count,
          SUM(amount_usd) as volume,
          COUNT(DISTINCT token_bought_symbol) as tokens_count,
          ABS(SUM(amount_usd) - ${targetVolume}) as volume_diff
        FROM dex.trades
        WHERE taker != from_hex('${walletAddress.replace('0x', '')}')
          AND block_date >= current_date - interval '${days}' day
          AND amount_usd > 0
          AND taker IS NOT NULL
        GROUP BY 1
        HAVING COUNT(*) >= ${minTrades}
          AND SUM(amount_usd) BETWEEN ${targetVolume * 0.5} AND ${targetVolume * 2}
        ORDER BY volume_diff ASC
        LIMIT 10
      `;
    } else {
      // Balanced: combination of tokens and volume similarity
      lookalikeQuery = `
        WITH your_tokens AS (
          SELECT DISTINCT token_bought_symbol as token
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND block_date >= current_date - interval '${days}' day
            AND token_bought_symbol IS NOT NULL
        ),
        other_wallets AS (
          SELECT 
            taker as wallet,
            COUNT(*) as trade_count,
            SUM(amount_usd) as volume,
            COUNT(DISTINCT token_bought_symbol) as tokens_count,
            COUNT(DISTINCT CASE WHEN token_bought_symbol IN (SELECT token FROM your_tokens) THEN token_bought_symbol END) as overlap_tokens
          FROM dex.trades
          WHERE taker != from_hex('${walletAddress.replace('0x', '')}')
            AND block_date >= current_date - interval '${days}' day
            AND amount_usd > 0
            AND taker IS NOT NULL
          GROUP BY 1
          HAVING COUNT(*) >= ${minTrades}
        )
        SELECT 
          wallet,
          trade_count,
          volume,
          tokens_count,
          overlap_tokens,
          (CAST(overlap_tokens AS DOUBLE) / NULLIF(tokens_count, 0) * 50) + 
          (CASE WHEN volume BETWEEN ${(yourProfile.total_volume || 0) * 0.3} AND ${(yourProfile.total_volume || 0) * 3} THEN 50 ELSE 0 END) as similarity_score
        FROM other_wallets
        WHERE overlap_tokens >= 1
        ORDER BY similarity_score DESC
        LIMIT 10
      `;
    }

    const lookalikeResult = await duneClient.runSql({
      query_sql: lookalikeQuery,
      isPrivate: false,
    });

    const lookalikes = lookalikeResult.result?.rows || [];

    // Step 3: Find what lookalikes are trading that you're not
    let alphaOpportunities: any[] = [];
    if (lookalikes.length > 0) {
      // Convert addresses to from_hex format for IN clause
      const topLookalikes = lookalikes.slice(0, 5).map((l: any) => {
        const addr = l.wallet.toLowerCase().replace('0x', '');
        return `from_hex('${addr}')`;
      }).join(",");
      const alphaSql = `
        WITH your_tokens AS (
          SELECT DISTINCT token_bought_symbol as token
          FROM dex.trades
          WHERE (taker = from_hex('${walletAddress.replace('0x', '')}') OR tx_from = from_hex('${walletAddress.replace('0x', '')}'))
            AND block_date >= current_date - interval '${days}' day
        ),
        lookalike_tokens AS (
          SELECT 
            token_bought_symbol as token,
            COUNT(DISTINCT taker) as traders,
            SUM(amount_usd) as volume
          FROM dex.trades
          WHERE taker IN (${topLookalikes})
            AND block_date >= current_date - interval '7' day
            AND token_bought_symbol NOT IN (SELECT token FROM your_tokens)
            AND token_bought_symbol IS NOT NULL
            AND amount_usd > 0
          GROUP BY 1
          HAVING COUNT(DISTINCT taker) >= 2
        )
        SELECT token, traders, volume
        FROM lookalike_tokens
        ORDER BY traders DESC, volume DESC
        LIMIT 5
      `;

      try {
        const alphaResult = await duneClient.runSql({
          query_sql: alphaSql,
          isPrivate: false,
        });
        alphaOpportunities = alphaResult.result?.rows || [];
      } catch {
        // Alpha query failed, continue without it
      }
    }

    trackCredits("wallets_like_mine", 200, { wallet: walletAddress, lookalikes: lookalikes.length });

    return successResult({
      yourWallet: context.wallet.address,
      yourProfile: {
        trades: yourProfile.trade_count || 0,
        volumeUsd: Math.round((yourProfile.total_volume || 0) * 100) / 100,
        uniqueTokens: yourProfile.unique_tokens || 0,
      },
      similarityType,
      timeframe: `${days} days`,
      lookalikeWallets: lookalikes.map((l: any, i: number) => ({
        rank: i + 1,
        wallet: l.wallet,
        trades: l.trade_count,
        volumeUsd: Math.round((l.volume || 0) * 100) / 100,
        tokensTraded: l.tokens_count,
        overlapTokens: l.overlap_tokens || 0,
        similarityScore: Math.round((l.similarity_score || l.overlap_score || 0) * 10) / 10,
      })),
      alphaOpportunities: alphaOpportunities.length > 0 ? {
        message: "🎯 Tokens your lookalikes are buying that you're NOT trading:",
        tokens: alphaOpportunities.map((a: any) => ({
          token: a.token,
          tradersCount: a.traders,
          volumeUsd: Math.round((a.volume || 0) * 100) / 100,
        })),
      } : undefined,
      note: lookalikes.length === 0
        ? `No similar wallets found with ${minTrades}+ trades. Try lowering min_trades.`
        : `Found ${lookalikes.length} wallets with similar trading patterns.`,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    return errorResult(`Failed to find lookalike wallets: ${errorMsg}`);
  }
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "dune-analytics", version: "5.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Debug: log what we're sending for wallet tools
  const myTradingHistory = TOOLS.find(t => t.name === "my_trading_history");
  console.log("[DEBUG] my_trading_history _meta:", myTradingHistory?._meta);
  console.log("[DEBUG] contextRequirements:", myTradingHistory?._meta?.contextRequirements);
  
  return { tools: TOOLS };
});

server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;
    
    // Extract wallet context from request _meta (injected by client SDK)
    const context = extractContext(request);

    try {
      switch (name) {
        // Discovery tools
        case "discover_tables":
          return await discoverTables(args as any);
        case "list_datasets":
          return await listDatasets(args as any);
        case "get_dataset_schema":
          return await getDatasetSchema(args as any);
        
        // Query tools
        case "execute_query":
          return await executeQuery(args as any);
        case "get_query_results":
          return await getQueryResults(args as any);
        case "run_sql":
          return await runSql(args as any);
        case "get_credit_usage":
          return await getCreditUsage();
        
        // 🎯 PERSONALIZED WALLET TOOLS (require connected wallet)
        case "analyze_my_portfolio":
          return await analyzeMyPortfolio(args as any, context);
        case "my_trading_history":
          return await myTradingHistory(args as any, context);
        case "my_token_pnl":
          return await myTokenPnl(args as any, context);
        case "wallets_like_mine":
          return await walletsLikeMine(args as any, context);
        
        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Unknown error");
    }
  }
);

/**
 * Extract wallet context from MCP request
 * The client SDK injects context when tools have contextRequirements
 * 
 * The client may inject wallet data in different formats:
 * 1. _meta.context.wallet - full wallet context object
 * 2. args.wallet.address - direct wallet object in args
 * 3. args.walletAddresses - array of wallet addresses (injected by Context platform)
 */
function extractContext(request: CallToolRequest): { wallet?: WalletContext } | undefined {
  try {
    // Context is passed via _meta in the request
    const meta = (request.params as any)?._meta;
    if (meta?.context?.wallet) {
      return { wallet: meta.context.wallet };
    }
    
    const args = request.params.arguments as any;
    
    // Check for direct wallet injection (alternative pattern)
    if (args?.wallet?.address) {
      return { wallet: args.wallet };
    }
    
    // Check for walletAddresses array (injected by Context platform)
    // This is the primary injection format from the client SDK
    if (args?.walletAddresses && Array.isArray(args.walletAddresses) && args.walletAddresses.length > 0) {
      return {
        wallet: {
          address: args.walletAddresses[0], // Use first wallet address
          chainId: 1, // Default to Ethereum mainnet
          balances: [],
          fetchedAt: new Date().toISOString(),
        }
      };
    }
    
    return undefined;
  } catch {
    return undefined;
  }
}

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
    version: "5.0.0",
    sdk: "@duneanalytics/client-sdk",
    apiKeyConfigured: !!API_KEY,
    tools: TOOLS.map((t) => t.name),
    features: [
      "✅ DYNAMIC DISCOVERY - discover_tables() queries Dune API for 2,800+ community tables",
      "✅ LIVE SCHEMA - get_dataset_schema() returns real columns from Dune API",
      "✅ RAW SQL - run_sql() executes any SQL against Spellbook tables",
      "✅ SAVED QUERIES - execute_query(id) runs community queries by ID",
      "✅ SMART CACHING - cache-first approach minimizes credits",
      "✅ AUTO-FRESHNESS - detects time-sensitivity from SQL",
      "✅ CREDIT MONITORING - get_credit_usage() tracks usage",
    ],
    personalizedTools: [
      "🎯 analyze_my_portfolio - Portfolio dashboard for connected wallet",
      "🎯 my_trading_history - Your complete DEX trading history",
      "🎯 my_token_pnl - Profit/Loss calculation per token",
      "🎯 wallets_like_mine - Find lookalike wallets (similar traders)",
    ],
    contextRequirements: {
      wallet: "Personalized tools require connected wallet via SDK context injection",
    },
    architecture: "Dynamic: discover_tables(search) → get_dataset_schema(table) → run_sql(query)",
    sessionCreditsUsed,
  });
});

// ============================================================================
// LOCAL TEST ENDPOINT (only accessible from localhost)
// ============================================================================
app.post("/test", async (req: Request, res: Response) => {
  // Only allow from localhost for security
  const clientIp = req.ip || req.socket.remoteAddress;
  if (!clientIp?.includes("127.0.0.1") && !clientIp?.includes("::1") && clientIp !== "::ffff:127.0.0.1") {
    res.status(403).json({ error: "Test endpoint only accessible from localhost" });
    return;
  }

  const { tool, args } = req.body;
  if (!tool) {
    res.status(400).json({ error: "Missing 'tool' in request body" });
    return;
  }

  try {
    // Extract context from test request (for wallet tools)
    const testContext = args?.wallet ? { wallet: args.wallet } : undefined;
    
    let result: CallToolResult;
    switch (tool) {
      case "discover_tables":
        result = await discoverTables(args || {});
        break;
      case "list_datasets":
        result = await listDatasets(args || {});
        break;
      case "get_dataset_schema":
        result = await getDatasetSchema(args || {});
        break;
      case "execute_query":
        result = await executeQuery(args || {});
        break;
      case "get_query_results":
        result = await getQueryResults(args || {});
        break;
      case "run_sql":
        result = await runSql(args || {});
        break;
      case "get_credit_usage":
        result = await getCreditUsage();
        break;
      // 🎯 PERSONALIZED WALLET TOOLS
      case "analyze_my_portfolio":
        result = await analyzeMyPortfolio(args || {}, testContext);
        break;
      case "my_trading_history":
        result = await myTradingHistory(args || {}, testContext);
        break;
      case "my_token_pnl":
        result = await myTokenPnl(args || {}, testContext);
        break;
      case "wallets_like_mine":
        result = await walletsLikeMine(args || {}, testContext);
        break;
      default:
        res.status(400).json({ error: `Unknown tool: ${tool}` });
        return;
    }
    res.json(result.structuredContent || { content: result.content });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : "Unknown error" });
  }
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
  console.log(`\n🔮 Dune Analytics MCP Server v4.3.0 - COMPREHENSIVE COLUMN HINTS!`);
  console.log(`📦 Using official @duneanalytics/client-sdk`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`🧪 Test endpoint: http://localhost:${port}/test (localhost only)`);
  console.log(`\n🛠️  Available tools (${TOOLS.length}):`);
  TOOLS.forEach((t) => console.log(`   - ${t.name}`));
  console.log(`\n⚙️  Configuration:`);
  console.log(`   API Key: ${API_KEY ? "✅ Configured" : "❌ Missing (set DUNE_API_KEY)"}`);
  console.log(`\n✨ v5.0 - PERSONALIZED BLOCKCHAIN ANALYTICS:`);
  console.log(`   📊 DISCOVERY: discover_tables(), list_datasets(), get_dataset_schema()`);
  console.log(`   🔍 QUERIES: run_sql(), execute_query(), get_query_results()`);
  console.log(`   💰 MONITORING: get_credit_usage()`);
  console.log(`\n🎯 NEW - PERSONALIZED WALLET TOOLS (require connected wallet):`);
  console.log(`   🎯 analyze_my_portfolio → Portfolio dashboard for YOUR wallet`);
  console.log(`   🎯 my_trading_history → YOUR complete DEX trading history`);
  console.log(`   🎯 my_token_pnl → YOUR profit/loss per token`);
  console.log(`   🎯 wallets_like_mine → Find wallets similar to YOU`);
  console.log(`\n🔄 WORKFLOW:`);
  console.log(`   Standard: discover_tables() → get_dataset_schema() → run_sql()`);
  console.log(`   Personal: Connect wallet → analyze_my_portfolio(), my_token_pnl()`);
  console.log(`   discover_tables(search: "arbitrum") → Find Arbitrum tables`);
  console.log(`   get_dataset_schema("dex.trades") → Get columns for DEX table`);
  console.log(`   run_sql("SELECT * FROM dex.trades LIMIT 10") → Query directly\n`);
});



