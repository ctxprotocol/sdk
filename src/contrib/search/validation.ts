import {
  CONTRIBUTOR_SEARCH_VALIDATION_VERSION,
  type ContributorSearchValidationArtifact,
  type ContributorSearchValidationCaseKind,
  type ContributorSearchValidationExpectation,
  type ContributorSearchResolution,
  type SearchCandidate,
  type SearchIntent,
} from "./types.js";

export function buildContributorSearchValidationArtifact(params: {
  caseId: string;
  caseKind: ContributorSearchValidationCaseKind;
  rawRequest: string;
  intents: SearchIntent[];
  candidates: SearchCandidate[];
  resolution: ContributorSearchResolution;
  expectation?: ContributorSearchValidationExpectation;
  generatedAt?: string;
}): ContributorSearchValidationArtifact {
  return {
    version: CONTRIBUTOR_SEARCH_VALIDATION_VERSION,
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    caseId: params.caseId,
    caseKind: params.caseKind,
    rawRequest: params.rawRequest,
    intents: params.intents,
    candidates: params.candidates,
    resolution: {
      outcome: params.resolution.outcome,
      selectedCandidateId:
        params.resolution.selectedCandidate?.candidateId ?? null,
      shortlistCandidateIds: params.resolution.shortlist.map(
        (candidate) => candidate.candidateId
      ),
      relatedCandidateIds: params.resolution.relatedCandidates.map(
        (candidate) => candidate.candidateId
      ),
      rejectedCandidateIds: params.resolution.rejectedCandidates.map(
        (candidate) => candidate.candidateId
      ),
      confidence: params.resolution.confidence,
      reason: params.resolution.reason,
      degradedReasonCode: params.resolution.degraded?.reasonCode ?? null,
    },
    searchMetadata: params.resolution.searchMetadata,
    ...(params.expectation ? { expectation: params.expectation } : {}),
  };
}
