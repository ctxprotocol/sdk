/**
 * Validate whale-flow size bucket thresholds against live Polymarket trade tapes.
 *
 * Pass 1: unfiltered recent tape (up to 4k rows) — retail/medium/large mix.
 * Pass 2: server-side CASH>=$500 tape — large-print deep window (what analyze_whale_flow supplements with).
 * Pass 3: server-side CASH>=$10k tape — true whale print density and notional range.
 *
 * Run: node validation/probe-trade-size-distribution.mjs
 */

const TRADES_BASE = "https://data-api.polymarket.com/trades";
const GAMMA_BASE = "https://gamma-api.polymarket.com/markets";

const BUCKETS = {
  smallMax: 50,
  mediumMax: 500,
  whaleMin: 10_000,
};

const HOT_MARKET =
  "0x421bc1929df1429cf2cb94f80c1ce6a3ed0d1f0b7a2749b9890075f94eb549e9";

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

async function fetchAllTrades(market, options = {}) {
  const { maxRows = 4_000, filterAmount = null } = options;
  const trades = [];
  for (let offset = 0; offset < maxRows; offset += 1_000) {
    const params = new URLSearchParams({
      market,
      limit: "1000",
      offset: String(offset),
    });
    if (filterAmount !== null) {
      params.set("filterType", "CASH");
      params.set("filterAmount", String(filterAmount));
    }
    const url = `${TRADES_BASE}?${params.toString()}`;
    const { status, body } = await fetchJson(url);
    if (status !== 200 || !Array.isArray(body) || body.length === 0) {
      break;
    }
    trades.push(...body);
    if (body.length < 1_000) {
      break;
    }
  }
  return trades;
}

function tradeNotional(trade) {
  const size = Number(trade.size ?? 0);
  const price = Number(trade.price ?? 0);
  const value = size * price;
  return Number.isFinite(value) ? value : 0;
}

function timestampRange(trades) {
  const timestamps = trades
    .map((trade) => Number(trade.timestamp))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) {
    return { newest: null, oldest: null, spanHours: null };
  }
  const newest = Math.max(...timestamps);
  const oldest = Math.min(...timestamps);
  return {
    newest,
    oldest,
    spanHours: Number(((newest - oldest) / 3600).toFixed(1)),
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) {
    return null;
  }
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
}

function classifyNotional(notional) {
  if (notional < BUCKETS.smallMax) {
    return "small";
  }
  if (notional < BUCKETS.mediumMax) {
    return "medium";
  }
  if (notional < BUCKETS.whaleMin) {
    return "large";
  }
  return "whale";
}

function analyzeDistribution(notionals) {
  const sorted = [...notionals].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const bucketCounts = { small: 0, medium: 0, large: 0, whale: 0 };
  const bucketVolume = { small: 0, medium: 0, large: 0, whale: 0 };

  for (const notional of sorted) {
    const bucket = classifyNotional(notional);
    bucketCounts[bucket] += 1;
    bucketVolume[bucket] += notional;
  }

  const count = sorted.length;
  const pct = (n) => (count > 0 ? Number(((n / count) * 100).toFixed(1)) : 0);
  const volPct = (n) => (total > 0 ? Number(((n / total) * 100).toFixed(1)) : 0);

  return {
    tradeCount: count,
    totalNotionalUsd: Number(total.toFixed(2)),
    percentilesUsd: {
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p90: percentile(sorted, 90),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
      max: sorted.at(-1) ?? null,
    },
    bucketCounts,
    bucketCountPct: {
      small: pct(bucketCounts.small),
      medium: pct(bucketCounts.medium),
      large: pct(bucketCounts.large),
      whale: pct(bucketCounts.whale),
    },
    bucketVolumeUsd: Object.fromEntries(
      Object.entries(bucketVolume).map(([key, value]) => [key, Number(value.toFixed(2))])
    ),
    bucketVolumePct: {
      small: volPct(bucketVolume.small),
      medium: volPct(bucketVolume.medium),
      large: volPct(bucketVolume.large),
      whale: volPct(bucketVolume.whale),
    },
  };
}

