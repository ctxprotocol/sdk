# Binance Alpha Detection MCP Server

> **Beyond Dashboards: True Alpha Detection**

A "giga-brained" MCP server for Binance that provides **actionable trading intelligence**, not just data visualization.

> **📖 Want to build portfolio analysis tools?** See the [Context Injection Guide](../../../docs/context-injection.md) for the architecture.

## 🎯 Philosophy

Traditional trading tools show you *what happened*. This MCP tells you *what's about to happen*.

Instead of dashboards showing raw metrics, this server processes thousands of data points to surface:
- **CVD Divergences** before price reversals
- **Smart Money** vs Retail flow patterns
- **Squeeze Setups** before explosive moves
- **Statistical Anomalies** before breakouts
- **Funding Arbitrage** opportunities

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    BINANCE ALPHA MCP                            │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │           TIER 1: INTELLIGENCE LAYER                      │  │
│  │           (The Value - Alpha Detection)                   │  │
│  │                                                           │  │
│  │  • scan_cvd_divergences    - Price vs Volume divergences  │  │
│  │  • analyze_smart_money_flow - Whale vs Retail detection   │  │
│  │  • calculate_squeeze_probability - Squeeze setups         │  │
│  │  • scan_volatility_anomalies - Z-Score breakout detection │  │
│  │  • find_funding_arbitrage  - Yield opportunities          │  │
│  │                                                           │  │
│  │  These tools do the heavy math internally and return      │  │
│  │  only the actionable insights.                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │           TIER 2: RAW DATA LAYER                          │  │
│  │           (Fallback for Custom Analysis)                  │  │
│  │                                                           │  │
│  │  • get_historical_klines   - OHLCV candlestick data       │  │
│  │  • get_orderbook_depth     - Order book / walls           │  │
│  │  • get_recent_trades       - Trade tape                   │  │
│  │  • get_ticker_24hr         - 24hr statistics              │  │
│  │  • get_exchange_info       - Symbols / limits             │  │
│  │                                                           │  │
│  │  Raw data for when users need custom analysis             │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    BINANCE API                            │  │
│  │            Spot API + Futures API                         │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 🧠 Tier 1: Intelligence Tools

### 1. `scan_cvd_divergences`
**Question:** "Which assets show a divergence between Price and Cumulative Volume Delta?"

**Logic:**
- Fetches 1000+ recent trades per asset
- Calculates Cumulative Volume Delta (Buy Vol - Sell Vol)
- Detects when Price makes Higher Highs but CVD makes Lower Highs (bearish reversal signal)
- Or Price makes Lower Lows but CVD makes Higher Lows (bullish reversal signal)

**Why it's valuable:** LLMs cannot process thousands of trades to calculate CVD. This tool does the heavy lifting.

### 2. `analyze_smart_money_flow`
**Question:** "What is the net flow of Smart Money (>$100k) vs Retail (<$1k)?"

**Logic:**
- Segments all recent trades by size
- Smart Money: trades > $100,000
- Retail: trades < $1,000
- Identifies market phase: Accumulation, Distribution, FOMO, Panic

**Why it's valuable:** Answers "Who is on the other side of the trade?"

### 3. `calculate_squeeze_probability`
**Question:** "What is the probability of a Short/Long squeeze on [COIN]?"

**Logic:**
- Combines Open Interest build-up
- Extreme Funding Rates (>90th percentile)
- Price Stagnation (low volatility compression)
- Outputs 0-100 probability score

**Why it's valuable:** Identifies coins PRIMED for explosive moves before they happen.

### 4. `scan_volatility_anomalies`
**Question:** "Which assets are experiencing 2+ sigma volume or volatility events?"

**Logic:**
- Calculates 30-day mean and standard deviation
- Computes Z-Score of current volume and volatility
- Flags statistical outliers (Z > 2)

**Why it's valuable:** Detects breakouts BEFORE they become obvious on charts.

### 5. `find_funding_arbitrage`
**Question:** "Where are the highest annualized funding rate opportunities?"

**Logic:**
- Scans all perpetual contracts
- Calculates annualized yield from funding
- Factors in volume for execution feasibility
- Returns sorted opportunities

**Why it's valuable:** Pure yield generation strategy.

## 📊 Tier 2: Raw Data Tools

| Tool | Description |
|------|-------------|
| `get_historical_klines` | OHLCV candles for charting |
| `get_orderbook_depth` | Order book to see walls |
| `get_recent_trades` | Trade tape |
| `get_ticker_24hr` | 24hr price/volume stats |
| `get_exchange_info` | Trading rules and limits |

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Or build and run
pnpm build
pnpm start
```

## 🔧 Configuration

Copy `env.example` to `.env`:

```bash
cp env.example .env
```

Environment variables:
- `PORT` - Server port (default: 4003)

Note: Most endpoints use public Binance data and don't require API keys.

## 📡 Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /sse` | SSE connection for MCP |
| `POST /messages` | MCP message handler |
| `GET /health` | Health check |

## 🧪 Example Usage

### Scan for CVD Divergences
```json
{
  "tool": "scan_cvd_divergences",
  "arguments": {
    "timeframe": "4h",
    "lookbackPeriods": 20
  }
}
```

### Analyze Smart Money Flow
```json
{
  "tool": "analyze_smart_money_flow",
  "arguments": {
    "symbol": "BTCUSDT",
    "smartMoneyThreshold": 100000,
    "retailThreshold": 1000
  }
}
```

### Calculate Squeeze Probability
```json
{
  "tool": "calculate_squeeze_probability",
  "arguments": {
    "symbol": "ETHUSDT"
  }
}
```

### Scan Volatility Anomalies
```json
{
  "tool": "scan_volatility_anomalies",
  "arguments": {
    "zScoreThreshold": 2.0,
    "lookbackDays": 30
  }
}
```

### Find Funding Arbitrage
```json
{
  "tool": "find_funding_arbitrage",
  "arguments": {
    "minAnnualizedYield": 10,
    "topN": 10
  }
}
```

## 📜 License

MIT


