#!/usr/bin/env node

/**
 * Queries the public Polymarket Gamma API to discover current live markets
 * and events. Outputs a structured JSON snapshot that the alpha-researcher
 * uses to generate grounded, entity-specific test prompts.
 *
 * Usage:
 *   node discover-live-markets.mjs [--out path/to/output.json]
 *
 * The output includes:
 *   - Top single-outcome markets by 24h volume
 *   - Top multi-outcome events by 24h volume
 *   - Markets with neg-risk enabled
 *   - A sample of markets ending soon
 *   - Category/tag overview
 *
 * All data comes from the public Gamma API (no auth required).
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GAMMA_API = "https://gamma-api.polymarket.com";
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function pickMarketFields(m) {
  return {
    question: m.question ?? "",
    slug: m.slug ?? "",
    conditionId: (m.conditionId ?? "").slice(0, 20),
    outcomePrices: m.outcomePrices ?? [],
    volume24hr: Number(m.volume24hr ?? 0),
    negRisk: Boolean(m.negRisk),
    endDate: m.endDate ?? null,
    outcomes: m.outcomes ?? ["Yes", "No"],
  };
}

function pickEventFields(e) {
  const markets = (e.markets ?? []).map(pickMarketFields);
  return {
    title: e.title ?? "",
    slug: e.slug ?? "",
    id: e.id ?? null,
    marketCount: markets.length,
    markets: markets.slice(0, 8),
  };
}

async function discoverTopMarkets() {
  const raw = await fetchJson(
    `${GAMMA_API}/markets?limit=20&active=true&closed=false&order=volume24hr&ascending=false`
  );
  return (Array.isArray(raw) ? raw : []).map(pickMarketFields);
}

async function discoverTopEvents() {
  const raw = await fetchJson(
    `${GAMMA_API}/events?limit=10&active=true&closed=false&order=volume24hr&ascending=false`
  );
  return (Array.isArray(raw) ? raw : []).map(pickEventFields);
}

async function discoverNegRiskMarkets() {
  const raw = await fetchJson(
    `${GAMMA_API}/markets?limit=10&active=true&closed=false&order=volume24hr&ascending=false&negRisk=true`
  );
  return (Array.isArray(raw) ? raw : []).map(pickMarketFields);
}

async function discoverEndingSoon() {
  const now = new Date();
  const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const raw = await fetchJson(
    `${GAMMA_API}/markets?limit=10&active=true&closed=false&order=endDate&ascending=true&end_date_min=${now.toISOString()}&end_date_max=${nextWeek.toISOString()}`
  );
  return (Array.isArray(raw) ? raw : []).map(pickMarketFields);
}

async function discoverCategories() {
  try {
    const raw = await fetchJson(`${GAMMA_API}/categories`);
    return Array.isArray(raw) ? raw.map((c) => c.label ?? c.name ?? c).slice(0, 20) : [];
  } catch {
    return [];
  }
}

async function discoverTags() {
  try {
    const raw = await fetchJson(`${GAMMA_API}/tags`);
    return Array.isArray(raw) ? raw.map((t) => t.label ?? t.name ?? t).slice(0, 30) : [];
  } catch {
    return [];
  }
}

async function main() {
  const args = process.argv.slice(2);
  let outPath = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--out" && args[i + 1]) {
      outPath = args[i + 1];
      i += 1;
    }
  }

  if (!outPath) {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    outPath = path.join(dir, "live-market-snapshot.json");
  }

  const results = await Promise.allSettled([
    discoverTopMarkets(),
    discoverTopEvents(),
    discoverNegRiskMarkets(),
    discoverEndingSoon(),
    discoverCategories(),
    discoverTags(),
  ]);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    topMarkets: results[0].status === "fulfilled" ? results[0].value : [],
    topEvents: results[1].status === "fulfilled" ? results[1].value : [],
    negRiskMarkets: results[2].status === "fulfilled" ? results[2].value : [],
    endingSoon: results[3].status === "fulfilled" ? results[3].value : [],
    categories: results[4].status === "fulfilled" ? results[4].value : [],
    tags: results[5].status === "fulfilled" ? results[5].value : [],
    errors: results
      .map((r, i) => (r.status === "rejected" ? { index: i, error: String(r.reason) } : null))
      .filter(Boolean),
  };

  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");

  const marketCount = snapshot.topMarkets.length + snapshot.negRiskMarkets.length;
  const eventCount = snapshot.topEvents.length;
  process.stdout.write(
    `Discovered ${marketCount} markets, ${eventCount} events, ${snapshot.categories.length} categories → ${outPath}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`discover-live-markets failed: ${error}\n`);
  process.exit(1);
});
