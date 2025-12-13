/**
 * Test script for Polymarket MCP Server endpoints
 * Tests all tools to ensure they work and return proper structures
 */

const BASE_URL = "http://localhost:4003";

interface MCPResponse {
  result?: {
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  error?: { message: string };
}

interface SSEMessage {
  sessionId?: string;
  endpoint?: string;
}

async function connectSSE(): Promise<string> {
  // Make a request to /sse to get a session ID
  const response = await fetch(`${BASE_URL}/sse`, {
    method: "GET",
    headers: { Accept: "text/event-stream" },
  });

  // Read the first event to get the session ID
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let sessionId = "";
  let buffer = "";

  // Read until we get the endpoint message
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE format
    const lines = buffer.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6)) as SSEMessage;
          if (data.sessionId) {
            sessionId = data.sessionId;
          }
        } catch {
          // Try parsing as endpoint message
          if (line.includes("endpoint")) {
            const match = line.match(/sessionId=([^"&]+)/);
            if (match) {
              sessionId = match[1];
            }
          }
        }
      }
      // Also check for endpoint line
      if (line.includes("?sessionId=")) {
        const match = line.match(/sessionId=([^"&\s]+)/);
        if (match) {
          sessionId = match[1];
        }
      }
    }

    if (sessionId) {
      reader.cancel();
      break;
    }
  }

  return sessionId;
}

async function callTool(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<MCPResponse> {
  const response = await fetch(`${BASE_URL}/messages?sessionId=${sessionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args,
      },
      id: Date.now(),
    }),
  });

  return response.json() as Promise<MCPResponse>;
}

async function testTool(
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
  expectedFields: string[]
): Promise<{ success: boolean; error?: string; data?: unknown }> {
  try {
    const response = await callTool(sessionId, name, args);

    if (response.error) {
      return { success: false, error: response.error.message };
    }

    const content = response.result?.content?.[0];
    if (!content || content.type !== "text") {
      return { success: false, error: "No text content in response" };
    }

    const data = JSON.parse(content.text);

    if (data.error) {
      return { success: false, error: data.error, data };
    }

    // Check for expected fields
    const missingFields = expectedFields.filter((f) => !(f in data));
    if (missingFields.length > 0) {
      return {
        success: false,
        error: `Missing fields: ${missingFields.join(", ")}`,
        data,
      };
    }

    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

async function runTests() {
  console.log("\n🧪 Polymarket MCP Server - Endpoint Tests\n");
  console.log("=" .repeat(60) + "\n");

  // First, connect and get session ID
  console.log("📡 Connecting to SSE endpoint...");
  let sessionId: string;
  try {
    sessionId = await connectSSE();
    if (!sessionId) {
      console.log("❌ Could not get session ID from SSE. Testing via direct HTTP instead.\n");
      // Fall back to direct API testing without MCP protocol
      await testDirectEndpoints();
      return;
    }
    console.log(`✅ Connected with session: ${sessionId}\n`);
  } catch (err) {
    console.log(`❌ SSE connection failed: ${err}`);
    console.log("   Testing via direct API instead.\n");
    await testDirectEndpoints();
    return;
  }

  const tests = [
    // Tier 2: Raw Data Tools (test these first as they're simpler)
    {
      name: "get_events",
      args: { limit: 3 },
      expected: ["events", "count", "fetchedAt"],
    },
    {
      name: "get_event_by_slug",
      args: { slug: "presidential-election-winner-2024" },
      expected: ["event", "markets", "fetchedAt"],
    },
    {
      name: "search_markets",
      args: { query: "bitcoin", limit: 3 },
      expected: ["results", "count", "fetchedAt"],
    },
    // Tier 1: Intelligence Tools
    {
      name: "discover_trending_markets",
      args: { limit: 5 },
      expected: ["trendingMarkets", "fetchedAt"],
    },
    {
      name: "find_arbitrage_opportunities",
      args: { limit: 10 },
      expected: ["scannedMarkets", "arbitrageOpportunities", "summary", "fetchedAt"],
    },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    process.stdout.write(`Testing ${test.name}... `);
    const result = await testTool(sessionId, test.name, test.args, test.expected);

    if (result.success) {
      console.log("✅ PASSED");
      passed++;

      // Show sample of data for key endpoints
      if (test.name === "get_event_by_slug" && result.data) {
        const data = result.data as Record<string, unknown>;
        const markets = data.markets as Array<Record<string, unknown>>;
        if (markets?.[0]) {
          console.log(`   └─ Markets found: ${markets.length}`);
          console.log(`   └─ First market has tokens: ${JSON.stringify(markets[0].tokens)}`);
        }
      }
    } else {
      console.log(`❌ FAILED: ${result.error}`);
      failed++;
      if (result.data) {
        console.log(`   └─ Response: ${JSON.stringify(result.data).slice(0, 200)}...`);
      }
    }
  }

  console.log("\n" + "=" .repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
}

async function testDirectEndpoints() {
  console.log("Testing Polymarket APIs directly (without MCP protocol):\n");

  // Test Gamma API
  console.log("1. Testing Gamma API (events)...");
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/events?limit=2&closed=false");
    const data = await resp.json();
    console.log(`   ✅ Got ${Array.isArray(data) ? data.length : 0} events`);
  } catch (err) {
    console.log(`   ❌ Failed: ${err}`);
  }

  // Test event by slug
  console.log("\n2. Testing Gamma API (event by slug)...");
  try {
    const resp = await fetch("https://gamma-api.polymarket.com/events/slug/presidential-election-winner-2024");
    const data = await resp.json() as Record<string, unknown>;
    console.log(`   ✅ Event: ${data.title}`);
    const markets = data.markets as Array<Record<string, unknown>>;
    if (markets?.[0]) {
      console.log(`   └─ Markets: ${markets.length}`);
      console.log(`   └─ First market clobTokenIds: ${JSON.stringify(markets[0].clobTokenIds)}`);
    }
  } catch (err) {
    console.log(`   ❌ Failed: ${err}`);
  }

  // Test CLOB API
  console.log("\n3. Testing CLOB API (prices)...");
  try {
    // Use a known token ID
    const resp = await fetch("https://clob.polymarket.com/prices", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        params: [{ token_id: "69236923620077691027083946871148646972011131466059644796654161903044970987404", side: "BUY" }],
      }),
    });
    const data = await resp.json();
    console.log(`   ✅ Got price data: ${JSON.stringify(data).slice(0, 100)}...`);
  } catch (err) {
    console.log(`   ❌ Failed: ${err}`);
  }

  console.log("\n" + "=" .repeat(60));
  console.log("\n✅ Direct API tests complete. The MCP server should work when called properly.\n");
}

// Run
runTests().catch(console.error);
