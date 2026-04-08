/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
export class Discovery {
    client;
    constructor(client) {
        this.client = client;
    }
    /**
     * Fetch a single marketplace tool by its unique ID.
     */
    async get(toolId) {
        return this.client._fetch(`/api/v1/tools/${encodeURIComponent(toolId)}`);
    }
    async search(queryOrOptions, limit) {
        const options = typeof queryOrOptions === "string"
            ? { query: queryOrOptions, limit }
            : queryOrOptions;
        const params = new URLSearchParams();
        const query = options.query ?? "";
        if (query) {
            params.set("q", query);
        }
        if (options.limit !== undefined) {
            params.set("limit", String(options.limit));
        }
        if (options.mode) {
            params.set("mode", options.mode);
        }
        if (options.surface) {
            params.set("surface", options.surface);
        }
        if (options.queryEligible !== undefined) {
            params.set("queryEligible", String(options.queryEligible));
        }
        if (options.requireExecutePricing !== undefined) {
            params.set("requireExecutePricing", String(options.requireExecutePricing));
        }
        if (options.excludeLatencyClasses &&
            options.excludeLatencyClasses.length > 0) {
            params.set("excludeLatency", options.excludeLatencyClasses.join(","));
        }
        if (options.excludeSlow !== undefined) {
            params.set("excludeSlow", String(options.excludeSlow));
        }
        const queryString = params.toString();
        const endpoint = `/api/v1/tools/search${queryString ? `?${queryString}` : ""}`;
        const response = await this.client._fetch(endpoint);
        return response.tools;
    }
    /**
     * Get featured/popular tools (empty query search)
     *
     * @param limit - Maximum number of results (1-50, default 10)
     * @returns Array of featured tools
     *
     * @example
     * ```typescript
     * const featured = await client.discovery.getFeatured(5);
     * ```
     */
    async getFeatured(limit, options) {
        return this.search({
            ...(options ?? {}),
            query: "",
            ...(limit !== undefined ? { limit } : {}),
        });
    }
}
//# sourceMappingURL=discovery.js.map