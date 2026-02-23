# Normalized Data Provider MCP Server

This example demonstrates an Execute-mode-ready **data broker** pattern: ingest external market data on a background loop, cache it locally, and serve normalized MCP responses from that cache.

## What this demonstrates

- Background ingestion from Binance + Hyperliquid
- In-memory cache (`Map`) that simulates a database-backed serving layer
- Instant, cache-only MCP method execution (no upstream calls at request time)
- Execute-mode metadata (`_meta`) with per-method pricing and rate limits
- One unpriced method (`get_supported_pairs`) via `UNPRICED_EXECUTE_METHODS`

## Architecture

1. **Ingest**: every ~10 seconds, fetch Binance and Hyperliquid market data.
2. **Normalize**: map both upstream payloads into one shape (`NormalizedPrice`).
3. **Cache**: rebuild local `Map<string, NormalizedPrice[]>`.
4. **Serve**: MCP methods (`get_prices`, `get_supported_pairs`, `get_price_spread`) read only from cache.

At serving time, this avoids upstream rate-limit pressure entirely because all reads come from local memory. In production, replace the in-memory map with Postgres/Redis/SQLite using the same pattern.

## Methods

- `get_prices`: fetch normalized prices, with optional `symbols` and `exchanges` filters.
- `get_supported_pairs`: list currently tracked pairs and available exchanges.
- `get_price_spread`: compare spread by exchange and return best bid/ask venues.

## `_meta` configuration

Each method is annotated for cross-mode orchestration:

- `surface: "both"`
- `queryEligible: true`
- `latencyClass: "instant"`
- `rateLimit`: high local-cache throughput with no upstream request-time dependency

Execute pricing is applied by default via:

- `DEFAULT_EXECUTE_PRICE_USD = "0.001"`
- `UNPRICED_EXECUTE_METHODS = new Set(["get_supported_pairs"])`

`get_supported_pairs` intentionally omits `pricing.executeUsd` to demonstrate unpriced execute-visible methods.

## Run

```bash
pnpm install
pnpm start
```

Default endpoints:

- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`
- `GET /health`

## References

- [Build Tools guide](https://docs.ctxprotocol.com/guides/build-tools)
- [Tool Metadata reference](https://docs.ctxprotocol.com/guides/tool-metadata)
