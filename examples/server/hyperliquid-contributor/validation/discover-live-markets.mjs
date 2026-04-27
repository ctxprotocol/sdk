#!/usr/bin/env node

/**
 * Fetches current public Hyperliquid market data for prompt grounding.
 *
 * Usage: node discover-live-markets.mjs [--out path/to/live-market-snapshot.json]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HYPERLIQUID_INFO_API = "https://api.hyperliquid.xyz/info";
const REQUEST_TIMEOUT_MS = 20_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseOutArg(argv) {
  const idx = argv.indexOf("--out");
  if (idx >= 0 && typeof argv.at(idx + 1) === "string") {
    return path.resolve(argv.at(idx + 1));
  }
  return path.join(__dirname, "live-market-snapshot.json");
}

async function fetchInfo(type) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(HYPERLIQUID_INFO_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${type}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickPerpMarket(asset, ctx, index) {
  const markPrice = toNumber(ctx?.markPx);
  const openInterest = toNumber(ctx?.openInterest);
  return {
    symbol: asset?.name ?? `asset-${String(index)}`,
    index,
    maxLeverage: asset?.maxLeverage ?? null,
    onlyIsolated: asset?.onlyIsolated ?? false,
    markPrice,
    midPrice: toNumber(ctx?.midPx),
    oraclePrice: toNumber(ctx?.oraclePx),
    fundingRate: toNumber(ctx?.funding),
    premium: toNumber(ctx?.premium),
    openInterest,
    openInterestUsd:
      markPrice !== null && openInterest !== null ? markPrice * openInterest : null,
    volume24h: toNumber(ctx?.dayNtlVlm),
    previousDayPrice: toNumber(ctx?.prevDayPx),
  };
}

function pickSpotMarket(token, index) {
  return {
    symbol: token?.name ?? `spot-${String(index)}`,
    index,
    tokenId: token?.tokenId ?? null,
    szDecimals: token?.szDecimals ?? null,
    weiDecimals: token?.weiDecimals ?? null,
  };
}

function sortByNumberDesc(key) {
  return (left, right) => (right[key] ?? -Infinity) - (left[key] ?? -Infinity);
}

async function main() {
  const outPath = parseOutArg(process.argv);
  const [perpRaw, spotRaw] = await Promise.allSettled([
    fetchInfo("metaAndAssetCtxs"),
    fetchInfo("spotMeta"),
  ]);

  const perpUniverse =
    perpRaw.status === "fulfilled" && Array.isArray(perpRaw.value?.[0]?.universe)
      ? perpRaw.value[0].universe
      : [];
  const perpContexts =
    perpRaw.status === "fulfilled" && Array.isArray(perpRaw.value?.[1])
      ? perpRaw.value[1]
      : [];
  const perpMarkets = perpUniverse.map((asset, index) =>
    pickPerpMarket(asset, perpContexts.at(index), index)
  );

  const spotTokens =
    spotRaw.status === "fulfilled" && Array.isArray(spotRaw.value?.tokens)
      ? spotRaw.value.tokens
      : [];
  const spotMarkets = spotTokens.map(pickSpotMarket);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: "POST /info type=metaAndAssetCtxs and type=spotMeta",
    apiBase: HYPERLIQUID_INFO_API,
    marketCount: perpMarkets.length,
    topByVolume24h: [...perpMarkets].sort(sortByNumberDesc("volume24h")).slice(0, 40),
    topByOpenInterestUsd: [...perpMarkets]
      .sort(sortByNumberDesc("openInterestUsd"))
      .slice(0, 40),
    mostPositiveFunding: [...perpMarkets]
      .filter((market) => market.fundingRate !== null)
      .sort(sortByNumberDesc("fundingRate"))
      .slice(0, 20),
    mostNegativeFunding: [...perpMarkets]
      .filter((market) => market.fundingRate !== null)
      .sort((left, right) => (left.fundingRate ?? Infinity) - (right.fundingRate ?? Infinity))
      .slice(0, 20),
    spotMarkets: spotMarkets.slice(0, 80),
    errors: [
      perpRaw.status === "rejected"
        ? { endpoint: "metaAndAssetCtxs", error: String(perpRaw.reason) }
        : null,
      spotRaw.status === "rejected"
        ? { endpoint: "spotMeta", error: String(spotRaw.reason) }
        : null,
    ].filter(Boolean),
  };

  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${outPath} (${String(snapshot.marketCount)} perp markets, ${String(snapshot.spotMarkets.length)} spot tokens)\n`
  );
}

void main().catch((error) => {
  process.stderr.write(`discover-live-markets failed: ${error}\n`);
  process.exitCode = 1;
});
