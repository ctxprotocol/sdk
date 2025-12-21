# Coinglass MCP Server

**Comprehensive crypto derivatives intelligence from Coinglass API.**

A dual-tier MCP server providing both high-level intelligence tools and raw data access for the Coinglass API.

## Features

### 🧠 Tier 1: Intelligence Layer (8 Tools)

High-value composite tools that synthesize multiple data sources:

| Tool | Description |
|------|-------------|
| `calculate_squeeze_probability` | Predict short/long squeeze probability using funding, OI, liquidations |
| `analyze_market_sentiment` | Cross-market sentiment analysis (Fear & Greed, funding bias, ratios) |
| `find_funding_arbitrage` | Best funding rate arbitrage opportunities with risk assessment |
| `get_btc_valuation_score` | Multi-indicator BTC valuation (AHR999, Rainbow, Puell, Bubble) |
| `detect_liquidation_risk` | Liquidation cascade risk prediction |
| `analyze_smart_money` | Top trader vs retail positioning analysis |
| `scan_volume_anomalies` | Unusual volume activity detection across all coins |
| `get_market_overview` | Complete derivatives dashboard (OI, volume, liquidations) |

### 📊 Tier 2: Raw Data Layer (35 Tools)

Direct access to Coinglass API endpoints:

**Futures Data:**
- `get_supported_coins`, `get_supported_exchanges`, `get_exchange_pairs`
- `get_futures_coins_markets`, `get_futures_pairs_markets`
- `get_price_history`, `get_funding_rates`, `get_funding_rate_history`
- `get_funding_arbitrage_list`
- `get_oi_by_exchange`, `get_oi_history`, `get_oi_coin_margin_history`
- `get_liquidation_history`, `get_aggregated_liquidations`
- `get_global_long_short_ratio`
- `get_top_trader_position_ratio`, `get_top_trader_account_ratio`
- `get_taker_buy_sell_volume`, `get_aggregated_taker_volume`
- `get_cvd_history`, `get_volume_footprint`
- `get_rsi_list`, `get_indicator_ma`, `get_indicator_boll`

**Index Data:**
- `get_ahr999_index`, `get_rainbow_chart`, `get_fear_greed_index`
- `get_bubble_index`, `get_puell_multiple`, `get_btc_vs_m2`
- `get_pi_cycle_indicator`, `get_bull_market_indicators`

**ETF & Exchange:**
- `get_btc_etf_netflow`, `get_exchange_balance`, `get_exchange_balance_chart`

**Spot & Options:**
- `get_spot_coins_markets`, `get_spot_price_history`, `get_options_oi_history`

## Setup

### 1. Get API Key

Get your Coinglass API key from [coinglass.com/pricing](https://www.coinglass.com/pricing)

Hobbyist tier supports: 70+ endpoints, 30 req/min, ≤1 min updates

### 2. Configure Environment

```bash
cp env.example .env
# Edit .env and add your API key
```

### 3. Install & Run

```bash
pnpm install
pnpm dev        # Development mode
pnpm build      # Build for production
pnpm start      # Production mode
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP protocol endpoint |
| `/mcp` | GET | SSE streaming endpoint |
| `/mcp` | DELETE | Session termination |
| `/health` | GET | Health check + tool list |

## Context Protocol

This server is secured with Context Protocol JWT verification. All MCP requests require valid Context7 authentication.

## Example Usage

### Intelligence Tools

```typescript
// Calculate squeeze probability for ETH
await callTool("calculate_squeeze_probability", { symbol: "ETH" });

// Get market sentiment analysis
await callTool("analyze_market_sentiment", {});

// Find funding arbitrage opportunities > 30% APR
await callTool("find_funding_arbitrage", { minApr: 30, limit: 10 });

// Get BTC valuation score
await callTool("get_btc_valuation_score", {});

// Detect liquidation cascade risk
await callTool("detect_liquidation_risk", { symbol: "BTC" });
```

### Raw Data Tools

```typescript
// Get current funding rates across exchanges
await callTool("get_funding_rates", { symbol: "BTC" });

// Get historical open interest
await callTool("get_oi_history", { 
  symbol: "BTC", 
  interval: "1h", 
  limit: 100 
});

// Get RSI values for all coins
await callTool("get_rsi_list", {});

// Get Fear & Greed Index history
await callTool("get_fear_greed_index", {});
```

## Rate Limits

Hobbyist tier: 30 requests/minute

The server respects Coinglass rate limits. For high-frequency usage, consider upgrading your API plan.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `COINGLASS_API_KEY` | ✅ | - | Your Coinglass API key |
| `PORT` | ❌ | 4004 | Server port |

## License

MIT

