// Simple direct test of the CLOB API endpoints
const YES_TOKEN = "45343480653694577807177505914664405669209636932459044719445554137639656106379";
const NO_TOKEN = "41964567801082845894806819450184088025109907047152958677101366054975498213237";
const CONDITION_ID = "0xafc235557ace53ff0b0d2e93392314a7c3f3daab26a79050e985c11282f66df7";
async function test() {
    console.log("🧪 Testing CLOB API directly (no MCP)\n");
    // Test 1: Get orderbook
    console.log("1️⃣ Fetching YES orderbook...");
    const yesBook = await fetch(`https://clob.polymarket.com/book?token_id=${YES_TOKEN}`).then(r => r.json());
    console.log(`   ✅ Got ${yesBook.bids?.length} bids, market: ${yesBook.market?.slice(0, 20)}...`);
    // Test 2: Get market to find complement token
    console.log("\n2️⃣ Fetching market info...");
    const market = await fetch(`https://clob.polymarket.com/markets/${CONDITION_ID}`).then(r => r.json());
    console.log(`   ✅ Market: ${market.question}`);
    console.log(`   ✅ Tokens: YES=${market.tokens?.[0]?.token_id?.slice(0, 20)}..., NO=${market.tokens?.[1]?.token_id?.slice(0, 20)}...`);
    // Test 3: Get NO orderbook 
    console.log("\n3️⃣ Fetching NO orderbook...");
    const noBook = await fetch(`https://clob.polymarket.com/book?token_id=${NO_TOKEN}`).then(r => r.json());
    console.log(`   ✅ Got ${noBook.bids?.length} bids, ${noBook.asks?.length} asks`);
    // Test 4: Build merged orderbook
    console.log("\n4️⃣ Building merged orderbook...");
    const mergedBids = [];
    const mergedAsks = [];
    // Synthetic YES bids from NO asks
    for (const ask of noBook.asks || []) {
        const synthetic = 1 - Number(ask.price);
        if (synthetic > 0 && synthetic < 1) {
            mergedBids.push({ price: synthetic, size: Number(ask.size) });
        }
    }
    // Synthetic YES asks from NO bids
    for (const bid of noBook.bids || []) {
        const synthetic = 1 - Number(bid.price);
        if (synthetic > 0 && synthetic < 1) {
            mergedAsks.push({ price: synthetic, size: Number(bid.size) });
        }
    }
    mergedBids.sort((a, b) => b.price - a.price);
    mergedAsks.sort((a, b) => a.price - b.price);
    console.log(`   ✅ Merged bids: ${mergedBids.length}, Best: ${(mergedBids[0]?.price * 100).toFixed(0)}¢`);
    console.log(`   ✅ Merged asks: ${mergedAsks.length}, Best: ${(mergedAsks[0]?.price * 100).toFixed(0)}¢`);
    console.log(`   ✅ Spread: ${((mergedAsks[0]?.price - mergedBids[0]?.price) * 100).toFixed(0)}¢`);
    // Test 5: Get prices
    console.log("\n5️⃣ Fetching prices...");
    const prices = await fetch("https://clob.polymarket.com/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
            { token_id: YES_TOKEN, side: "BUY" },
            { token_id: NO_TOKEN, side: "BUY" },
        ])
    }).then(r => r.json());
    const yesPrice = prices[YES_TOKEN]?.BUY || prices[YES_TOKEN];
    const noPrice = prices[NO_TOKEN]?.BUY || prices[NO_TOKEN];
    console.log(`   ✅ YES: ${(Number(yesPrice) * 100).toFixed(0)}¢, NO: ${(Number(noPrice) * 100).toFixed(0)}¢`);
    console.log(`   ✅ Sum: ${((Number(yesPrice) + Number(noPrice)) * 100).toFixed(0)}¢`);
    console.log("\n✅ All API tests passed!");
}
test().catch(console.error);
export {};
