import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contributorSearchModuleSpecifiers = [
  "@ctxprotocol/sdk/contrib/search",
  "../../../../dist/contrib/search/index.js",
];

async function loadContributorSearchModule() {
  let lastError = null;
  for (const specifier of contributorSearchModuleSpecifiers) {
    try {
      return specifier.startsWith("@")
        ? await import(specifier)
        : await import(new URL(specifier, import.meta.url).href);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to load contributor search helper module.");
}

const {
  buildContributorSearchValidationArtifact,
  createSearchIntent,
  resolveContributorSearch,
} = await loadContributorSearchModule();

const GENERATED_AT = "2026-03-28T12:00:00.000Z";
const VALIDATION_DIR = dirname(fileURLToPath(import.meta.url));

const TARIFFS_PROMPT =
  "What does Kalshi imply about the Supreme Court tariffs case, and which exact market should I inspect?";
const CAPABILITY_MISS_PROMPT =
  "Find a Bybit perpetual order-book market on Kalshi.";

function buildCandidate({
  candidateId,
  title,
  query,
  rank,
  description = null,
  source = "website-search-v2",
  rawIds = {},
  rankFeatures = {},
  metadata = {},
}) {
  return {
    candidateId,
    title,
    description,
    rawIds,
    rankFeatures,
    provenance: [
      {
        source,
        query,
        rank,
        fetchedAt: GENERATED_AT,
        metadata: {
          fixture: true,
          ...metadata,
        },
      },
    ],
    metadata,
  };
}

function createJudge(result) {
  return {
    async evaluate() {
      return result;
    },
  };
}

const cases = [
  {
    filename: "named-regression-supreme-court-tariffs.json",
    caseId: "kalshi-supreme-court-tariffs",
    caseKind: "named_regression",
    rawRequest: TARIFFS_PROMPT,
    intents: [
      createSearchIntent({
        intentId: "kalshi-tariffs-case",
        rawRequest: TARIFFS_PROMPT,
        query: "supreme court tariffs case",
        clause: "exact Kalshi market selection",
      }),
      createSearchIntent({
        intentId: "kalshi-tariffs-ticker",
        rawRequest: TARIFFS_PROMPT,
        query: "kxdjtvostariffs trump tariffs supreme court",
        clause: "ticker-aware validation",
      }),
    ],
    candidates: [
      buildCandidate({
        candidateId: "kalshi-kxdjtvostariffs",
        title:
          "Will the Supreme Court rule in favor of Trump in V.O.S. Selections, Inc. v. Trump?",
        query: "supreme court tariffs case",
        rank: 1,
        source: "search_markets",
        description:
          "The exact Kalshi tariff-case contract surfaced by the contributor search examples.",
        rawIds: {
          ticker: "KXDJTVOSTARIFFS",
          eventTicker: "KXDJTVOSTARIFFS",
          slug: "kxdjtvostariffs",
        },
        rankFeatures: {
          exactPhraseMatch: true,
          semanticScore: 0.98,
          yesPrice: 0.32,
          closeDate: "2026-06-30",
        },
        metadata: {
          url: "https://kalshi.com/markets/kxdjtvostariffs/tariffs-case",
          yesPrice: 0.32,
          closeTime: "2026-06-30T23:59:59Z",
          eventTitle: "Will the Supreme Court rule on the tariffs case?",
        },
      }),
      buildCandidate({
        candidateId: "kalshi-scotus-trade-powers",
        title: "Will the Supreme Court limit executive trade powers in 2026?",
        query: "kxdjtvostariffs trump tariffs supreme court",
        rank: 2,
        source: "search_markets",
        description:
          "A close neighboring court-case contract that is related but broader than the exact tariffs case.",
        rawIds: {
          ticker: "KXSCOTUSTRADE",
          eventTicker: "KXSCOTUSTRADE",
        },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.83,
          yesPrice: 0.41,
          closeDate: "2026-12-31",
        },
        metadata: {
          url: "https://kalshi.com/markets/kxscotustrade/executive-trade-powers",
          yesPrice: 0.41,
          closeTime: "2026-12-31T23:59:59Z",
        },
      }),
      buildCandidate({
        candidateId: "kalshi-tariff-revenue-2026",
        title: "Will tariff revenue exceed $300B in 2026?",
        query: "supreme court tariffs case",
        rank: 3,
        source: "search_markets",
        description:
          "A tariff-adjacent macro contract that should be rejected for the exact court-case ask.",
        rawIds: {
          ticker: "KXTARIFFREV",
          eventTicker: "KXTARIFFREV",
        },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.52,
          yesPrice: 0.28,
          closeDate: "2026-12-31",
        },
        metadata: {
          url: "https://kalshi.com/markets/kxtariffrev/tariff-revenue-2026",
          yesPrice: 0.28,
          closeTime: "2026-12-31T23:59:59Z",
        },
      }),
    ],
    expectation: {
      outcome: "selected",
      selectedCandidateId: "kalshi-kxdjtvostariffs",
    },
    helperConfig: {
      provider: "openrouter",
      model: "openai/gpt-5.4-nano",
      timeoutMs: 4000,
      budgetUsd: "0.010000",
      maxShortlistSize: 4,
    },
    overrides: {
      model: "glm-turbo-model",
      timeoutMs: 1200,
      budgetUsd: "0.003000",
    },
    traceLabel: "kalshi-tariffs-helper-pilot",
    judge: createJudge({
      primaryCandidateId: "kalshi-kxdjtvostariffs",
      relatedCandidateIds: ["kalshi-scotus-trade-powers"],
      rejectedCandidateIds: ["kalshi-tariff-revenue-2026"],
      confidence: "high",
      reason:
        "The KXDJTVOSTARIFFS contract is the exact Supreme Court tariffs case, while the other candidates are broader or only tariff-adjacent.",
      usage: {
        promptTokens: 310,
        completionTokens: 92,
        totalTokens: 402,
        costUsd: "0.000980",
        latencyMs: 244,
      },
    }),
  },
  {
    filename: "shared-capability-miss-unsupported-venue.json",
    caseId: "capability-miss-unsupported-venue",
    caseKind: "capability_miss",
    rawRequest: CAPABILITY_MISS_PROMPT,
    intents: [
      createSearchIntent({
        rawRequest: CAPABILITY_MISS_PROMPT,
        query: "bybit perpetual order book",
        clause: "unsupported venue and capability request",
      }),
    ],
    candidates: [
      buildCandidate({
        candidateId: "kalshi-weather-high-ny",
        title: "NYC high temperature above 47.5F?",
        query: "bybit perpetual order book",
        rank: 1,
        source: "search_markets",
        description:
          "A valid Kalshi contract that cannot satisfy the requested venue or capability.",
        rawIds: { ticker: "KXHIGHNY-26MAR19-B47.5" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.08,
        },
        metadata: {
          venue: "kalshi",
          capability: "weather",
        },
      }),
      buildCandidate({
        candidateId: "kalshi-bitcoin-spot-range",
        title: "Will Bitcoin settle above $120k this week?",
        query: "bybit perpetual order book",
        rank: 2,
        source: "search_markets",
        description: "A venue-matched but capability-mismatched contract.",
        rawIds: { ticker: "KXBTC-120K" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.12,
        },
        metadata: {
          venue: "kalshi",
          capability: "event_contract",
        },
      }),
    ],
    expectation: {
      outcome: "capability_miss",
      degradedReasonCode: "no_viable_candidates",
    },
    helperConfig: {
      provider: "openrouter",
      model: "glm-turbo-model",
      timeoutMs: 1000,
      budgetUsd: "0.001500",
      maxShortlistSize: 2,
    },
    traceLabel: "capability-miss-parity",
    isCandidateValid(candidate) {
      return (
        candidate.metadata?.venue === "bybit" &&
        candidate.metadata?.capability === "perpetual_orderbook"
      );
    },
  },
];

