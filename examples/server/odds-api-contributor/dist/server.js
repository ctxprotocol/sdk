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
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";
// ============================================================================
// API CONFIGURATION
// ============================================================================
const ODDS_API_BASE = "https://api.the-odds-api.com/v4";
const API_KEY = process.env.ODDS_API_KEY || "";
// Default regions to query (affects quota cost)
const DEFAULT_REGIONS = ["us", "us2", "eu", "uk", "au"];
const DEFAULT_MARKETS = ["h2h", "spreads", "totals"];
// Popular sports for discovery
const POPULAR_SPORTS = [
    "americanfootball_nfl",
    "americanfootball_ncaaf",
    "basketball_nba",
    "basketball_ncaab",
    "baseball_mlb",
    "icehockey_nhl",
    "soccer_epl",
    "soccer_uefa_champs_league",
    "mma_mixed_martial_arts",
    "tennis_atp_us_open",
];
// ============================================================================
// TOOL DEFINITIONS
// ============================================================================
const TOOLS = [
    // ==================== TIER 1: INTELLIGENCE TOOLS ====================
    {
        name: "find_arbitrage_opportunities",
        description: "🧠 INTELLIGENCE: Scan multiple bookmakers to find arbitrage opportunities where you can guarantee profit by betting both sides. Returns opportunities sorted by profit margin. Combines odds from 50+ bookmakers.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl, basketball_nba). Use 'upcoming' for next 8 events across all sports.",
                    default: "upcoming",
                },
                minProfitPercent: {
                    type: "number",
                    description: "Minimum profit percentage to report (default: 0.5)",
                    default: 0.5,
                },
                maxResults: {
                    type: "number",
                    description: "Maximum number of opportunities to return (default: 10)",
                    default: 10,
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                opportunities: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            event: { type: "string" },
                            eventId: { type: "string" },
                            sport: { type: "string" },
                            commenceTime: { type: "string" },
                            market: { type: "string" },
                            profitPercent: { type: "number" },
                            totalImpliedOdds: { type: "number" },
                            legs: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        outcome: { type: "string" },
                                        bookmaker: { type: "string" },
                                        price: { type: "number" },
                                        impliedProbability: { type: "number" },
                                        stakePercent: { type: "number" },
                                    },
                                },
                            },
                        },
                    },
                },
                totalScanned: { type: "number" },
                eventsAnalyzed: { type: "number" },
                recommendation: { type: "string" },
                dataFreshness: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["opportunities", "totalScanned", "fetchedAt"],
        },
    },
    {
        name: "find_best_odds",
        description: "🧠 INTELLIGENCE: Find the best available odds across all bookmakers for a specific event or sport. Shows which bookmaker offers the best price for each outcome.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl, basketball_nba)",
                },
                eventId: {
                    type: "string",
                    description: "Specific event ID (optional - if provided, shows detailed odds for that event)",
                },
                market: {
                    type: "string",
                    description: "Market type: h2h (moneyline), spreads, totals (default: h2h)",
                    default: "h2h",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            eventId: { type: "string" },
                            event: { type: "string" },
                            commenceTime: { type: "string" },
                            market: { type: "string" },
                            outcomes: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        name: { type: "string" },
                                        bestOdds: { type: "number" },
                                        bestBookmaker: { type: "string" },
                                        worstOdds: { type: "number" },
                                        worstBookmaker: { type: "string" },
                                        edgePercent: { type: "number" },
                                        allBookmakers: { type: "array", items: { type: "object" } },
                                    },
                                },
                            },
                        },
                    },
                },
                summary: {
                    type: "object",
                    properties: {
                        totalEvents: { type: "number" },
                        bestOverallBookmaker: { type: "string" },
                        averageEdge: { type: "number" },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["events", "fetchedAt"],
        },
    },
    {
        name: "analyze_line_movement",
        description: "🧠 INTELLIGENCE: Analyze how odds have moved over time using historical data. Detects sharp money by comparing opening lines to current lines. Useful for identifying where professional bettors are placing their money.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl)",
                },
                eventId: {
                    type: "string",
                    description: "Specific event ID to analyze",
                },
                hoursBack: {
                    type: "number",
                    description: "Hours of history to analyze (default: 24, max: 168)",
                    default: 24,
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            eventId: { type: "string" },
                            event: { type: "string" },
                            commenceTime: { type: "string" },
                            lineMovement: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        outcome: { type: "string" },
                                        openingLine: { type: "number" },
                                        currentLine: { type: "number" },
                                        movement: { type: "number" },
                                        movementPercent: { type: "number" },
                                        direction: { type: "string", enum: ["steam", "reverse", "stable"] },
                                    },
                                },
                            },
                            sharpAction: {
                                type: "string",
                                enum: ["heavy_home", "moderate_home", "neutral", "moderate_away", "heavy_away"],
                            },
                            confidence: { type: "number" },
                        },
                    },
                },
                interpretation: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["events", "fetchedAt"],
        },
    },
    {
        name: "analyze_market_efficiency",
        description: "🧠 INTELLIGENCE: Calculate market efficiency (vig/juice) and true implied probabilities across bookmakers. Find markets with lowest vig for better value. Useful for comparing to prediction market prices (e.g., Polymarket).",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl)",
                },
                eventId: {
                    type: "string",
                    description: "Specific event ID (optional)",
                },
                market: {
                    type: "string",
                    description: "Market type: h2h, spreads, totals",
                    default: "h2h",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            eventId: { type: "string" },
                            event: { type: "string" },
                            commenceTime: { type: "string" },
                            market: { type: "string" },
                            bookmakerEfficiency: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        bookmaker: { type: "string" },
                                        totalImpliedOdds: { type: "number" },
                                        vigPercent: { type: "number" },
                                        efficiency: { type: "string", enum: ["excellent", "good", "average", "poor"] },
                                    },
                                },
                            },
                            consensusProbabilities: {
                                type: "object",
                                description: "Vig-adjusted true probabilities (comparable to Polymarket prices)",
                            },
                            lowestVigBookmaker: { type: "string" },
                            averageVig: { type: "number" },
                        },
                    },
                },
                recommendation: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["events", "fetchedAt"],
        },
    },
    {
        name: "compare_historical_closing_lines",
        description: "🧠 INTELLIGENCE: Compare current odds to historical closing lines for similar events. Helps identify Closing Line Value (CLV) - a key metric for +EV betting. Uses historical data to contextualize current odds.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                team: {
                    type: "string",
                    description: "Team name to analyze historical lines for",
                },
                daysBack: {
                    type: "number",
                    description: "Days of history to analyze (default: 30)",
                    default: 30,
                },
            },
            required: ["sport", "team"],
        },
        outputSchema: {
            type: "object",
            properties: {
                team: { type: "string" },
                sport: { type: "string" },
                historicalGames: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            event: { type: "string" },
                            date: { type: "string" },
                            openingLine: { type: "number" },
                            closingLine: { type: "number" },
                            result: { type: "string" },
                            clvCapture: { type: "number" },
                        },
                    },
                },
                averageClvMovement: { type: "number" },
                consistency: { type: "number" },
                recommendation: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["team", "historicalGames", "fetchedAt"],
        },
    },
    {
        name: "discover_value_bets",
        description: "🧠 INTELLIGENCE: Find potential value bets by identifying odds that differ significantly from consensus. Combines multiple bookmakers to calculate consensus probabilities and flags outliers.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl). Use 'upcoming' for all sports.",
                    default: "upcoming",
                },
                minEdgePercent: {
                    type: "number",
                    description: "Minimum edge vs consensus to report (default: 3%)",
                    default: 3,
                },
                market: {
                    type: "string",
                    description: "Market type: h2h, spreads, totals",
                    default: "h2h",
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                valueBets: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            event: { type: "string" },
                            eventId: { type: "string" },
                            sport: { type: "string" },
                            commenceTime: { type: "string" },
                            outcome: { type: "string" },
                            bookmaker: { type: "string" },
                            odds: { type: "number" },
                            impliedProbability: { type: "number" },
                            consensusProbability: { type: "number" },
                            edgePercent: { type: "number" },
                            confidence: { type: "string", enum: ["high", "medium", "low"] },
                        },
                    },
                },
                totalEventsScanned: { type: "number" },
                recommendation: { type: "string" },
                fetchedAt: { type: "string" },
            },
            required: ["valueBets", "fetchedAt"],
        },
    },
    // ==================== TIER 2: RAW DATA TOOLS ====================
    {
        name: "get_sports",
        description: "📊 RAW DATA: Get list of all available sports with their active status. This endpoint is free (no quota cost).",
        inputSchema: {
            type: "object",
            properties: {
                all: {
                    type: "boolean",
                    description: "Include inactive sports (default: false)",
                    default: false,
                },
            },
            required: [],
        },
        outputSchema: {
            type: "object",
            properties: {
                sports: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            key: { type: "string" },
                            group: { type: "string" },
                            title: { type: "string" },
                            description: { type: "string" },
                            active: { type: "boolean" },
                            hasOutrights: { type: "boolean" },
                        },
                    },
                },
                totalActive: { type: "number" },
                totalInactive: { type: "number" },
                fetchedAt: { type: "string" },
            },
            required: ["sports", "fetchedAt"],
        },
    },
    {
        name: "get_events",
        description: "📊 RAW DATA: Get list of upcoming and live events for a sport. This endpoint is free (no quota cost). Returns event IDs needed for other endpoints.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl, basketball_nba)",
                },
                commenceTimeFrom: {
                    type: "string",
                    description: "ISO 8601 timestamp to filter events starting after (optional)",
                },
                commenceTimeTo: {
                    type: "string",
                    description: "ISO 8601 timestamp to filter events starting before (optional)",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            sportKey: { type: "string" },
                            sportTitle: { type: "string" },
                            commenceTime: { type: "string" },
                            homeTeam: { type: "string" },
                            awayTeam: { type: "string" },
                        },
                    },
                },
                totalEvents: { type: "number" },
                fetchedAt: { type: "string" },
            },
            required: ["events", "fetchedAt"],
        },
    },
    {
        name: "get_odds",
        description: "📊 RAW DATA: Get live odds for a sport from multiple bookmakers. Supports h2h, spreads, and totals markets. Quota cost depends on regions and markets requested.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., americanfootball_nfl). Use 'upcoming' for next 8 events across all sports.",
                },
                regions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Regions to include: us, us2, uk, eu, au (default: us)",
                    default: ["us"],
                },
                markets: {
                    type: "array",
                    items: { type: "string" },
                    description: "Markets: h2h, spreads, totals, outrights (default: h2h)",
                    default: ["h2h"],
                },
                oddsFormat: {
                    type: "string",
                    description: "Odds format: decimal or american (default: decimal)",
                    default: "decimal",
                },
                bookmakers: {
                    type: "array",
                    items: { type: "string" },
                    description: "Specific bookmakers to query (overrides regions)",
                },
                eventIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Filter to specific event IDs",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            sportKey: { type: "string" },
                            sportTitle: { type: "string" },
                            commenceTime: { type: "string" },
                            homeTeam: { type: "string" },
                            awayTeam: { type: "string" },
                            bookmakers: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        key: { type: "string" },
                                        title: { type: "string" },
                                        lastUpdate: { type: "string" },
                                        markets: { type: "array" },
                                    },
                                },
                            },
                        },
                    },
                },
                quotaCost: { type: "number" },
                fetchedAt: { type: "string" },
            },
            required: ["events", "fetchedAt"],
        },
    },
    {
        name: "get_scores",
        description: "📊 RAW DATA: Get live scores and recently completed game results. Scores update every ~30 seconds for live games. Can retrieve completed games from up to 3 days ago.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key (e.g., basketball_nba)",
                },
                daysFrom: {
                    type: "number",
                    description: "Days of completed games to include (1-3, optional)",
                },
                eventIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Filter to specific event IDs",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                games: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            sportKey: { type: "string" },
                            commenceTime: { type: "string" },
                            completed: { type: "boolean" },
                            homeTeam: { type: "string" },
                            awayTeam: { type: "string" },
                            homeScore: { type: "string" },
                            awayScore: { type: "string" },
                            lastUpdate: { type: "string" },
                        },
                    },
                },
                liveGames: { type: "number" },
                completedGames: { type: "number" },
                fetchedAt: { type: "string" },
            },
            required: ["games", "fetchedAt"],
        },
    },
    {
        name: "get_event_odds",
        description: "📊 RAW DATA: Get detailed odds for a specific event including player props and alternate lines. Supports any market type for single events.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                eventId: {
                    type: "string",
                    description: "Event ID from get_events",
                },
                regions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Regions to include",
                    default: ["us"],
                },
                markets: {
                    type: "array",
                    items: { type: "string" },
                    description: "Markets to include (supports any market including player props like player_pass_tds, player_points)",
                    default: ["h2h"],
                },
                oddsFormat: {
                    type: "string",
                    description: "decimal or american",
                    default: "decimal",
                },
            },
            required: ["sport", "eventId"],
        },
        outputSchema: {
            type: "object",
            properties: {
                event: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        sportKey: { type: "string" },
                        commenceTime: { type: "string" },
                        homeTeam: { type: "string" },
                        awayTeam: { type: "string" },
                        bookmakers: { type: "array" },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["event", "fetchedAt"],
        },
    },
    {
        name: "get_event_markets",
        description: "📊 RAW DATA: Get available market types for a specific event. Shows which prop bets and alternate lines are available from each bookmaker. Costs 1 quota credit.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                eventId: {
                    type: "string",
                    description: "Event ID",
                },
                regions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Regions",
                    default: ["us"],
                },
            },
            required: ["sport", "eventId"],
        },
        outputSchema: {
            type: "object",
            properties: {
                event: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        sportKey: { type: "string" },
                        commenceTime: { type: "string" },
                        homeTeam: { type: "string" },
                        awayTeam: { type: "string" },
                    },
                },
                bookmakerMarkets: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            bookmaker: { type: "string" },
                            markets: {
                                type: "array",
                                items: {
                                    type: "object",
                                    properties: {
                                        key: { type: "string" },
                                        lastUpdate: { type: "string" },
                                    },
                                },
                            },
                        },
                    },
                },
                allAvailableMarkets: { type: "array", items: { type: "string" } },
                fetchedAt: { type: "string" },
            },
            required: ["bookmakerMarkets", "fetchedAt"],
        },
    },
    {
        name: "get_historical_odds",
        description: "📊 RAW DATA: Get historical odds snapshot at a specific point in time. Available from June 2020 with 5-10 minute intervals. Required for line movement analysis. Paid tier only.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                date: {
                    type: "string",
                    description: "ISO 8601 timestamp for the snapshot (e.g., 2024-01-15T12:00:00Z)",
                },
                regions: {
                    type: "array",
                    items: { type: "string" },
                    description: "Regions",
                    default: ["us"],
                },
                markets: {
                    type: "array",
                    items: { type: "string" },
                    description: "Markets",
                    default: ["h2h"],
                },
                eventIds: {
                    type: "array",
                    items: { type: "string" },
                    description: "Filter to specific events",
                },
            },
            required: ["sport", "date"],
        },
        outputSchema: {
            type: "object",
            properties: {
                timestamp: { type: "string" },
                previousTimestamp: { type: "string" },
                nextTimestamp: { type: "string" },
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            commenceTime: { type: "string" },
                            homeTeam: { type: "string" },
                            awayTeam: { type: "string" },
                            bookmakers: { type: "array" },
                        },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["timestamp", "events", "fetchedAt"],
        },
    },
    {
        name: "get_historical_events",
        description: "📊 RAW DATA: Get list of events at a historical point in time. Useful for finding event IDs for historical odds queries. Paid tier only.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                date: {
                    type: "string",
                    description: "ISO 8601 timestamp",
                },
                commenceTimeFrom: {
                    type: "string",
                    description: "Filter events after this time",
                },
                commenceTimeTo: {
                    type: "string",
                    description: "Filter events before this time",
                },
            },
            required: ["sport", "date"],
        },
        outputSchema: {
            type: "object",
            properties: {
                timestamp: { type: "string" },
                events: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            sportKey: { type: "string" },
                            commenceTime: { type: "string" },
                            homeTeam: { type: "string" },
                            awayTeam: { type: "string" },
                        },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["timestamp", "events", "fetchedAt"],
        },
    },
    {
        name: "get_historical_event_odds",
        description: "📊 RAW DATA: Get historical odds for a specific event. Supports player props and alternate markets. Paid tier only.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
                eventId: {
                    type: "string",
                    description: "Event ID",
                },
                date: {
                    type: "string",
                    description: "ISO 8601 timestamp",
                },
                regions: {
                    type: "array",
                    items: { type: "string" },
                    default: ["us"],
                },
                markets: {
                    type: "array",
                    items: { type: "string" },
                    default: ["h2h"],
                },
            },
            required: ["sport", "eventId", "date"],
        },
        outputSchema: {
            type: "object",
            properties: {
                timestamp: { type: "string" },
                event: {
                    type: "object",
                    properties: {
                        id: { type: "string" },
                        commenceTime: { type: "string" },
                        homeTeam: { type: "string" },
                        awayTeam: { type: "string" },
                        bookmakers: { type: "array" },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["timestamp", "event", "fetchedAt"],
        },
    },
    {
        name: "get_participants",
        description: "📊 RAW DATA: Get list of teams or players for a sport. Returns participant IDs that can be used for filtering.",
        inputSchema: {
            type: "object",
            properties: {
                sport: {
                    type: "string",
                    description: "Sport key",
                },
            },
            required: ["sport"],
        },
        outputSchema: {
            type: "object",
            properties: {
                participants: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            id: { type: "string" },
                            fullName: { type: "string" },
                        },
                    },
                },
                fetchedAt: { type: "string" },
            },
            required: ["participants", "fetchedAt"],
        },
    },
];
// ============================================================================
// API HELPER FUNCTIONS
// ============================================================================
function errorResult(message) {
    return {
        content: [{ type: "text", text: message }],
        structuredContent: { error: message, fetchedAt: new Date().toISOString() },
        isError: true,
    };
}
function successResult(data) {
    return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        structuredContent: data,
    };
}
async function fetchOddsApi(endpoint, params = {}, timeoutMs = 30000) {
    const url = new URL(`${ODDS_API_BASE}${endpoint}`);
    // Add API key
    url.searchParams.set("apiKey", API_KEY);
    // Add other params
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
            if (Array.isArray(value)) {
                url.searchParams.set(key, value.join(","));
            }
            else {
                url.searchParams.set(key, String(value));
            }
        }
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url.toString(), {
            signal: controller.signal,
            headers: { Accept: "application/json" },
        });
        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error ${response.status}: ${errorText}`);
        }
        return await response.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function americanToDecimal(american) {
    if (american > 0) {
        return american / 100 + 1;
    }
    else {
        return 100 / Math.abs(american) + 1;
    }
}
function decimalToImplied(decimal) {
    return 1 / decimal;
}
function impliedToDecimal(implied) {
    return 1 / implied;
}
function calculateVig(outcomes) {
    const totalImplied = outcomes.reduce((sum, o) => sum + o.impliedProbability, 0);
    return (totalImplied - 1) * 100;
}
function calculateTrueProbabilities(outcomes) {
    const totalImplied = outcomes.reduce((sum, o) => sum + o.impliedProbability, 0);
    const result = {};
    for (const outcome of outcomes) {
        result[outcome.name] = outcome.impliedProbability / totalImplied;
    }
    return result;
}
// ============================================================================
// TIER 1: INTELLIGENCE TOOL HANDLERS
// ============================================================================
async function handleFindArbitrage(args) {
    const sport = args?.sport || "upcoming";
    const minProfitPercent = args?.minProfitPercent || 0.5;
    const maxResults = args?.maxResults || 10;
    try {
        // Fetch odds from all major regions to maximize bookmaker coverage
        const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
            regions: DEFAULT_REGIONS,
            markets: "h2h",
            oddsFormat: "decimal",
        }));
        const opportunities = [];
        let eventsAnalyzed = 0;
        let totalScanned = 0;
        for (const event of oddsData) {
            eventsAnalyzed++;
            // Build a map of best odds for each outcome across all bookmakers
            const bestOdds = new Map();
            for (const bookmaker of event.bookmakers) {
                totalScanned++;
                const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");
                if (!h2hMarket)
                    continue;
                for (const outcome of h2hMarket.outcomes) {
                    const current = bestOdds.get(outcome.name);
                    if (!current || outcome.price > current.price) {
                        bestOdds.set(outcome.name, {
                            bookmaker: bookmaker.title,
                            price: outcome.price,
                        });
                    }
                }
            }
            // Check for arbitrage opportunity
            if (bestOdds.size >= 2) {
                const outcomes = Array.from(bestOdds.entries());
                let totalImplied = 0;
                const legs = [];
                for (const [name, data] of outcomes) {
                    const implied = 1 / data.price;
                    totalImplied += implied;
                    legs.push({
                        outcome: name,
                        bookmaker: data.bookmaker,
                        price: data.price,
                        impliedProbability: implied,
                        stakePercent: 0, // Will calculate below
                    });
                }
                // Calculate profit and stakes
                if (totalImplied < 1) {
                    const profitPercent = (1 / totalImplied - 1) * 100;
                    if (profitPercent >= minProfitPercent) {
                        // Calculate optimal stake percentages
                        for (const leg of legs) {
                            leg.stakePercent = (leg.impliedProbability / totalImplied) * 100;
                        }
                        opportunities.push({
                            event: `${event.away_team} @ ${event.home_team}`,
                            eventId: event.id,
                            sport: event.sport_key,
                            commenceTime: event.commence_time,
                            market: "h2h",
                            profitPercent: Math.round(profitPercent * 100) / 100,
                            totalImpliedOdds: Math.round(totalImplied * 10000) / 10000,
                            legs,
                        });
                    }
                }
            }
        }
        // Sort by profit and limit results
        opportunities.sort((a, b) => b.profitPercent - a.profitPercent);
        const topOpportunities = opportunities.slice(0, maxResults);
        let recommendation = "";
        if (topOpportunities.length > 0) {
            recommendation = `Found ${topOpportunities.length} arbitrage opportunities. Best opportunity: ${topOpportunities[0].profitPercent.toFixed(2)}% guaranteed profit on ${topOpportunities[0].event}. Stake percentages shown represent optimal allocation.`;
        }
        else {
            recommendation =
                "No arbitrage opportunities found meeting the minimum profit threshold. Markets are efficiently priced. Consider lowering minProfitPercent or waiting for line movements.";
        }
        return successResult({
            opportunities: topOpportunities,
            totalScanned,
            eventsAnalyzed,
            recommendation,
            dataFreshness: "real-time",
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to find arbitrage: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleFindBestOdds(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const market = args?.market || "h2h";
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        let oddsData;
        if (eventId) {
            // Fetch specific event
            const event = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/odds`, {
                regions: DEFAULT_REGIONS,
                markets: market,
                oddsFormat: "decimal",
            }));
            oddsData = [event];
        }
        else {
            // Fetch all events for sport
            oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
                regions: DEFAULT_REGIONS,
                markets: market,
                oddsFormat: "decimal",
            }));
        }
        const events = [];
        const bookmakerWins = new Map();
        for (const event of oddsData) {
            const outcomeOdds = new Map();
            // Collect all odds by outcome
            for (const bookmaker of event.bookmakers) {
                const mkt = bookmaker.markets.find((m) => m.key === market);
                if (!mkt)
                    continue;
                for (const outcome of mkt.outcomes) {
                    const key = outcome.point !== undefined
                        ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
                        : outcome.name;
                    if (!outcomeOdds.has(key)) {
                        outcomeOdds.set(key, []);
                    }
                    outcomeOdds.get(key).push({
                        bookmaker: bookmaker.title,
                        odds: outcome.price,
                    });
                }
            }
            // Find best and worst for each outcome
            const outcomes = [];
            for (const [name, odds] of outcomeOdds) {
                if (odds.length === 0)
                    continue;
                odds.sort((a, b) => b.odds - a.odds);
                const best = odds[0];
                const worst = odds[odds.length - 1];
                const edgePercent = worst.odds > 0 ? ((best.odds - worst.odds) / worst.odds) * 100 : 0;
                // Track bookmaker performance
                bookmakerWins.set(best.bookmaker, (bookmakerWins.get(best.bookmaker) || 0) + 1);
                outcomes.push({
                    name,
                    bestOdds: best.odds,
                    bestBookmaker: best.bookmaker,
                    worstOdds: worst.odds,
                    worstBookmaker: worst.bookmaker,
                    edgePercent: Math.round(edgePercent * 100) / 100,
                    allBookmakers: odds,
                });
            }
            events.push({
                eventId: event.id,
                event: `${event.away_team} @ ${event.home_team}`,
                commenceTime: event.commence_time,
                market,
                outcomes,
            });
        }
        // Find best overall bookmaker
        let bestBookmaker = "";
        let maxWins = 0;
        for (const [bookmaker, wins] of bookmakerWins) {
            if (wins > maxWins) {
                maxWins = wins;
                bestBookmaker = bookmaker;
            }
        }
        // Calculate average edge
        let totalEdge = 0;
        let edgeCount = 0;
        for (const event of events) {
            for (const outcome of event.outcomes) {
                if (outcome.edgePercent > 0) {
                    totalEdge += outcome.edgePercent;
                    edgeCount++;
                }
            }
        }
        return successResult({
            events,
            summary: {
                totalEvents: events.length,
                bestOverallBookmaker: bestBookmaker,
                averageEdge: edgeCount > 0 ? Math.round((totalEdge / edgeCount) * 100) / 100 : 0,
            },
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to find best odds: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleAnalyzeLineMovement(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const hoursBack = Math.min(args?.hoursBack || 24, 168);
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        // Get current odds
        const currentParams = {
            regions: DEFAULT_REGIONS,
            markets: "h2h",
            oddsFormat: "decimal",
        };
        if (eventId) {
            currentParams.eventIds = eventId;
        }
        const currentOdds = (await fetchOddsApi(`/sports/${sport}/odds`, currentParams));
        // Calculate historical timestamp
        const historicalDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
        const historicalDateStr = historicalDate.toISOString();
        // Get historical odds
        let historicalOdds = [];
        try {
            const histParams = {
                date: historicalDateStr,
                regions: ["us"],
                markets: "h2h",
                oddsFormat: "decimal",
            };
            if (eventId) {
                histParams.eventIds = eventId;
            }
            const histResponse = (await fetchOddsApi(`/historical/sports/${sport}/odds`, histParams));
            historicalOdds = histResponse.data || [];
        }
        catch {
            // Historical data may not be available for all events/sports
            return successResult({
                events: [],
                interpretation: "Historical odds data not available for this sport/timeframe. Historical data requires a paid API tier and is available from June 2020.",
                fetchedAt: new Date().toISOString(),
            });
        }
        // Build historical lookup
        const historicalMap = new Map();
        for (const event of historicalOdds) {
            historicalMap.set(event.id, event);
        }
        // Analyze line movement
        const events = [];
        for (const current of currentOdds) {
            const historical = historicalMap.get(current.id);
            if (!historical)
                continue;
            // Get consensus odds (average across bookmakers)
            const getCurrentConsensus = (event, outcomeName) => {
                const prices = [];
                for (const bm of event.bookmakers) {
                    const market = bm.markets.find((m) => m.key === "h2h");
                    const outcome = market?.outcomes.find((o) => o.name === outcomeName);
                    if (outcome)
                        prices.push(outcome.price);
                }
                return prices.length > 0
                    ? prices.reduce((a, b) => a + b, 0) / prices.length
                    : 0;
            };
            const lineMovement = [];
            let totalMovement = 0;
            // Get all unique outcomes
            const outcomes = new Set();
            for (const bm of current.bookmakers) {
                const market = bm.markets.find((m) => m.key === "h2h");
                market?.outcomes.forEach((o) => outcomes.add(o.name));
            }
            for (const outcomeName of outcomes) {
                const openingLine = getCurrentConsensus(historical, outcomeName);
                const currentLine = getCurrentConsensus(current, outcomeName);
                if (openingLine === 0 || currentLine === 0)
                    continue;
                const movement = currentLine - openingLine;
                const movementPercent = (movement / openingLine) * 100;
                let direction = "stable";
                if (movementPercent < -2)
                    direction = "steam"; // Line shortened = money coming in
                else if (movementPercent > 2)
                    direction = "reverse"; // Line lengthened
                totalMovement +=
                    outcomeName === current.home_team ? -movementPercent : movementPercent;
                lineMovement.push({
                    outcome: outcomeName,
                    openingLine: Math.round(openingLine * 100) / 100,
                    currentLine: Math.round(currentLine * 100) / 100,
                    movement: Math.round(movement * 100) / 100,
                    movementPercent: Math.round(movementPercent * 100) / 100,
                    direction,
                });
            }
            // Determine sharp action
            let sharpAction = "neutral";
            if (totalMovement < -5)
                sharpAction = "heavy_home";
            else if (totalMovement < -2)
                sharpAction = "moderate_home";
            else if (totalMovement > 5)
                sharpAction = "heavy_away";
            else if (totalMovement > 2)
                sharpAction = "moderate_away";
            // Confidence based on consistency of movement
            const movements = lineMovement.map((l) => Math.abs(l.movementPercent));
            const avgMovement = movements.reduce((a, b) => a + b, 0) / movements.length;
            const confidence = Math.min(avgMovement / 5, 1); // Scale to 0-1
            events.push({
                eventId: current.id,
                event: `${current.away_team} @ ${current.home_team}`,
                commenceTime: current.commence_time,
                lineMovement,
                sharpAction,
                confidence: Math.round(confidence * 100) / 100,
            });
        }
        // Sort by confidence
        events.sort((a, b) => b.confidence - a.confidence);
        const interpretation = events.length > 0
            ? `Analyzed ${events.length} events over ${hoursBack} hours. Sharp money indicators: ${events.filter((e) => e.sharpAction.includes("heavy")).length} events show significant line movement, suggesting professional action.`
            : "No significant line movements detected in the analyzed timeframe.";
        return successResult({
            events,
            interpretation,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to analyze line movement: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleAnalyzeMarketEfficiency(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const market = args?.market || "h2h";
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        let oddsData;
        if (eventId) {
            const event = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/odds`, {
                regions: DEFAULT_REGIONS,
                markets: market,
                oddsFormat: "decimal",
            }));
            oddsData = [event];
        }
        else {
            oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
                regions: DEFAULT_REGIONS,
                markets: market,
                oddsFormat: "decimal",
            }));
        }
        const events = [];
        for (const event of oddsData) {
            const bookmakerEfficiency = [];
            let lowestVig = Infinity;
            let lowestVigBookmaker = "";
            // Collect all probabilities for consensus calculation
            const allProbabilities = new Map();
            for (const bookmaker of event.bookmakers) {
                const mkt = bookmaker.markets.find((m) => m.key === market);
                if (!mkt)
                    continue;
                let totalImplied = 0;
                for (const outcome of mkt.outcomes) {
                    const implied = 1 / outcome.price;
                    totalImplied += implied;
                    const key = outcome.point !== undefined
                        ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
                        : outcome.name;
                    if (!allProbabilities.has(key)) {
                        allProbabilities.set(key, []);
                    }
                    allProbabilities.get(key).push(implied);
                }
                const vigPercent = (totalImplied - 1) * 100;
                let efficiency = "average";
                if (vigPercent < 2)
                    efficiency = "excellent";
                else if (vigPercent < 4)
                    efficiency = "good";
                else if (vigPercent > 8)
                    efficiency = "poor";
                if (vigPercent < lowestVig) {
                    lowestVig = vigPercent;
                    lowestVigBookmaker = bookmaker.title;
                }
                bookmakerEfficiency.push({
                    bookmaker: bookmaker.title,
                    totalImpliedOdds: Math.round(totalImplied * 10000) / 10000,
                    vigPercent: Math.round(vigPercent * 100) / 100,
                    efficiency,
                });
            }
            // Calculate consensus probabilities (vig-adjusted)
            const consensusProbabilities = {};
            let totalConsensus = 0;
            for (const [name, probs] of allProbabilities) {
                const avgProb = probs.reduce((a, b) => a + b, 0) / probs.length;
                consensusProbabilities[name] = avgProb;
                totalConsensus += avgProb;
            }
            // Normalize to remove vig (true probabilities)
            for (const name in consensusProbabilities) {
                consensusProbabilities[name] = Math.round((consensusProbabilities[name] / totalConsensus) * 10000) / 10000;
            }
            // Sort by efficiency
            bookmakerEfficiency.sort((a, b) => a.vigPercent - b.vigPercent);
            const avgVig = bookmakerEfficiency.reduce((sum, b) => sum + b.vigPercent, 0) /
                bookmakerEfficiency.length;
            events.push({
                eventId: event.id,
                event: `${event.away_team} @ ${event.home_team}`,
                commenceTime: event.commence_time,
                market,
                bookmakerEfficiency,
                consensusProbabilities,
                lowestVigBookmaker,
                averageVig: Math.round(avgVig * 100) / 100,
            });
        }
        const recommendation = events.length > 0
            ? `For best value, prefer bookmakers with lowest vig. ${events[0].lowestVigBookmaker} offers the most efficient odds at ${events[0].bookmakerEfficiency[0]?.vigPercent.toFixed(2)}% vig. Consensus probabilities shown are vig-adjusted and comparable to prediction market prices.`
            : "No events found for analysis.";
        return successResult({
            events,
            recommendation,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to analyze market efficiency: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleCompareHistoricalClosingLines(args) {
    const sport = args?.sport;
    const team = args?.team;
    const daysBack = args?.daysBack || 30;
    if (!sport || !team) {
        return errorResult("sport and team parameters are required");
    }
    try {
        // Get historical events
        const endDate = new Date();
        const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);
        const historicalGames = [];
        // We'll check multiple historical snapshots
        const checkDates = [];
        for (let d = 0; d < daysBack; d += 3) {
            // Check every 3 days
            checkDates.push(new Date(endDate.getTime() - d * 24 * 60 * 60 * 1000));
        }
        for (const checkDate of checkDates.slice(0, 10)) {
            // Limit to 10 API calls
            try {
                const histResponse = (await fetchOddsApi(`/historical/sports/${sport}/odds`, {
                    date: checkDate.toISOString(),
                    regions: ["us"],
                    markets: "h2h",
                }));
                if (!histResponse.data)
                    continue;
                for (const event of histResponse.data) {
                    // Check if team is in this event
                    if (!event.home_team.toLowerCase().includes(team.toLowerCase()) &&
                        !event.away_team.toLowerCase().includes(team.toLowerCase())) {
                        continue;
                    }
                    // Get consensus odds
                    let teamOdds = [];
                    for (const bm of event.bookmakers) {
                        const h2h = bm.markets.find((m) => m.key === "h2h");
                        const outcome = h2h?.outcomes.find((o) => o.name.toLowerCase().includes(team.toLowerCase()));
                        if (outcome)
                            teamOdds.push(outcome.price);
                    }
                    if (teamOdds.length === 0)
                        continue;
                    const avgOdds = teamOdds.reduce((a, b) => a + b, 0) / teamOdds.length;
                    historicalGames.push({
                        event: `${event.away_team} @ ${event.home_team}`,
                        date: event.commence_time,
                        openingLine: Math.round(avgOdds * 100) / 100,
                        closingLine: Math.round(avgOdds * 100) / 100, // Would need another snapshot for true closing
                        result: "unknown", // Would need scores data
                        clvCapture: 0,
                    });
                }
            }
            catch {
                // Skip failed historical queries
                continue;
            }
        }
        // Remove duplicates by event name
        const uniqueGames = Array.from(new Map(historicalGames.map((g) => [g.event, g])).values());
        const avgClvMovement = uniqueGames.length > 0
            ? uniqueGames.reduce((sum, g) => sum + g.clvCapture, 0) /
                uniqueGames.length
            : 0;
        return successResult({
            team,
            sport,
            historicalGames: uniqueGames.slice(0, 20), // Limit results
            averageClvMovement: Math.round(avgClvMovement * 100) / 100,
            consistency: uniqueGames.length / 20, // Rough consistency measure
            recommendation: uniqueGames.length > 0
                ? `Found ${uniqueGames.length} historical games for ${team}. For full CLV analysis, compare opening lines (captured when market opens) to closing lines (right before game start).`
                : `No historical games found for ${team} in the past ${daysBack} days. Try a different team name or sport.`,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to analyze closing lines: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleDiscoverValueBets(args) {
    const sport = args?.sport || "upcoming";
    const minEdgePercent = args?.minEdgePercent || 3;
    const market = args?.market || "h2h";
    try {
        const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
            regions: DEFAULT_REGIONS,
            markets: market,
            oddsFormat: "decimal",
        }));
        const valueBets = [];
        let totalEventsScanned = 0;
        for (const event of oddsData) {
            totalEventsScanned++;
            // Calculate consensus probability for each outcome
            const outcomeProbabilities = new Map();
            const outcomeOdds = new Map();
            for (const bookmaker of event.bookmakers) {
                const mkt = bookmaker.markets.find((m) => m.key === market);
                if (!mkt)
                    continue;
                for (const outcome of mkt.outcomes) {
                    const key = outcome.point !== undefined
                        ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
                        : outcome.name;
                    const implied = 1 / outcome.price;
                    if (!outcomeProbabilities.has(key)) {
                        outcomeProbabilities.set(key, []);
                        outcomeOdds.set(key, []);
                    }
                    outcomeProbabilities.get(key).push(implied);
                    outcomeOdds.get(key).push({
                        bookmaker: bookmaker.title,
                        odds: outcome.price,
                        implied,
                    });
                }
            }
            // Calculate consensus (vig-adjusted)
            const consensus = new Map();
            let totalConsensus = 0;
            for (const [name, probs] of outcomeProbabilities) {
                const avg = probs.reduce((a, b) => a + b, 0) / probs.length;
                consensus.set(name, avg);
                totalConsensus += avg;
            }
            // Normalize
            for (const [name, prob] of consensus) {
                consensus.set(name, prob / totalConsensus);
            }
            // Find value bets (where a bookmaker offers odds better than consensus)
            for (const [outcomeName, odds] of outcomeOdds) {
                const consensusProb = consensus.get(outcomeName) || 0;
                if (consensusProb === 0)
                    continue;
                for (const { bookmaker, odds: oddsValue, implied } of odds) {
                    // Edge = (1/consensusProb) - (1/implied)
                    // Or simpler: if implied < consensus, there's value
                    const edgePercent = ((consensusProb - implied) / implied) * 100;
                    if (edgePercent >= minEdgePercent) {
                        // Calculate confidence based on number of bookmakers and edge size
                        let confidence = "low";
                        const numBookmakers = odds.length;
                        if (numBookmakers >= 10 && edgePercent >= 5)
                            confidence = "high";
                        else if (numBookmakers >= 5 && edgePercent >= 3)
                            confidence = "medium";
                        valueBets.push({
                            event: `${event.away_team} @ ${event.home_team}`,
                            eventId: event.id,
                            sport: event.sport_key,
                            commenceTime: event.commence_time,
                            outcome: outcomeName,
                            bookmaker,
                            odds: oddsValue,
                            impliedProbability: Math.round(implied * 10000) / 10000,
                            consensusProbability: Math.round(consensusProb * 10000) / 10000,
                            edgePercent: Math.round(edgePercent * 100) / 100,
                            confidence,
                        });
                    }
                }
            }
        }
        // Sort by edge
        valueBets.sort((a, b) => b.edgePercent - a.edgePercent);
        const recommendation = valueBets.length > 0
            ? `Found ${valueBets.length} potential value bets with ${minEdgePercent}%+ edge vs consensus. High confidence bets are backed by many bookmakers showing consistent pricing. Always verify odds are still available before betting.`
            : `No value bets found meeting the ${minEdgePercent}% edge threshold. Markets appear efficiently priced. Try lowering minEdgePercent or checking different sports.`;
        return successResult({
            valueBets: valueBets.slice(0, 50), // Limit results
            totalEventsScanned,
            recommendation,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to discover value bets: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
// ============================================================================
// TIER 2: RAW DATA TOOL HANDLERS
// ============================================================================
async function handleGetSports(args) {
    const all = args?.all;
    try {
        const sports = (await fetchOddsApi("/sports", {
            all: all ? "true" : undefined,
        }));
        const formattedSports = sports.map((s) => ({
            key: s.key,
            group: s.group,
            title: s.title,
            description: s.description,
            active: s.active,
            hasOutrights: s.has_outrights,
        }));
        return successResult({
            sports: formattedSports,
            totalActive: sports.filter((s) => s.active).length,
            totalInactive: sports.filter((s) => !s.active).length,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get sports: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetEvents(args) {
    const sport = args?.sport;
    const commenceTimeFrom = args?.commenceTimeFrom;
    const commenceTimeTo = args?.commenceTimeTo;
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        const events = (await fetchOddsApi(`/sports/${sport}/events`, {
            commenceTimeFrom,
            commenceTimeTo,
        }));
        const formattedEvents = events.map((e) => ({
            id: e.id,
            sportKey: e.sport_key,
            sportTitle: e.sport_title,
            commenceTime: e.commence_time,
            homeTeam: e.home_team,
            awayTeam: e.away_team,
        }));
        return successResult({
            events: formattedEvents,
            totalEvents: events.length,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get events: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetOdds(args) {
    const sport = args?.sport;
    const regions = args?.regions || ["us"];
    const markets = args?.markets || ["h2h"];
    const oddsFormat = args?.oddsFormat || "decimal";
    const bookmakers = args?.bookmakers;
    const eventIds = args?.eventIds;
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        const params = {
            regions: bookmakers ? undefined : regions,
            markets,
            oddsFormat,
            bookmakers,
            eventIds,
        };
        const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, params));
        // Calculate quota cost
        const numRegions = bookmakers
            ? Math.ceil(bookmakers.length / 10)
            : regions.length;
        const quotaCost = markets.length * numRegions;
        const events = oddsData.map((e) => ({
            id: e.id,
            sportKey: e.sport_key,
            sportTitle: e.sport_title,
            commenceTime: e.commence_time,
            homeTeam: e.home_team,
            awayTeam: e.away_team,
            bookmakers: e.bookmakers.map((b) => ({
                key: b.key,
                title: b.title,
                lastUpdate: b.last_update,
                markets: b.markets,
            })),
        }));
        return successResult({
            events,
            quotaCost,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get odds: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetScores(args) {
    const sport = args?.sport;
    const daysFrom = args?.daysFrom;
    const eventIds = args?.eventIds;
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        const scores = (await fetchOddsApi(`/sports/${sport}/scores`, {
            daysFrom: daysFrom ? String(daysFrom) : undefined,
            eventIds,
        }));
        const games = scores.map((s) => {
            const homeScore = s.scores?.find((sc) => sc.name === s.home_team)?.score;
            const awayScore = s.scores?.find((sc) => sc.name === s.away_team)?.score;
            return {
                id: s.id,
                sportKey: s.sport_key,
                commenceTime: s.commence_time,
                completed: s.completed || false,
                homeTeam: s.home_team,
                awayTeam: s.away_team,
                homeScore: homeScore || null,
                awayScore: awayScore || null,
                lastUpdate: s.last_update || null,
            };
        });
        return successResult({
            games,
            liveGames: games.filter((g) => !g.completed && g.homeScore !== null).length,
            completedGames: games.filter((g) => g.completed).length,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get scores: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetEventOdds(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const regions = args?.regions || ["us"];
    const markets = args?.markets || ["h2h"];
    const oddsFormat = args?.oddsFormat || "decimal";
    if (!sport || !eventId) {
        return errorResult("sport and eventId parameters are required");
    }
    try {
        const event = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/odds`, {
            regions,
            markets,
            oddsFormat,
        }));
        return successResult({
            event: {
                id: event.id,
                sportKey: event.sport_key,
                commenceTime: event.commence_time,
                homeTeam: event.home_team,
                awayTeam: event.away_team,
                bookmakers: event.bookmakers,
            },
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get event odds: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetEventMarkets(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const regions = args?.regions || ["us"];
    if (!sport || !eventId) {
        return errorResult("sport and eventId parameters are required");
    }
    try {
        const response = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/markets`, {
            regions,
        }));
        // Collect all unique markets
        const allMarkets = new Set();
        const bookmakerMarkets = response.bookmakers.map((b) => {
            for (const m of b.markets) {
                allMarkets.add(m.key);
            }
            return {
                bookmaker: b.title,
                markets: b.markets,
            };
        });
        return successResult({
            event: {
                id: response.id,
                sportKey: response.sport_key,
                commenceTime: response.commence_time,
                homeTeam: response.home_team,
                awayTeam: response.away_team,
            },
            bookmakerMarkets,
            allAvailableMarkets: Array.from(allMarkets).sort(),
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get event markets: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetHistoricalOdds(args) {
    const sport = args?.sport;
    const date = args?.date;
    const regions = args?.regions || ["us"];
    const markets = args?.markets || ["h2h"];
    const eventIds = args?.eventIds;
    if (!sport || !date) {
        return errorResult("sport and date parameters are required");
    }
    try {
        const response = (await fetchOddsApi(`/historical/sports/${sport}/odds`, {
            date,
            regions,
            markets,
            eventIds,
        }));
        const events = (response.data || []).map((e) => ({
            id: e.id,
            commenceTime: e.commence_time,
            homeTeam: e.home_team,
            awayTeam: e.away_team,
            bookmakers: e.bookmakers,
        }));
        return successResult({
            timestamp: response.timestamp,
            previousTimestamp: response.previous_timestamp,
            nextTimestamp: response.next_timestamp,
            events,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get historical odds: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetHistoricalEvents(args) {
    const sport = args?.sport;
    const date = args?.date;
    const commenceTimeFrom = args?.commenceTimeFrom;
    const commenceTimeTo = args?.commenceTimeTo;
    if (!sport || !date) {
        return errorResult("sport and date parameters are required");
    }
    try {
        const response = (await fetchOddsApi(`/historical/sports/${sport}/events`, {
            date,
            commenceTimeFrom,
            commenceTimeTo,
        }));
        const events = (response.data || []).map((e) => ({
            id: e.id,
            sportKey: e.sport_key,
            commenceTime: e.commence_time,
            homeTeam: e.home_team,
            awayTeam: e.away_team,
        }));
        return successResult({
            timestamp: response.timestamp,
            events,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get historical events: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetHistoricalEventOdds(args) {
    const sport = args?.sport;
    const eventId = args?.eventId;
    const date = args?.date;
    const regions = args?.regions || ["us"];
    const markets = args?.markets || ["h2h"];
    if (!sport || !eventId || !date) {
        return errorResult("sport, eventId, and date parameters are required");
    }
    try {
        const response = (await fetchOddsApi(`/historical/sports/${sport}/events/${eventId}/odds`, {
            date,
            regions,
            markets,
        }));
        const event = response.data?.[0];
        return successResult({
            timestamp: response.timestamp,
            event: event
                ? {
                    id: event.id,
                    commenceTime: event.commence_time,
                    homeTeam: event.home_team,
                    awayTeam: event.away_team,
                    bookmakers: event.bookmakers,
                }
                : null,
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get historical event odds: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
async function handleGetParticipants(args) {
    const sport = args?.sport;
    if (!sport) {
        return errorResult("sport parameter is required");
    }
    try {
        const participants = (await fetchOddsApi(`/sports/${sport}/participants`));
        return successResult({
            participants: participants.map((p) => ({
                id: p.id,
                fullName: p.full_name,
            })),
            fetchedAt: new Date().toISOString(),
        });
    }
    catch (error) {
        return errorResult(`Failed to get participants: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
}
// ============================================================================
// MCP SERVER SETUP
// ============================================================================
const server = new Server({ name: "mcp-odds-api", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
        // Tier 1: Intelligence Tools
        case "find_arbitrage_opportunities":
            return handleFindArbitrage(args);
        case "find_best_odds":
            return handleFindBestOdds(args);
        case "analyze_line_movement":
            return handleAnalyzeLineMovement(args);
        case "analyze_market_efficiency":
            return handleAnalyzeMarketEfficiency(args);
        case "compare_historical_closing_lines":
            return handleCompareHistoricalClosingLines(args);
        case "discover_value_bets":
            return handleDiscoverValueBets(args);
        // Tier 2: Raw Data Tools
        case "get_sports":
            return handleGetSports(args);
        case "get_events":
            return handleGetEvents(args);
        case "get_odds":
            return handleGetOdds(args);
        case "get_scores":
            return handleGetScores(args);
        case "get_event_odds":
            return handleGetEventOdds(args);
        case "get_event_markets":
            return handleGetEventMarkets(args);
        case "get_historical_odds":
            return handleGetHistoricalOdds(args);
        case "get_historical_events":
            return handleGetHistoricalEvents(args);
        case "get_historical_event_odds":
            return handleGetHistoricalEventOdds(args);
        case "get_participants":
            return handleGetParticipants(args);
        default:
            return errorResult(`Unknown tool: ${name}`);
    }
});
// ============================================================================
// EXPRESS SERVER WITH SECURITY MIDDLEWARE
// ============================================================================
const app = express();
app.use(express.json());
// Create security middleware
const verifyContextAuth = createContextMiddleware();
// Health check (no auth required)
app.get("/health", (_req, res) => {
    res.json({
        status: "ok",
        server: "mcp-odds-api",
        version: "1.0.0",
        apiConfigured: !!API_KEY,
    });
});
// Session management
const transports = new Map();
// MCP endpoint with security middleware
app.post("/mcp", verifyContextAuth, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        const newSessionId = randomUUID();
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        await server.connect(transport);
    }
    else {
        res.status(400).json({ error: "Bad Request: No valid session" });
        return;
    }
    await transport.handleRequest(req, res, req.body);
});
// Handle SSE for streaming (GET requests)
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    const transport = transports.get(sessionId);
    if (!transport) {
        res.status(400).json({ error: "No transport found for session" });
        return;
    }
    await transport.handleRequest(req, res);
});
// Start server
const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
    console.log(`\n🎰 The Odds API MCP Server v1.0.0`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`🔌 MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`🔑 API Key: ${API_KEY ? "✅ Configured" : "❌ Missing (set ODDS_API_KEY)"}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
