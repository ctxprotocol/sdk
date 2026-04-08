export declare const CONTRIBUTOR_SEARCH_METADATA_VERSION: "ctx-contributor-search/v1";
export declare const CONTRIBUTOR_SEARCH_VALIDATION_VERSION: "ctx-contributor-search-validation/v1";
export type ContributorSearchOutcome = "selected" | "shortlist_only" | "capability_miss";
export type ContributorSearchConfidence = "high" | "medium" | "low";
export type ContributorSearchDegradedOutcomePolicy = "return_shortlist" | "allow_low_confidence_selected";
export type ContributorSearchDegradedReasonCode = "judge_disabled" | "judge_missing" | "judge_timeout" | "judge_budget_exceeded" | "judge_invalid_output" | "judge_error" | "validator_rejected" | "ambiguous_shortlist" | "no_viable_candidates";
export type ContributorSearchValidationCaseKind = "named_regression" | "generic_overlap" | "still_ambiguous" | "capability_miss";
export type ContributorSearchValidatorStatus = "accepted" | "rejected" | "not_run";
export interface SearchIntent {
    intentId: string;
    rawRequest: string;
    query: string;
    clause: string | null;
    metadata?: Record<string, unknown>;
}
export interface SearchCandidateProvenance {
    source: string;
    query: string;
    rank: number | null;
    fetchedAt: string | null;
    metadata?: Record<string, unknown>;
}
export interface SearchCandidate {
    candidateId: string;
    title: string;
    description?: string | null;
    rawIds?: Record<string, string>;
    rankFeatures?: Record<string, boolean | number | string | null>;
    provenance: SearchCandidateProvenance[];
    metadata?: Record<string, unknown>;
}
export interface SearchShortlist {
    maxSize: number;
    candidates: SearchCandidate[];
}
export interface ContributorSearchConfig {
    provider?: string | null;
    model?: string | null;
    timeoutMs?: number | null;
    budgetUsd?: string | null;
    disableJudge?: boolean;
    degradedOutcomePolicy?: ContributorSearchDegradedOutcomePolicy;
    maxShortlistSize?: number;
}
export interface ContributorSearchResolvedConfig {
    provider: string | null;
    model: string | null;
    timeoutMs: number | null;
    budgetUsd: string | null;
    disableJudge: boolean;
    degradedOutcomePolicy: ContributorSearchDegradedOutcomePolicy;
    maxShortlistSize: number;
}
export interface ContributorSearchJudgeUsage {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    costUsd?: string | null;
    latencyMs?: number | null;
}
export interface ContributorSearchJudgeInput {
    rawRequest: string;
    intents: SearchIntent[];
    shortlist: SearchShortlist;
    instructions?: string;
    policy: ContributorSearchResolvedConfig;
}
export interface ContributorSearchJudgeContext {
    provider: string | null;
    model: string | null;
    timeoutMs: number | null;
    budgetUsd: string | null;
    traceLabel: string | null;
}
export interface ContributorSearchJudgeResult {
    primaryCandidateId: string | null;
    relatedCandidateIds: string[];
    rejectedCandidateIds: string[];
    confidence: ContributorSearchConfidence;
    reason: string;
    usage?: ContributorSearchJudgeUsage;
}
export interface ContributorSearchJudge {
    evaluate(input: ContributorSearchJudgeInput, context: ContributorSearchJudgeContext): Promise<ContributorSearchJudgeResult>;
}
export interface ContributorSearchDegradedOutcome {
    reasonCode: ContributorSearchDegradedReasonCode;
    message: string;
}
export interface ContributorSearchMetadataSource {
    source: string;
    query: string;
    candidateCount: number;
}
export interface ContributorSearchJudgeSnapshot {
    provider: string | null;
    model: string | null;
    timeoutMs: number | null;
    budgetUsd: string | null;
    disabled: boolean;
    applied: boolean;
    usage: ContributorSearchJudgeUsage | null;
}
export interface ContributorSearchTraceSummary {
    usedDeterministicFallback: boolean;
    validatorStatus: ContributorSearchValidatorStatus;
    validatorReasonCode: string | null;
    validatorReason: string | null;
}
export interface ContributorSearchMetadata {
    version: typeof CONTRIBUTOR_SEARCH_METADATA_VERSION;
    outcome: ContributorSearchOutcome;
    confidence: ContributorSearchConfidence;
    selectedCandidateId: string | null;
    shortlistCandidateIds: string[];
    relatedCandidateIds: string[];
    rejectedCandidateIds: string[];
    candidateCount: number;
    shortlistCount: number;
    intentQueries: string[];
    degraded: ContributorSearchDegradedOutcome | null;
    judge: ContributorSearchJudgeSnapshot;
    provenance: ContributorSearchMetadataSource[];
    trace: ContributorSearchTraceSummary;
}
export interface ContributorSearchTraceRecord {
    toolId: string | null;
    toolName: string | null;
    timestampMs: number | null;
    searchMetadata: ContributorSearchMetadata;
}
export interface ContributorSearchResolution {
    outcome: ContributorSearchOutcome;
    selectedCandidate: SearchCandidate | null;
    shortlist: SearchCandidate[];
    relatedCandidates: SearchCandidate[];
    rejectedCandidates: SearchCandidate[];
    confidence: ContributorSearchConfidence;
    reason: string;
    degraded: ContributorSearchDegradedOutcome | null;
    searchMetadata: ContributorSearchMetadata;
}
export interface ContributorSearchValidationExpectation {
    outcome: ContributorSearchOutcome;
    selectedCandidateId?: string | null;
    degradedReasonCode?: ContributorSearchDegradedReasonCode | null;
}
export interface ContributorSearchValidationArtifact {
    version: typeof CONTRIBUTOR_SEARCH_VALIDATION_VERSION;
    generatedAt: string;
    caseId: string;
    caseKind: ContributorSearchValidationCaseKind;
    rawRequest: string;
    intents: SearchIntent[];
    candidates: SearchCandidate[];
    resolution: {
        outcome: ContributorSearchOutcome;
        selectedCandidateId: string | null;
        shortlistCandidateIds: string[];
        relatedCandidateIds: string[];
        rejectedCandidateIds: string[];
        confidence: ContributorSearchConfidence;
        reason: string;
        degradedReasonCode: ContributorSearchDegradedReasonCode | null;
    };
    searchMetadata: ContributorSearchMetadata;
    expectation?: ContributorSearchValidationExpectation;
}
export interface ResolveContributorSearchParams {
    rawRequest: string;
    intents: SearchIntent[];
    candidates: SearchCandidate[];
    judge?: ContributorSearchJudge;
    helperConfig?: ContributorSearchConfig;
    contributorConfig?: ContributorSearchConfig;
    overrides?: ContributorSearchConfig;
    instructions?: string;
    isCandidateValid?: (candidate: SearchCandidate) => boolean;
    traceLabel?: string | null;
}
export declare class ContributorSearchBudgetExceededError extends Error {
    constructor(message?: string);
}
//# sourceMappingURL=types.d.ts.map