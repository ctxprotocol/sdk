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

const IRAN_PROMPT =
  "What are Polymarket's implied odds on US or allied boots on the ground in Iran—which specific markets, resolution dates, and price levels matter, and how should I think about that for broader risk-off positioning?";
const GENERIC_OVERLAP_PROMPT =
  "Which exact tariffs market should I inspect for the Supreme Court case?";
const STILL_AMBIGUOUS_PROMPT =
  "Find the best trade-policy market to inspect without assuming the scope.";

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
    filename: "named-regression-iran-boots-on-ground.json",
    caseId: "polymarket-iran-boots-on-ground",
    caseKind: "named_regression",
    rawRequest: IRAN_PROMPT,
    intents: [
      createSearchIntent({
        intentId: "iran-ground-entry",
        rawRequest: IRAN_PROMPT,
        query: "boots on the ground iran polymarket",
        clause: "exact boots-on-the-ground contract selection",
      }),
      createSearchIntent({
        intentId: "iran-allied-escalation",
        rawRequest: IRAN_PROMPT,
        query: "us allied enter invade iran",
        clause: "related allied escalation markets",
      }),
    ],
    candidates: [
      buildCandidate({
        candidateId: "pm-us-forces-enter-iran-mar-31",
        title: "US forces enter Iran by March 31?",
        query: "boots on the ground iran polymarket",
        rank: 1,
        description:
          "Active US military personnel physically enter Iranian territory by March 31, 2026.",
        rawIds: {
          conditionId:
            "0x306d10d4a4d51b41910dbc779ca00908bd917c131541c5c42bbbc736258d2d56",
          venue: "polymarket",
        },
        rankFeatures: {
          exactPhraseMatch: true,
          semanticScore: 0.99,
          yesPrice: 0.155,
          resolutionDate: "2026-03-31",
        },
        metadata: {
          url: "https://polymarket.com/event/158299",
          eventSlug: "us-forces-enter-iran-by",
          resolutionDate: "2026-03-31T23:59:59Z",
          yesPrice: 0.155,
        },
      }),
      buildCandidate({
        candidateId: "pm-us-forces-enter-iran-apr-30",
        title: "US forces enter Iran by April 30?",
        query: "us allied enter invade iran",
        rank: 2,
        description:
          "The same event family with a later resolution window for direct US entry.",
        rawIds: {
          conditionId:
            "0x6d0e09d0f04572d9b1adad84703458b0297bc5603b69dccbde93147ee4443246",
          venue: "polymarket",
        },
        rankFeatures: {
          exactPhraseMatch: true,
          semanticScore: 0.95,
          yesPrice: 0.585,
          resolutionDate: "2026-04-30",
        },
        metadata: {
          url: "https://polymarket.com/event/158299",
          eventSlug: "us-forces-enter-iran-by",
          resolutionDate: "2026-04-30T23:59:59Z",
          yesPrice: 0.585,
        },
      }),
      buildCandidate({
        candidateId: "pm-us-invade-iran-before-2027",
        title: "Will the U.S. invade Iran before 2027?",
        query: "us allied enter invade iran",
        rank: 3,
        description:
          "A stricter invasion framing for longer-dated US boots-on-the-ground risk.",
        rawIds: {
          conditionId:
            "0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846",
          venue: "polymarket",
        },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.93,
          yesPrice: 0.605,
          resolutionDate: "2026-12-31",
        },
        metadata: {
          url: "https://polymarket.com/event/73130",
          eventSlug: "will-the-us-invade-iran-before-2027",
          resolutionDate: "2026-12-31T23:59:59Z",
          yesPrice: 0.605,
        },
      }),
      buildCandidate({
        candidateId: "pm-netanyahu-enters-iran-jun-30",
        title: "Will Benjamin Netanyahu enter Iran by June 30?",
        query: "us allied enter invade iran",
        rank: 4,
        description:
          "An allied-personnel proxy that still belongs to the broader Iran-entry family.",
        rawIds: {
          conditionId:
            "0x83f38b0110a93a4e68d2391dc70868ab1f8a9a074de58b0ef50d5312e3fcfcf7",
          venue: "polymarket",
        },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.77,
          yesPrice: 0.055,
          resolutionDate: "2026-06-30",
        },
        metadata: {
          url: "https://polymarket.com/event/239820",
          eventSlug: "who-will-enter-iran-by-june-30",
          resolutionDate: "2026-06-30T23:59:59Z",
          yesPrice: 0.055,
        },
      }),
      buildCandidate({
        candidateId: "pm-us-iran-ceasefire-mar-31",
        title: "Will the U.S. and Iran reach a ceasefire by March 31?",
        query: "boots on the ground iran polymarket",
        rank: 5,
        description:
          "A neighboring macro conflict contract that should stay visible but rejected for direct boots-on-the-ground resolution.",
        rawIds: {
          venue: "polymarket",
        },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.4,
          yesPrice: 0.043,
          resolutionDate: "2026-03-31",
        },
        metadata: {
          url: "https://polymarket.com/event/us-iran-ceasefire-by-march-31",
          eventSlug: "us-iran-ceasefire-by-march-31",
          resolutionDate: "2026-03-31T23:59:59Z",
          yesPrice: 0.043,
        },
      }),
    ],
    expectation: {
      outcome: "selected",
      selectedCandidateId: "pm-us-forces-enter-iran-mar-31",
    },
    helperConfig: {
      provider: "openrouter",
      model: "openai/gpt-5.4-nano",
      timeoutMs: 5000,
      budgetUsd: "0.020000",
      maxShortlistSize: 5,
    },
    contributorConfig: {
      model: "anthropic/claude-sonnet-4.5",
      budgetUsd: "0.015000",
    },
    overrides: {
      model: "glm-turbo-model",
      timeoutMs: 1500,
      budgetUsd: "0.005000",
    },
    traceLabel: "polymarket-iran-helper-pilot",
    judge: createJudge({
      primaryCandidateId: "pm-us-forces-enter-iran-mar-31",
      relatedCandidateIds: [
        "pm-us-forces-enter-iran-apr-30",
        "pm-us-invade-iran-before-2027",
        "pm-netanyahu-enters-iran-jun-30",
      ],
      rejectedCandidateIds: ["pm-us-iran-ceasefire-mar-31"],
      confidence: "high",
      reason:
        "The March 31 US-forces-enter contract is the tightest direct boots-on-the-ground market, while the April 30, before-2027, and Netanyahu-in-Iran contracts remain related escalation follow-ups.",
      usage: {
        promptTokens: 420,
        completionTokens: 118,
        totalTokens: 538,
        costUsd: "0.001230",
        latencyMs: 312,
      },
    }),
  },
  {
    filename: "shared-generic-overlap-best-match.json",
    caseId: "generic-overlap-best-match",
    caseKind: "generic_overlap",
    rawRequest: GENERIC_OVERLAP_PROMPT,
    intents: [
      createSearchIntent({
        rawRequest: GENERIC_OVERLAP_PROMPT,
        query: "supreme court tariffs case",
        clause: "exact market selection",
      }),
    ],
    candidates: [
      buildCandidate({
        candidateId: "generic-scotus-tariffs",
        title: "Supreme Court tariff ruling in 2026",
        query: "supreme court tariffs case",
        rank: 1,
        description: "The exact court-case market family.",
        rawIds: { marketId: "market-1" },
        rankFeatures: {
          exactPhraseMatch: true,
          semanticScore: 0.94,
        },
      }),
      buildCandidate({
        candidateId: "generic-trade-policy-outlook",
        title: "Broader tariff policy outlook",
        query: "supreme court tariffs case",
        rank: 2,
        description: "A broader policy proxy with overlapping language.",
        rawIds: { marketId: "market-2" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.78,
        },
      }),
      buildCandidate({
        candidateId: "generic-tariff-revenue-benchmark",
        title: "Tariff revenue benchmark in 2026",
        query: "supreme court tariffs case",
        rank: 3,
        description: "Tariff-adjacent but not the exact court-case resolution.",
        rawIds: { marketId: "market-3" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.51,
        },
      }),
    ],
    expectation: {
      outcome: "selected",
      selectedCandidateId: "generic-scotus-tariffs",
    },
    helperConfig: {
      provider: "openrouter",
      model: "openai/gpt-5.4-nano",
      timeoutMs: 3500,
      budgetUsd: "0.009000",
      maxShortlistSize: 3,
    },
    contributorConfig: {
      model: "anthropic/claude-sonnet-4.5",
      budgetUsd: "0.008000",
    },
    overrides: {
      model: "glm-turbo-model",
      timeoutMs: 900,
      budgetUsd: "0.002500",
    },
    traceLabel: "generic-overlap-parity",
    judge: createJudge({
      primaryCandidateId: "generic-scotus-tariffs",
      relatedCandidateIds: ["generic-trade-policy-outlook"],
      rejectedCandidateIds: ["generic-tariff-revenue-benchmark"],
      confidence: "high",
      reason:
        "The court-case candidate is the exact clause-level match, while the broader policy and revenue contracts should stay secondary.",
      usage: {
        promptTokens: 180,
        completionTokens: 48,
        totalTokens: 228,
        costUsd: "0.000410",
        latencyMs: 133,
      },
    }),
  },
  {
    filename: "shared-still-ambiguous-shortlist.json",
    caseId: "still-ambiguous-shortlist",
    caseKind: "still_ambiguous",
    rawRequest: STILL_AMBIGUOUS_PROMPT,
    intents: [
      createSearchIntent({
        rawRequest: STILL_AMBIGUOUS_PROMPT,
        query: "trade policy outlook",
        clause: "scope remains ambiguous across candidate families",
      }),
    ],
    candidates: [
      buildCandidate({
        candidateId: "ambiguous-scotus-case",
        title: "Supreme Court tariff ruling in 2026",
        query: "trade policy outlook",
        rank: 1,
        description: "A court-case contract.",
        rawIds: { marketId: "ambiguous-1" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.72,
        },
      }),
      buildCandidate({
        candidateId: "ambiguous-policy-basket",
        title: "Broader trade policy outlook in 2026",
        query: "trade policy outlook",
        rank: 2,
        description: "A macro policy basket.",
        rawIds: { marketId: "ambiguous-2" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.71,
        },
      }),
      buildCandidate({
        candidateId: "ambiguous-tariff-revenue",
        title: "Tariff revenue benchmark in 2026",
        query: "trade policy outlook",
        rank: 3,
        description: "A metric-style contract instead of the user-facing market choice.",
        rawIds: { marketId: "ambiguous-3" },
        rankFeatures: {
          exactPhraseMatch: false,
          semanticScore: 0.55,
        },
      }),
    ],
    expectation: {
      outcome: "shortlist_only",
      degradedReasonCode: "ambiguous_shortlist",
    },
    helperConfig: {
      provider: "openrouter",
      model: "glm-turbo-model",
      timeoutMs: 1000,
      budgetUsd: "0.002000",
      maxShortlistSize: 3,
    },
    traceLabel: "still-ambiguous-parity",
    judge: createJudge({
      primaryCandidateId: null,
      relatedCandidateIds: ["ambiguous-scotus-case", "ambiguous-policy-basket"],
      rejectedCandidateIds: ["ambiguous-tariff-revenue"],
      confidence: "low",
      reason:
        "The shortlist still splits between an exact court-case scope and a broader policy scope, so the helper should preserve ambiguity instead of inventing certainty.",
      usage: {
        promptTokens: 165,
        completionTokens: 61,
        totalTokens: 226,
        costUsd: "0.000390",
        latencyMs: 149,
      },
    }),
  },
];

async function writeCaseArtifact(caseConfig) {
  const resolution = await resolveContributorSearch({
    rawRequest: caseConfig.rawRequest,
    intents: caseConfig.intents,
    candidates: caseConfig.candidates,
    judge: caseConfig.judge,
    helperConfig: caseConfig.helperConfig,
    contributorConfig: caseConfig.contributorConfig,
    overrides: caseConfig.overrides,
    traceLabel: caseConfig.traceLabel,
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
