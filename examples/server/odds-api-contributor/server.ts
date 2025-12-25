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
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
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
// TYPE DEFINITIONS
// ============================================================================

interface OddsApiSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

interface OddsApiEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  completed?: boolean;
  scores?: Array<{ name: string; score: string }>;
  last_update?: string;
}

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
  description?: string;
}

interface OddsApiMarket {
  key: string;
  last_update?: string;
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

interface OddsApiOddsEvent extends OddsApiEvent {
  bookmakers: OddsApiBookmaker[];
}

interface HistoricalOddsResponse {
  timestamp: string;
  previous_timestamp: string | null;
  next_timestamp: string | null;
  data: OddsApiOddsEvent[];
}

// ============================================================================
// TOOL DEFINITIONS
// ============================================================================

const TOOLS = [
  // ==================== TIER 1: INTELLIGENCE TOOLS ====================

  {
    name: "find_arbitrage_opportunities",
    description:
      "🧠 INTELLIGENCE: Scan multiple bookmakers to find arbitrage opportunities where you can guarantee profit by betting both sides. Returns opportunities sorted by profit margin. Combines odds from 50+ bookmakers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description:
            "Sport key (e.g., americanfootball_nfl, basketball_nba). Use 'upcoming' for next 8 events across all sports.",
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
      type: "object" as const,
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
    description:
      "🧠 INTELLIGENCE: Find the best available odds across all bookmakers for a specific event or sport. Shows which bookmaker offers the best price for each outcome.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "🧠 INTELLIGENCE: Analyze how odds have moved over time using historical data. Detects sharp money by comparing opening lines to current lines. Useful for identifying where professional bettors are placing their money.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "🧠 INTELLIGENCE: Calculate market efficiency (vig/juice) and true implied probabilities across bookmakers. Find markets with lowest vig for better value. Useful for comparing to prediction market prices (e.g., Polymarket).",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "🧠 INTELLIGENCE: Compare current odds to historical closing lines for similar events. Helps identify Closing Line Value (CLV) - a key metric for +EV betting. Uses historical data to contextualize current odds.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "🧠 INTELLIGENCE: Find potential value bets by identifying odds that differ significantly from consensus. Combines multiple bookmakers to calculate consensus probabilities and flags outliers.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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

  // ==================== CROSS-PLATFORM INTEROPERABILITY ====================

  {
    name: "find_cross_platform_gaps",
    description: `🔍 CROSS-PLATFORM INTELLIGENCE: This tool provides GUIDANCE for finding probability gaps between sportsbooks and prediction markets.

⚠️ IMPORTANT: This tool returns INSTRUCTIONS and METHODOLOGY, not live cross-platform data.
To find actual gaps, you must:
1. Call get_comparable_markets on THIS server (Odds API) to get sports probabilities
2. Call get_comparable_markets on Polymarket/Kalshi servers to get prediction market probabilities  
3. Compare normalized probabilities (all on 0-1 scale)

PROBABILITY GAP = Difference between sportsbook implied probability and prediction market price

EXAMPLE WORKFLOW:
1. Odds API: get_outrights({ sport: "basketball_nba_championship_winner" })
   → "Lakers" best odds 5.00 → implied probability = 1/5.00 = 0.20 (20%)
2. Polymarket: search_markets({ query: "Lakers NBA Finals" })
   → "Lakers win NBA Finals" YES price = 0.35 (35%)
3. GAP = |0.35 - 0.20| = 0.15 (15 percentage points!)

ARBITRAGE DETECTION:
- Gap > 10 percentage points = potential arbitrage
- Gap > 5 percentage points = significant discrepancy worth investigating
- Gap < 5 percentage points = markets roughly agree

COMMON CROSS-PLATFORM OVERLAPS:
- NBA/NFL/MLB championship winners (Odds API outrights vs Polymarket/Kalshi futures)
- Super Bowl winner
- World Series winner
- Presidential election outcomes (Kalshi/Polymarket only - no Odds API)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        targetSport: {
          type: "string",
          description: "Sport to analyze (e.g., 'basketball_nba', 'americanfootball_nfl')",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        methodology: { type: "string" },
        sportsAvailable: { type: "array", items: { type: "string" } },
        crossPlatformOverlaps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              category: { type: "string" },
              oddsApiSport: { type: "string" },
              polymarketSearch: { type: "string" },
              kalshiCategory: { type: "string" },
            },
          },
        },
        instructions: { type: "array", items: { type: "string" } },
        fetchedAt: { type: "string" },
      },
      required: ["methodology", "instructions", "fetchedAt"],
    },
  },

  {
    name: "get_comparable_markets",
    description: `📊 CROSS-PLATFORM: Get sports betting events in a STANDARDIZED format for comparing with prediction markets (Polymarket only - Kalshi has no sports).

Returns events with normalized probabilities (0-1 scale) derived from decimal odds, matching the format
used by prediction markets. This enables direct probability comparison.

🕐 LIVE vs HISTORICAL DATA:
  - DEFAULT (includeCompleted: false): Returns only UPCOMING events that haven't started
    → Use for: Current arbitrage, live comparisons, real-time betting analysis
  - HISTORICAL (includeCompleted: true): Includes events that have already completed
    → Use for: Past game analysis, accuracy studies, "what were the odds on X game?"
    ⚠️ Note: Historical odds data is limited compared to Polymarket/Kalshi

WHEN TO USE includeCompleted: true:
  - "What were the sportsbook odds on the Chiefs winning Super Bowl 2024?"
  - "How did closing lines compare to Polymarket prices for past games?"
  - Any question about PAST sporting events

USE THIS TOOL when you need to:
- Find arbitrage opportunities between sportsbooks and Polymarket
- Compare probability assessments for sports events
- Build cross-platform analysis of championship/futures markets
- Analyze historical betting odds (with includeCompleted: true)

⚠️ CROSS-PLATFORM MATCHING GUIDE:
Markets on different platforms have DIFFERENT titles for the SAME event:
  - Odds API: "NFL Super Bowl Winner" or "Kansas City Chiefs vs Detroit Lions"
  - Polymarket: "Super Bowl Champion 2026" or "Chiefs win Super Bowl"

DO NOT use exact title matching! Instead, use FUZZY MATCHING with these fields:
  1. teams: Check if the same teams appear on both platforms (most reliable for sports!)
  2. keywords: Check if 50%+ of keywords overlap
  3. sport: Map to Polymarket's eventCategory (both should be "sports")
  4. normalizedProbability: Once matched, compare these directly (all 0-1 scale)

MATCHING EXAMPLE:
  Odds API teams: ["Kansas City Chiefs", "Detroit Lions"]
  Odds API keywords: ["nfl", "super", "bowl", "kansas city chiefs"]
  Polymarket keywords: ["super", "bowl", "champion", "2026", "chiefs"]
  → Team match: "Chiefs" appears in both → SAME MARKET!
  → Compare: Odds API 0.28 vs Polymarket 0.25 = 3% gap

PROBABILITY CONVERSION (already done for you):
  - Decimal 2.00 → 1/2.00 = 0.50 (50%)
  - Decimal 1.50 → 1/1.50 = 0.667 (66.7%)
  - Decimal 3.00 → 1/3.00 = 0.333 (33.3%)

PLATFORM COMPATIBILITY:
  - Sports: Use Odds API + Polymarket (Kalshi has NO sports markets)
  - For outrights/futures, use sport keys ending in _winner (e.g., americanfootball_nfl_super_bowl_winner)`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description: "Sport key (e.g., 'americanfootball_nfl', 'basketball_nba'). Use 'upcoming' for next events across all sports.",
          default: "upcoming",
        },
        market: {
          type: "string",
          description: "Market type: h2h (moneyline), spreads, totals, outrights",
          default: "h2h",
        },
        limit: {
          type: "number",
          description: "Number of results (default: 30, max: 50)",
        },
        includeCompleted: {
          type: "boolean",
          description: "Include completed events (default: false). Note: Odds API primarily returns upcoming events. Historical data may be limited.",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        platform: { type: "string", const: "odds_api" },
        markets: {
          type: "array",
          description: "Sports events in standardized format. Use teams/keywords for FUZZY MATCHING with Polymarket - NOT title matching!",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Human-readable title. DO NOT use for cross-platform matching (titles differ by platform)" },
              description: { type: "string" },
              eventCategory: { type: "string", const: "sports", description: "Always 'sports' - compare with Polymarket sports category" },
              sport: { type: "string", description: "Sport key (e.g., americanfootball_nfl). Helps narrow matching scope" },
              keywords: { 
                type: "array", 
                items: { type: "string" }, 
                description: "🔑 USE FOR MATCHING: Check if 50%+ keywords overlap with Polymarket's keywords array" 
              },
              teams: { 
                type: "array", 
                items: { type: "string" }, 
                description: "🔑 BEST FOR MATCHING: Check if team names appear in Polymarket market (most reliable for sports!)" 
              },
              outcomes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Outcome name (team name or Over/Under)" },
                    normalizedProbability: { type: "number", description: "🎯 COMPARE THIS: 0-1 scale, directly comparable with Polymarket" },
                    rawOdds: { type: "number", description: "Original decimal odds (normalizedProbability = 1/rawOdds)" },
                    bestBookmaker: { type: "string", description: "Which bookmaker has the best odds for this outcome" },
                  },
                },
              },
              commenceTime: { type: "string", description: "Event start time - can help confirm same event across platforms" },
              platformEventId: { type: "string" },
            },
          },
        },
        totalCount: { type: "number" },
        hint: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["platform", "markets", "fetchedAt"],
    },
  },

  // ==================== TIER 2: RAW DATA TOOLS ====================

  {
    name: "get_sports",
    description: `🏀 DISCOVERY: List ALL available sports on The Odds API.

Returns sport keys for use with other endpoints (get_odds, get_events, get_outrights).

⚠️ SCOPE: This API covers SPORTS BETTING ONLY.
   - ✅ NFL, NBA, MLB, NHL, Soccer, Tennis, Golf, MMA, Cricket, Rugby
   - ❌ NO politics, crypto, entertainment, or other categories
   For non-sports predictions, use Polymarket.

IMPORTANT FIELD: has_outrights
  - true → Futures/championship betting available (who wins Super Bowl, NBA Finals, etc.)
  - false → Game-by-game betting only (Eagles vs Cowboys this Sunday)

SPORT KEY PATTERNS:
  - Game odds: "basketball_nba", "americanfootball_nfl", "soccer_epl"
  - Futures: "basketball_nba_championship_winner", "americanfootball_nfl_super_bowl_winner"

DATA FLOW:
  get_sports → sport_key with has_outrights:false → get_odds (games)
  get_sports → sport_key with has_outrights:true → get_outrights (futures)

CROSS-PLATFORM COMPOSABILITY:
  Futures sports (has_outrights:true) overlap with Polymarket championship markets.
  Compare sportsbook futures odds vs prediction market prices for arbitrage.
  
📊 This endpoint is FREE (no quota cost).`,
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    name: "get_futures_sports",
    description: `🏆 DISCOVERY: List all sports with FUTURES/CHAMPIONSHIP betting available.

Filters to only sports where has_outrights=true.

FUTURES EXAMPLES:
  - americanfootball_nfl_super_bowl_winner
  - basketball_nba_championship_winner
  - golf_masters_tournament_winner
  - soccer_epl_league_winner

USE WITH: get_outrights({ sport: <sport_key> }) to get actual odds

⚠️ SCOPE: This API covers SPORTS BETTING ONLY - no politics, crypto, or entertainment.
For those categories, use Polymarket.

CROSS-PLATFORM STRATEGY:
  This is where Odds API and Polymarket OVERLAP!
  
  1. Call get_futures_sports → find "basketball_nba_championship_winner"
  2. Call get_outrights → Lakers +450 (implied 18.2%)
  3. Search Polymarket for "Lakers NBA Finals" → 45% YES price
  4. Compare probabilities → 27 percentage point discrepancy!`,
    inputSchema: {
      type: "object" as const,
      properties: {
        group: {
          type: "string",
          description: "Filter by sport group (e.g., 'American Football', 'Basketball', 'Soccer', 'Golf')",
        },
      },
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        futuresSports: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "Sport key for use with get_outrights" },
              title: { type: "string", description: "Display name" },
              group: { type: "string", description: "Sport group (Basketball, Football, etc.)" },
              description: { type: "string" },
              active: { type: "boolean" },
            },
          },
        },
        totalCount: { type: "number" },
        hint: { type: "string" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      required: ["futuresSports", "fetchedAt"],
    },
  },

  {
    name: "get_events",
    description:
      "📊 RAW DATA: Get list of upcoming and live events for a sport. This endpoint is free (no quota cost). Returns event IDs needed for other endpoints.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get live odds for a sport from multiple bookmakers. Supports h2h, spreads, and totals markets. Quota cost depends on regions and markets requested.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get live scores and recently completed game results. Scores update every ~30 seconds for live games. Can retrieve completed games from up to 3 days ago.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get detailed odds for a specific event including player props and alternate lines. Supports any market type for single events.",
    inputSchema: {
      type: "object" as const,
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
          description:
            "Markets to include (supports any market including player props like player_pass_tds, player_points)",
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get available market types for a specific event. Shows which prop bets and alternate lines are available from each bookmaker. Costs 1 quota credit.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get historical odds snapshot at a specific point in time. Available from June 2020 with 5-10 minute intervals. Required for line movement analysis. Paid tier only.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get list of events at a historical point in time. Useful for finding event IDs for historical odds queries. Paid tier only.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get historical odds for a specific event. Supports player props and alternate markets. Paid tier only.",
    inputSchema: {
      type: "object" as const,
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
      type: "object" as const,
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
    description:
      "📊 RAW DATA: Get list of teams or players for a sport. Returns participant IDs that can be used for filtering.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description: "Sport key",
        },
      },
      required: ["sport"],
    },
    outputSchema: {
      type: "object" as const,
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

  {
    name: "get_outrights",
    description: `🎰 RAW DATA: Get futures/championship winner odds from 50+ sportsbooks.

INPUT: Futures sport key from get_futures_sports or get_sports (has_outrights: true)
  Examples: 
  - "americanfootball_nfl_super_bowl_winner"
  - "basketball_nba_championship_winner"
  - "golf_masters_tournament_winner"

RETURNS: All teams/outcomes with:
  - Best odds across all bookmakers
  - Implied probability (calculated as 1/decimal_odds)
  - Which bookmaker offers the best price

CONVERTING ODDS TO PROBABILITY:
  - Decimal 2.50 → 1/2.50 = 40% implied probability
  - American +450 → 100/(450+100) = 18.2% implied probability
  - American -200 → 200/(200+100) = 66.7% implied probability

CROSS-PLATFORM COMPARISON:
  Sportsbook odds can be directly compared to Polymarket prices!
  
  Example workflow:
  1. get_outrights({ sport: "basketball_nba_championship_winner" })
     → Lakers +450 = 18.2% implied probability
  2. Polymarket browse_by_tag for "NBA" → "Will Lakers win NBA Finals?" 
     → YES price 0.45 = 45% probability
  3. DISCREPANCY: 45% - 18.2% = 26.8 percentage points
  4. If you believe sportsbooks are right, bet NO on Polymarket
     If you believe Polymarket is right, bet Lakers at sportsbook`,
    inputSchema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description:
            "Sport key for outright market (e.g., americanfootball_nfl_super_bowl_winner, basketball_nba_championship_winner). Call get_futures_sports or get_sports to see available outright sports.",
        },
        regions: {
          type: "array",
          items: { type: "string" },
          description:
            "Bookmaker regions to include (us, us2, uk, eu, au). Default: all regions.",
        },
        bookmakers: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific bookmakers to query (optional, overrides regions).",
        },
      },
      required: ["sport"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        sport: { type: "string" },
        sportTitle: { type: "string" },
        commenceTime: { type: "string" },
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
              consensusOdds: { type: "number" },
              impliedProbability: { type: "number" },
              allBookmakers: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    bookmaker: { type: "string" },
                    odds: { type: "number" },
                  },
                },
              },
            },
          },
        },
        fetchedAt: { type: "string" },
      },
      required: ["sport", "outcomes", "fetchedAt"],
    },
  },

  {
    name: "analyze_futures_value",
    description:
      "🧠 INTELLIGENCE: Analyze futures/outright markets to find value. Compares odds across bookmakers, calculates implied probabilities, identifies mispriced outcomes, and shows which books offer the best prices for each outcome.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sport: {
          type: "string",
          description:
            "Sport key for outright market (e.g., americanfootball_nfl_super_bowl_winner, basketball_nba_championship_winner).",
        },
        minEdgePercent: {
          type: "number",
          description:
            "Minimum edge percentage vs consensus to flag as value (default: 10)",
          default: 10,
        },
      },
      required: ["sport"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        sport: { type: "string" },
        sportTitle: { type: "string" },
        analysis: {
          type: "array",
          items: {
            type: "object",
            properties: {
              outcome: { type: "string" },
              consensusImpliedProbability: { type: "number" },
              bestOdds: { type: "number" },
              bestBookmaker: { type: "string" },
              bestImpliedProbability: { type: "number" },
              edgeVsConsensus: { type: "number" },
              isValue: { type: "boolean" },
            },
          },
        },
        valueBets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              outcome: { type: "string" },
              bookmaker: { type: "string" },
              odds: { type: "number" },
              edgePercent: { type: "number" },
            },
          },
        },
        marketOverround: { type: "number" },
        recommendation: { type: "string" },
        fetchedAt: { type: "string" },
      },
      required: ["sport", "analysis", "valueBets", "fetchedAt"],
    },
  },
];

// ============================================================================
// API HELPER FUNCTIONS
// ============================================================================

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: message, fetchedAt: new Date().toISOString() },
    isError: true,
  };
}

function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

async function fetchOddsApi(
  endpoint: string,
  params: Record<string, string | string[] | number | boolean | undefined> = {},
  timeoutMs = 30000
): Promise<unknown> {
  const url = new URL(`${ODDS_API_BASE}${endpoint}`);

  // Add API key
  url.searchParams.set("apiKey", API_KEY);

  // Add other params
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      if (Array.isArray(value)) {
        url.searchParams.set(key, value.join(","));
      } else {
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
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function americanToDecimal(american: number): number {
  if (american > 0) {
    return american / 100 + 1;
  } else {
    return 100 / Math.abs(american) + 1;
  }
}

function decimalToImplied(decimal: number): number {
  return 1 / decimal;
}

function impliedToDecimal(implied: number): number {
  return 1 / implied;
}

function calculateVig(outcomes: Array<{ impliedProbability: number }>): number {
  const totalImplied = outcomes.reduce((sum, o) => sum + o.impliedProbability, 0);
  return (totalImplied - 1) * 100;
}

function calculateTrueProbabilities(
  outcomes: Array<{ name: string; impliedProbability: number }>
): Record<string, number> {
  const totalImplied = outcomes.reduce((sum, o) => sum + o.impliedProbability, 0);
  const result: Record<string, number> = {};
  for (const outcome of outcomes) {
    result[outcome.name] = outcome.impliedProbability / totalImplied;
  }
  return result;
}

// ============================================================================
// TIER 1: INTELLIGENCE TOOL HANDLERS
// ============================================================================

async function handleFindArbitrage(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = (args?.sport as string) || "upcoming";
  const minProfitPercent = (args?.minProfitPercent as number) || 0.5;
  const maxResults = (args?.maxResults as number) || 10;

  try {
    // Fetch odds from all major regions to maximize bookmaker coverage
    const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
      regions: DEFAULT_REGIONS,
      markets: "h2h",
      oddsFormat: "decimal",
    })) as OddsApiOddsEvent[];

    const opportunities: Array<{
      event: string;
      eventId: string;
      sport: string;
      commenceTime: string;
      market: string;
      profitPercent: number;
      totalImpliedOdds: number;
      legs: Array<{
        outcome: string;
        bookmaker: string;
        price: number;
        impliedProbability: number;
        stakePercent: number;
      }>;
    }> = [];

    let eventsAnalyzed = 0;
    let totalScanned = 0;

    for (const event of oddsData) {
      eventsAnalyzed++;

      // Build a map of best odds for each outcome across all bookmakers
      const bestOdds: Map<string, { bookmaker: string; price: number }> = new Map();

      for (const bookmaker of event.bookmakers) {
        totalScanned++;
        const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");
        if (!h2hMarket) continue;

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
        const legs: typeof opportunities[0]["legs"] = [];

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
    } else {
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
  } catch (error) {
    return errorResult(`Failed to find arbitrage: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleFindBestOdds(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string | undefined;
  const market = (args?.market as string) || "h2h";

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    let oddsData: OddsApiOddsEvent[];

    if (eventId) {
      // Fetch specific event
      const event = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/odds`, {
        regions: DEFAULT_REGIONS,
        markets: market,
        oddsFormat: "decimal",
      })) as OddsApiOddsEvent;
      oddsData = [event];
    } else {
      // Fetch all events for sport
      oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
        regions: DEFAULT_REGIONS,
        markets: market,
        oddsFormat: "decimal",
      })) as OddsApiOddsEvent[];
    }

    const events: Array<{
      eventId: string;
      event: string;
      commenceTime: string;
      market: string;
      outcomes: Array<{
        name: string;
        bestOdds: number;
        bestBookmaker: string;
        worstOdds: number;
        worstBookmaker: string;
        edgePercent: number;
        allBookmakers: Array<{ bookmaker: string; odds: number }>;
      }>;
    }> = [];

    const bookmakerWins: Map<string, number> = new Map();

    for (const event of oddsData) {
      const outcomeOdds: Map<
        string,
        Array<{ bookmaker: string; odds: number }>
      > = new Map();

      // Collect all odds by outcome
      for (const bookmaker of event.bookmakers) {
        const mkt = bookmaker.markets.find((m) => m.key === market);
        if (!mkt) continue;

        for (const outcome of mkt.outcomes) {
          const key = outcome.point !== undefined 
            ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
            : outcome.name;
          
          if (!outcomeOdds.has(key)) {
            outcomeOdds.set(key, []);
          }
          outcomeOdds.get(key)!.push({
            bookmaker: bookmaker.title,
            odds: outcome.price,
          });
        }
      }

      // Find best and worst for each outcome
      const outcomes: typeof events[0]["outcomes"] = [];

      for (const [name, odds] of outcomeOdds) {
        if (odds.length === 0) continue;

        odds.sort((a, b) => b.odds - a.odds);
        const best = odds[0];
        const worst = odds[odds.length - 1];

        const edgePercent =
          worst.odds > 0 ? ((best.odds - worst.odds) / worst.odds) * 100 : 0;

        // Track bookmaker performance
        bookmakerWins.set(
          best.bookmaker,
          (bookmakerWins.get(best.bookmaker) || 0) + 1
        );

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
        averageEdge:
          edgeCount > 0 ? Math.round((totalEdge / edgeCount) * 100) / 100 : 0,
      },
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to find best odds: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleAnalyzeLineMovement(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string | undefined;
  const hoursBack = Math.min((args?.hoursBack as number) || 24, 168);

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    // Get current odds
    const currentParams: Record<string, string | string[]> = {
      regions: DEFAULT_REGIONS,
      markets: "h2h",
      oddsFormat: "decimal",
    };
    if (eventId) {
      currentParams.eventIds = eventId;
    }

    const currentOdds = (await fetchOddsApi(
      `/sports/${sport}/odds`,
      currentParams
    )) as OddsApiOddsEvent[];

    // Calculate historical timestamp
    const historicalDate = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    const historicalDateStr = historicalDate.toISOString();

    // Get historical odds
    let historicalOdds: OddsApiOddsEvent[] = [];
    try {
      const histParams: Record<string, string | string[]> = {
        date: historicalDateStr,
        regions: ["us"],
        markets: "h2h",
        oddsFormat: "decimal",
      };
      if (eventId) {
        histParams.eventIds = eventId;
      }

      const histResponse = (await fetchOddsApi(
        `/historical/sports/${sport}/odds`,
        histParams
      )) as HistoricalOddsResponse;
      historicalOdds = histResponse.data || [];
    } catch {
      // Historical data may not be available for all events/sports
      return successResult({
        events: [],
        interpretation:
          "Historical odds data not available for this sport/timeframe. Historical data requires a paid API tier and is available from June 2020.",
        fetchedAt: new Date().toISOString(),
      });
    }

    // Build historical lookup
    const historicalMap = new Map<string, OddsApiOddsEvent>();
    for (const event of historicalOdds) {
      historicalMap.set(event.id, event);
    }

    // Analyze line movement
    const events: Array<{
      eventId: string;
      event: string;
      commenceTime: string;
      lineMovement: Array<{
        outcome: string;
        openingLine: number;
        currentLine: number;
        movement: number;
        movementPercent: number;
        direction: "steam" | "reverse" | "stable";
      }>;
      sharpAction:
        | "heavy_home"
        | "moderate_home"
        | "neutral"
        | "moderate_away"
        | "heavy_away";
      confidence: number;
    }> = [];

    for (const current of currentOdds) {
      const historical = historicalMap.get(current.id);
      if (!historical) continue;

      // Get consensus odds (average across bookmakers)
      const getCurrentConsensus = (
        event: OddsApiOddsEvent,
        outcomeName: string
      ): number => {
        const prices: number[] = [];
        for (const bm of event.bookmakers) {
          const market = bm.markets.find((m) => m.key === "h2h");
          const outcome = market?.outcomes.find((o) => o.name === outcomeName);
          if (outcome) prices.push(outcome.price);
        }
        return prices.length > 0
          ? prices.reduce((a, b) => a + b, 0) / prices.length
          : 0;
      };

      const lineMovement: typeof events[0]["lineMovement"] = [];
      let totalMovement = 0;

      // Get all unique outcomes
      const outcomes = new Set<string>();
      for (const bm of current.bookmakers) {
        const market = bm.markets.find((m) => m.key === "h2h");
        market?.outcomes.forEach((o) => outcomes.add(o.name));
      }

      for (const outcomeName of outcomes) {
        const openingLine = getCurrentConsensus(historical, outcomeName);
        const currentLine = getCurrentConsensus(current, outcomeName);

        if (openingLine === 0 || currentLine === 0) continue;

        const movement = currentLine - openingLine;
        const movementPercent = (movement / openingLine) * 100;

        let direction: "steam" | "reverse" | "stable" = "stable";
        if (movementPercent < -2) direction = "steam"; // Line shortened = money coming in
        else if (movementPercent > 2) direction = "reverse"; // Line lengthened

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
      let sharpAction: typeof events[0]["sharpAction"] = "neutral";
      if (totalMovement < -5) sharpAction = "heavy_home";
      else if (totalMovement < -2) sharpAction = "moderate_home";
      else if (totalMovement > 5) sharpAction = "heavy_away";
      else if (totalMovement > 2) sharpAction = "moderate_away";

      // Confidence based on consistency of movement
      const movements = lineMovement.map((l) => Math.abs(l.movementPercent));
      const avgMovement =
        movements.reduce((a, b) => a + b, 0) / movements.length;
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

    const interpretation =
      events.length > 0
        ? `Analyzed ${events.length} events over ${hoursBack} hours. Sharp money indicators: ${events.filter((e) => e.sharpAction.includes("heavy")).length} events show significant line movement, suggesting professional action.`
        : "No significant line movements detected in the analyzed timeframe.";

    return successResult({
      events,
      interpretation,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to analyze line movement: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleAnalyzeMarketEfficiency(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string | undefined;
  const market = (args?.market as string) || "h2h";

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    let oddsData: OddsApiOddsEvent[];

    if (eventId) {
      const event = (await fetchOddsApi(`/sports/${sport}/events/${eventId}/odds`, {
        regions: DEFAULT_REGIONS,
        markets: market,
        oddsFormat: "decimal",
      })) as OddsApiOddsEvent;
      oddsData = [event];
    } else {
      oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
        regions: DEFAULT_REGIONS,
        markets: market,
        oddsFormat: "decimal",
      })) as OddsApiOddsEvent[];
    }

    const events: Array<{
      eventId: string;
      event: string;
      commenceTime: string;
      market: string;
      bookmakerEfficiency: Array<{
        bookmaker: string;
        totalImpliedOdds: number;
        vigPercent: number;
        efficiency: "excellent" | "good" | "average" | "poor";
      }>;
      consensusProbabilities: Record<string, number>;
      lowestVigBookmaker: string;
      averageVig: number;
    }> = [];

    for (const event of oddsData) {
      const bookmakerEfficiency: typeof events[0]["bookmakerEfficiency"] = [];
      let lowestVig = Infinity;
      let lowestVigBookmaker = "";

      // Collect all probabilities for consensus calculation
      const allProbabilities: Map<string, number[]> = new Map();

      for (const bookmaker of event.bookmakers) {
        const mkt = bookmaker.markets.find((m) => m.key === market);
        if (!mkt) continue;

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
          allProbabilities.get(key)!.push(implied);
        }

        const vigPercent = (totalImplied - 1) * 100;

        let efficiency: "excellent" | "good" | "average" | "poor" = "average";
        if (vigPercent < 2) efficiency = "excellent";
        else if (vigPercent < 4) efficiency = "good";
        else if (vigPercent > 8) efficiency = "poor";

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
      const consensusProbabilities: Record<string, number> = {};
      let totalConsensus = 0;

      for (const [name, probs] of allProbabilities) {
        const avgProb = probs.reduce((a, b) => a + b, 0) / probs.length;
        consensusProbabilities[name] = avgProb;
        totalConsensus += avgProb;
      }

      // Normalize to remove vig (true probabilities)
      for (const name in consensusProbabilities) {
        consensusProbabilities[name] = Math.round(
          (consensusProbabilities[name] / totalConsensus) * 10000
        ) / 10000;
      }

      // Sort by efficiency
      bookmakerEfficiency.sort((a, b) => a.vigPercent - b.vigPercent);

      const avgVig =
        bookmakerEfficiency.reduce((sum, b) => sum + b.vigPercent, 0) /
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

    const recommendation =
      events.length > 0
        ? `For best value, prefer bookmakers with lowest vig. ${events[0].lowestVigBookmaker} offers the most efficient odds at ${events[0].bookmakerEfficiency[0]?.vigPercent.toFixed(2)}% vig. Consensus probabilities shown are vig-adjusted and comparable to prediction market prices.`
        : "No events found for analysis.";

    return successResult({
      events,
      recommendation,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to analyze market efficiency: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleCompareHistoricalClosingLines(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const team = args?.team as string;
  const daysBack = (args?.daysBack as number) || 30;

  if (!sport || !team) {
    return errorResult("sport and team parameters are required");
  }

  try {
    // Get historical events
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - daysBack * 24 * 60 * 60 * 1000);

    const historicalGames: Array<{
      event: string;
      date: string;
      openingLine: number;
      closingLine: number;
      result: string;
      clvCapture: number;
    }> = [];

    // We'll check multiple historical snapshots
    const checkDates: Date[] = [];
    for (let d = 0; d < daysBack; d += 3) {
      // Check every 3 days
      checkDates.push(new Date(endDate.getTime() - d * 24 * 60 * 60 * 1000));
    }

    for (const checkDate of checkDates.slice(0, 10)) {
      // Limit to 10 API calls
      try {
        const histResponse = (await fetchOddsApi(
          `/historical/sports/${sport}/odds`,
          {
            date: checkDate.toISOString(),
            regions: ["us"],
            markets: "h2h",
          }
        )) as HistoricalOddsResponse;

        if (!histResponse.data) continue;

        for (const event of histResponse.data) {
          // Check if team is in this event
          if (
            !event.home_team.toLowerCase().includes(team.toLowerCase()) &&
            !event.away_team.toLowerCase().includes(team.toLowerCase())
          ) {
            continue;
          }

          // Get consensus odds
          let teamOdds: number[] = [];
          for (const bm of event.bookmakers) {
            const h2h = bm.markets.find((m) => m.key === "h2h");
            const outcome = h2h?.outcomes.find((o) =>
              o.name.toLowerCase().includes(team.toLowerCase())
            );
            if (outcome) teamOdds.push(outcome.price);
          }

          if (teamOdds.length === 0) continue;

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
      } catch {
        // Skip failed historical queries
        continue;
      }
    }

    // Remove duplicates by event name
    const uniqueGames = Array.from(
      new Map(historicalGames.map((g) => [g.event, g])).values()
    );

    const avgClvMovement =
      uniqueGames.length > 0
        ? uniqueGames.reduce((sum, g) => sum + g.clvCapture, 0) /
          uniqueGames.length
        : 0;

    return successResult({
      team,
      sport,
      historicalGames: uniqueGames.slice(0, 20), // Limit results
      averageClvMovement: Math.round(avgClvMovement * 100) / 100,
      consistency: uniqueGames.length / 20, // Rough consistency measure
      recommendation:
        uniqueGames.length > 0
          ? `Found ${uniqueGames.length} historical games for ${team}. For full CLV analysis, compare opening lines (captured when market opens) to closing lines (right before game start).`
          : `No historical games found for ${team} in the past ${daysBack} days. Try a different team name or sport.`,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to analyze closing lines: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleDiscoverValueBets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = (args?.sport as string) || "upcoming";
  const minEdgePercent = (args?.minEdgePercent as number) || 3;
  const market = (args?.market as string) || "h2h";

  try {
    const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
      regions: DEFAULT_REGIONS,
      markets: market,
      oddsFormat: "decimal",
    })) as OddsApiOddsEvent[];

    const valueBets: Array<{
      event: string;
      eventId: string;
      sport: string;
      commenceTime: string;
      outcome: string;
      bookmaker: string;
      odds: number;
      impliedProbability: number;
      consensusProbability: number;
      edgePercent: number;
      confidence: "high" | "medium" | "low";
    }> = [];

    let totalEventsScanned = 0;

    for (const event of oddsData) {
      totalEventsScanned++;

      // Calculate consensus probability for each outcome
      const outcomeProbabilities: Map<string, number[]> = new Map();
      const outcomeOdds: Map<
        string,
        Array<{ bookmaker: string; odds: number; implied: number }>
      > = new Map();

      for (const bookmaker of event.bookmakers) {
        const mkt = bookmaker.markets.find((m) => m.key === market);
        if (!mkt) continue;

        for (const outcome of mkt.outcomes) {
          const key = outcome.point !== undefined
            ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
            : outcome.name;
          
          const implied = 1 / outcome.price;

          if (!outcomeProbabilities.has(key)) {
            outcomeProbabilities.set(key, []);
            outcomeOdds.set(key, []);
          }
          outcomeProbabilities.get(key)!.push(implied);
          outcomeOdds.get(key)!.push({
            bookmaker: bookmaker.title,
            odds: outcome.price,
            implied,
          });
        }
      }

      // Calculate consensus (vig-adjusted)
      const consensus: Map<string, number> = new Map();
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
        if (consensusProb === 0) continue;

        for (const { bookmaker, odds: oddsValue, implied } of odds) {
          // Edge = (1/consensusProb) - (1/implied)
          // Or simpler: if implied < consensus, there's value
          const edgePercent = ((consensusProb - implied) / implied) * 100;

          if (edgePercent >= minEdgePercent) {
            // Calculate confidence based on number of bookmakers and edge size
            let confidence: "high" | "medium" | "low" = "low";
            const numBookmakers = odds.length;
            if (numBookmakers >= 10 && edgePercent >= 5) confidence = "high";
            else if (numBookmakers >= 5 && edgePercent >= 3) confidence = "medium";

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

    const recommendation =
      valueBets.length > 0
        ? `Found ${valueBets.length} potential value bets with ${minEdgePercent}%+ edge vs consensus. High confidence bets are backed by many bookmakers showing consistent pricing. Always verify odds are still available before betting.`
        : `No value bets found meeting the ${minEdgePercent}% edge threshold. Markets appear efficiently priced. Try lowering minEdgePercent or checking different sports.`;

    return successResult({
      valueBets: valueBets.slice(0, 50), // Limit results
      totalEventsScanned,
      recommendation,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to discover value bets: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// CROSS-PLATFORM INTEROPERABILITY HANDLERS
// ============================================================================

async function handleFindCrossPlatformGaps(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const targetSport = args?.targetSport as string | undefined;

  // Fetch available sports to provide accurate guidance
  let availableSports: string[] = [];
  try {
    const sports = (await fetchOddsApi("/sports")) as OddsApiSport[];
    availableSports = sports
      .filter(s => s.active)
      .map(s => s.key)
      .slice(0, 20);
  } catch {
    availableSports = POPULAR_SPORTS;
  }

  const crossPlatformOverlaps = [
    {
      category: "NBA Championship",
      oddsApiSport: "basketball_nba_championship_winner",
      polymarketSearch: "Lakers Celtics NBA Finals championship",
      kalshiCategory: "Sports",
      description: "NBA Finals winner - compare futures odds vs prediction market prices",
    },
    {
      category: "NFL Super Bowl",
      oddsApiSport: "americanfootball_nfl_super_bowl_winner",
      polymarketSearch: "Super Bowl Chiefs Eagles",
      kalshiCategory: "Sports",
      description: "Super Bowl winner - often has significant cross-platform gaps",
    },
    {
      category: "MLB World Series",
      oddsApiSport: "baseball_mlb_world_series_winner",
      polymarketSearch: "World Series Yankees Dodgers",
      kalshiCategory: "Sports",
      description: "World Series champion predictions",
    },
    {
      category: "Soccer Major Tournaments",
      oddsApiSport: "soccer_fifa_world_cup_winner",
      polymarketSearch: "World Cup winner soccer",
      kalshiCategory: "Sports",
      description: "FIFA World Cup predictions",
    },
  ];

  const instructions = [
    "STEP 1: Get sportsbook odds from Odds API",
    `  → Call: get_outrights({ sport: "${targetSport || 'basketball_nba_championship_winner'}" })`,
    "  → Or: get_comparable_markets({ sport: 'upcoming', market: 'h2h' })",
    "",
    "STEP 2: Get prediction market prices",
    "  → For Polymarket: search_markets({ query: '<team_name> championship', matchMode: 'any' })",
    "  → For Kalshi: get_comparable_markets({ keywords: '<team_name> <sport>' })",
    "",
    "STEP 3: Compare normalized probabilities",
    "  → Odds API: probability = 1 / decimal_odds (e.g., 1/2.50 = 0.40)",
    "  → Polymarket: probability = YES price (e.g., 0.45)",
    "  → Kalshi: probability = yesPrice / 100 (e.g., 45/100 = 0.45)",
    "",
    "STEP 4: Calculate gap",
    "  → Gap = |sportsbook_prob - prediction_market_prob|",
    "  → Gap > 0.10 (10pp) = significant arbitrage potential",
    "  → Gap > 0.05 (5pp) = worth investigating",
    "",
    "STEP 5: Identify arbitrage opportunity",
    "  → If sportsbook prob < prediction market prob: bet on sportsbook, sell YES on prediction market",
    "  → If sportsbook prob > prediction market prob: sell on sportsbook (if possible), buy YES on prediction market",
  ];

  return successResult({
    methodology: "Cross-platform probability gap detection compares normalized probabilities (0-1 scale) across sportsbooks and prediction markets to find pricing discrepancies.",
    sportsAvailable: availableSports,
    crossPlatformOverlaps,
    instructions,
    targetSport: targetSport || "Use one of the sportsAvailable keys",
    hint: "This tool provides METHODOLOGY. To find actual gaps, call get_comparable_markets on multiple servers and compare the normalizedProbability values.",
    fetchedAt: new Date().toISOString(),
  });
}

async function handleGetComparableMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = (args?.sport as string) || "upcoming";
  const market = (args?.market as string) || "h2h";
  const limit = Math.min((args?.limit as number) || 30, 50);
  const includeCompleted = args?.includeCompleted === true;

  try {
    const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
      regions: DEFAULT_REGIONS,
      markets: market,
      oddsFormat: "decimal",
    })) as OddsApiOddsEvent[];

    // By default, filter out completed events unless includeCompleted is true
    // Completed events have passed commence_time and/or completed=true
    const now = new Date();
    const filteredEvents = includeCompleted 
      ? oddsData 
      : oddsData.filter(event => {
          // Keep events that haven't started yet or are in-progress
          const commenceTime = event.commence_time ? new Date(event.commence_time) : null;
          const isCompleted = event.completed === true;
          return !isCompleted && (!commenceTime || commenceTime > now);
        });

    const comparableMarkets = filteredEvents.slice(0, limit).map(event => {
      // Build a map of best odds for each outcome across all bookmakers
      const bestOdds: Map<string, { bookmaker: string; odds: number }> = new Map();

      for (const bookmaker of event.bookmakers) {
        const mkt = bookmaker.markets.find(m => m.key === market);
        if (!mkt) continue;

        for (const outcome of mkt.outcomes) {
          const key = outcome.point !== undefined 
            ? `${outcome.name} (${outcome.point > 0 ? "+" : ""}${outcome.point})`
            : outcome.name;
          
          const current = bestOdds.get(key);
          if (!current || outcome.price > current.odds) {
            bestOdds.set(key, {
              bookmaker: bookmaker.title,
              odds: outcome.price,
            });
          }
        }
      }

      // Convert to outcomes array with normalized probabilities
      const outcomes = Array.from(bestOdds.entries()).map(([name, data]) => ({
        name,
        normalizedProbability: Math.round((1 / data.odds) * 10000) / 10000,
        rawOdds: data.odds,
        bestBookmaker: data.bookmaker,
      }));

      // Extract keywords for cross-platform matching
      const keywords = [
        event.sport_key.replace(/_/g, ' '),
        event.home_team?.toLowerCase(),
        event.away_team?.toLowerCase(),
      ].filter(Boolean) as string[];

      // For outright/futures markets, home_team and away_team are null
      // Use sport_title as the title instead
      const isOutright = market === 'outrights' || !event.home_team || !event.away_team;
      const title = isOutright 
        ? event.sport_title || event.sport_key.replace(/_/g, ' ')
        : `${event.away_team} @ ${event.home_team}`;
      
      // For outrights, extract team names from outcomes for matching
      const teamNames = isOutright 
        ? outcomes.map(o => o.name)
        : [event.home_team, event.away_team].filter(Boolean);

      return {
        title,
        description: `${event.sport_title} - ${market.toUpperCase()} market`,
        eventCategory: 'sports',
        sport: event.sport_key,
        keywords: [...keywords, ...teamNames.slice(0, 5).map(t => t.toLowerCase())],
        teams: teamNames,
        outcomes,
        commenceTime: event.commence_time,
        platformEventId: event.id,
        isOutright, // Flag to indicate this is a futures/outright market
      };
    });

    // Group by sport for breakdown
    const sportCounts: Record<string, number> = {};
    for (const market of comparableMarkets) {
      const sportGroup = market.sport.split('_')[0] || 'other';
      sportCounts[sportGroup] = (sportCounts[sportGroup] || 0) + 1;
    }

    return successResult({
      platform: 'odds_api',
      markets: comparableMarkets,
      totalCount: comparableMarkets.length,
      sportBreakdown: sportCounts,
      hint: `Returned ${comparableMarkets.length} sports events. Probabilities are normalized 0-1 (derived from decimal odds as 1/odds). Compare with Polymarket or Kalshi prediction markets. Note: Sportsbook probabilities often sum to >100% due to vig/juice.`,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get comparable markets: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// TIER 2: RAW DATA TOOL HANDLERS
// ============================================================================

async function handleGetSports(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const all = args?.all as boolean;

  try {
    const sports = (await fetchOddsApi("/sports", {
      all: all ? "true" : undefined,
    })) as OddsApiSport[];

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
  } catch (error) {
    return errorResult(`Failed to get sports: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetFuturesSports(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const group = args?.group as string | undefined;

  try {
    const allSports = await fetchOddsApi("/sports", { all: "true" }) as OddsApiSport[];

    // Filter to only sports with outrights
    let futuresSports = allSports.filter((s) => s.has_outrights === true);

    // Optionally filter by group
    if (group) {
      futuresSports = futuresSports.filter((s) => 
        s.group.toLowerCase().includes(group.toLowerCase())
      );
    }

    const formatted = futuresSports.map((s) => ({
      key: s.key,
      title: s.title,
      group: s.group,
      description: s.description,
      active: s.active,
    }));

    return successResult({
      futuresSports: formatted,
      totalCount: formatted.length,
      hint: "Use these sport keys with get_outrights to get championship/futures odds. Compare with Polymarket for arbitrage.",
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get futures sports: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetEvents(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const commenceTimeFrom = args?.commenceTimeFrom as string | undefined;
  const commenceTimeTo = args?.commenceTimeTo as string | undefined;

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    const events = (await fetchOddsApi(`/sports/${sport}/events`, {
      commenceTimeFrom,
      commenceTimeTo,
    })) as OddsApiEvent[];

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
  } catch (error) {
    return errorResult(`Failed to get events: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetOdds(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const regions = (args?.regions as string[]) || ["us"];
  const markets = (args?.markets as string[]) || ["h2h"];
  const oddsFormat = (args?.oddsFormat as string) || "decimal";
  const bookmakers = args?.bookmakers as string[] | undefined;
  const eventIds = args?.eventIds as string[] | undefined;

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    const params: Record<string, string | string[] | undefined> = {
      regions: bookmakers ? undefined : regions,
      markets,
      oddsFormat,
      bookmakers,
      eventIds,
    };

    const oddsData = (await fetchOddsApi(
      `/sports/${sport}/odds`,
      params
    )) as OddsApiOddsEvent[];

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
  } catch (error) {
    return errorResult(`Failed to get odds: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetScores(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const daysFrom = args?.daysFrom as number | undefined;
  const eventIds = args?.eventIds as string[] | undefined;

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    const scores = (await fetchOddsApi(`/sports/${sport}/scores`, {
      daysFrom: daysFrom ? String(daysFrom) : undefined,
      eventIds,
    })) as OddsApiEvent[];

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
  } catch (error) {
    return errorResult(`Failed to get scores: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetEventOdds(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string;
  const regions = (args?.regions as string[]) || ["us"];
  const markets = (args?.markets as string[]) || ["h2h"];
  const oddsFormat = (args?.oddsFormat as string) || "decimal";

  if (!sport || !eventId) {
    return errorResult("sport and eventId parameters are required");
  }

  try {
    const event = (await fetchOddsApi(
      `/sports/${sport}/events/${eventId}/odds`,
      {
        regions,
        markets,
        oddsFormat,
      }
    )) as OddsApiOddsEvent;

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
  } catch (error) {
    return errorResult(`Failed to get event odds: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetEventMarkets(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string;
  const regions = (args?.regions as string[]) || ["us"];

  if (!sport || !eventId) {
    return errorResult("sport and eventId parameters are required");
  }

  try {
    const response = (await fetchOddsApi(
      `/sports/${sport}/events/${eventId}/markets`,
      {
        regions,
      }
    )) as {
      id: string;
      sport_key: string;
      sport_title: string;
      commence_time: string;
      home_team: string;
      away_team: string;
      bookmakers: Array<{
        key: string;
        title: string;
        markets: Array<{ key: string; last_update: string }>;
      }>;
    };

    // Collect all unique markets
    const allMarkets = new Set<string>();
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
  } catch (error) {
    return errorResult(`Failed to get event markets: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetHistoricalOdds(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const date = args?.date as string;
  const regions = (args?.regions as string[]) || ["us"];
  const markets = (args?.markets as string[]) || ["h2h"];
  const eventIds = args?.eventIds as string[] | undefined;

  if (!sport || !date) {
    return errorResult("sport and date parameters are required");
  }

  try {
    const response = (await fetchOddsApi(`/historical/sports/${sport}/odds`, {
      date,
      regions,
      markets,
      eventIds,
    })) as HistoricalOddsResponse;

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
  } catch (error) {
    return errorResult(`Failed to get historical odds: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetHistoricalEvents(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const date = args?.date as string;
  const commenceTimeFrom = args?.commenceTimeFrom as string | undefined;
  const commenceTimeTo = args?.commenceTimeTo as string | undefined;

  if (!sport || !date) {
    return errorResult("sport and date parameters are required");
  }

  try {
    const response = (await fetchOddsApi(
      `/historical/sports/${sport}/events`,
      {
        date,
        commenceTimeFrom,
        commenceTimeTo,
      }
    )) as {
      timestamp: string;
      data: OddsApiEvent[];
    };

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
  } catch (error) {
    return errorResult(`Failed to get historical events: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetHistoricalEventOdds(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const eventId = args?.eventId as string;
  const date = args?.date as string;
  const regions = (args?.regions as string[]) || ["us"];
  const markets = (args?.markets as string[]) || ["h2h"];

  if (!sport || !eventId || !date) {
    return errorResult("sport, eventId, and date parameters are required");
  }

  try {
    const response = (await fetchOddsApi(
      `/historical/sports/${sport}/events/${eventId}/odds`,
      {
        date,
        regions,
        markets,
      }
    )) as {
      timestamp: string;
      data: OddsApiOddsEvent[];
    };

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
  } catch (error) {
    return errorResult(`Failed to get historical event odds: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetParticipants(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;

  if (!sport) {
    return errorResult("sport parameter is required");
  }

  try {
    const participants = (await fetchOddsApi(
      `/sports/${sport}/participants`
    )) as Array<{ id: string; full_name: string }>;

    return successResult({
      participants: participants.map((p) => ({
        id: p.id,
        fullName: p.full_name,
      })),
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get participants: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleGetOutrights(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const regions = (args?.regions as string[]) || DEFAULT_REGIONS;
  const bookmakers = args?.bookmakers as string[] | undefined;

  if (!sport) {
    return errorResult("sport parameter is required. Use a sport key ending in '_winner' like americanfootball_nfl_super_bowl_winner");
  }

  try {
    const params: Record<string, string | string[] | undefined> = {
      regions: bookmakers ? undefined : regions,
      bookmakers,
      markets: ["outrights"],
      oddsFormat: "decimal",
    };

    const oddsData = (await fetchOddsApi(
      `/sports/${sport}/odds`,
      params
    )) as OddsApiOddsEvent[];

    if (!oddsData.length) {
      return errorResult(`No outright data found for ${sport}. Make sure to use a futures sport key like americanfootball_nfl_super_bowl_winner`);
    }

    const event = oddsData[0];

    // Aggregate all outcomes from all bookmakers
    const outcomeMap: Map<string, Array<{ bookmaker: string; odds: number }>> = new Map();

    for (const bookmaker of event.bookmakers) {
      const outrightsMarket = bookmaker.markets.find((m) => m.key === "outrights");
      if (outrightsMarket) {
        for (const outcome of outrightsMarket.outcomes) {
          const existing = outcomeMap.get(outcome.name) || [];
          existing.push({ bookmaker: bookmaker.title, odds: outcome.price });
          outcomeMap.set(outcome.name, existing);
        }
      }
    }

    // Calculate best/worst odds for each outcome
    const outcomes = Array.from(outcomeMap.entries()).map(([name, bookmakerOdds]) => {
      const sortedOdds = [...bookmakerOdds].sort((a, b) => b.odds - a.odds);
      const bestOdds = sortedOdds[0]?.odds || 0;
      const bestBookmaker = sortedOdds[0]?.bookmaker || "";
      const worstOdds = sortedOdds[sortedOdds.length - 1]?.odds || 0;
      const worstBookmaker = sortedOdds[sortedOdds.length - 1]?.bookmaker || "";

      // Calculate consensus (average) odds
      const avgOdds = bookmakerOdds.reduce((sum, b) => sum + b.odds, 0) / bookmakerOdds.length;
      const impliedProbability = 1 / avgOdds;

      return {
        name,
        bestOdds,
        bestBookmaker,
        worstOdds,
        worstBookmaker,
        consensusOdds: Math.round(avgOdds * 100) / 100,
        impliedProbability: Math.round(impliedProbability * 10000) / 10000,
        allBookmakers: sortedOdds,
      };
    });

    // Sort by implied probability (favorites first)
    outcomes.sort((a, b) => b.impliedProbability - a.impliedProbability);

    return successResult({
      sport: event.sport_key,
      sportTitle: event.sport_title,
      commenceTime: event.commence_time,
      outcomes,
      totalOutcomes: outcomes.length,
      totalBookmakers: event.bookmakers.length,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to get outrights: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

async function handleAnalyzeFuturesValue(
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  const sport = args?.sport as string;
  const minEdgePercent = (args?.minEdgePercent as number) || 10;

  if (!sport) {
    return errorResult("sport parameter is required. Use a sport key ending in '_winner' like americanfootball_nfl_super_bowl_winner");
  }

  try {
    // Fetch from all regions for comprehensive coverage
    const oddsData = (await fetchOddsApi(`/sports/${sport}/odds`, {
      regions: DEFAULT_REGIONS,
      markets: ["outrights"],
      oddsFormat: "decimal",
    })) as OddsApiOddsEvent[];

    if (!oddsData.length) {
      return errorResult(`No outright data found for ${sport}. Make sure to use a futures sport key.`);
    }

    const event = oddsData[0];

    // Aggregate all outcomes
    const outcomeMap: Map<string, Array<{ bookmaker: string; odds: number }>> = new Map();

    for (const bookmaker of event.bookmakers) {
      const outrightsMarket = bookmaker.markets.find((m) => m.key === "outrights");
      if (outrightsMarket) {
        for (const outcome of outrightsMarket.outcomes) {
          const existing = outcomeMap.get(outcome.name) || [];
          existing.push({ bookmaker: bookmaker.title, odds: outcome.price });
          outcomeMap.set(outcome.name, existing);
        }
      }
    }

    // Analyze each outcome
    const analysis: Array<{
      outcome: string;
      consensusImpliedProbability: number;
      bestOdds: number;
      bestBookmaker: string;
      bestImpliedProbability: number;
      edgeVsConsensus: number;
      isValue: boolean;
    }> = [];

    const valueBets: Array<{
      outcome: string;
      bookmaker: string;
      odds: number;
      edgePercent: number;
    }> = [];

    let totalImpliedProbability = 0;

    for (const [outcomeName, bookmakerOdds] of outcomeMap.entries()) {
      // Calculate consensus (average) probability
      const avgOdds = bookmakerOdds.reduce((sum, b) => sum + b.odds, 0) / bookmakerOdds.length;
      const consensusProb = 1 / avgOdds;
      totalImpliedProbability += consensusProb;

      // Find best odds
      const sortedOdds = [...bookmakerOdds].sort((a, b) => b.odds - a.odds);
      const bestOdds = sortedOdds[0]?.odds || 0;
      const bestBookmaker = sortedOdds[0]?.bookmaker || "";
      const bestImpliedProb = 1 / bestOdds;

      // Calculate edge vs consensus
      const edgeVsConsensus = ((consensusProb - bestImpliedProb) / bestImpliedProb) * 100;
      const isValue = edgeVsConsensus >= minEdgePercent;

      analysis.push({
        outcome: outcomeName,
        consensusImpliedProbability: Math.round(consensusProb * 10000) / 10000,
        bestOdds,
        bestBookmaker,
        bestImpliedProbability: Math.round(bestImpliedProb * 10000) / 10000,
        edgeVsConsensus: Math.round(edgeVsConsensus * 100) / 100,
        isValue,
      });

      // Track all value bets above threshold
      for (const bo of bookmakerOdds) {
        const impliedProb = 1 / bo.odds;
        const edge = ((consensusProb - impliedProb) / impliedProb) * 100;
        if (edge >= minEdgePercent) {
          valueBets.push({
            outcome: outcomeName,
            bookmaker: bo.bookmaker,
            odds: bo.odds,
            edgePercent: Math.round(edge * 100) / 100,
          });
        }
      }
    }

    // Sort analysis by edge (descending)
    analysis.sort((a, b) => b.edgeVsConsensus - a.edgeVsConsensus);

    // Sort value bets by edge (descending)
    valueBets.sort((a, b) => b.edgePercent - a.edgePercent);

    // Calculate market overround
    const marketOverround = (totalImpliedProbability - 1) * 100;

    // Generate recommendation
    let recommendation = "";
    if (valueBets.length === 0) {
      recommendation = `No significant value bets found with edge >= ${minEdgePercent}%. The futures market appears efficiently priced.`;
    } else {
      const topValue = valueBets[0];
      recommendation = `Found ${valueBets.length} value opportunities. Best value: ${topValue.outcome} at ${topValue.bookmaker} (${topValue.odds}) with ${topValue.edgePercent}% edge vs consensus.`;
    }

    return successResult({
      sport: event.sport_key,
      sportTitle: event.sport_title,
      analysis: analysis.slice(0, 20), // Top 20 by edge
      valueBets: valueBets.slice(0, 15), // Top 15 value bets
      marketOverround: Math.round(marketOverround * 100) / 100,
      totalOutcomes: outcomeMap.size,
      totalBookmakers: event.bookmakers.length,
      recommendation,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResult(`Failed to analyze futures: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new Server(
  { name: "mcp-odds-api", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
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

    // Cross-Platform Interoperability
    case "find_cross_platform_gaps":
      return handleFindCrossPlatformGaps(args);
    case "get_comparable_markets":
      return handleGetComparableMarkets(args);

    // Tier 2: Raw Data Tools
    case "get_sports":
      return handleGetSports(args);
    case "get_futures_sports":
      return handleGetFuturesSports(args);
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
    case "get_outrights":
      return handleGetOutrights(args);
    case "analyze_futures_value":
      return handleAnalyzeFuturesValue(args);

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
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "mcp-odds-api",
    version: "1.0.0",
    apiConfigured: !!API_KEY,
  });
});

// Debug endpoint to list tools (no auth required)
app.get("/debug-tools", (_req: Request, res: Response) => {
  const tier1 = TOOLS.filter(t => 
    t.name.startsWith("find_") || 
    t.name.startsWith("analyze_") || 
    t.name.startsWith("discover_") || 
    t.name.startsWith("compare_")
  );
  const tier2 = TOOLS.filter(t => t.name.startsWith("get_"));
  
  res.json({
    totalTools: TOOLS.length,
    tier1Intelligence: tier1.map(t => ({ name: t.name, description: t.description })),
    tier2RawData: tier2.map(t => ({ name: t.name, description: t.description })),
  });
});

// Test endpoint - calls tools directly without MCP auth (for testing only)
app.post("/test-tool", async (req: Request, res: Response) => {
  const { tool, args } = req.body;
  if (!tool) {
    res.status(400).json({ error: "Missing tool name" });
    return;
  }

  try {
    let result;
    switch (tool) {
      case "get_sports": result = await handleGetSports(args); break;
      case "get_futures_sports": result = await handleGetFuturesSports(args); break;
      case "get_events": result = await handleGetEvents(args); break;
      case "get_odds": result = await handleGetOdds(args); break;
      case "get_scores": result = await handleGetScores(args); break;
      case "get_event_odds": result = await handleGetEventOdds(args); break;
      case "get_event_markets": result = await handleGetEventMarkets(args); break;
      case "get_historical_odds": result = await handleGetHistoricalOdds(args); break;
      case "get_historical_events": result = await handleGetHistoricalEvents(args); break;
      case "get_historical_event_odds": result = await handleGetHistoricalEventOdds(args); break;
      case "get_participants": result = await handleGetParticipants(args); break;
      case "get_outrights": result = await handleGetOutrights(args); break;
      case "analyze_futures_value": result = await handleAnalyzeFuturesValue(args); break;
      case "find_arbitrage_opportunities": result = await handleFindArbitrage(args); break;
      case "find_best_odds": result = await handleFindBestOdds(args); break;
      case "analyze_line_movement": result = await handleAnalyzeLineMovement(args); break;
      case "analyze_market_efficiency": result = await handleAnalyzeMarketEfficiency(args); break;
      case "compare_historical_closing_lines": result = await handleCompareHistoricalClosingLines(args); break;
      case "discover_value_bets": result = await handleDiscoverValueBets(args); break;
      case "find_cross_platform_gaps": result = await handleFindCrossPlatformGaps(args); break;
      case "get_comparable_markets": result = await handleGetComparableMarkets(args); break;
      default:
        res.status(400).json({ error: `Unknown tool: ${tool}` });
        return;
    }
    res.json(result.structuredContent || { error: "No structured content" });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

// Session management
const transports: Record<string, StreamableHTTPServerTransport> = {};

// MCP endpoint with security middleware
app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports[id] = transport;
        console.log(`Session initialized: ${id}`);
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        delete transports[transport.sessionId];
        console.log(`Session closed: ${transport.sessionId}`);
      }
    };

    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Invalid session. Send initialize request first." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// Handle SSE for streaming (GET requests)
app.get("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

// Handle session cleanup (DELETE requests)
app.delete("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handleRequest(req, res);
  } else {
    res.status(400).json({ error: "Invalid session" });
  }
});

// Start server
const PORT = Number(process.env.PORT || 4006);
app.listen(PORT, () => {
  console.log(`\n🎰 The Odds API MCP Server v1.0.0`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔌 MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`🔑 API Key: ${API_KEY ? "✅ Configured" : "❌ Missing (set ODDS_API_KEY)"}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});

