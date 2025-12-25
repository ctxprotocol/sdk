# Dune Analytics MCP Server

A streamlined MCP server for blockchain analytics using the [Dune Analytics API](https://docs.dune.com/api-reference). Access trending contracts, DEX stats, Farcaster trends, EigenLayer metrics, and execute any of Dune's **750,000+ community queries**.

## Features

### Intelligence Tools
- **discover_trending_contracts** - Find trending smart contracts on any EVM chain
- **get_dex_pair_stats** - Get comprehensive DEX trading pair statistics
- **get_farcaster_trends** - Discover trending Farcaster users, channels, memecoins

### Raw Data Tools (Bridge to Community Queries)
- **execute_query** - Execute ANY saved Dune query by ID
- **get_query_results** - Get cached results from previously executed queries
- **get_execution_status** - Check query execution status
- **get_execution_results** - Get results from specific execution
- **get_eigenlayer_avs** - EigenLayer AVS metadata and metrics
- **get_eigenlayer_operators** - EigenLayer operator data

### Discovery Tools
- **list_supported_chains** - List all supported blockchain networks

## Quick Start

1. **Get a Dune API Key**
   - Sign up at [dune.com](https://dune.com)
   - Go to Settings → API → Create New API Key
   - Free tier includes 40 RPM for read-heavy endpoints

2. **Configure Environment**
   ```bash
   cp env.example .env
   # Edit .env and add your API key
   ```

3. **Install Dependencies**
   ```bash
   npm install
   ```

4. **Run the Server**
   ```bash
   npm run dev   # Development with hot reload
   npm start     # Production
   ```

5. **Health Check**
   ```bash
   curl http://localhost:4008/health
   ```

## Using Community Queries (The Power of Dune)

Dune has **750,000+ community queries** covering every aspect of blockchain analytics. The `execute_query` tool lets you tap into this massive resource.

### Finding Useful Queries
1. Go to [dune.com](https://dune.com) and search for dashboards (e.g., "Uniswap Volume", "Wallet Analysis")
2. Open a chart and look at the underlying query
3. Note the query ID from the URL: `dune.com/queries/1234567` → **1234567**

### Example: Execute a Community Query
```json
{
  "tool": "execute_query",
  "arguments": {
    "queryId": 1234567,
    "parameters": {
      "wallet_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"
    }
  }
}
```

### Popular Community Query IDs
| Query ID | Description |
|----------|-------------|
| `3237721` | Top DEX traders by volume |
| `2030664` | Ethereum gas tracker |
| `1747157` | NFT marketplace volumes |
| `3296627` | Wallet token balances |
| `2898034` | Token holder analysis |

> **Note**: Community queries can change or break. For critical applications, fork queries to your own account.

## Rate Limits

| Tier | Write Endpoints | Read Endpoints |
|------|-----------------|----------------|
| Free | 15 RPM | 40 RPM |
| Plus | 70 RPM | 200 RPM |
| Premium | 350 RPM | 1000 RPM |

**Write-heavy:** `execute_query`  
**Read-heavy:** `get_query_results`, `get_execution_status`, `get_execution_results`, etc.

## Supported Chains

- Ethereum (mainnet)
- Polygon
- Arbitrum One
- Optimism
- Base
- Avalanche C-Chain
- BNB Smart Chain

## Example Usage

### Find Trending Contracts
```json
{
  "tool": "discover_trending_contracts",
  "arguments": {
    "chain": "base",
    "limit": 10
  }
}
```

### Get DEX Pair Stats
```json
{
  "tool": "get_dex_pair_stats",
  "arguments": {
    "blockchain": "ethereum",
    "tokenAddress": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
  }
}
```

### Discover Farcaster Trends
```json
{
  "tool": "get_farcaster_trends",
  "arguments": {
    "type": "memecoins",
    "limit": 20
  }
}
```

### Get EigenLayer AVS Rankings
```json
{
  "tool": "get_eigenlayer_avs",
  "arguments": {
    "limit": 10,
    "sortBy": "tvl desc"
  }
}
```

## API Documentation

- [Dune API Reference](https://docs.dune.com/api-reference)
- [Query Execution](https://docs.dune.com/api-reference/executions/endpoint/execute-query)
- [Trending Contracts](https://docs.dune.com/api-reference/evm/endpoint/contracts)
- [EigenLayer API](https://docs.dune.com/api-reference/eigenlayer/introduction)
- [Farcaster API](https://docs.dune.com/api-reference/farcaster/introduction)

## License

MIT
