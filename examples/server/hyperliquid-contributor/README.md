# Hyperliquid Ultimate MCP Server v2.0

The world's most comprehensive Hyperliquid MCP server. Built with the standard `@modelcontextprotocol/sdk`.

Enables AI agents to analyze orderbook depth, simulate price impact, track funding rates, monitor staking flows, and answer complex questions like:

> "The HyperLiquid team sent 609,108 HYPE ($20.9M) to Flowdesk. Can the market absorb this sell pressure? By how much would the price drop?"

## Context Protocol Compliance

This server is **Context Protocol compliant**, which means:

1. **`outputSchema`** - Every tool defines its response structure (enables AI code generation)
2. **`structuredContent`** - Every response includes machine-readable data (enables type-safe parsing)

```typescript
// Tool definition with outputSchema (Context Protocol extension)
const TOOLS = [{
  name: "get_orderbook",
  inputSchema: { /* ... */ },
  outputSchema: {  // <-- Context Protocol extension
    type: "object",
    properties: {
      coin: { type: "string" },
      midPrice: { type: "number" },
      // ...
    },
    required: ["coin", "midPrice"],
  },
}];

// Response with structuredContent (Context Protocol extension)
function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,  // <-- Context Protocol extension
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

The Context Protocol extensions (`outputSchema`, `structuredContent`) are simply additional fields - no special SDK required.

## 📚 API Reference

Based on [Hyperliquid API Documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api).

## License

MIT
