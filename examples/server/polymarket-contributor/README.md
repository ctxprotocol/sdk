# Polymarket Intelligence MCP Server

A "giga-brained" MCP server for Polymarket prediction market analysis. Provides whale cost analysis, market efficiency checks, smart money tracking, and arbitrage detection.

> 🔒 **Security**: This server is secured with Context Protocol Request Signing. Requests must come from the Context Platform or a client with a valid signing key.

> **📖 Building portfolio analysis tools?** See the [Context Injection Guide](../../../docs/context-injection.md) to learn how user portfolio data is automatically injected into your tools.

## Context Requirements

This server includes tools that require user portfolio data. These tools declare their requirements using `_meta.contextRequirements` (part of the MCP spec for arbitrary tool metadata):

### Tools Requiring Portfolio Context

| Tool | Context Required | Description |
|------|-----------------|-------------|
| `analyze_my_positions` | `["polymarket"]` | Analyzes user's prediction market positions with P&L and exit liquidity |

### Tools NOT Requiring Context (Public Data)

All other tools use public Polymarket API data, including:
- Query-first discovery/comparison tools such as `search_and_get_outcomes`, `compare_event_outcome_quotes`, and `search_markets`
- Raw primitives such as `get_events`, `get_event_by_slug`, `get_event_outcomes`, `get_orderbook`, `get_prices`, and `get_price_history`
- Higher-level analytics such as `analyze_market_liquidity`, `check_market_efficiency`, `analyze_whale_flow`, `find_correlated_markets`, `find_arbitrage_opportunities`, and `discover_trending_markets`

### How Context Requirements Work

```typescript
// Tools that need portfolio data declare requirements in _meta:
{
  name: "analyze_my_positions",
  
  // ✅ _meta is preserved by MCP SDK (part of MCP spec)
  _meta: {
    contextRequirements: ["polymarket"],  // ← Platform reads this
    rateLimit: {
      maxRequestsPerMinute: 60,
      cooldownMs: 1500,
      maxConcurrency: 1,
      supportsBulk: false,
      recommendedBatchTools: ["discover_trending_markets"],
      notes: "Heavy analysis tool: run alone to avoid timeout/rate-limit failures."
    }
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

**Why `_meta`?**
- `_meta` is part of the MCP specification for arbitrary tool metadata
- It is preserved through MCP transport (unlike custom top-level fields)
- The Context platform reads `_meta.contextRequirements` to determine what user data to inject
- The Context platform reads `_meta.rateLimit` to pace planner/runtime tool calls

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

### Tier 1: Query-First Intelligence Tools (High Value)

| Tool | Question Answered |
|------|------------------|
| `search_and_get_outcomes` | "Resolve one event and show all current outcomes/prices in one call" |
| `compare_event_outcome_quotes` | "Compare Spain, Brazil, and France in one market with live spreads" |
| `search_markets` | "Which live Polymarket contracts exist about this topic?" |
| `analyze_market_liquidity` | "Can I exit this position? What's the whale cost?" |
| `analyze_event_outcome_liquidity` | "For a multi-outcome event, which outcomes are actually liquid enough to exit?" |
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
| `get_event_outcomes` | Get all outcomes once you already know the event slug |
| `get_orderbook` | Raw L2 orderbook data |
| `get_prices` | Current token prices |
| `get_price_history` | Historical price data |
| `get_user_activity` | Wallet activity feed (trades/redeems/etc.) |
| `get_user_total_value` | Total marked-to-market user value |
| `get_market_open_interest` | Open interest by conditionId |
| `get_event_live_volume` | Live event-level volume breakdown |

These raw primitives remain available to broad Query flows too, but planners usually do best when a query-first resolver has already identified the right slug, conditionId, or tokenId.

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

- **MCP**: `http://localhost:4003/mcp` - MCP Streamable HTTP endpoint
- **Health**: `http://localhost:4003/health` - Status check

