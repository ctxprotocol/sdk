/**
 * Comprehensive MCP Protocol Test
 * Tests all endpoints via proper MCP JSON-RPC protocol over SSE
 * 
 * Note: SSE transport sends responses via the SSE stream, not HTTP POST body
 */

import http from "http";

const BASE_URL = "http://localhost:4003";

interface MCPResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface MCPResponse {
  jsonrpc: string;
  id: number;
  result?: MCPResult | { tools: Array<{ name: string }> };
  error?: { code: number; message: string };
}

class MCPClient {
  private sessionId: string = "";
  private sseResponse: http.IncomingMessage | null = null;
  private responseBuffer: string = "";
  private pendingRequests: Map<number, { resolve: (resp: MCPResponse) => void; reject: (err: Error) => void }> = new Map();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Connection timeout")), 10000);
      
      const url = new URL(`${BASE_URL}/sse`);
      
      http.get(url, (res) => {
        this.sseResponse = res;
        
        res.on("data", (chunk: Buffer) => {
          this.responseBuffer += chunk.toString();
          
          // Process any complete SSE messages
          const lines = this.responseBuffer.split("\n");
          this.responseBuffer = lines.pop() || ""; // Keep incomplete line in buffer
          
          for (const line of lines) {
            // Parse SSE format to extract sessionId from endpoint event
            const sessionMatch = line.match(/sessionId=([a-f0-9-]+)/);
            if (sessionMatch && !this.sessionId) {
              this.sessionId = sessionMatch[1];
              clearTimeout(timeout);
              resolve();
            }
            
            // Parse JSON-RPC responses from message events
            if (line.startsWith("data: ")) {
              try {
                const data = JSON.parse(line.slice(6)) as MCPResponse;
                if (data.jsonrpc && data.id) {
                  const pending = this.pendingRequests.get(data.id);
                  if (pending) {
                    pending.resolve(data);
                    this.pendingRequests.delete(data.id);
                  }
                }
              } catch {
                // Not a JSON response, ignore
              }
            }
          }
        });
        
        res.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      }).on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<MCPResponse> {
    if (!this.sessionId) {
      throw new Error("Not connected - call connect() first");
    }

    const id = Date.now() + Math.floor(Math.random() * 1000);
    
    // Create promise to receive response via SSE
    const responsePromise = new Promise<MCPResponse>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      
      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error("Request timeout"));
        }
      }, 30000);
    });

    // Send the request
    await fetch(`${BASE_URL}/messages?sessionId=${this.sessionId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id,
      }),
    });

    return responsePromise;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<MCPResponse> {
    return this.sendRequest("tools/call", { name, arguments: args });
  }

  async listTools(): Promise<MCPResponse> {
    return this.sendRequest("tools/list", {});
  }

  disconnect(): void {
    if (this.sseResponse) {
      this.sseResponse.destroy();
      this.sseResponse = null;
    }
    this.pendingRequests.clear();
  }
}

interface TestCase {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  validate: (data: Record<string, unknown>) => { ok: boolean; message: string };
}

const tests: TestCase[] = [
  {
    name: "Get Events",
    tool: "get_events",
    args: { limit: 3 },
    validate: (data) => {
      const events = data.events as unknown[];
      if (!Array.isArray(events)) return { ok: false, message: "events not an array" };
      if (events.length === 0) return { ok: false, message: "no events returned" };
      return { ok: true, message: `Got ${events.length} events` };
    },
  },
  {
    name: "Get Event By Slug (with tokens)",
    tool: "get_event_by_slug",
    args: { slug: "presidential-election-winner-2024" },
    validate: (data) => {
      if (!data.event) return { ok: false, message: "no event" };
      const markets = data.markets as Array<{ tokens?: Array<{ id: string; outcome: string }> }>;
      if (!Array.isArray(markets)) return { ok: false, message: "markets not an array" };
      if (markets.length === 0) return { ok: false, message: "no markets" };
      
      // KEY CHECK: verify tokens array exists and has proper structure
      const firstMarket = markets[0];
      if (!firstMarket.tokens) return { ok: false, message: "first market missing tokens array" };
      if (!Array.isArray(firstMarket.tokens)) return { ok: false, message: "tokens not an array" };
      if (firstMarket.tokens.length < 2) return { ok: false, message: "tokens array should have at least 2 items" };
      
      const yesToken = firstMarket.tokens.find(t => t.outcome === "YES");
      const noToken = firstMarket.tokens.find(t => t.outcome === "NO");
      
      if (!yesToken?.id) return { ok: false, message: "missing YES token id" };
      if (!noToken?.id) return { ok: false, message: "missing NO token id" };
      
      return { 
        ok: true, 
        message: `✓ ${markets.length} markets with proper tokens array (YES: ${yesToken.id.slice(0, 10)}...)` 
      };
    },
  },
  {
    name: "Search Markets",
    tool: "search_markets",
    args: { query: "election", limit: 5 },
    validate: (data) => {
      const results = data.results as unknown[];
      if (!Array.isArray(results)) return { ok: false, message: "results not an array" };
      return { ok: true, message: `Found ${results.length} results` };
    },
  },
  {
    name: "Discover Trending Markets",
    tool: "discover_trending_markets",
    args: { limit: 5 },
    validate: (data) => {
      const markets = data.trendingMarkets as unknown[];
      if (!Array.isArray(markets)) return { ok: false, message: "trendingMarkets not an array" };
      return { ok: true, message: `Found ${markets.length} trending markets` };
    },
  },
  {
    name: "Check Market Efficiency",
    tool: "check_market_efficiency",
    args: { slug: "presidential-election-winner-2024" },
    validate: (data) => {
      if (!data.outcomes) return { ok: false, message: "no outcomes" };
      if (!data.marketEfficiency) return { ok: false, message: "no marketEfficiency" };
      const eff = data.marketEfficiency as { efficiency?: string };
      return { ok: true, message: `Efficiency: ${eff.efficiency}` };
    },
  },
  {
    name: "Check Market Rules",
    tool: "check_market_rules",
    args: { slug: "presidential-election-winner-2024" },
    validate: (data) => {
      if (!data.market) return { ok: false, message: "no market" };
      if (!data.rulesSummary) return { ok: false, message: "no rulesSummary" };
      return { ok: true, message: `Rules parsed for: ${(data.market as string).slice(0, 30)}...` };
    },
  },
];

async function runTests() {
  console.log("\n🧪 MCP Protocol Integration Tests\n");
  console.log("=".repeat(60) + "\n");

  const client = new MCPClient();

  try {
    // Connect
    console.log("📡 Connecting to MCP server via SSE...");
    await client.connect();
    console.log("✅ Connected!\n");

    // List tools
    console.log("📋 Listing tools...");
    try {
      const toolsResp = await client.listTools();
      const tools = (toolsResp.result as { tools: Array<{ name: string }> })?.tools;
      if (tools) {
        console.log(`✅ ${tools.length} tools available\n`);
      } else {
        console.log("⚠️ Could not list tools\n");
      }
    } catch (err) {
      console.log(`⚠️ List tools failed: ${err}\n`);
    }

    // Run tests
    let passed = 0;
    let failed = 0;

    for (const test of tests) {
      process.stdout.write(`Testing: ${test.name}... `);

      try {
        const resp = await client.callTool(test.tool, test.args);

        if (resp.error) {
          console.log(`❌ FAILED (RPC error: ${resp.error.message})`);
          failed++;
          continue;
        }

        const result = resp.result as MCPResult;
        const content = result?.content?.[0];
        if (!content || content.type !== "text") {
          console.log("❌ FAILED (no text content)");
          failed++;
          continue;
        }

        const data = JSON.parse(content.text) as Record<string, unknown>;

        if (data.error) {
          console.log(`❌ FAILED (tool error: ${data.error})`);
          failed++;
          continue;
        }

        const validationResult = test.validate(data);
        if (validationResult.ok) {
          console.log(`✅ PASSED - ${validationResult.message}`);
          passed++;
        } else {
          console.log(`❌ FAILED - ${validationResult.message}`);
          failed++;
        }
      } catch (err) {
        console.log(`❌ FAILED (${err})`);
        failed++;
      }
    }

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log(`\n📊 Results: ${passed} passed, ${failed} failed out of ${tests.length}\n`);

    if (failed === 0) {
      console.log("🎉 All tests passed! The MCP server is ready for your client app.\n");
    } else {
      console.log("⚠️  Some tests failed. Review the issues above.\n");
    }

  } catch (err) {
    console.error("❌ Test setup failed:", err);
  } finally {
    client.disconnect();
  }
}

runTests();
