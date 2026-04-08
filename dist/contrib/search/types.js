export const CONTRIBUTOR_SEARCH_METADATA_VERSION = "ctx-contributor-search/v1";
export const CONTRIBUTOR_SEARCH_VALIDATION_VERSION = "ctx-contributor-search-validation/v1";
export class ContributorSearchBudgetExceededError extends Error {
    constructor(message = "Contributor search budget exceeded") {
        super(message);
        this.name = "ContributorSearchBudgetExceededError";
    }
}
//# sourceMappingURL=types.js.map