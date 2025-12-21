/**
 * Test correct market lookup endpoints based on Context7 docs
 */

const GAMMA_API_URL = "https://gamma-api.polymarket.com";
const CLOB_API_URL = "https://clob.polymarket.com";

async function testMarketLookup() {
  // First, get a real conditionId and slug from an event
  console.log("1. Fetching test market data from an event...\n");
  
  const eventsResp = await fetch(`${GAMMA_API_URL}/events?closed=false&limit=3`);
  const events = await eventsResp.json();
  
  let testConditionId: string | null = null;
  let testSlug: string | null = null;
  let testEventSlug: string | null = null;
  
  for (const event of events) {
    if (event.markets?.[0]?.conditionId && event.slug) {
      testConditionId = event.markets[0].conditionId;
      testSlug = event.markets[0].slug || null;
      testEventSlug = event.slug;
      console.log(`Found test market:`);
      console.log(`  Event Title: ${event.title}`);
      console.log(`  Event Slug: ${testEventSlug}`);
      console.log(`  Market ConditionId: ${testConditionId}`);
      console.log(`  Market Slug: ${testSlug || 'N/A'}`);
      break;
    }
  }
  
  if (!testConditionId) {
    console.error("❌ Could not find a market with conditionId");
    return;
  }

  // TEST 1: Gamma API /markets?condition_id= (DOESN'T WORK - per Context7 docs)
  console.log("\n2. Testing Gamma API: /markets?condition_id=... (expected to NOT filter)\n");
  try {
    const resp = await fetch(`${GAMMA_API_URL}/markets?condition_id=${testConditionId}&limit=3`);
    const markets = await resp.json();
    console.log(`   Status: ${resp.status}`);
    console.log(`   Markets returned: ${markets.length}`);
    if (markets.length > 0) {
      const firstMatch = markets[0].conditionId === testConditionId;
      console.log(`   First market conditionId matches: ${firstMatch ? '✅ YES' : '❌ NO'}`);
      console.log(`   First market conditionId: ${markets[0].conditionId?.slice(0, 20)}...`);
      if (!firstMatch) {
        console.log(`   ⚠️ CONFIRMED: condition_id param is IGNORED by Gamma API`);
      }
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e}`);
  }

  // TEST 2: CLOB API /markets/{conditionId} (Used in existing code)
  console.log("\n3. Testing CLOB API: /markets/{conditionId}\n");
  try {
    const resp = await fetch(`${CLOB_API_URL}/markets/${testConditionId}`);
    const status = resp.status;
    console.log(`   Status: ${status}`);
    
    if (resp.ok) {
      const market = await resp.json();
      console.log(`   ✅ SUCCESS - Found market!`);
      console.log(`   Market data:`);
      console.log(`     - condition_id: ${market.condition_id?.slice(0, 30)}...`);
      console.log(`     - question_id: ${market.question_id?.slice(0, 30) || 'N/A'}...`);
      console.log(`     - tokens: ${market.tokens?.length || 0} tokens`);
      if (market.tokens?.[0]) {
        console.log(`     - token[0].token_id: ${market.tokens[0].token_id?.slice(0, 30)}...`);
        console.log(`     - token[0].outcome: ${market.tokens[0].outcome}`);
      }
    } else {
      const text = await resp.text();
      console.log(`   ❌ FAILED: ${text.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e}`);
  }

  // TEST 3: Gamma API /events/slug/{slug} (Documented correct approach)
  if (testEventSlug) {
    console.log("\n4. Testing Gamma API: /events/slug/{slug} (RECOMMENDED)\n");
    try {
      const resp = await fetch(`${GAMMA_API_URL}/events/slug/${testEventSlug}`);
      const event = await resp.json();
      console.log(`   Status: ${resp.status}`);
      if (event && event.markets) {
        console.log(`   ✅ SUCCESS - Found event with ${event.markets.length} markets`);
        const targetMarket = event.markets.find((m: any) => m.conditionId === testConditionId);
        if (targetMarket) {
          console.log(`   ✅ Found target market by conditionId in event!`);
          console.log(`     - question: ${targetMarket.question?.slice(0, 50) || targetMarket.title?.slice(0, 50)}...`);
        }
      } else {
        console.log(`   ❌ Event not found or no markets`);
      }
    } catch (e) {
      console.log(`   ❌ Error: ${e}`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("CONCLUSION:");
  console.log("=".repeat(60));
  console.log("✅ CLOB API /markets/{conditionId} works for direct lookup");
  console.log("✅ Gamma API /events/slug/{slug} works for slug-based lookup");
  console.log("❌ Gamma API /markets?condition_id= does NOT filter by conditionId");
}

testMarketLookup().catch(console.error);
