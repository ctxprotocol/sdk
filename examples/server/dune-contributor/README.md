# Dune Analytics MCP Server

A streamlined MCP server that provides access to **Dune's 750,000+ community queries** via their official API.

## Features

| Tool | Description | Rate Limit |
|------|-------------|------------|
| `search_queries` | **Search curated query catalog** | Instant |
| `execute_query` | Execute any saved Dune query by ID | 15 RPM |
| `get_query_results` | Get cached results (faster!) | 40 RPM |
| `get_execution_status` | Check if query finished | 40 RPM |
| `get_execution_results` | Get results from execution | 40 RPM |
| `run_sql` | Execute raw SQL (Premium only) | 15 RPM |

## Quick Start

```bash
# 1. Configure API key
echo 'DUNE_API_KEY="your_key_here"' > .env

# 2. Install & run
npm install
npm run dev
```

## How It Works

### Step 1: Search for the Right Query

Use `search_queries` to find a query ID for your use case:

```json
{
  "tool": "search_queries",
  "arguments": {
    "query": "dex volume"
  }
}
```

Returns curated queries like:
- `3358886` - DEX Volume by Chain (24h)
- `2803687` - Top DEX Protocols by Volume
- `1324628` - Uniswap Daily Volume

### Step 2: Execute the Query

```json
{
  "tool": "get_query_results",
  "arguments": {
    "queryId": 3358886,
    "limit": 100
  }
}
```

## Query Categories

| Category | Examples |
|----------|----------|
| `dex` | DEX volume, trading stats, Uniswap |
| `wallet` | Token balances, wallet analysis |
| `nft` | NFT marketplace volume, top collections |
| `ethereum` | Gas prices, ETH burned, staking |
| `l2` | Layer 2 TVL, Base, Arbitrum, Optimism |
| `defi` | TVL rankings, lending protocols |
| `stablecoin` | USDC/USDT volume, market cap |
| `bridge` | Cross-chain bridge volume |
| `memecoin` | Top memecoins by volume |

## Workflow for AI Agents

```
1. search_queries(query: "what you're looking for")
   → Returns matching query IDs
   
2. get_query_results(queryId: <id from step 1>)
   → Returns cached data (fast, 40 RPM)
   
   OR
   
   execute_query(queryId: <id>, parameters: {...})
   → Triggers fresh execution (15 RPM)
   
3. If execute_query returns "PENDING":
   → get_execution_status(executionId: <id>)
   → get_execution_results(executionId: <id>)
```

## Example Questions for AI Chat

| Question | Workflow |
|----------|----------|
| "What's the DEX volume today?" | `search_queries("dex volume")` → `get_query_results(3358886)` |
| "What tokens does vitalik.eth hold?" | `search_queries("wallet balance")` → `execute_query(3352067, {wallet_address: "0x..."})` |
| "Top NFT collections?" | `search_queries("nft")` → `get_query_results(2477537)` |
| "Ethereum gas prices?" | `search_queries("gas")` → `get_query_results(3298549)` |

## Rate Limits

| Tier | Write (execute_query) | Read (get_query_results) |
|------|----------------------|--------------------------|
| Free | 15 RPM | 40 RPM |
| Plus | 70 RPM | 200 RPM |
| Premium | 350 RPM | 1000 RPM |

**Pro Tip**: Always prefer `get_query_results` for cached data!

## Adding New Queries to Catalog

To add more queries to the catalog, edit `server.ts` and add entries to `QUERY_CATALOG`:

```typescript
{
  id: 1234567,
  name: "My Query Name",
  description: "What this query does",
  category: "dex",  // or wallet, nft, ethereum, etc.
  params: ["param1", "param2"],  // optional
}
```

## API Documentation

- [Dune API Reference](https://docs.dune.com/api-reference)
- [Query Execution](https://docs.dune.com/api-reference/executions/endpoint/execute-query)
- [Get Results](https://docs.dune.com/api-reference/executions/endpoint/get-query-result)

## License

MIT
