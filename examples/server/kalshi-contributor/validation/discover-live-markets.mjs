#!/usr/bin/env node

/**
 * Fetches open Kalshi markets from the public Trade API (no auth) for
 * alpha-researcher grounding. Writes a compact snapshot for test prompts.
 *
 * Usage: node discover-live-markets.mjs [--out path/to/live-market-snapshot.json]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const REQUEST_TIMEOUT_MS = 20_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseOutArg(argv) {
  const idx = argv.indexOf("--out");
  if (idx >= 0 && typeof argv[idx + 1] === "string") {
    return path.resolve(argv[idx + 1]);
  }
  return path.join(__dirname, "live-market-snapshot.json");
}

function pickMarket(m) {
  return {
    ticker: m.ticker ?? "",
    eventTicker: m.event_ticker ?? "",
    title: m.title ?? "",
    subtitle: m.subtitle ?? "",
    status: m.status ?? "",
    yesBid: m.yes_bid ?? null,
    yesAsk: m.yes_ask ?? null,
    noBid: m.no_bid ?? null,
    noAsk: m.no_ask ?? null,
    volume24h: m.volume_24h ?? m.volume24h ?? null,
    liquidity: m.liquidity ?? null,
    closeTime: m.close_time ?? m.closeTime ?? null,
    category: m.category ?? null,
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const outPath = parseOutArg(process.argv);
  const base = process.env.KALSHI_API_BASE_URL
    ? `${process.env.KALSHI_API_BASE_URL.replace(/\/$/u, "")}/trade-api/v2`
    : DEFAULT_BASE;

  const page1 = await fetchJson(`${base}/markets?limit=100&status=open`);
  const marketsRaw = Array.isArray(page1.markets) ? page1.markets : [];
  const byTicker = new Map();
  for (const m of marketsRaw) {
    const t = m?.ticker;
    if (typeof t === "string" && t.length > 0 && !byTicker.has(t)) {
      byTicker.set(t, pickMarket(m));
    }
  }
  const markets = [...byTicker.values()].slice(0, 60);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    apiBase: base,
    source: "GET /markets (public Kalshi Trade API)",
    marketCount: markets.length,
    markets,
    sampleTickers: markets.slice(0, 15).map((m) => m.ticker),
  };

  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(`Wrote ${outPath} (${String(markets.length)} markets)\n`);
}

void main().catch((error) => {
  process.stderr.write(`discover-live-markets failed: ${error}\n`);
  process.exitCode = 1;
});