function analyzeLargeVsWhaleOnFilteredTape(notionals) {
  const sorted = [...notionals].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const largeOnly = sorted.filter(
    (value) => value >= BUCKETS.mediumMax && value < BUCKETS.whaleMin
  );
  const whaleOnly = sorted.filter((value) => value >= BUCKETS.whaleMin);
  const largeVolume = largeOnly.reduce((sum, value) => sum + value, 0);
  const whaleVolume = whaleOnly.reduce((sum, value) => sum + value, 0);

  const notes = [];
  if (largeOnly.length === 0 && whaleOnly.length === 0) {
    notes.push("No prints in filtered sample.");
  } else if (largeOnly.length === 0) {
    notes.push(
      "Filtered tape is whale-only at this depth — large tier empty (market may lack $500–$10k prints in this window)."
    );
  } else if (whaleOnly.length === 0) {
    notes.push(
      `Filtered tape has ${largeOnly.length} large prints but no whales — $10k floor may be too high for this market's conviction sizing.`
    );
  } else {
    notes.push(
      `Large ($500–$10k): ${largeOnly.length} prints (${total > 0 ? ((largeVolume / total) * 100).toFixed(1) : 0}% vol). Whale (>=$10k): ${whaleOnly.length} prints (${total > 0 ? ((whaleVolume / total) * 100).toFixed(1) : 0}% vol).`
    );
  }

  if (whaleOnly.length > 0 && largeOnly.length > 0) {
    const whaleShareOfCount = whaleOnly.length / (largeOnly.length + whaleOnly.length);
    if (whaleShareOfCount <= 0.25) {
      notes.push(
        `Whale prints are ${(whaleShareOfCount * 100).toFixed(1)}% of filtered large+ prints — $10k cleanly separates a rare tail.`
      );
    } else {
      notes.push(
        `Whale prints are ${(whaleShareOfCount * 100).toFixed(1)}% of filtered large+ prints — whale tier is not ultra-rare on this market.`
      );
    }
  }

  const thresholdsReasonable =
    whaleOnly.length === 0 ||
    (largeOnly.length > 0 && whaleVolume / (largeVolume + whaleVolume) >= 0.2);

  return {
    largePrintCount: largeOnly.length,
    whalePrintCount: whaleOnly.length,
    largeVolumeUsd: Number(largeVolume.toFixed(2)),
    whaleVolumeUsd: Number(whaleVolume.toFixed(2)),
    largeVolumePct: total > 0 ? Number(((largeVolume / total) * 100).toFixed(1)) : 0,
    whaleVolumePct: total > 0 ? Number(((whaleVolume / total) * 100).toFixed(1)) : 0,
    thresholdsReasonable,
    notes,
  };
}

function evaluateRawThresholds(stats) {
  const notes = [];
  const { percentilesUsd, bucketCounts, bucketCountPct, bucketVolumePct } = stats;

  if (bucketCountPct.small >= 40) {
    notes.push(
      `Small bucket dominates count (${bucketCountPct.small}%) — <$${BUCKETS.smallMax} correctly captures retail/noise.`
    );
  }

  if (bucketCountPct.medium >= 5 && bucketCountPct.medium <= 40) {
    notes.push(
      `Medium bucket (${bucketCountPct.medium}% of trades) is a meaningful middle tier.`
    );
  }

  if (bucketCounts.large > 0 && bucketVolumePct.large >= 5) {
    notes.push(
      `Large bucket carries ${bucketVolumePct.large}% of notional on recent tape.`
    );
  }

  if (bucketCounts.whale > 0) {
    notes.push(
      `Whale bucket has ${bucketCounts.whale} prints (${bucketCountPct.whale}%) on recent unfiltered tape.`
    );
  }

  if (percentilesUsd.p99 !== null && percentilesUsd.p99 < BUCKETS.whaleMin) {
    notes.push(`p99 ($${percentilesUsd.p99.toFixed(2)}) is below $10k on recent tape.`);
  }

  const thresholdsReasonable =
    bucketCountPct.small + bucketCountPct.medium >= 30 &&
    (bucketCounts.large > 0 || bucketCounts.whale > 0);

  return { thresholdsReasonable, notes };
}

