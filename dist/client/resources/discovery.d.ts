import type { SearchOptions, Tool } from "../types.js";
import type { ContextClient } from "../client.js";
/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
export declare class Discovery {
    private client;
    constructor(client: ContextClient);
    /**
     * Fetch a single marketplace tool by its unique ID.
     */
    get(toolId: string): Promise<Tool>;
    /**
     * Search for tools matching a query string.
     *
     * Backward-compatible signatures:
     * - `search("gas prices", 10)`
     * - `search({ query: "gas prices", limit: 10, mode: "execute" })`
     */
    search(query: string, limit?: number): Promise<Tool[]>;
    search(options: SearchOptions): Promise<Tool[]>;
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
    getFeatured(limit?: number, options?: Omit<SearchOptions, "query" | "limit">): Promise<Tool[]>;
}
//# sourceMappingURL=discovery.d.ts.map