async function writeCaseArtifact(caseConfig) {
  const resolution = await resolveContributorSearch({
    rawRequest: caseConfig.rawRequest,
    intents: caseConfig.intents,
    candidates: caseConfig.candidates,
    ...(caseConfig.judge ? { judge: caseConfig.judge } : {}),
    helperConfig: caseConfig.helperConfig,
    overrides: caseConfig.overrides,
    traceLabel: caseConfig.traceLabel,
    ...(caseConfig.isCandidateValid
      ? { isCandidateValid: caseConfig.isCandidateValid }
      : {}),
  });

  const artifact = buildContributorSearchValidationArtifact({
    caseId: caseConfig.caseId,
    caseKind: caseConfig.caseKind,
    rawRequest: caseConfig.rawRequest,
    intents: caseConfig.intents,
    candidates: caseConfig.candidates,
    resolution,
    expectation: caseConfig.expectation,
    generatedAt: GENERATED_AT,
  });

  const outputPath = resolve(VALIDATION_DIR, caseConfig.filename);
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outputPath;
}

async function main() {
  await mkdir(VALIDATION_DIR, { recursive: true });
  const files = [];
  for (const caseConfig of cases) {
    files.push(await writeCaseArtifact(caseConfig));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        generatedAt: GENERATED_AT,
        caseCount: files.length,
        files: files.map((filePath) => filePath.replace(`${VALIDATION_DIR}/`, "")),
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