### Temporary Unauthenticated Debug Mode

For temporary endpoint testing only, you can bypass MCP auth middleware with:

```bash
POLYMARKET_ALLOW_UNAUTH_MCP=true
```

This is intended for short-lived debugging on isolated environments. Keep it `false` in production.

## Tool Examples

### Search And Get Outcomes In One Call

```json
{
  "name": "search_and_get_outcomes",
  "arguments": {
    "query": "US forces enter Iran by"
  }
}
```

**Behavior notes:**
- Best first choice when the user wants one resolved event plus all current outcomes/prices
- Uses the helper-backed website search flow before fetching the winning event
- Better Query entry point than chaining `search_markets` -> `get_event_outcomes`

### Compare Specific Outcomes Inside One Event

```json
{
  "name": "compare_event_outcome_quotes",
  "arguments": {
    "query": "Compare Spain, Brazil, and France in the 2026 FIFA World Cup winner market."
  }
}
```

**Behavior notes:**
- Best when the user names two or more outcomes in the same event
- Returns matched names, current implied odds, and live bid/ask spreads
- Avoids brittle multi-step token lookup plus spread fetching

### Search Candidate Market Families

```json
{
  "name": "search_markets",
  "arguments": {
    "query": "boots on the ground iran polymarket",
    "status": "live",
    "limit": 10
  }
}
```

**Behavior notes:**
- Use this to map related contracts and gather slugs/URLs/conditionIds
- Not the best first tool when the user clearly wants one event plus all outcomes
- Prefer `compare_event_outcome_quotes` for same-event named outcome comparisons

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

### Analyze Top Holders (Natural-Language Query)

```json
{
  "name": "analyze_top_holders",
  "arguments": {
    "marketQuery": "Bitcoin above $100k"
  }
}
```

**Behavior notes:**
- `marketQuery` resolution searches both **active** and **resolved** markets
- Matching is deterministic and price-target aware (e.g., `$100k` will not auto-match `$150k`)
- If no exact market exists, the tool returns a clear unresolved error instead of silently drifting to a different target

### Analyze Multi-Outcome Event Liquidity

```json
{
  "name": "analyze_event_outcome_liquidity",
  "arguments": {
    "eventQuery": "2026 FIFA World Cup winner",
    "limit": 4
  }
}
```

**Behavior notes:**
- Designed for tournaments, elections, awards, and other categorical markets
- If no specific outcomes are provided, it analyzes the top outcomes by volume instead of arbitrarily picking one "YES side"
- Returns per-outcome spreads, depth, and $1k/$5k/$10k exit-slippage estimates

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

The server now includes upstream pacing + retry hardening for Polymarket APIs:

- Per-upstream cooldowns derived from requests-per-minute budgets
- Retry with exponential backoff for transient 408/429/502/503/504 failures
- `Retry-After` header support when upstream provides it
- Paced deep-fetch batches for holder analysis instead of single large bursts

Default budgets (override via env vars):

- `POLYMARKET_GAMMA_RATE_LIMIT=180`
- `POLYMARKET_CLOB_RATE_LIMIT=240`
- `POLYMARKET_DATA_RATE_LIMIT=120`
- `POLYMARKET_RETRY_ATTEMPTS=3`
- `POLYMARKET_RETRY_BASE_BACKOFF_MS=450`

Search-helper defaults (contributor BYOK via OpenRouter unless overridden):

- `POLYMARKET_SEARCH_JUDGE_MODEL=google/gemini-3.1-flash-lite-preview`
- `POLYMARKET_SEARCH_JUDGE_TIMEOUT_MS=4500`
- `POLYMARKET_SEARCH_JUDGE_MAX_SHORTLIST=6`
- `POLYMARKET_SEARCH_JUDGE_BUDGET_USD=0.010`

In addition, tools publish `_meta.rateLimit` hints in `listTools()` so agent planners can choose safer call patterns (batch-first, sequential heavy calls).

## License

MIT

