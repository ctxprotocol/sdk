import { C as ContributorSearchResolution, a as ContributorSearchMetadata, S as SearchCandidate, b as SearchShortlist, c as SearchIntent, d as ContributorSearchConfig, e as ContributorSearchResolvedConfig, R as ResolveContributorSearchParams, Q as QueryDeveloperTrace, f as ContributorSearchTraceRecord, g as ContributorSearchValidationCaseKind, h as ContributorSearchValidationExpectation, i as ContributorSearchValidationArtifact } from '../../types-BStHo4tI.js';
export { k as CONTRIBUTOR_SEARCH_METADATA_VERSION, l as CONTRIBUTOR_SEARCH_VALIDATION_VERSION, j as ContributorSearchBudgetExceededError, m as ContributorSearchConfidence, n as ContributorSearchDegradedOutcome, o as ContributorSearchDegradedOutcomePolicy, p as ContributorSearchDegradedReasonCode, q as ContributorSearchJudge, r as ContributorSearchJudgeContext, s as ContributorSearchJudgeInput, t as ContributorSearchJudgeResult, u as ContributorSearchJudgeSnapshot, v as ContributorSearchJudgeUsage, w as ContributorSearchMetadataSource, x as ContributorSearchOutcome, y as ContributorSearchTraceSummary, z as ContributorSearchValidatorStatus, A as SearchCandidateProvenance } from '../../types-BStHo4tI.js';

declare function createSearchIntent(params: {
    rawRequest: string;
    query: string;
    intentId?: string;
    clause?: string | null;
    metadata?: Record<string, unknown>;
}): SearchIntent;
declare function dedupeSearchCandidates(candidates: readonly SearchCandidate[]): SearchCandidate[];
declare function buildSearchShortlist(candidates: readonly SearchCandidate[], maxShortlistSize?: number): SearchShortlist;
declare function mergeContributorSearchConfig(...configs: ReadonlyArray<ContributorSearchConfig | undefined>): ContributorSearchResolvedConfig;
declare function attachContributorSearchMetadata<T extends Record<string, unknown>>(data: T, resolution: ContributorSearchResolution): T & {
    searchMetadata: ContributorSearchMetadata;
};
declare function resolveContributorSearch(params: ResolveContributorSearchParams): Promise<ContributorSearchResolution>;

declare function extractContributorSearchMetadata(result: unknown): ContributorSearchMetadata | null;
declare function extractContributorSearchesFromDeveloperTrace(trace: QueryDeveloperTrace | undefined): ContributorSearchTraceRecord[];

declare function buildContributorSearchValidationArtifact(params: {
    caseId: string;
    caseKind: ContributorSearchValidationCaseKind;
    rawRequest: string;
    intents: SearchIntent[];
    candidates: SearchCandidate[];
    resolution: ContributorSearchResolution;
    expectation?: ContributorSearchValidationExpectation;
    generatedAt?: string;
}): ContributorSearchValidationArtifact;

export { ContributorSearchConfig, ContributorSearchMetadata, ContributorSearchResolution, ContributorSearchResolvedConfig, ContributorSearchTraceRecord, ContributorSearchValidationArtifact, ContributorSearchValidationCaseKind, ContributorSearchValidationExpectation, ResolveContributorSearchParams, SearchCandidate, SearchIntent, SearchShortlist, attachContributorSearchMetadata, buildContributorSearchValidationArtifact, buildSearchShortlist, createSearchIntent, dedupeSearchCandidates, extractContributorSearchMetadata, extractContributorSearchesFromDeveloperTrace, mergeContributorSearchConfig, resolveContributorSearch };
