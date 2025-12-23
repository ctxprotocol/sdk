# Kalshi Prediction Markets MCP Server

A "giga-brained" MCP server for Kalshi prediction market analysis. Provides market discovery, sentiment analysis, liquidity analysis, arbitrage detection, and trading opportunity identification.

## Features

### Tier 1: Intelligence Tools (7 tools)

| Tool | Description |
|------|-------------|
| `discover_trending_markets` | Find hottest markets by volume, liquidity, or activity |
| `analyze_market_liquidity` | Orderbook depth analysis + slippage simulation |
| `check_market_efficiency` | Vig/overround calculation + true probability adjustment |
| `find_arbitrage_opportunities` | Scan for YES+NO < 100¢ opportunities |
| `find_trading_opportunities` | Strategy-based opportunity finder |
| `get_markets_by_probability` | Filter markets by win probability |
| `analyze_market_sentiment` | Price trend + volume analysis |

### Tier 2: Raw Data Tools (7 tools)

| Tool | Description |
|------|-------------|
| `get_events` | List events with filters |
| `get_event` | Get event details with nested markets |
| `get_market` | Get single market details |
| `search_markets` | Search markets by keyword |
| `get_market_orderbook` | Level 2 orderbook data |
| `get_market_trades` | Recent trade history |
| `get_market_candlesticks` | Historical OHLC data |

### Discovery Layer Tools (4 tools)

| Tool | Description |
|------|-------------|
| `get_all_categories` | List all categories and tags |
| `get_all_series` | List all series (market templates) |
| `browse_category` | Browse markets by category |
| `browse_series` | Browse markets by series |

## Cross-Platform Composability

This MCP is designed to work alongside other prediction market and data MCPs:

### With Polymarket MCP
```
1. Kalshi: browse_category({ category: "Politics" }) → "Trump wins" at 52¢
2. Polymarket: search_markets({ query: "Trump" }) → same event at 48¢
3. Arbitrage: 4% spread = potential profit
```

### With Odds API MCP
```
1. Kalshi: browse_category({ category: "Sports" }) → "Lakers NBA Finals" at 25¢
2. Odds API: get_outrights({ sport: "basketball_nba_championship_winner" }) → Lakers +450
3. Compare: Kalshi 25% vs Sportsbooks 18% implied
```

## Data Hierarchy

```
Categories (Politics, Economics, Sports, etc.)
    └── Tags (specific topics within categories)
        └── Series (recurring event templates)
            └── Events (specific occurrences)
                └── Markets (tradeable outcomes)
                    └── Orderbook, Trades, Candlesticks
```

## Installation

```bash
cd examples/server/kalshi-contributor
npm install
```

## Configuration

Copy `env.example` to `.env` and configure:

```bash
# Port (default: 4007)
PORT=4007

# Kalshi API (public endpoints don't require auth)
KALSHI_API_BASE_URL=https://api.elections.kalshi.com
```

For authenticated endpoints (portfolio management), you'll need:
- `KALSHI_API_KEY_ID`
- `KALSHI_PRIVATE_KEY_PATH`

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

## API Rate Limits

Kalshi has tiered rate limits:

| Tier | Read/s | Write/s |
|------|--------|---------|
| Basic | 20 | 10 |
| Advanced | 30 | 30 |
| Premier | 100 | 100 |
| Prime | 400 | 400 |

This MCP primarily uses read endpoints and caches results to stay within limits.

## Context Protocol Compliance

✅ All tools have `outputSchema`  
✅ All responses include `structuredContent`  
✅ Security middleware (`createContextMiddleware`) for paid tools  
✅ Discovery layer for cross-platform composability

## Example Usage

### Find Trending Markets
```json
{
  "tool": "discover_trending_markets",
  "arguments": {
    "category": "Politics",
    "sortBy": "volume_24h",
    "limit": 10
  }
}
```

### Analyze Liquidity
```json
{
  "tool": "analyze_market_liquidity",
  "arguments": {
    "ticker": "PRES-2024-DT"
  }
}
```

### Find Arbitrage
```json
{
  "tool": "find_arbitrage_opportunities",
  "arguments": {
    "minEdge": 2,
    "limit": 50
  }
}
```

### Browse by Category
```json
{
  "tool": "browse_category",
  "arguments": {
    "category": "Sports",
    "sortBy": "volume_24h"
  }
}
```

## License

MIT

