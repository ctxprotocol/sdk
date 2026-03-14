import type { SearchOptions, SearchResponse, Tool } from "../types.js";
import type { ContextClient } from "../client.js";

/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
export class Discovery {
  constructor(private client: ContextClient) {}

  /**
   * Fetch a single marketplace tool by its unique ID.
   */
  async get(toolId: string): Promise<Tool> {
    return this.client._fetch<Tool>(
      `/api/v1/tools/${encodeURIComponent(toolId)}`
    );
  }

  /**
   * Search for tools matching a query string.
   *
   * Backward-compatible signatures:
   * - `search("gas prices", 10)`
   * - `search({ query: "gas prices", limit: 10, mode: "execute" })`
   */
  async search(query: string, limit?: number): Promise<Tool[]>;
  async search(options: SearchOptions): Promise<Tool[]>;
  async search(
    queryOrOptions: string | SearchOptions,
    limit?: number
  ): Promise<Tool[]> {
    const options: SearchOptions =
      typeof queryOrOptions === "string"
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
      params.set(
        "requireExecutePricing",
        String(options.requireExecutePricing)
      );
    }

    if (
      options.excludeLatencyClasses &&
      options.excludeLatencyClasses.length > 0
    ) {
      params.set("excludeLatency", options.excludeLatencyClasses.join(","));
    }

    if (options.excludeSlow !== undefined) {
      params.set("excludeSlow", String(options.excludeSlow));
    }

    const queryString = params.toString();
    const endpoint = `/api/v1/tools/search${queryString ? `?${queryString}` : ""}`;

    const response = await this.client._fetch<SearchResponse>(endpoint);

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
  async getFeatured(
    limit?: number,
    options?: Omit<SearchOptions, "query" | "limit">
  ): Promise<Tool[]> {
    return this.search({
      ...(options ?? {}),
      query: "",
      ...(limit !== undefined ? { limit } : {}),
    });
  }
}
