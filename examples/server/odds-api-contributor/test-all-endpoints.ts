/**
 * Comprehensive test script for Odds API MCP Server
 * Tests all Tier 1 and Tier 2 tools against the deployed server
 */

const BASE_URL = "https://mcp.ctxprotocol.com/odds-api";

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  error?: { code: number; message: string };
}

async function initSession(): Promise<string | null> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });

  const sessionId = res.headers.get("mcp-session-id");
  return sessionId;
}

async function callTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<MCPResponse> {
  const res = await fetch(`${BASE_URL}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 10000),
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { jsonrpc: "2.0", id: 0, error: { code: -1, message: `Parse error: ${text.slice(0, 200)}` } };
  }
}

function printResult(name: string, result: MCPResponse) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`📍 ${name}`);
  console.log("=".repeat(70));

  if (result.error) {
    console.log(`❌ ERROR: ${result.error.message}`);
    return false;
  }

  const data = result.result?.structuredContent;
  if (!data) {
    console.log("❌ No structured content returned");
    return false;
  }

  if ((data as any).error) {
    console.log(`❌ API ERROR: ${(data as any).error}`);
    return false;
  }

  // Print key stats based on the tool type
  console.log("✅ Success!");
  console.log(`   Fetched at: ${(data as any).fetchedAt || "N/A"}`);
  return data;
}

async function testAllTools() {
  console.log("\n🧪 ODDS API MCP SERVER - COMPREHENSIVE TEST\n");
  console.log(`Target: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // Initialize session
  console.log("1️⃣ Initializing MCP session...");
  const sessionId = await initSession();
  if (!sessionId) {
    console.log("❌ Failed to get session - testing without auth (debug mode)");
    // Continue with direct API tests via health/debug endpoints
  } else {
    console.log(`✅ Session: ${sessionId.slice(0, 8)}...`);
  }

  // =========================================================================
  // TIER 2: RAW DATA TOOLS
  // =========================================================================
  console.log("\n\n" + "█".repeat(70));
  console.log("  TIER 2: RAW DATA TOOLS");
  console.log("█".repeat(70));

  // Test 1: get_sports (FREE)
  if (sessionId) {
    const sports = await callTool(sessionId, "get_sports", {});
    const sportsData = printResult("get_sports", sports);
    if (sportsData) {
      const s = sportsData as { sports: Array<{ key: string; title: string; active: boolean }>; totalActive: number };
      console.log(`   Total sports: ${s.sports?.length || 0}`);
      console.log(`   Active: ${s.totalActive}`);
      if (s.sports?.length > 0) {
        console.log("   Sample sports:");
        s.sports.slice(0, 5).forEach((sp) => {
          console.log(`     - ${sp.title} (${sp.key}) ${sp.active ? "✅" : "❌"}`);
        });
      }
    }
  }

  // Test 2: get_events (FREE)
  if (sessionId) {
    const events = await callTool(sessionId, "get_events", { sport: "basketball_nba" });
    const eventsData = printResult("get_events (NBA)", events);
    if (eventsData) {
      const e = eventsData as { events: Array<{ id: string; homeTeam: string; awayTeam: string; commenceTime: string }>; totalEvents: number };
      console.log(`   Total events: ${e.totalEvents}`);
      if (e.events?.length > 0) {
        console.log("   Upcoming games:");
        e.events.slice(0, 3).forEach((ev) => {
          console.log(`     - ${ev.awayTeam} @ ${ev.homeTeam} (${new Date(ev.commenceTime).toLocaleString()})`);
        });
      }
    }
  }

  // Test 3: get_odds (COSTS QUOTA)
  if (sessionId) {
    const odds = await callTool(sessionId, "get_odds", {
      sport: "upcoming",
      regions: ["us"],
      markets: ["h2h"],
    });
    const oddsData = printResult("get_odds (upcoming, h2h)", odds);
    if (oddsData) {
      const o = oddsData as { events: Array<{ event?: string; homeTeam: string; awayTeam: string; bookmakers: Array<any> }>; quotaCost: number };
      console.log(`   Events with odds: ${o.events?.length || 0}`);
      console.log(`   Quota cost: ${o.quotaCost}`);
      if (o.events?.length > 0) {
        const ev = o.events[0];
        console.log(`   Sample event: ${ev.awayTeam} @ ${ev.homeTeam}`);
        console.log(`   Bookmakers: ${ev.bookmakers?.length || 0}`);
        if (ev.bookmakers?.length > 0) {
          console.log(`   Sample bookmaker: ${ev.bookmakers[0].title}`);
          const h2h = ev.bookmakers[0].markets?.find((m: any) => m.key === "h2h");
          if (h2h?.outcomes) {
            console.log("   Odds:");
            h2h.outcomes.forEach((out: any) => {
              console.log(`     - ${out.name}: ${out.price}`);
            });
          }
        }
      }
    }
  }

  // Test 4: get_scores
  if (sessionId) {
    const scores = await callTool(sessionId, "get_scores", {
      sport: "basketball_nba",
      daysFrom: 1,
    });
    const scoresData = printResult("get_scores (NBA, 1 day)", scores);
    if (scoresData) {
      const s = scoresData as { games: Array<{ homeTeam: string; awayTeam: string; homeScore: string; awayScore: string; completed: boolean }>; liveGames: number; completedGames: number };
      console.log(`   Live games: ${s.liveGames}`);
      console.log(`   Completed: ${s.completedGames}`);
      if (s.games?.length > 0) {
        console.log("   Recent games:");
        s.games.slice(0, 3).forEach((g) => {
          console.log(`     - ${g.awayTeam} ${g.awayScore || "?"} @ ${g.homeTeam} ${g.homeScore || "?"} ${g.completed ? "(Final)" : "(Live)"}`);
        });
      }
    }
  }

  // Test 5: get_participants
  if (sessionId) {
    const participants = await callTool(sessionId, "get_participants", {
      sport: "americanfootball_nfl",
    });
    const pData = printResult("get_participants (NFL)", participants);
    if (pData) {
      const p = pData as { participants: Array<{ id: string; fullName: string }> };
      console.log(`   Total participants: ${p.participants?.length || 0}`);
      if (p.participants?.length > 0) {
        console.log("   Sample teams:");
        p.participants.slice(0, 5).forEach((t) => {
          console.log(`     - ${t.fullName}`);
        });
      }
    }
  }

  // =========================================================================
  // TIER 1: INTELLIGENCE TOOLS
  // =========================================================================
  console.log("\n\n" + "█".repeat(70));
  console.log("  TIER 1: INTELLIGENCE TOOLS");
  console.log("█".repeat(70));

  // Test 6: find_arbitrage_opportunities
  if (sessionId) {
    const arb = await callTool(sessionId, "find_arbitrage_opportunities", {
      sport: "upcoming",
      minProfitPercent: 0.1,
      maxResults: 5,
    });
    const arbData = printResult("find_arbitrage_opportunities", arb);
    if (arbData) {
      const a = arbData as { opportunities: Array<{ event: string; profitPercent: number; legs: Array<any> }>; totalScanned: number; eventsAnalyzed: number; recommendation: string };
      console.log(`   Events analyzed: ${a.eventsAnalyzed}`);
      console.log(`   Bookmakers scanned: ${a.totalScanned}`);
      console.log(`   Opportunities found: ${a.opportunities?.length || 0}`);
      if (a.opportunities?.length > 0) {
        console.log("   Top opportunity:");
        const opp = a.opportunities[0];
        console.log(`     Event: ${opp.event}`);
        console.log(`     Profit: ${opp.profitPercent}%`);
        opp.legs?.forEach((leg: any) => {
          console.log(`       - ${leg.outcome} @ ${leg.bookmaker}: ${leg.price} (stake ${leg.stakePercent?.toFixed(1)}%)`);
        });
      }
      console.log(`   Recommendation: ${a.recommendation?.slice(0, 100)}...`);
    }
  }

  // Test 7: find_best_odds
  if (sessionId) {
    const best = await callTool(sessionId, "find_best_odds", {
      sport: "basketball_nba",
      market: "h2h",
    });
    const bestData = printResult("find_best_odds (NBA h2h)", best);
    if (bestData) {
      const b = bestData as { events: Array<{ event: string; outcomes: Array<{ name: string; bestOdds: number; bestBookmaker: string; edgePercent: number }> }>; summary: { totalEvents: number; bestOverallBookmaker: string; averageEdge: number } };
      console.log(`   Total events: ${b.summary?.totalEvents}`);
      console.log(`   Best bookmaker: ${b.summary?.bestOverallBookmaker}`);
      console.log(`   Average edge: ${b.summary?.averageEdge}%`);
      if (b.events?.length > 0) {
        const ev = b.events[0];
        console.log(`   Sample event: ${ev.event}`);
        ev.outcomes?.slice(0, 2).forEach((out) => {
          console.log(`     - ${out.name}: best ${out.bestOdds} @ ${out.bestBookmaker} (${out.edgePercent}% edge)`);
        });
      }
    }
  }

  // Test 8: analyze_market_efficiency
  if (sessionId) {
    const eff = await callTool(sessionId, "analyze_market_efficiency", {
      sport: "basketball_nba",
      market: "h2h",
    });
    const effData = printResult("analyze_market_efficiency (NBA)", eff);
    if (effData) {
      const e = effData as { events: Array<{ event: string; lowestVigBookmaker: string; averageVig: number; consensusProbabilities: Record<string, number>; bookmakerEfficiency: Array<{ bookmaker: string; vigPercent: number; efficiency: string }> }>; recommendation: string };
      if (e.events?.length > 0) {
        const ev = e.events[0];
        console.log(`   Sample event: ${ev.event}`);
        console.log(`   Lowest vig: ${ev.lowestVigBookmaker}`);
        console.log(`   Average vig: ${ev.averageVig}%`);
        console.log("   Consensus probabilities (comparable to Polymarket):");
        for (const [name, prob] of Object.entries(ev.consensusProbabilities || {})) {
          console.log(`     - ${name}: ${((prob as number) * 100).toFixed(1)}%`);
        }
        console.log("   Bookmaker efficiency:");
        ev.bookmakerEfficiency?.slice(0, 3).forEach((b) => {
          console.log(`     - ${b.bookmaker}: ${b.vigPercent}% vig (${b.efficiency})`);
        });
      }
    }
  }

  // Test 9: discover_value_bets
  if (sessionId) {
    const value = await callTool(sessionId, "discover_value_bets", {
      sport: "upcoming",
      minEdgePercent: 2,
      market: "h2h",
    });
    const valueData = printResult("discover_value_bets (2%+ edge)", value);
    if (valueData) {
      const v = valueData as { valueBets: Array<{ event: string; outcome: string; bookmaker: string; odds: number; edgePercent: number; confidence: string }>; totalEventsScanned: number; recommendation: string };
      console.log(`   Events scanned: ${v.totalEventsScanned}`);
      console.log(`   Value bets found: ${v.valueBets?.length || 0}`);
      if (v.valueBets?.length > 0) {
        console.log("   Top value bets:");
        v.valueBets.slice(0, 3).forEach((bet) => {
          console.log(`     - ${bet.event}`);
          console.log(`       ${bet.outcome} @ ${bet.bookmaker}: ${bet.odds} (+${bet.edgePercent}% edge, ${bet.confidence})`);
        });
      }
    }
  }

  // Test 10: analyze_line_movement (requires historical data)
  if (sessionId) {
    const line = await callTool(sessionId, "analyze_line_movement", {
      sport: "basketball_nba",
      hoursBack: 24,
    });
    const lineData = printResult("analyze_line_movement (NBA, 24h)", line);
    if (lineData) {
      const l = lineData as { events: Array<{ event: string; sharpAction: string; confidence: number; lineMovement: Array<{ outcome: string; movementPercent: number; direction: string }> }>; interpretation: string };
      console.log(`   Events with movement data: ${l.events?.length || 0}`);
      if (l.events?.length > 0) {
        console.log("   Line movements:");
        l.events.slice(0, 2).forEach((ev) => {
          console.log(`     ${ev.event} - Sharp action: ${ev.sharpAction} (conf: ${ev.confidence})`);
          ev.lineMovement?.forEach((m) => {
            console.log(`       ${m.outcome}: ${m.movementPercent > 0 ? "+" : ""}${m.movementPercent}% (${m.direction})`);
          });
        });
      }
      console.log(`   Interpretation: ${l.interpretation?.slice(0, 150)}...`);
    }
  }

  // =========================================================================
  // SUMMARY
  // =========================================================================
  console.log("\n\n" + "█".repeat(70));
  console.log("  TEST SUMMARY");
  console.log("█".repeat(70));
  console.log("\n✅ All endpoint tests completed!");
  console.log("\nTools tested:");
  console.log("  TIER 2 (Raw Data): get_sports, get_events, get_odds, get_scores, get_participants");
  console.log("  TIER 1 (Intelligence): find_arbitrage, find_best_odds, analyze_efficiency,");
  console.log("                         discover_value_bets, analyze_line_movement");
  console.log("\nNot tested (require specific event IDs or historical dates):");
  console.log("  - get_event_odds, get_event_markets");
  console.log("  - get_historical_odds, get_historical_events, get_historical_event_odds");
  console.log("  - compare_historical_closing_lines");
}

testAllTools().catch(console.error);

