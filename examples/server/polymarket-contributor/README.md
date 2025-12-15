# Polymarket Intelligence MCP Server

A "giga-brained" MCP server for Polymarket prediction market analysis. Provides whale cost analysis, market efficiency checks, smart money tracking, and arbitrage detection.

> **📖 Building portfolio analysis tools?** See the [Context Injection Guide](../../../docs/context-injection.md) to learn how user portfolio data is automatically injected into your tools.

## Context Requirements

This server includes tools that require user portfolio data. These tools declare their requirements using `_meta.contextRequirements` (part of the MCP spec for arbitrary tool metadata):

### Tools Requiring Portfolio Context

| Tool | Context Required | Description |
|------|-----------------|-------------|
| `analyze_my_positions` | `["polymarket"]` | Analyzes user's prediction market positions with P&L and exit liquidity |

### Tools NOT Requiring Context (Public Data)

All other tools use public Polymarket API data:
- `get_events`, `get_event_by_slug`, `search_markets`
- `get_orderbook`, `get_prices`, `get_price_history`
- `analyze_market_liquidity`, `check_market_efficiency`
- `analyze_whale_flow`, `find_correlated_markets`
- `find_arbitrage_opportunities`, `discover_trending_markets`

### How Context Requirements Work

```typescript
// Tools that need portfolio data declare requirements in _meta:
{
  name: "analyze_my_positions",
  
  // ✅ _meta is preserved by MCP SDK (part of MCP spec)
  _meta: {
    contextRequirements: ["polymarket"]  // ← Platform reads this
  },
  
  inputSchema: {
    type: "object",
    properties: {
      portfolio: { type: "object" }  // ← Platform injects PolymarketContext here
    },
    required: ["portfolio"]
  }
}
```

**Why `_meta.contextRequirements`?**
- `_meta` is part of the MCP specification for arbitrary tool metadata
- It is preserved through MCP transport (unlike custom top-level fields)
- The Context platform reads `_meta.contextRequirements` to determine what user data to inject

### What Gets Injected

When the Context platform detects `_meta.contextRequirements: ["polymarket"]`, it injects:

```typescript
interface PolymarketContext {
  walletAddress: string;
  positions: PolymarketPosition[];
  openOrders: PolymarketOrder[];
  totalValue?: number;
  fetchedAt: string;
}
```

---

## Features

### Tier 1: Intelligence Tools (High Value)

| Tool | Question Answered |
|------|------------------|
| `analyze_market_liquidity` | "Can I exit this position? What's the whale cost?" |
| `check_market_efficiency` | "Is this market efficiently priced? What's the vig?" |
| `analyze_whale_flow` | "What's smart money doing? Any retail/whale divergence?" |
| `find_correlated_markets` | "What markets can I use to hedge this position?" |
| `check_market_rules` | "What gotchas could cause unexpected resolution?" |
| `find_arbitrage_opportunities` | "Are there any pricing inefficiencies to exploit?" |
| `discover_trending_markets` | "What markets are gaining momentum?" |

### Tier 2: Raw Data Tools

| Tool | Purpose |
|------|---------|
| `get_events` | List markets with filters |
| `get_event_by_slug` | Get specific event details |
| `get_orderbook` | Raw L2 orderbook data |
| `get_prices` | Current token prices |
| `get_price_history` | Historical price data |
| `search_markets` | Search by keyword/category |

## Quick Start

```bash
# Install dependencies
pnpm install

# Copy environment template
cp env.example .env

# Start development server
pnpm dev

# Or build and run
pnpm build
pnpm start
```

## API Endpoints

- **SSE**: `http://localhost:4003/sse`
- **Health**: `http://localhost:4003/health`
- **Messages**: `http://localhost:4003/messages`

## Tool Examples

### Analyze Market Liquidity (Whale Cost)

```json
{
  "name": "analyze_market_liquidity",
  "arguments": {
    "tokenId": "71321045679252212594626385532706912750332728571942532289631379312455583992563"
  }
}
```

**Output includes:**
- Spread (absolute, percentage, bps)
- Depth within ±2% of mid price
- Whale cost simulation ($1k, $5k, $10k slippage)
- Liquidity score (excellent/good/moderate/poor/illiquid)

### Check Market Efficiency (Vig Check)

```json
{
  "name": "check_market_efficiency",
  "arguments": {
    "slug": "bitcoin-100k-2024"
  }
}
```

**Output includes:**
- Sum of outcome prices (should be ~1.0)
- Vig percentage and bps
- Vig-adjusted true probabilities
- Efficiency rating

### Analyze Whale Flow (Smart Money)

```json
{
  "name": "analyze_whale_flow",
  "arguments": {
    "conditionId": "0x123...",
    "hoursBack": 24
  }
}
```

**Output includes:**
- Flow by size bucket (Small <$50, Medium $50-500, Whale >$1000)
- Net directional flow per bucket
- Whale vs retail divergence detection

### Find Arbitrage Opportunities

```json
{
  "name": "find_arbitrage_opportunities",
  "arguments": {
    "category": "crypto",
    "limit": 50
  }
}
```

**Output includes:**
- Markets where sum of prices < 1.0 (arbitrage!)
- Markets with excessive vig (liquidity warning)
- Average vig across scanned markets

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    POLYMARKET INTELLIGENCE MCP                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    TIER 1: INTELLIGENCE LAYER                         │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ analyze_market  │  │ check_market    │  │ analyze_whale   │       │  │
│  │  │ _liquidity      │  │ _efficiency     │  │ _flow           │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │ find_correlated │  │ check_market    │  │ find_arbitrage  │       │  │
│  │  │ _markets        │  │ _rules          │  │ _opportunities  │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    TIER 2: RAW DATA LAYER                             │  │
│  │                                                                       │  │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐             │  │
│  │  │get_events │ │get_order  │ │get_prices │ │get_price  │             │  │
│  │  │           │ │book       │ │           │ │_history   │             │  │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    POLYMARKET APIs                                    │  │
│  │         Gamma API (Markets)     |     CLOB API (Trading)              │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Rate Limits

The server respects Polymarket's rate limits:
- CLOB API: ~50 req/10s for most endpoints
- Gamma API: ~100 req/10s for market data

## License

MIT

