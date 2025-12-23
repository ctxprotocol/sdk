/**
 * The Odds API MCP Server v1.0.0
 *
 * A "giga-brained" MCP server for sports betting odds analysis.
 * Aggregates odds from 50+ bookmakers, detects arbitrage opportunities,
 * analyzes line movements, and provides historical odds data.
 *
 * API Documentation: https://the-odds-api.com/liveapi/guides/v4/
 *
 * Context Protocol compliant with:
 * - outputSchema (typed response definitions)
 * - structuredContent (machine-readable responses)
 *
 * INTEGRATION NOTE: This server can be used in conjunction with
 * Polymarket MCP to compare sportsbook odds with prediction market prices.
 */
import "dotenv/config";
