# Coinglass MCP Server

Hobby-tier-optimized Coinglass MCP server with an intelligence layer and a raw endpoint layer.

## Active Tooling

The current server exposes **27 active tools**:

- **7 intelligence tools** (composite analysis)
- **20 raw tools** (direct endpoint access)

### Intelligence tools

- `analyze_market_sentiment`
- `get_btc_valuation_score`
- `get_market_overview`
- `scan_oi_divergence`
- `get_oi_batch`
- `analyze_hobby_market_regime`
- `analyze_exchange_balance_pressure`

### Raw tools by domain

- **Futures core:** `get_supported_coins`, `get_supported_exchanges`, `get_exchange_pairs`, `get_futures_pairs_markets`, `get_funding_rates`, `get_oi_by_exchange`
- **Futures liquidation:** `get_futures_liquidation_exchanges`, `get_futures_liquidation_coins`
- **Indices:** `get_ahr999_index`, `get_rainbow_chart`, `get_fear_greed_index`, `get_stock_flow_index`, `get_bubble_index`, `get_puell_multiple`, `get_bull_market_indicators`
- **ETF & exchange:** `get_btc_etf_netflow`, `get_btc_etf_list`, `get_exchange_balance`, `get_exchange_balance_chart`
- **Spot:** `get_spot_supported_coins`

Premium endpoints are intentionally not exposed on the Hobby-key marketplace build (kept in code, disabled by default) to avoid planners calling tools that return `Upgrade plan`:

- `get_rsi_list`, `get_indicator_ma`, `get_indicator_boll`
- `get_whale_index_history`, `get_futures_liquidation_orders`
- `get_spot_price_history`

## Setup

1. Copy env file and set your API key:

```bash
cp env.example .env
```

2. Start server:

```bash
pnpm install
pnpm dev
```

## API Endpoints

- `POST /mcp` MCP protocol endpoint
- `GET /mcp` SSE transport
- `DELETE /mcp` session termination
- `GET /health` health + capability snapshot

## Auth and Testing

Context middleware auth is on by default.

- `CONTEXT_AUTH_ENABLED=true` (default): auth middleware enabled
- `CONTEXT_AUTH_ENABLED=false`: disable middleware for controlled direct testing

Keep auth enabled in normal/production operation.

## Plan Guard Behavior

On each tool call, the server probes a small set of Coinglass endpoints and caches the result briefly. If the current key is blocked (for example upstream returns `Upgrade plan`), tools return a structured `PLAN_UPGRADE_REQUIRED` response instead of synthetic fallback data.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `COINGLASS_API_KEY` | - | Coinglass API key (required) |
| `COINGLASS_PLAN` | `hobbyist` | Plan guard (`hobbyist` enforces allowlist) |
| `COINGLASS_RATE_LIMIT` | `60` | Upstream requests per minute |
| `PORT` | `4005` | Server port |
| `CONTEXT_AUTH_ENABLED` | `true` | Toggle Context auth middleware |

