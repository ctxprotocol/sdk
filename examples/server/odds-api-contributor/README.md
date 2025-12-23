# The Odds API MCP Server

A "giga-brained" MCP server for sports betting odds analysis. Aggregates odds from 50+ bookmakers across multiple regions, detects arbitrage opportunities, analyzes line movements using historical data, and provides real-time odds comparisons.

## Features

### Tier 1: Intelligence Tools (High-Value Analysis)

| Tool | Description |
|------|-------------|
| `find_arbitrage_opportunities` | Scan all bookmakers to find guaranteed profit opportunities by betting both sides |
| `find_best_odds` | Find the best available odds across all bookmakers for any event |
| `analyze_line_movement` | Track how odds change over time to detect sharp money action |
| `analyze_market_efficiency` | Calculate vig/juice and true implied probabilities (comparable to Polymarket prices) |
| `compare_historical_closing_lines` | Analyze CLV (Closing Line Value) for a team using historical data |
| `discover_value_bets` | Find odds that differ significantly from market consensus |

### Tier 2: Raw Data Tools (Direct API Access)

| Tool | Description | Quota Cost |
|------|-------------|------------|
| `get_sports` | List all available sports | Free |
| `get_events` | Get upcoming/live events for a sport | Free |
| `get_odds` | Get live odds from multiple bookmakers | 1 per region × market |
| `get_scores` | Get live scores and recent results | 1 |
| `get_event_odds` | Get detailed odds for a specific event (including props) | 1 per region × market |
| `get_event_markets` | Get available markets for an event | 1 |
| `get_historical_odds` | Get historical odds snapshot at a point in time | 1 |
| `get_historical_events` | Get historical events list | 1 |
| `get_historical_event_odds` | Get historical odds for specific event | 1 |
| `get_participants` | Get teams/players for a sport | Free |

## Integration with Polymarket

This server is designed to work alongside the Polymarket MCP server. The `analyze_market_efficiency` tool outputs **vig-adjusted consensus probabilities** that are directly comparable to Polymarket prices. This enables:

- Comparing sportsbook implied odds to prediction market prices
- Finding discrepancies between traditional betting markets and prediction markets
- Identifying arbitrage opportunities across market types

Example workflow:
```
1. Use odds-api to get consensus probability for "Team X to win championship" (e.g., 35%)
2. Use polymarket to get current price for same outcome (e.g., $0.32)
3. If significant difference exists, there may be value in one market
```

## Quick Start

### 1. Get API Key

Sign up at [The Odds API](https://the-odds-api.com/) to get your API key.

- **Free tier**: 500 requests/month (limited to live odds)
- **Paid tier**: Historical data, more requests, player props

### 2. Install Dependencies

```bash
cd examples/server/odds-api-contributor
npm install
```

### 3. Configure Environment

```bash
cp env.example .env
# Edit .env and add your API key
```

### 4. Run the Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start
```

### 5. Test

```bash
curl http://localhost:4006/health
```

## API Key Tiers

| Feature | Free | Paid |
|---------|------|------|
| Live odds | ✅ | ✅ |
| Historical odds | ❌ | ✅ |
| Player props | ❌ | ✅ |
| Line movement analysis | ❌ | ✅ |
| Closing line value | ❌ | ✅ |

## Supported Sports

The API supports 50+ sports including:

- **American Football**: NFL, NCAAF
- **Basketball**: NBA, NCAAB, EuroLeague
- **Baseball**: MLB
- **Hockey**: NHL
- **Soccer**: EPL, La Liga, Serie A, Bundesliga, Champions League, MLS
- **Combat Sports**: UFC/MMA, Boxing
- **Tennis**: ATP, WTA
- **Golf**: PGA
- **And many more...**

Use `get_sports` to see all currently active sports.

## Supported Bookmakers

Bookmakers are grouped by region:

- **US**: DraftKings, FanDuel, BetMGM, Caesars, PointsBet, Barstool, etc.
- **US2**: Additional US books (BetRivers, Unibet, etc.)
- **UK**: Bet365, William Hill, Ladbrokes, Coral, etc.
- **EU**: Pinnacle, Betfair, 1xBet, Unibet EU, etc.
- **AU**: Sportsbet, TAB, Neds, Ladbrokes AU, etc.

## Example Usage

### Find Arbitrage Opportunities

```json
{
  "name": "find_arbitrage_opportunities",
  "arguments": {
    "sport": "basketball_nba",
    "minProfitPercent": 1.0
  }
}
```

### Get Best Odds for NFL

```json
{
  "name": "find_best_odds", 
  "arguments": {
    "sport": "americanfootball_nfl",
    "market": "spreads"
  }
}
```

### Analyze Market Efficiency

```json
{
  "name": "analyze_market_efficiency",
  "arguments": {
    "sport": "basketball_nba",
    "market": "h2h"
  }
}
```

### Get Historical Odds

```json
{
  "name": "get_historical_odds",
  "arguments": {
    "sport": "americanfootball_nfl",
    "date": "2024-01-15T12:00:00Z",
    "markets": ["h2h", "spreads"]
  }
}
```

## Quota Management

The API uses a credit-based quota system:

- **Cost formula**: `regions × markets`
- **Example**: 2 regions × 3 markets = 6 credits

Tips for efficient usage:
1. Use specific `eventIds` when possible
2. Request only needed markets
3. Use fewer regions for preliminary scans
4. Cache results for frequently accessed data

## Response Format

All tools return structured responses with:

```json
{
  "data": { ... },
  "fetchedAt": "2024-01-15T12:00:00Z"
}
```

Intelligence tools also include:
- `recommendation`: Actionable insights
- `confidence`: 0-1 confidence score
- `dataFreshness`: "real-time" | "historical"

## Rate Limits

The Odds API has rate limits based on your plan:
- **Free**: 5 requests/second
- **Paid**: Higher limits based on tier

The server handles rate limiting gracefully with appropriate error messages.

## Documentation

- [The Odds API Documentation](https://the-odds-api.com/liveapi/guides/v4/)
- [Supported Sports List](https://the-odds-api.com/sports-odds-data/sports-apis.html)
- [Bookmakers by Region](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html)

## License

MIT