async function fetchTopMarkets(limit = 5) {
  const url = `${GAMMA_BASE}?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`;
  const { status, body } = await fetchJson(url);
  if (status !== 200 || !Array.isArray(body)) {
    return [];
  }
  return body.map((market) => ({
    conditionId: market.conditionId,
    question: market.question,
    volume24hr: Number(market.volume24hr ?? market.volume ?? 0),
    slug: market.slug,
  }));
}

async function analyzeMarket(label, conditionId, question) {
  const rawTrades = await fetchAllTrades(conditionId);
  const filtered500Trades = await fetchAllTrades(conditionId, { filterAmount: 500 });
  const filtered10kTrades = await fetchAllTrades(conditionId, { filterAmount: 10_000 });

  const rawNotionals = rawTrades.map(tradeNotional).filter((value) => value > 0);
  const filtered500Notionals = filtered500Trades
    .map(tradeNotional)
    .filter((value) => value > 0);
  const filtered10kNotionals = filtered10kTrades
    .map(tradeNotional)
    .filter((value) => value > 0);

  const rawStats = analyzeDistribution(rawNotionals);
  const filtered500Stats = analyzeDistribution(filtered500Notionals);
  const filtered10kStats = analyzeDistribution(filtered10kNotionals);
  const largeVsWhaleOn500Tape = analyzeLargeVsWhaleOnFilteredTape(filtered500Notionals);

  return {
    label,
    conditionId,
    question: question?.slice(0, 120) ?? null,
    rawRecentTape: {
      ...rawStats,
      timeWindow: timestampRange(rawTrades),
      evaluation: evaluateRawThresholds(rawStats),
    },
    filtered500PlusTape: {
      ...filtered500Stats,
      timeWindow: timestampRange(filtered500Trades),
      largeVsWhale: largeVsWhaleOn500Tape,
    },
    filtered10kPlusTape: {
      tradeCount: filtered10kStats.tradeCount,
      totalNotionalUsd: filtered10kStats.totalNotionalUsd,
      percentilesUsd: filtered10kStats.percentilesUsd,
      minNotional: filtered10kNotionals.length > 0 ? Math.min(...filtered10kNotionals) : null,
      maxNotional: filtered10kStats.percentilesUsd.max,
      timeWindow: timestampRange(filtered10kTrades),
    },
  };
}

async function main() {
  console.log("Polymarket trade size distribution probe (raw + filtered passes)");
  console.log(
    `Bucket thresholds: small<$${BUCKETS.smallMax}, medium<$${BUCKETS.mediumMax}, large<$${BUCKETS.whaleMin.toLocaleString()}, whale>=$${BUCKETS.whaleMin.toLocaleString()}`
  );

  const topMarkets = await fetchTopMarkets(5);
  const marketsToProbe = [
    { label: "known-hot", conditionId: HOT_MARKET, question: "(deploy smoke hot market)" },
    ...topMarkets.map((market, index) => ({
      label: `top-vol-${index + 1}`,
      conditionId: market.conditionId,
      question: market.question,
    })),
  ];

  const seen = new Set();
  const uniqueMarkets = marketsToProbe.filter((market) => {
    if (seen.has(market.conditionId)) {
      return false;
    }
    seen.add(market.conditionId);
    return true;
  });

  const results = [];
  for (const market of uniqueMarkets) {
    results.push(await analyzeMarket(market.label, market.conditionId, market.question));
  }

  const rawPass = results.every(
    (result) => result.rawRecentTape.evaluation.thresholdsReasonable
  );
  const filteredPass = results.every(
    (result) => result.filtered500PlusTape.largeVsWhale.thresholdsReasonable
  );

  console.log(
    JSON.stringify(
      {
        pass: rawPass && filteredPass,
        rawPass,
        filteredPass,
        bucketThresholds: BUCKETS,
        marketCount: results.length,
        markets: results,
        summary:
          "Pass 1 validates retail/medium cutoffs on recent tape. Pass 2/3 validate large vs whale separation on server-side filtered deep tapes (what analyze_whale_flow and minNotional tools actually use).",
      },
      null,
      2
    )
  );

  process.exit(rawPass && filteredPass ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
