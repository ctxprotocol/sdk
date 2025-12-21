/**
 * Test script for new Hyperliquid MCP endpoints (v2.2.0)
 * Tests all 14 new API endpoints directly against Hyperliquid API
 */

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

// Test addresses
const HLP_VAULT_ADDRESS = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const TEST_USER_ADDRESS = "0x8c967e73e6b15087c42a10d344cff4c96d877f1d";

interface TestResult {
  name: string;
  status: "✅ PASS" | "❌ FAIL" | "⚠️ WARN";
  message: string;
  duration: number;
}

const results: TestResult[] = [];

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

// ============================================
// TIER 2 - NEW RAW DATA ENDPOINTS
// ============================================

async function testSpotMetaAndAssetCtxs(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ type: "spotMetaAndAssetCtxs" }) as [
      { tokens: unknown[]; universe: unknown[] },
      unknown[]
    ];
    
    if (data[0]?.tokens && data[0]?.universe && data[1]) {
      return {
        name: "spotMetaAndAssetCtxs (get_spot_meta)",
        status: "✅ PASS",
        message: `${data[0].tokens.length} tokens, ${data[0].universe.length} pairs`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "spotMetaAndAssetCtxs",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "spotMetaAndAssetCtxs",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testSpotClearinghouseState(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "spotClearinghouseState", 
      user: HLP_VAULT_ADDRESS 
    }) as { balances: unknown[] };
    
    if (Array.isArray(data.balances)) {
      return {
        name: "spotClearinghouseState (get_spot_balances)",
        status: "✅ PASS",
        message: `${data.balances.length} token balances`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "spotClearinghouseState",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "spotClearinghouseState",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testClearinghouseState(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "clearinghouseState", 
      user: HLP_VAULT_ADDRESS 
    }) as { assetPositions: unknown[]; marginSummary: { accountValue: string } };
    
    if (data.assetPositions && data.marginSummary) {
      return {
        name: "clearinghouseState (get_user_state)",
        status: "✅ PASS",
        message: `${data.assetPositions.length} positions, $${Number(data.marginSummary.accountValue).toLocaleString()} account value`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "clearinghouseState",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "clearinghouseState",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testFrontendOpenOrders(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "frontendOpenOrders", 
      user: HLP_VAULT_ADDRESS 
    }) as unknown[];
    
    if (Array.isArray(data)) {
      return {
        name: "frontendOpenOrders (get_open_orders)",
        status: "✅ PASS",
        message: `${data.length} open orders`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "frontendOpenOrders",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "frontendOpenOrders",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testOrderStatus(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "orderStatus", 
      user: HLP_VAULT_ADDRESS,
      oid: 12345 // Test with dummy order ID
    }) as { status: string };
    
    if (data.status) {
      return {
        name: "orderStatus (get_order_status)",
        status: "✅ PASS",
        message: `Order status: ${data.status}`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "orderStatus",
      status: "⚠️ WARN",
      message: `Response: ${JSON.stringify(data).slice(0, 100)}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "orderStatus",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testUserFills(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "userFills", 
      user: HLP_VAULT_ADDRESS 
    }) as unknown[];
    
    if (Array.isArray(data)) {
      return {
        name: "userFills (get_user_fills)",
        status: "✅ PASS",
        message: `${data.length} trade fills`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "userFills",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "userFills",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testUserFees(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "userFees", 
      user: HLP_VAULT_ADDRESS 
    }) as { feeSchedule: unknown; userCrossRate: string };
    
    if (data.feeSchedule && data.userCrossRate) {
      return {
        name: "userFees (get_user_fees)",
        status: "✅ PASS",
        message: `Taker rate: ${(Number(data.userCrossRate) * 100).toFixed(3)}%`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "userFees",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "userFees",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testReferralState(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "referral", 
      user: HLP_VAULT_ADDRESS 
    }) as Record<string, unknown>;
    
    // Any response is valid (may be empty for some addresses)
    return {
      name: "referral (get_referral_state)",
      status: "✅ PASS",
      message: `Referral data retrieved (${Object.keys(data).length} fields)`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "referral",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testUserPortfolio(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "portfolio", 
      user: HLP_VAULT_ADDRESS 
    }) as Array<[string, unknown]>;
    
    if (Array.isArray(data) && data.length > 0) {
      const periods = data.map(([period]) => period);
      return {
        name: "portfolio (get_user_portfolio)",
        status: "✅ PASS",
        message: `Periods: ${periods.slice(0, 4).join(", ")}...`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "portfolio",
      status: "⚠️ WARN",
      message: "Unexpected structure or empty",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "portfolio",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testUserVaultEquities(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "userVaultEquities", 
      user: TEST_USER_ADDRESS 
    }) as Array<{ vaultAddress: string; equity: string }>;
    
    if (Array.isArray(data)) {
      const totalEquity = data.reduce((sum, v) => sum + Number(v.equity || 0), 0);
      return {
        name: "userVaultEquities (get_user_vault_equities)",
        status: "✅ PASS",
        message: `${data.length} vault positions, $${totalEquity.toLocaleString()} total`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "userVaultEquities",
      status: "⚠️ WARN",
      message: "Unexpected structure",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "userVaultEquities",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testSubAccounts(): Promise<TestResult> {
  const start = Date.now();
  try {
    const data = await hyperliquidPost({ 
      type: "subAccounts", 
      user: TEST_USER_ADDRESS 
    }) as unknown[] | null;
    
    // API returns null if no sub-accounts, or an array if they exist
    if (data === null || Array.isArray(data)) {
      return {
        name: "subAccounts (get_sub_accounts)",
        status: "✅ PASS",
        message: data === null ? "No sub-accounts (null response)" : `${data.length} sub-accounts`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "subAccounts",
      status: "⚠️ WARN",
      message: `Unexpected structure: ${typeof data}`,
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "subAccounts",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

// ============================================
// TIER 1 - INTELLIGENCE TOOLS (test underlying data)
// ============================================

async function testAnalyzeTraderPerformanceData(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Test all data sources needed for analyze_trader_performance
    const [fills, fees, portfolio] = await Promise.all([
      hyperliquidPost({ type: "userFills", user: HLP_VAULT_ADDRESS }) as Promise<unknown[]>,
      hyperliquidPost({ type: "userFees", user: HLP_VAULT_ADDRESS }) as Promise<Record<string, unknown>>,
      hyperliquidPost({ type: "portfolio", user: HLP_VAULT_ADDRESS }) as Promise<unknown[]>,
    ]);
    
    if (Array.isArray(fills) && fees.feeSchedule && Array.isArray(portfolio)) {
      return {
        name: "analyze_trader_performance (data composition)",
        status: "✅ PASS",
        message: `${fills.length} fills + fee schedule + portfolio data`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "analyze_trader_performance",
      status: "⚠️ WARN",
      message: "Missing some data sources",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "analyze_trader_performance",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testAnalyzeSpotMarketsData(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Test data sources for analyze_spot_markets
    const [spotData, perpData] = await Promise.all([
      hyperliquidPost({ type: "spotMetaAndAssetCtxs" }) as Promise<[{ tokens: unknown[]; universe: unknown[] }, unknown[]]>,
      hyperliquidPost({ type: "metaAndAssetCtxs" }) as Promise<[{ universe: unknown[] }, unknown[]]>,
    ]);
    
    if (spotData[0]?.universe && perpData[0]?.universe) {
      return {
        name: "analyze_spot_markets (data composition)",
        status: "✅ PASS",
        message: `${spotData[0].universe.length} spot pairs + ${perpData[0].universe.length} perp markets`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "analyze_spot_markets",
      status: "⚠️ WARN",
      message: "Missing some data sources",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "analyze_spot_markets",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function testAnalyzeWhaleWalletData(): Promise<TestResult> {
  const start = Date.now();
  try {
    // Test data sources for analyze_whale_wallet
    const [state, orders, spotBalances] = await Promise.all([
      hyperliquidPost({ type: "clearinghouseState", user: HLP_VAULT_ADDRESS }) as Promise<{ assetPositions: unknown[]; marginSummary: { accountValue: string } }>,
      hyperliquidPost({ type: "frontendOpenOrders", user: HLP_VAULT_ADDRESS }) as Promise<unknown[]>,
      hyperliquidPost({ type: "spotClearinghouseState", user: HLP_VAULT_ADDRESS }) as Promise<{ balances: unknown[] }>,
    ]);
    
    if (state.assetPositions && Array.isArray(orders) && state.marginSummary) {
      return {
        name: "analyze_whale_wallet (data composition)",
        status: "✅ PASS",
        message: `${state.assetPositions.length} positions, ${orders.length} orders, $${Number(state.marginSummary.accountValue).toLocaleString()} value`,
        duration: Date.now() - start,
      };
    }
    return {
      name: "analyze_whale_wallet",
      status: "⚠️ WARN",
      message: "Missing some data sources",
      duration: Date.now() - start,
    };
  } catch (error) {
    return {
      name: "analyze_whale_wallet",
      status: "❌ FAIL",
      message: error instanceof Error ? error.message : "Unknown error",
      duration: Date.now() - start,
    };
  }
}

async function runTests(): Promise<void> {
  console.log("\n" + "═".repeat(70));
  console.log("🧪 HYPERLIQUID MCP v2.2.0 - NEW ENDPOINT TESTS");
  console.log("═".repeat(70) + "\n");
  
  console.log("📊 TIER 2 - NEW RAW DATA ENDPOINTS\n");
  
  const tier2Tests = [
    testSpotMetaAndAssetCtxs,
    testSpotClearinghouseState,
    testClearinghouseState,
    testFrontendOpenOrders,
    testOrderStatus,
    testUserFills,
    testUserFees,
    testReferralState,
    testUserPortfolio,
    testUserVaultEquities,
    testSubAccounts,
  ];
  
  for (const test of tier2Tests) {
    const result = await test();
    results.push(result);
    console.log(`${result.status} ${result.name}`);
    console.log(`   ${result.message} (${result.duration}ms)\n`);
  }
  
  console.log("\n🧠 TIER 1 - NEW INTELLIGENCE TOOLS (data composition tests)\n");
  
  const tier1Tests = [
    testAnalyzeTraderPerformanceData,
    testAnalyzeSpotMarketsData,
    testAnalyzeWhaleWalletData,
  ];
  
  for (const test of tier1Tests) {
    const result = await test();
    results.push(result);
    console.log(`${result.status} ${result.name}`);
    console.log(`   ${result.message} (${result.duration}ms)\n`);
  }
  
  // Summary
  console.log("═".repeat(70));
  console.log("📊 TEST SUMMARY");
  console.log("═".repeat(70) + "\n");
  
  const passed = results.filter(r => r.status === "✅ PASS").length;
  const warned = results.filter(r => r.status === "⚠️ WARN").length;
  const failed = results.filter(r => r.status === "❌ FAIL").length;
  
  console.log(`   ✅ Passed: ${passed}`);
  console.log(`   ⚠️ Warnings: ${warned}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log(`   📈 Total: ${results.length}\n`);
  
  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / results.length;
  console.log(`   ⏱️  Avg response time: ${avgDuration.toFixed(0)}ms\n`);
  
  if (failed > 0) {
    console.log("❌ FAILED TESTS:");
    for (const r of results.filter(r => r.status === "❌ FAIL")) {
      console.log(`   • ${r.name}: ${r.message}`);
    }
    console.log("");
    process.exit(1);
  }
  
  if (passed === results.length) {
    console.log("🎉 ALL NEW ENDPOINTS WORKING CORRECTLY!\n");
    console.log("   Ready for MCP client integration.\n");
  }
}

runTests().catch(console.error);
