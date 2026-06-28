/**
 * Financial Modeling Prep (FMP) MCP Server v1.0
 *
 * Read-only equities and market intelligence over the official FMP "stable" REST API
 * (https://financialmodelingprep.com/stable). Covers symbol discovery, quotes,
 * company profiles, financial statements, ratios/key-metrics, analyst consensus,
 * historical prices, technical indicators, market movers, screening, and news.
 *
 * Auth model: a single contributor-hosted FMP API key (FMP_API_KEY) is appended as
 * the `apikey` query parameter on every upstream request. There is no per-user context
 * injection, so every tool advertises an empty `_meta.contextRequirements`.
 */
import "dotenv/config";
