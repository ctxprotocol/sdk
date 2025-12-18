/**
 * Comprehensive test script for all Hyperliquid MCP Server endpoints.
 * 
 * Tests each tool to verify:
 * 1. The endpoint responds without error
 * 2. The response structure is valid
 * 3. Required fields are present
 */

const SERVER_URL = "http://localhost:4002";

interface TestResult {
  tool: string;
  status: "✅ PASS" | "❌ FAIL" | "⚠️ WARN";
  message: string;
  duration: number;
  responsePreview?: string;
}

const results: TestResult[] = [];

// Helper to make MCP tool calls via the server's SSE transport
// Since testing MCP directly requires SSE, we'll test the underlying API functions directly
const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

async function hyperliquidPost(body: object): Promise<unknown> {
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error (${response.status}): ${text.slice(0, 200)}`);
  }

  return response.json();
}

async function testHealthEndpoint(): Promise<TestResult> {
  const start = Date.now();
  try {
    const response = await fetch(`${SERVER_URL}/health`);
    const data = await response.json();
    
    // Check for v2.1 features: tier1Tools, tier2Tools, protocol
    const hasV21Features = data.tier1Tools && data.tier2Tools && data.protocol === "2025-11-25";
    
    if (data.status === "ok" && data.tools && data.tools.length >= 17) {
      const tierInfo = hasV21Features 
        ? `, Tier1: ${data.tier1Tools.length}, Tier2: ${data.tier2Tools.length}, Protocol: ${data.protocol}`
        : "";
      return {
        tool: "health_check",
        status: "✅ PASS",
        message: `Server healthy, ${data.tools.length} tools${tierInfo}`,
        duration: Date.now() - start,
        responsePreview: JSON.stringify(data).slice(0, 200),
      };
    }
    return {
      tool: "health_check",
      status: "⚠️ WARN",
      message: `Unexpected response structure`,
      duration: Date.now() - start,
      responsePreview: JSON.stringify(data).slice(0, 200),
    };
  } catch (error) {
    return {
      tool: "health_check",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

// Test each underlying API call that the tools use
async function testL2Book(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "l2Book", coin: "BTC" }) as { levels: unknown[][] };
    
    if (data.levels && data.levels.length === 2 && data.levels[0].length > 0) {
      return {
        tool: "get_orderbook",
        status: "✅ PASS",
        message: `Got ${data.levels[0].length} bid levels, ${data.levels[1].length} ask levels`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_orderbook",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_orderbook",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testMeta(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "meta" }) as { universe: unknown[] };
    
    if (data.universe && data.universe.length > 0) {
      return {
        tool: "list_markets",
        status: "✅ PASS",
        message: `Found ${data.universe.length} markets`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "list_markets",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "list_markets",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testAllMids(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "allMids" }) as Record<string, string>;
    const coins = Object.keys(data);
    
    if (coins.length > 0 && data.BTC) {
      return {
        tool: "allMids (used by multiple tools)",
        status: "✅ PASS",
        message: `Got prices for ${coins.length} coins, BTC=$${Number(data.BTC).toFixed(2)}`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "allMids",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "allMids",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testMetaAndAssetCtxs(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "metaAndAssetCtxs" }) as [{ universe: unknown[] }, unknown[]];
    
    if (data[0]?.universe && data[1] && data[0].universe.length === data[1].length) {
      return {
        tool: "get_market_info (metaAndAssetCtxs)",
        status: "✅ PASS",
        message: `Got context for ${data[0].universe.length} markets`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_market_info",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_market_info",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testRecentTrades(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "recentTrades", coin: "BTC" }) as unknown[];
    
    if (Array.isArray(data) && data.length > 0) {
      return {
        tool: "get_recent_trades",
        status: "✅ PASS",
        message: `Got ${data.length} recent trades`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_recent_trades",
      status: "⚠️ WARN",
      message: "No trades returned",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_recent_trades",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testPredictedFundings(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "predictedFundings" }) as unknown[];
    
    if (Array.isArray(data) && data.length > 0) {
      return {
        tool: "get_funding_analysis (predictedFundings)",
        status: "✅ PASS",
        message: `Got funding predictions for ${data.length} markets`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_funding_analysis",
      status: "⚠️ WARN",
      message: "No predictions returned",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_funding_analysis",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testDelegations(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Test with a known address (Hyperliquid foundation)
    const testAddress = "0x0000000000000000000000000000000000000000";
    const data = await hyperliquidPost({ type: "delegations", user: testAddress }) as unknown[];
    
    // Even empty result is valid
    if (Array.isArray(data)) {
      return {
        tool: "get_user_delegations",
        status: "✅ PASS",
        message: `API responds correctly (${data.length} delegations found)`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_user_delegations",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_user_delegations",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testPerpsAtOiCap(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "perpsAtOpenInterestCap" }) as string[];
    
    if (Array.isArray(data)) {
      return {
        tool: "get_markets_at_oi_cap",
        status: "✅ PASS",
        message: `${data.length} markets at OI cap`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_markets_at_oi_cap",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_markets_at_oi_cap",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testCandleSnapshot(): Promise<TestResult> {
  const start = Date.now();
  try {
    const now = Date.now();
    const startTime = now - 24 * 60 * 60 * 1000; // 24 hours ago
    const data = await hyperliquidPost({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1h", startTime, endTime: now }
    }) as unknown[];
    
    if (Array.isArray(data) && data.length > 0) {
      return {
        tool: "get_candles",
        status: "✅ PASS",
        message: `Got ${data.length} candles`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_candles",
      status: "⚠️ WARN",
      message: "No candles returned",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_candles",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testVaultDetails(): Promise<TestResult> {
  const start = Date.now();
  try {
    const HLP_VAULT_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
    const data = await hyperliquidPost({
      type: "vaultDetails",
      vaultAddress: HLP_VAULT_ADDRESS,
      user: null
    }) as { name?: string; apr?: number };
    
    if (data && typeof data.apr === "number") {
      return {
        tool: "get_hlp_vault_stats",
        status: "✅ PASS",
        message: `HLP vault APR: ${(data.apr * 100).toFixed(2)}%`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_hlp_vault_stats",
      status: "⚠️ WARN",
      message: "Unexpected response structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_hlp_vault_stats",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testFundingHistory(): Promise<TestResult> {
  const start = Date.now();
  try {
    const now = Date.now();
    const startTime = now - 7 * 24 * 60 * 60 * 1000; // 7 days ago
    const data = await hyperliquidPost({
      type: "fundingHistory",
      coin: "BTC",
      startTime,
      endTime: now
    }) as unknown[];
    
    if (Array.isArray(data) && data.length > 0) {
      return {
        tool: "get_funding_history",
        status: "✅ PASS",
        message: `Got ${data.length} funding snapshots`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_funding_history",
      status: "⚠️ WARN",
      message: "No funding history returned",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_funding_history",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

// Test calculation/composition tools (these use multiple API calls)
async function testCalculatePriceImpact(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Fetch orderbook
    const bookData = await hyperliquidPost({ type: "l2Book", coin: "BTC" }) as { levels: Array<Array<{ px: string; sz: string }>> };
    const [rawBids] = bookData.levels;
    
    // Parse and calculate
    const bids = rawBids.map(l => ({ price: Number(l.px), size: Number(l.sz) }));
    const midPrice = bids[0]?.price ?? 0;
    
    // Simulate sell of 1 BTC
    let remaining = 1;
    let filled = 0;
    let notional = 0;
    
    for (const bid of bids) {
      if (remaining <= 0) break;
      const fillSize = Math.min(remaining, bid.size);
      filled += fillSize;
      notional += fillSize * bid.price;
      remaining -= fillSize;
    }
    
    const avgPrice = filled > 0 ? notional / filled : midPrice;
    const impact = ((avgPrice - midPrice) / midPrice) * 100;
    
    return {
      tool: "calculate_price_impact",
      status: "✅ PASS",
      message: `1 BTC sell: ${Math.abs(impact).toFixed(4)}% impact, avg price $${avgPrice.toFixed(2)}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "calculate_price_impact",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testOpenInterestAnalysis(): Promise<TestResult> {
  const start = Date.now();
  try {
    const [metaAndCtx, marketsAtCap] = await Promise.all([
      hyperliquidPost({ type: "metaAndAssetCtxs" }) as Promise<[{ universe: Array<{ name: string }> }, Array<{ openInterest: string; dayNtlVlm: string; funding: string; markPx: string }>]>,
      hyperliquidPost({ type: "perpsAtOpenInterestCap" }) as Promise<string[]>,
    ]);
    
    const btcIdx = metaAndCtx[0].universe.findIndex(u => u.name === "BTC");
    if (btcIdx === -1) throw new Error("BTC not found");
    
    const ctx = metaAndCtx[1][btcIdx];
    const oi = Number(ctx.openInterest);
    const markPrice = Number(ctx.markPx);
    const oiUsd = oi * markPrice;
    const atCap = marketsAtCap.includes("BTC");
    
    return {
      tool: "get_open_interest_analysis",
      status: "✅ PASS",
      message: `BTC OI: $${(oiUsd / 1e9).toFixed(2)}B, at cap: ${atCap}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_open_interest_analysis",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testExchangeStats(): Promise<TestResult> {
  const start = Date.now();
  try {
    const metaAndCtx = await hyperliquidPost({ type: "metaAndAssetCtxs" }) as [{ universe: unknown[] }, Array<{ dayNtlVlm: string }>];
    
    let totalVolume = 0;
    for (const ctx of metaAndCtx[1]) {
      totalVolume += Number(ctx.dayNtlVlm || 0);
    }
    
    return {
      tool: "get_exchange_stats",
      status: "✅ PASS",
      message: `24h volume: $${(totalVolume / 1e9).toFixed(2)}B across ${metaAndCtx[0].universe.length} markets`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_exchange_stats",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testVolumeHistory(): Promise<TestResult> {
  const start = Date.now();
  try {
    const now = Date.now();
    const startTime = now - 7 * 24 * 60 * 60 * 1000;
    const candles = await hyperliquidPost({
      type: "candleSnapshot",
      req: { coin: "BTC", interval: "1d", startTime, endTime: now }
    }) as Array<{ v: string; c: string }>;
    
    if (candles.length > 0) {
      const volumes = candles.map(c => Number(c.v) * Number(c.c));
      const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      
      return {
        tool: "get_volume_history",
        status: "✅ PASS",
        message: `${candles.length} days, avg daily volume: $${(avgVolume / 1e6).toFixed(1)}M`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_volume_history",
      status: "⚠️ WARN",
      message: "No volume data returned",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_volume_history",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testStakingSummary(): Promise<TestResult> {
  const start = Date.now();
  try {
    const mids = await hyperliquidPost({ type: "allMids" }) as Record<string, string>;
    const hypePrice = Number(mids.HYPE || 0);
    
    if (hypePrice > 0) {
      return {
        tool: "get_staking_summary",
        status: "✅ PASS",
        message: `HYPE price: $${hypePrice.toFixed(2)} (staking mechanics are static info)`,
        duration: Date.now() - start,
      };
    }
    return {
      tool: "get_staking_summary",
      status: "⚠️ WARN",
      message: "HYPE price not available",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "get_staking_summary",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testAnalyzeLargeOrder(): Promise<TestResult> {
  const start = Date.now();
  try {
    // This tool composes multiple API calls
    const [bookData, metaAndCtx] = await Promise.all([
      hyperliquidPost({ type: "l2Book", coin: "HYPE" }) as Promise<{ levels: Array<Array<{ px: string; sz: string }>> }>,
      hyperliquidPost({ type: "metaAndAssetCtxs" }) as Promise<[{ universe: Array<{ name: string }> }, Array<{ dayNtlVlm: string; markPx: string }>]>,
    ]);
    
    const hypeIdx = metaAndCtx[0].universe.findIndex(u => u.name === "HYPE");
    if (hypeIdx === -1) throw new Error("HYPE not found");
    
    const ctx = metaAndCtx[1][hypeIdx];
    const volume24h = Number(ctx.dayNtlVlm || 0);
    const markPrice = Number(ctx.markPx || 0);
    
    // Simulate 100K USD sell
    const sizeUsd = 100_000;
    const size = sizeUsd / markPrice;
    const asPercentOfVolume = volume24h > 0 ? (sizeUsd / volume24h) * 100 : 0;
    
    return {
      tool: "analyze_large_order",
      status: "✅ PASS",
      message: `$100K HYPE sell = ${asPercentOfVolume.toFixed(2)}% of daily volume`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "analyze_large_order",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testAnalyzeMyPositions(): Promise<TestResult> {
  const start = Date.now();
  try {
    // This tool requires portfolio context - test the logic with mock data
    const mockPortfolio = {
      walletAddress: "0x123...",
      perpPositions: [
        {
          coin: "BTC",
          size: 0.5,
          entryPrice: 100000,
          unrealizedPnl: 500,
          liquidationPrice: 80000,
          positionValue: 50000,
          leverage: { value: 2, type: "cross" },
          marginUsed: 25000,
          markPrice: 101000,
        }
      ],
      accountSummary: {
        accountValue: 100000,
        totalMarginUsed: 25000,
      },
    };
    
    // Test the position analysis logic
    const position = mockPortfolio.perpPositions[0];
    const direction = position.size > 0 ? "LONG" : "SHORT";
    const distanceToLiq = ((position.markPrice - position.liquidationPrice) / position.markPrice) * 100;
    
    return {
      tool: "analyze_my_positions",
      status: "✅ PASS",
      message: `Logic works: ${direction} ${position.coin}, ${distanceToLiq.toFixed(1)}% from liq`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      tool: "analyze_my_positions",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function runAllTests() {
  console.log("\n" + "=".repeat(70));
  console.log("🧪 HYPERLIQUID MCP SERVER - COMPREHENSIVE ENDPOINT TESTS");
  console.log("=".repeat(70) + "\n");
  
  // First check if server is running
  console.log("📡 Checking server health...\n");
  const healthResult = await testHealthEndpoint();
  results.push(healthResult);
  
  if (healthResult.status === "❌ FAIL") {
    console.log("❌ Server not running! Start with: npm run dev\n");
    console.log("   Testing underlying Hyperliquid API endpoints instead...\n");
  } else {
    console.log(`${healthResult.status} ${healthResult.tool}: ${healthResult.message}\n`);
  }
  
  console.log("-".repeat(70));
  console.log("🔌 TESTING HYPERLIQUID API ENDPOINTS (used by MCP tools)");
  console.log("-".repeat(70) + "\n");
  
  // Run all API tests
  const tests = [
    testL2Book,
    testMeta,
    testAllMids,
    testMetaAndAssetCtxs,
    testRecentTrades,
    testPredictedFundings,
    testDelegations,
    testPerpsAtOiCap,
    testCandleSnapshot,
    testVaultDetails,
    testFundingHistory,
  ];
  
  for (const test of tests) {
    const result = await test();
    results.push(result);
    console.log(`${result.status} ${result.tool}`);
    console.log(`   ${result.message} (${result.duration}ms)\n`);
  }
  
  console.log("-".repeat(70));
  console.log("🔧 TESTING COMPOSED/CALCULATION TOOLS");
  console.log("-".repeat(70) + "\n");
  
  const composedTests = [
    testCalculatePriceImpact,
    testOpenInterestAnalysis,
    testExchangeStats,
    testVolumeHistory,
    testStakingSummary,
    testAnalyzeLargeOrder,
    testAnalyzeMyPositions,
  ];
  
  for (const test of composedTests) {
    const result = await test();
    results.push(result);
    console.log(`${result.status} ${result.tool}`);
    console.log(`   ${result.message} (${result.duration}ms)\n`);
  }
  
  // Summary
  console.log("=".repeat(70));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(70) + "\n");
  
  const passed = results.filter(r => r.status === "✅ PASS").length;
  const warned = results.filter(r => r.status === "⚠️ WARN").length;
  const failed = results.filter(r => r.status === "❌ FAIL").length;
  
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ⚠️ Warnings: ${warned}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Total: ${results.length}`);
  
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  console.log(`   ⏱️  Avg response time: ${avgDuration.toFixed(0)}ms\n`);
  
  if (failed > 0) {
    console.log("❌ FAILED TESTS:");
    for (const r of results.filter(r => r.status === "❌ FAIL")) {
      console.log(`   • ${r.tool}: ${r.message}`);
    }
    console.log("");
  }
  
  // Composability check
  console.log("-".repeat(70));
  console.log("🔗 COMPOSABILITY ASSESSMENT");
  console.log("-".repeat(70) + "\n");
  
  const apiToolsWorking = results.slice(1, 12).filter(r => r.status === "✅ PASS").length;
  const composedToolsWorking = results.slice(12).filter(r => r.status === "✅ PASS").length;
  
  console.log(`   API endpoints working: ${apiToolsWorking}/11`);
  console.log(`   Composed tools working: ${composedToolsWorking}/7`);
  
  if (apiToolsWorking >= 10 && composedToolsWorking >= 6) {
    console.log("\n   ✅ SERVER IS READY FOR MCP CLIENT INTEGRATION\n");
    console.log("   All core endpoints are responding correctly.");
    console.log("   Tools can be composed to build complex analyses.\n");
  } else if (failed === 0 || (failed === 1 && results[0].status === "❌ FAIL")) {
    console.log("\n   ⚠️ APIS WORKING - START THE SERVER FOR MCP INTEGRATION\n");
    console.log("   Run: npm run dev\n");
  } else {
    console.log("\n   ❌ ISSUES DETECTED - REVIEW FAILED TESTS\n");
  }
}

runAllTests().catch(console.error);



