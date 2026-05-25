/**
 * Live probe: Polymarket Data API GET /trades pagination behavior.
 * Run: node validation/probe-trades-pagination.mjs
 *
 * Does NOT use our contributor server — hits data-api.polymarket.com directly.
 */

const BASE = "https://data-api.polymarket.com/trades";

// High 24h volume market (from get_top_markets during deploy smoke)
const HOT_MARKET =
  "0x421bc1929df1429cf2cb94f80c1ce6a3ed0d1f0b7a2749b9890075f94eb549e9";

// Quieter market for contrast
const QUIET_MARKET =
  "0xd9fb1184af0064e5e34b129f5b79afa5a17b7e32f2953ab05efed82315fee6d4";

async function fetchTrades(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      search.set(key, String(value));
    }
  }
  const url = `${BASE}?${search.toString()}`;
  const started = Date.now();
  const response = await fetch(url);
  const elapsedMs = Date.now() - started;
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  const rows = Array.isArray(body) ? body.length : null;
  const error = !Array.isArray(body) && body?.error ? body.error : null;
  return {
    url,
    status: response.status,
    elapsedMs,
    rows,
    trades: Array.isArray(body) ? body : [],
    error,
    bodyPreview: typeof body === "string" ? body.slice(0, 120) : null,
  };
}

function tradeKey(trade) {
  return [
    trade.transactionHash,
    trade.timestamp,
    trade.size,
    trade.price,
    trade.proxyWallet,
    trade.outcome,
  ].join("|");
}

function timestampRange(trades) {
  const timestamps = trades
    .map((trade) => trade.timestamp)
    .filter((value) => Number.isFinite(value));
  return {
    newest: timestamps.length > 0 ? Math.max(...timestamps) : null,
    oldest: timestamps.length > 0 ? Math.min(...timestamps) : null,
  };
}

function countOverlap(left, right) {
  const leftKeys = new Set(left.map(tradeKey));
  return right.filter((trade) => leftKeys.has(tradeKey(trade))).length;
}

function summarize(label, result) {
  return {
    label,
    status: result.status,
    rows: result.rows,
    error: result.error,
    ms: result.elapsedMs,
  };
}

async function probeLimitBehavior(market) {
  console.log("\n=== LIMIT probe (offset=0) ===");
  const limits = [100, 500, 1000, 1500, 2000, 5000, 10000];
  const results = [];
  for (const limit of limits) {
    const r = await fetchTrades({ market, limit, offset: 0 });
    results.push(
      summarize(`limit=${limit}`, r)
    );
  }
  console.log(JSON.stringify(results, null, 2));

  const at1000 = results.find((r) => r.label === "limit=1000")?.rows;
  const at2000 = results.find((r) => r.label === "limit=2000")?.rows;
  const at10000 = results.find((r) => r.label === "limit=10000")?.rows;
  console.log("\nLimit interpretation:");
  if (at1000 === at2000 && at2000 === at10000 && at1000 !== null) {
    console.log(`  Hard page cap at ~${at1000} rows (higher limits return same count).`);
  } else if (at10000 > at1000) {
    console.log(`  Higher limits DO return more rows (docs max may be real).`);
  } else {
    console.log(`  Mixed/inconclusive — inspect table above.`);
  }
}

async function probeOffsetBehavior(market) {
  console.log("\n=== OFFSET probe (limit=1000) ===");
  const offsets = [0, 1000, 2000, 2999, 3000, 3001, 4000, 5000, 9000, 10000];
  const results = [];
  for (const offset of offsets) {
    const r = await fetchTrades({ market, limit: 1000, offset });
    results.push(summarize(`offset=${offset}`, r));
  }
  console.log(JSON.stringify(results, null, 2));

  const maxOk = results.filter((r) => r.status === 200 && r.rows > 0);
  const lastOk = maxOk.at(-1);
  const firstFail = results.find((r) => r.status !== 200 || r.error);
  console.log("\nOffset interpretation:");
  console.log(
    `  Last successful page: ${lastOk?.label ?? "none"} (${lastOk?.rows ?? 0} rows)`
  );
  if (firstFail) {
    console.log(
      `  First failure: ${firstFail.label} status=${firstFail.status} error=${firstFail.error ?? "n/a"}`
    );
  }
}

