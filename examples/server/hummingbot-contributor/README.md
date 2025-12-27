# Hummingbot Market Intelligence MCP Server

A **public market data** MCP server powered by the Hummingbot API. Provides real-time market intelligence across 40+ centralized and decentralized exchanges.

## Scope

✅ **Public Market Data Only**
- Price data, order books, candles
- Liquidity analysis, trade impact estimation
- Funding rates for perpetuals
- DEX swap quotes and pool info

❌ **Excluded (User-Specific Data)**
- Portfolio balances
- Trading positions/orders
- Account management
- Bot orchestration
- Backtesting (too slow for serverless)

## Tools Overview

### 🧠 Intelligence Tools (5)

| Tool | Description |
|------|-------------|
| `analyze_trade_impact` | Calculate exact VWAP and price impact for a trade size |
| `analyze_market_depth` | Deep liquidity analysis at multiple trade sizes with grading |
| `analyze_funding_sentiment` | Funding rate analysis with sentiment interpretation |
| `get_dex_swap_quote` | DEX swap quotes via Jupiter (Solana) or 0x (EVM) |
| `get_clmm_pool_info` | CLMM pool details from Meteora/Raydium |

### 📊 Raw Data Tools (6)

| Tool | Description |
|------|-------------|
| `get_prices` | Batch price lookup for multiple pairs |
| `get_market_candles` | Real-time OHLCV candlestick data |
| `get_historical_candles` | Historical OHLCV for a time range |
| `get_order_book` | Raw order book snapshot |
| `get_funding_rates` | Raw funding rate data |
| `get_connectors` | List all 40+ supported exchanges |

## Supported Exchanges

**CEX (Spot):** Binance, Coinbase, Kraken, KuCoin, Bybit, OKX, Gate.io, MEXC, Bitget, HTX, and more

**CEX (Perpetuals):** Binance Perpetual, Bybit Perpetual, Hyperliquid, OKX Perpetual, dYdX v4, Gate.io Perpetual, KuCoin Perpetual

**DEX:** Jupiter (Solana), 0x (EVM chains), Raydium, Meteora, Vertex, Injective

## Setup

### 1. Environment Variables

```bash
cp env.example .env
```

Edit `.env`:
```bash
# Hummingbot API connection
HUMMINGBOT_API_URL=http://localhost:8000
HB_USERNAME=admin
HB_PASSWORD=admin

# Server port
PORT=4009
```

### 2. Install & Run

```bash
pnpm install
npx tsx server.ts
```

## Deployment (on Hummingbot Server)

This MCP runs on the **same server** as the Hummingbot API (93.127.213.72).

### Deploy from local machine:
```bash
./deploy-hummingbot.sh
```

### On the server:
```bash
cd ~/hummingbot-mcp
./setup-hummingbot-server.sh      # Start with PM2
sudo ./setup-hummingbot-caddy-https.sh  # Enable HTTPS
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check with tool list |
| `POST /mcp` | MCP protocol endpoint |

## Example Usage

### Analyze Trade Impact
```json
{
  "tool": "analyze_trade_impact",
  "arguments": {
    "connector_name": "binance",
    "trading_pair": "BTC-USDT",
    "side": "BUY",
    "amount": 1.0
  }
}
```

Returns VWAP, price impact %, total quote volume needed.

### Get DEX Swap Quote
```json
{
  "tool": "get_dex_swap_quote",
  "arguments": {
    "connector": "jupiter",
    "network": "solana-mainnet-beta",
    "trading_pair": "SOL-USDC",
    "side": "BUY",
    "amount": 100
  }
}
```

### Analyze Funding Sentiment
```json
{
  "tool": "analyze_funding_sentiment",
  "arguments": {
    "connector_name": "hyperliquid_perpetual",
    "trading_pair": "BTC-USD"
  }
}
```

Returns funding rate, annualized rate, sentiment (Bullish/Bearish/Neutral), and explanation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Server (93.127.213.72)                   │
│  ┌─────────────────────┐    ┌─────────────────────────────┐ │
│  │  Hummingbot API     │    │  Market Intel MCP Server    │ │
│  │  (localhost:8000)   │◄───│  (localhost:4009)           │ │
│  │                     │    │                             │ │
│  │  • Market Data      │    │  • Intelligence Layer       │ │
│  │  • Order Books      │    │  • Context Auth             │ │
│  │  • Gateway (DEX)    │    │  • MCP Protocol             │ │
│  └─────────────────────┘    └─────────────────────────────┘ │
│                                        │                    │
│                                        ▼                    │
│                              ┌─────────────────────┐        │
│                              │  Caddy (HTTPS)      │        │
│                              │  Port 443           │        │
│                              └─────────────────────┘        │
└─────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
                        https://mcp-hummingbot.ctxprotocol.com/mcp
```

## License

MIT
