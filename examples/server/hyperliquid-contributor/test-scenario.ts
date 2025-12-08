/**
 * Test script to verify the price impact calculation for the HYPE sell scenario.
 * 
 * Scenario from tweet:
 * "The HyperLiquid team recently unstaked 2.6M $HYPE ($89.2M).
 * - 609,108 $HYPE ($20.9M) was sent to #Flowdesk"
 * 
 * Question: Can the market effectively absorb this sell flow?
 */

const HYPERLIQUID_API_URL = "https://api.hyperliquid.xyz/info";

interface L2Level {
  px: string;
  sz: string;
  n: number;
}

interface L2BookResponse {
  coin: string;
  time: number;
  levels: [L2Level[], L2Level[]];
}

async function testPriceImpact() {
  console.log("🔍 Testing HYPE Price Impact Scenario\n");
  console.log("Scenario: 609,108 HYPE ($20.9M) sent to Flowdesk");
  console.log("Question: Can the market absorb this sell flow?\n");
  
  // Fetch orderbook
  const response = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "l2Book", coin: "HYPE" }),
  });
  
  const data = await response.json() as L2BookResponse;
  const [rawBids, rawAsks] = data.levels;
  
  // Parse bids
  const bids = rawBids.map(level => ({
    price: Number(level.px),
    size: Number(level.sz),
    numOrders: level.n,
  }));
  
  const bestBid = bids.at(0)?.price ?? 0;
  const bestAsk = Number(rawAsks.at(0)?.px ?? 0);
  const midPrice = (bestBid + bestAsk) / 2;
  
  console.log(`📊 Current Market State:`);
  console.log(`   Mid Price: $${midPrice.toFixed(4)}`);
  console.log(`   Best Bid: $${bestBid}`);
  console.log(`   Best Ask: $${bestAsk}`);
  console.log(`   Spread: ${((bestAsk - bestBid) / midPrice * 10000).toFixed(2)} bps\n`);
  
  // Calculate total bid liquidity
  let totalBidLiquidity = 0;
  let totalBidSize = 0;
  for (const bid of bids) {
    totalBidLiquidity += bid.price * bid.size;
    totalBidSize += bid.size;
  }
  
  console.log(`💰 Visible Bid Liquidity:`);
  console.log(`   Total Size: ${totalBidSize.toFixed(2)} HYPE`);
  console.log(`   Total Notional: $${(totalBidLiquidity / 1000000).toFixed(2)}M\n`);
  
  // Simulate sell of 609,108 HYPE
  const sellSize = 609108;
  let remainingSize = sellSize;
  let totalFilled = 0;
  let totalNotional = 0;
  let levelsConsumed = 0;
  let worstPrice = midPrice;
  
  for (const bid of bids) {
    if (remainingSize <= 0) break;
    
    const fillSize = Math.min(remainingSize, bid.size);
    totalFilled += fillSize;
    totalNotional += fillSize * bid.price;
    remainingSize -= fillSize;
    levelsConsumed++;
    worstPrice = bid.price;
  }
  
  const avgFillPrice = totalFilled > 0 ? totalNotional / totalFilled : midPrice;
  const priceImpact = ((avgFillPrice - midPrice) / midPrice) * 100;
  const slippageBps = Math.abs(priceImpact) * 100;
  const filledPercent = (totalFilled / sellSize) * 100;
  
  console.log(`🎯 Price Impact Analysis for ${sellSize.toLocaleString()} HYPE:`);
  console.log(`   Order Notional: $${(sellSize * midPrice / 1000000).toFixed(2)}M`);
  console.log(`   Average Fill Price: $${avgFillPrice.toFixed(4)}`);
  console.log(`   Worst Fill Price: $${worstPrice.toFixed(4)}`);
  console.log(`   Price Impact: ${priceImpact.toFixed(4)}%`);
  console.log(`   Slippage: ${slippageBps.toFixed(2)} bps`);
  console.log(`   Filled: ${totalFilled.toLocaleString()} HYPE (${filledPercent.toFixed(2)}%)`);
  console.log(`   Remaining: ${remainingSize.toLocaleString()} HYPE`);
  console.log(`   Levels Consumed: ${levelsConsumed}`);
  
  const canAbsorb = remainingSize <= 0;
  console.log(`\n📈 Verdict:`);
  
  if (canAbsorb) {
    if (slippageBps < 50) {
      console.log(`   ✅ Market can EASILY absorb this sell flow`);
      console.log(`   💡 Slippage is minimal (< 0.5%)`);
    } else if (slippageBps < 200) {
      console.log(`   ⚠️ Market can absorb this sell flow WITH MODERATE IMPACT`);
      console.log(`   💡 Expect ${slippageBps.toFixed(0)} bps slippage (~${priceImpact.toFixed(2)}% drop)`);
    } else {
      console.log(`   ⚠️ Market can absorb but WITH SIGNIFICANT IMPACT`);
      console.log(`   💡 Expect ${slippageBps.toFixed(0)} bps slippage (~${priceImpact.toFixed(2)}% drop)`);
    }
  } else {
    console.log(`   ❌ Market CANNOT absorb this sell flow`);
    console.log(`   💡 Would exhaust visible liquidity`);
    console.log(`   💡 ${remainingSize.toLocaleString()} HYPE would remain unfilled`);
    console.log(`   💡 Price would rerate significantly lower`);
  }
  
  // Additional context
  console.log(`\n📝 Note: This analysis is based on visible orderbook only.`);
  console.log(`   Hidden liquidity, market makers, and OTC desks may provide`);
  console.log(`   additional absorption capacity. Flowdesk likely uses TWAP`);
  console.log(`   or algorithmic execution to minimize market impact.`);
}

testPriceImpact().catch(console.error);