async function probeSequentialPages(market) {
  console.log("\n=== SEQUENTIAL pages (limit=1000, offset += 1000) ===");
  const pages = [];
  for (let page = 0; page < 12; page += 1) {
    const offset = page * 1000;
    const r = await fetchTrades({ market, limit: 1000, offset });
    pages.push({
      page: page + 1,
      offset,
      status: r.status,
      rows: r.rows,
      error: r.error,
    });
    if (r.status !== 200 || r.rows === 0) {
      break;
    }
  }
  console.log(JSON.stringify(pages, null, 2));
  const totalRows = pages
    .filter((p) => p.status === 200 && typeof p.rows === "number")
    .reduce((sum, p) => sum + p.rows, 0);
  console.log(`\nTotal rows fetched across pages: ${totalRows}`);
}

async function probeTimestampCursorWorkaround(market) {
  console.log("\n=== TIMESTAMP cursor workaround probe ===");
  const firstPage = await fetchTrades({ market, limit: 1000, offset: 0 });
  const fourthPage = await fetchTrades({ market, limit: 1000, offset: 3000 });
  const fourthPageRange = timestampRange(fourthPage.trades);
  const beforeOldest =
    fourthPageRange.oldest === null
      ? null
      : await fetchTrades({
          market,
          limit: 1000,
          before: fourthPageRange.oldest - 1,
        });
  const beforeOldestRange = beforeOldest
    ? timestampRange(beforeOldest.trades)
    : { newest: null, oldest: null };

  console.log(
    JSON.stringify(
      {
        firstPage: {
          ...summarize("offset=0", firstPage),
          ...timestampRange(firstPage.trades),
        },
        fourthPage: {
          ...summarize("offset=3000", fourthPage),
          ...fourthPageRange,
        },
        beforeFourthPageOldest: beforeOldest
          ? {
              ...summarize(`before=${fourthPageRange.oldest - 1}`, beforeOldest),
              ...beforeOldestRange,
              overlapWithFirstPage: countOverlap(firstPage.trades, beforeOldest.trades),
              overlapWithFourthPage: countOverlap(
                fourthPage.trades,
                beforeOldest.trades
              ),
            }
          : null,
      },
      null,
      2
    )
  );

  console.log("\nTimestamp cursor interpretation:");
  if (
    beforeOldest &&
    beforeOldestRange.oldest === timestampRange(firstPage.trades).oldest
  ) {
    console.log(
      "  Public Data API /trades appears to ignore before/after; it returned the newest page again."
    );
    console.log(
      "  The documented before/after cursor params are for the CLOB /trades endpoint, not this public Data API endpoint."
    );
  } else if (beforeOldest && beforeOldestRange.newest < fourthPageRange.oldest) {
    console.log("  before/after moved beyond offset=3000; deeper public paging may work.");
  } else {
    console.log("  Mixed/inconclusive — inspect table above.");
  }
}

async function probeClobTradesEndpoint(market) {
  console.log("\n=== CLOB /trades auth check ===");
  const url = `https://clob.polymarket.com/trades?market=${encodeURIComponent(
    market
  )}&before=1700000000`;
  const response = await fetch(url);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  console.log(
    JSON.stringify(
      {
        status: response.status,
        body: typeof body === "string" ? body.slice(0, 160) : body,
      },
      null,
      2
    )
  );
  console.log(
    "CLOB interpretation: this endpoint documents before/after and next_cursor, but it is not usable as an unauthenticated public fallback."
  );
}

async function probeTakerOnly(market) {
  console.log("\n=== takerOnly=true vs false (limit=1000, offset=0) ===");
  for (const takerOnly of [true, false]) {
    const r = await fetchTrades({ market, limit: 1000, offset: 0, takerOnly });
    console.log(JSON.stringify(summarize(`takerOnly=${takerOnly}`, r), null, 2));
  }
}

async function main() {
  console.log("Polymarket Data API /trades pagination probe");
  console.log("Docs claim: limit max 10000, offset max 10000");
  console.log(`Hot market: ${HOT_MARKET}`);
  console.log(`Quiet market: ${QUIET_MARKET}`);

  await probeLimitBehavior(HOT_MARKET);
  await probeOffsetBehavior(HOT_MARKET);
  await probeSequentialPages(HOT_MARKET);
  await probeTimestampCursorWorkaround(HOT_MARKET);
  await probeClobTradesEndpoint(HOT_MARKET);
  await probeTakerOnly(HOT_MARKET);

  console.log("\n--- Repeat offset probe on quiet market ---");
  await probeOffsetBehavior(QUIET_MARKET);
  await probeSequentialPages(QUIET_MARKET);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
