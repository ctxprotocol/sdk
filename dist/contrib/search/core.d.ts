import { type ContributorSearchConfig, type ContributorSearchMetadata, type ContributorSearchResolution, type ContributorSearchResolvedConfig, type ResolveContributorSearchParams, type SearchCandidate, type SearchIntent, type SearchShortlist } from "./types.js";
export declare function createSearchIntent(params: {
    rawRequest: string;
    query: string;
    intentId?: string;
    clause?: string | null;
    metadata?: Record<string, unknown>;
}): SearchIntent;
export declare function dedupeSearchCandidates(candidates: readonly SearchCandidate[]): SearchCandidate[];
export declare function buildSearchShortlist(candidates: readonly SearchCandidate[], maxShortlistSize?: number): SearchShortlist;
export declare function mergeContributorSearchConfig(...configs: ReadonlyArray<ContributorSearchConfig | undefined>): ContributorSearchResolvedConfig;
export declare function attachContributorSearchMetadata<T extends Record<string, unknown>>(data: T, resolution: ContributorSearchResolution): T & {
    searchMetadata: ContributorSearchMetadata;
};
export declare function resolveContributorSearch(params: ResolveContributorSearchParams): Promise<ContributorSearchResolution>;
//# sourceMappingURL=core.d.ts.map