import { type ContributorSearchValidationArtifact, type ContributorSearchValidationCaseKind, type ContributorSearchValidationExpectation, type ContributorSearchResolution, type SearchCandidate, type SearchIntent } from "./types.js";
export declare function buildContributorSearchValidationArtifact(params: {
    caseId: string;
    caseKind: ContributorSearchValidationCaseKind;
    rawRequest: string;
    intents: SearchIntent[];
    candidates: SearchCandidate[];
    resolution: ContributorSearchResolution;
    expectation?: ContributorSearchValidationExpectation;
    generatedAt?: string;
}): ContributorSearchValidationArtifact;
//# sourceMappingURL=validation.d.ts.map