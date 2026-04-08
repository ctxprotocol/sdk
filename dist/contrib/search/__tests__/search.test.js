import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ContributorSearchBudgetExceededError, attachContributorSearchMetadata, buildContributorSearchValidationArtifact, createSearchIntent, extractContributorSearchMetadata, extractContributorSearchesFromDeveloperTrace, resolveContributorSearch, } from "../index.js";
const GENERATED_AT = "2026-03-28T12:00:00.000Z";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const IRAN_PROMPT = "What are Polymarket's implied odds on US or allied boots on the ground in Iran—which specific markets, resolution dates, and price levels matter, and how should I think about that for broader risk-off positioning?";
const TARIFFS_PROMPT = "What does Kalshi imply about the Supreme Court tariffs case, and which exact market should I inspect?";
const GENERIC_OVERLAP_PROMPT = "Which exact tariffs market should I inspect for the Supreme Court case?";
const STILL_AMBIGUOUS_PROMPT = "Find the best trade-policy market to inspect without assuming the scope.";
const CAPABILITY_MISS_PROMPT = "Find a Bybit perpetual order-book market on Kalshi.";
function buildCandidate(params) {
    return {
        candidateId: params.candidateId,
        title: params.title,
        description: params.description ?? null,
        rawIds: params.rawIds ?? {},
        rankFeatures: params.rankFeatures ?? {},
        provenance: [
            {
                source: params.source ?? "website-search-v2",
                query: params.query,
                rank: params.rank,
                fetchedAt: GENERATED_AT,
                metadata: {
                    fixture: true,
                    ...(params.metadata ?? {}),
                },
            },
        ],
        metadata: params.metadata ?? {},
    };
}
function readArtifact(relativePath) {
    const absolutePath = resolve(REPO_ROOT, relativePath);
    return JSON.parse(readFileSync(absolutePath, "utf8"));
}
function createStaticJudge(result) {
    const evaluate = vi.fn(async () => result);
    return {
        judge: { evaluate },
        evaluate,
    };
}
function createFailingJudge(error) {
    const evaluate = vi.fn(async () => {
        throw error;
    });
    return {
        judge: { evaluate },
        evaluate,
    };
}
const iranIntents = [
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
];
const tariffsIntents = [
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
];
const overlapIntents = [
    createSearchIntent({
        rawRequest: GENERIC_OVERLAP_PROMPT,
        query: "supreme court tariffs case",
        clause: "exact market selection",
    }),
];
const ambiguousIntents = [
    createSearchIntent({
        rawRequest: STILL_AMBIGUOUS_PROMPT,
        query: "trade policy outlook",
        clause: "scope remains ambiguous across candidate families",
    }),
];
const capabilityMissIntents = [
    createSearchIntent({
        rawRequest: CAPABILITY_MISS_PROMPT,
        query: "bybit perpetual order book",
        clause: "unsupported venue and capability request",
    }),
];
const iranCandidates = [
    buildCandidate({
        candidateId: "pm-us-forces-enter-iran-mar-31",
        title: "US forces enter Iran by March 31?",
        query: "boots on the ground iran polymarket",
        rank: 1,
        description: "Active US military personnel physically enter Iranian territory by March 31, 2026.",
        rawIds: {
            conditionId: "0x306d10d4a4d51b41910dbc779ca00908bd917c131541c5c42bbbc736258d2d56",
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
        description: "The same event family with a later resolution window for direct US entry.",
        rawIds: {
            conditionId: "0x6d0e09d0f04572d9b1adad84703458b0297bc5603b69dccbde93147ee4443246",
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
        description: "A stricter invasion framing for longer-dated US boots-on-the-ground risk.",
        rawIds: {
            conditionId: "0x5db999fad322cea2914535aae5517060c3f80ad6d8c0231cde2124a434d16846",
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
        description: "An allied-personnel proxy that still belongs to the broader Iran-entry family.",
        rawIds: {
            conditionId: "0x83f38b0110a93a4e68d2391dc70868ab1f8a9a074de58b0ef50d5312e3fcfcf7",
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
        description: "A neighboring macro conflict contract that should stay visible but rejected for direct boots-on-the-ground resolution.",
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
];
const tariffsCandidates = [
    buildCandidate({
        candidateId: "kalshi-kxdjtvostariffs",
        title: "Will the Supreme Court rule in favor of Trump in V.O.S. Selections, Inc. v. Trump?",
        query: "supreme court tariffs case",
        rank: 1,
        source: "search_markets",
        description: "The exact Kalshi tariff-case contract surfaced by the contributor search examples.",
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
        description: "A close neighboring court-case contract that is related but broader than the exact tariffs case.",
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
        description: "A tariff-adjacent macro contract that should be rejected for the exact court-case ask.",
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
];
const genericOverlapCandidates = [
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
];
const ambiguousCandidates = [
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
];
const unsupportedVenueCandidates = [
    buildCandidate({
        candidateId: "kalshi-weather-high-ny",
        title: "NYC high temperature above 47.5F?",
        query: "bybit perpetual order book",
        rank: 1,
        source: "search_markets",
        description: "A valid Kalshi contract that cannot satisfy the requested venue or capability.",
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
];
const validationCases = [
    {
        artifactPath: "examples/server/polymarket-contributor/validation/named-regression-iran-boots-on-ground.json",
        caseId: "polymarket-iran-boots-on-ground",
        caseKind: "named_regression",
        rawRequest: IRAN_PROMPT,
        intents: iranIntents,
        candidates: iranCandidates,
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
        judgeResult: {
            primaryCandidateId: "pm-us-forces-enter-iran-mar-31",
            relatedCandidateIds: [
                "pm-us-forces-enter-iran-apr-30",
                "pm-us-invade-iran-before-2027",
                "pm-netanyahu-enters-iran-jun-30",
            ],
            rejectedCandidateIds: ["pm-us-iran-ceasefire-mar-31"],
            confidence: "high",
            reason: "The March 31 US-forces-enter contract is the tightest direct boots-on-the-ground market, while the April 30, before-2027, and Netanyahu-in-Iran contracts remain related escalation follow-ups.",
            usage: {
                promptTokens: 420,
                completionTokens: 118,
                totalTokens: 538,
                costUsd: "0.001230",
                latencyMs: 312,
            },
        },
    },
    {
        artifactPath: "examples/server/kalshi-contributor/validation/named-regression-supreme-court-tariffs.json",
        caseId: "kalshi-supreme-court-tariffs",
        caseKind: "named_regression",
        rawRequest: TARIFFS_PROMPT,
        intents: tariffsIntents,
        candidates: tariffsCandidates,
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
        judgeResult: {
            primaryCandidateId: "kalshi-kxdjtvostariffs",
            relatedCandidateIds: ["kalshi-scotus-trade-powers"],
            rejectedCandidateIds: ["kalshi-tariff-revenue-2026"],
            confidence: "high",
            reason: "The KXDJTVOSTARIFFS contract is the exact Supreme Court tariffs case, while the other candidates are broader or only tariff-adjacent.",
            usage: {
                promptTokens: 310,
                completionTokens: 92,
                totalTokens: 402,
                costUsd: "0.000980",
                latencyMs: 244,
            },
        },
    },
    {
        artifactPath: "examples/server/polymarket-contributor/validation/shared-generic-overlap-best-match.json",
        caseId: "generic-overlap-best-match",
        caseKind: "generic_overlap",
        rawRequest: GENERIC_OVERLAP_PROMPT,
        intents: overlapIntents,
        candidates: genericOverlapCandidates,
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
        judgeResult: {
            primaryCandidateId: "generic-scotus-tariffs",
            relatedCandidateIds: ["generic-trade-policy-outlook"],
            rejectedCandidateIds: ["generic-tariff-revenue-benchmark"],
            confidence: "high",
            reason: "The court-case candidate is the exact clause-level match, while the broader policy and revenue contracts should stay secondary.",
            usage: {
                promptTokens: 180,
                completionTokens: 48,
                totalTokens: 228,
                costUsd: "0.000410",
                latencyMs: 133,
            },
        },
    },
    {
        artifactPath: "examples/server/polymarket-contributor/validation/shared-still-ambiguous-shortlist.json",
        caseId: "still-ambiguous-shortlist",
        caseKind: "still_ambiguous",
        rawRequest: STILL_AMBIGUOUS_PROMPT,
        intents: ambiguousIntents,
        candidates: ambiguousCandidates,
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
        judgeResult: {
            primaryCandidateId: null,
            relatedCandidateIds: ["ambiguous-scotus-case", "ambiguous-policy-basket"],
            rejectedCandidateIds: ["ambiguous-tariff-revenue"],
            confidence: "low",
            reason: "The shortlist still splits between an exact court-case scope and a broader policy scope, so the helper should preserve ambiguity instead of inventing certainty.",
            usage: {
                promptTokens: 165,
                completionTokens: 61,
                totalTokens: 226,
                costUsd: "0.000390",
                latencyMs: 149,
            },
        },
    },
    {
        artifactPath: "examples/server/kalshi-contributor/validation/shared-capability-miss-unsupported-venue.json",
        caseId: "capability-miss-unsupported-venue",
        caseKind: "capability_miss",
        rawRequest: CAPABILITY_MISS_PROMPT,
        intents: capabilityMissIntents,
        candidates: unsupportedVenueCandidates,
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
        isCandidateValid: (candidate) => candidate.metadata?.venue === "bybit" &&
            candidate.metadata?.capability === "perpetual_orderbook",
    },
];
async function resolveValidationCase(validationCase) {
    const judgeHandle = validationCase.judgeResult
        ? createStaticJudge(validationCase.judgeResult)
        : null;
    const resolution = await resolveContributorSearch({
        rawRequest: validationCase.rawRequest,
        intents: validationCase.intents,
        candidates: validationCase.candidates,
        ...(judgeHandle ? { judge: judgeHandle.judge } : {}),
        ...(validationCase.helperConfig
            ? { helperConfig: validationCase.helperConfig }
            : {}),
        ...(validationCase.contributorConfig
            ? { contributorConfig: validationCase.contributorConfig }
            : {}),
        ...(validationCase.overrides ? { overrides: validationCase.overrides } : {}),
        ...(validationCase.traceLabel ? { traceLabel: validationCase.traceLabel } : {}),
        ...(validationCase.isCandidateValid
            ? { isCandidateValid: validationCase.isCandidateValid }
            : {}),
    });
    const artifact = buildContributorSearchValidationArtifact({
        caseId: validationCase.caseId,
        caseKind: validationCase.caseKind,
        rawRequest: validationCase.rawRequest,
        intents: validationCase.intents,
        candidates: validationCase.candidates,
        resolution,
        expectation: validationCase.expectation,
        generatedAt: GENERATED_AT,
    });
    return { artifact, judgeHandle, resolution };
}
describe("contributor search helper", () => {
    it.each(validationCases)("$caseId stays in sync with the saved validation artifact", async (validationCase) => {
        const { artifact, resolution } = await resolveValidationCase(validationCase);
        expect(resolution.outcome).toBe(validationCase.expectation.outcome);
        expect(resolution.selectedCandidate?.candidateId ?? null).toBe(validationCase.expectation.selectedCandidateId ?? null);
        expect(resolution.degraded?.reasonCode ?? null).toBe(validationCase.expectation.degradedReasonCode ?? null);
        expect(artifact).toEqual(readArtifact(validationCase.artifactPath));
    });
    it("passes merged provider, model, timeout, budget, and trace label into the judge context", async () => {
        const validationCase = validationCases.find((entry) => entry.caseId === "generic-overlap-best-match");
        if (!validationCase?.judgeResult) {
            throw new Error("generic overlap validation case is required");
        }
        const judgeHandle = createStaticJudge(validationCase.judgeResult);
        await resolveContributorSearch({
            rawRequest: validationCase.rawRequest,
            intents: validationCase.intents,
            candidates: validationCase.candidates,
            judge: judgeHandle.judge,
            helperConfig: validationCase.helperConfig,
            contributorConfig: validationCase.contributorConfig,
            overrides: validationCase.overrides,
            traceLabel: validationCase.traceLabel,
        });
        expect(judgeHandle.evaluate).toHaveBeenCalledTimes(1);
        const [input, context] = judgeHandle.evaluate.mock.calls[0] ?? [];
        expect(input).toMatchObject({
            policy: {
                provider: "openrouter",
                model: "glm-turbo-model",
                timeoutMs: 900,
                budgetUsd: "0.002500",
                maxShortlistSize: 3,
            },
        });
        expect(context).toMatchObject({
            provider: "openrouter",
            model: "glm-turbo-model",
            timeoutMs: 900,
            budgetUsd: "0.002500",
            traceLabel: "generic-overlap-parity",
        });
    });
    it("allows a low-confidence selected fallback when one validated candidate survives and the judge budget is exceeded", async () => {
        const judgeHandle = createFailingJudge(new ContributorSearchBudgetExceededError("Budget exhausted while ranking the single surviving candidate."));
        const resolution = await resolveContributorSearch({
            rawRequest: TARIFFS_PROMPT,
            intents: tariffsIntents,
            candidates: [tariffsCandidates[0]],
            judge: judgeHandle.judge,
            contributorConfig: {
                degradedOutcomePolicy: "allow_low_confidence_selected",
            },
        });
        expect(resolution.outcome).toBe("selected");
        expect(resolution.confidence).toBe("low");
        expect(resolution.selectedCandidate?.candidateId).toBe("kalshi-kxdjtvostariffs");
        expect(resolution.degraded?.reasonCode).toBe("judge_budget_exceeded");
        expect(resolution.searchMetadata.judge.applied).toBe(true);
    });
    it("extracts standardized contributor search metadata from wrapped results and developer traces", async () => {
        const validationCase = validationCases.find((entry) => entry.caseId === "generic-overlap-best-match");
        if (!validationCase) {
            throw new Error("generic overlap validation case is required");
        }
        const { resolution } = await resolveValidationCase(validationCase);
        const wrappedResult = attachContributorSearchMetadata({ ok: true }, resolution);
        const trace = {
            timeline: [
                {
                    tool: { id: "tool-1", name: "Tariff Markets" },
                    timestampMs: 123,
                    metadata: {
                        result: wrappedResult,
                    },
                },
            ],
        };
        expect(extractContributorSearchMetadata(wrappedResult)?.selectedCandidateId).toBe("generic-scotus-tariffs");
        expect(extractContributorSearchesFromDeveloperTrace(trace)).toEqual([
            {
                toolId: "tool-1",
                toolName: "Tariff Markets",
                timestampMs: 123,
                searchMetadata: resolution.searchMetadata,
            },
        ]);
    });
});
//# sourceMappingURL=search.test.js.map