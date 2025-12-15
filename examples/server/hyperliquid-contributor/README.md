# Hyperliquid Ultimate MCP Server v2.0

The world's most comprehensive Hyperliquid MCP server. Built with the standard `@modelcontextprotocol/sdk`.

> **📖 Building portfolio analysis tools?** See the [Context Injection Guide](../../../docs/context-injection.md) to learn how user portfolio data is automatically injected into your tools.

## Context Requirements

This server includes tools that require user portfolio data. These tools declare their requirements using the `x-context-requirements` JSON Schema extension in `inputSchema`:

### Tools Requiring Portfolio Context

| Tool | Context Required | Description |
|------|-----------------|-------------|
| `analyze_my_positions` | `["hyperliquid"]` | Analyzes user's perp positions with P&L and risk assessment |

### Tools NOT Requiring Context (Public Data)

All other tools in this server use public Hyperliquid API data and don't require user context:
- `get_orderbook`, `calculate_price_impact`, `analyze_large_order`
- `get_market_info`, `list_markets`, `get_candles`, `get_recent_trades`
- `get_funding_analysis`, `get_funding_history`, `get_open_interest_analysis`
- `get_staking_summary`, `get_user_delegations`, `get_hlp_vault_stats`
- `get_exchange_stats`, `get_volume_history`, `get_markets_at_oi_cap`

### How Context Requirements Work

```typescript
// Tools that need portfolio data include x-context-requirements in inputSchema:
{
  name: "analyze_my_positions",
  inputSchema: {
    type: "object",
    "x-context-requirements": ["hyperliquid"],  // ← Platform reads this
    properties: {
      portfolio: { type: "object" }  // ← Platform injects HyperliquidContext here
    },
    required: ["portfolio"]
  }
}
```

**Why `x-context-requirements` in inputSchema?**
- The MCP protocol only transmits standard fields (`name`, `description`, `inputSchema`, `outputSchema`)
- Custom top-level fields like `requirements` get stripped by the MCP SDK during transport
- JSON Schema allows custom `x-` prefixed extension properties
- `inputSchema` is preserved through MCP transport

### What Gets Injected

When the Context platform detects `"x-context-requirements": ["hyperliquid"]`, it:

1. Checks if the user has linked a wallet
2. If not → shows an in-chat prompt to link wallet
3. If yes → fetches user's Hyperliquid data via their public API
4. Injects `HyperliquidContext` as the `portfolio` argument

```typescript
// What your tool receives:
interface HyperliquidContext {
  walletAddress: string;
  perpPositions: HyperliquidPerpPosition[];
  spotBalances: HyperliquidSpotBalance[];
  openOrders: HyperliquidOrder[];
  accountSummary: HyperliquidAccountSummary;
  fetchedAt: string;
}
```

---

## Features

Enables AI agents to analyze orderbook depth, simulate price impact, track funding rates, monitor staking flows, and answer complex questions like:

> "The HyperLiquid team sent 609,108 HYPE ($20.9M) to Flowdesk. Can the market absorb this sell pressure? By how much would the price drop?"

## Context Protocol Compliance

This server is **Context Protocol compliant**. Context requires `outputSchema` and `structuredContent` from the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema) for all paid tools. While these are optional in vanilla MCP, Context requires them for payment verification and dispute resolution.

1. **`outputSchema`** - Every tool defines its response structure (enables AI code generation)
2. **`structuredContent`** - Every response includes machine-readable data (enables type-safe parsing)

```typescript
// Tool definition with outputSchema (standard MCP feature, required by Context)
const TOOLS = [{
  name: "get_orderbook",
  inputSchema: { /* ... */ },
  outputSchema: {  // Standard MCP feature (required by Context)
    type: "object",
    properties: {
      coin: { type: "string" },
      midPrice: { type: "number" },
      // ...
    },
    required: ["coin", "midPrice"],
  },
}];

// Response with structuredContent (standard MCP feature, required by Context)
function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],  // Backward compat
    structuredContent: data,  // Standard MCP feature (required by Context)
  };
}
```

## 🚀 Features

### Orderbook & Liquidity Analysis
- **get_orderbook** - L2 orderbook with cumulative depth, liquidity scores, and volume context
- **calculate_price_impact** - Simulate order execution with TWAP duration estimates
- **analyze_large_order** - Comprehensive analysis for large orders (team unlocks, whale sells)

### Market Data
- **get_market_info** - Price, volume, OI, funding, max leverage, impact prices
- **list_markets** - All available perpetual markets
- **get_candles** - Historical OHLCV data for any interval

### Funding & Sentiment
- **get_funding_analysis** - Current and predicted funding rates across Binance, Bybit, Hyperliquid
- **get_funding_history** - Historical funding rates over time to analyze trends
- **get_open_interest_analysis** - OI analysis with liquidation risk assessment

### Exchange Stats & Volume
- **get_exchange_stats** - Aggregated exchange-wide stats: total 24h volume, total OI, top markets
- **get_volume_history** - Historical volume trends to identify liquidity changes over time

### Staking & Flows
- **get_staking_summary** - Staking mechanics, lockup periods, APY info
- **get_user_delegations** - Query any wallet's staking delegations

### HLP Vault
- **get_hlp_vault_stats** - HLP vault APR, TVL, historical performance, and P&L

### Trade Analysis
- **get_recent_trades** - Recent trades with whale detection
- **get_markets_at_oi_cap** - Markets at open interest capacity

## 📦 Setup

```bash
cd examples/server/hyperliquid-contributor
pnpm install
pnpm run dev
```

Server runs on `http://localhost:4002`.

## 🔌 Endpoints

- **SSE**: `http://localhost:4002/sse` - MCP connection
- **Health**: `http://localhost:4002/health` - Status check

## 💡 Example Questions This MCP Can Answer

### Market Absorption Analysis
> "Can the market absorb 609,000 HYPE being sold?"

Uses `analyze_large_order` to provide:
- % of daily volume the order represents
- Visible orderbook absorption capacity
- TWAP duration recommendation
- Reflexivity risk assessment
- Price impact estimates

### Funding Arbitrage
> "Is there a funding arbitrage opportunity between Hyperliquid and Binance for ETH?"

Uses `get_funding_analysis` to compare rates across venues.

### Staking Flow Analysis
> "The team unstaked 2.6M HYPE. When will it hit the market?"

Uses `get_staking_summary` to explain the 7-day unstaking queue.

### Liquidation Risk
> "Is HYPE at risk of liquidation cascades?"

Uses `get_open_interest_analysis` to assess OI/volume ratio and funding bias.

## 📊 Output Schema

All tools return `structuredContent` for reliable AI parsing.

> ⚠️ **Schema Accuracy Matters**: Your `outputSchema` is used for automated dispute resolution. If your actual output doesn't match your declared schema, users can file disputes that are auto-adjudicated against you.

## 🌐 Deploying to Production

Deploy to Railway, Fly.io, or Render:

```bash
# Railway
railway up

# Fly.io
fly launch
fly deploy
```

Then register on Context: `https://ctxprotocol.com`

## Architecture

This server uses the standard MCP SDK (`@modelcontextprotocol/sdk`) with:
- Express for HTTP server
- SSE transport for MCP communication
- Hyperliquid API for market data

The `outputSchema` and `structuredContent` fields are part of the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema) - no special SDK required. Context requires these for payment verification and dispute resolution.

## 📚 API Reference

Based on [Hyperliquid API Documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api).

## License

MIT
