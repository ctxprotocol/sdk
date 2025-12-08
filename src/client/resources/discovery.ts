import type { Tool, SearchResponse } from "../types.js";
import type { ContextClient } from "../client.js";

/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
export class Discovery {
  constructor(private client: ContextClient) {}

  /**
   * Search for tools matching a query string
   *
   * @param query - The search query (e.g., "gas prices", "nft metadata")
   * @param limit - Maximum number of results (1-50, default 10)
   * @returns Array of matching tools
   *
   * @example
   * ```typescript
   * const tools = await client.discovery.search("gas prices");
   * console.log(tools[0].name); // "Gas Price Oracle"
   * console.log(tools[0].mcpTools); // Available methods
   * ```
   */
  async search(query: string, limit?: number): Promise<Tool[]> {
    const params = new URLSearchParams();

    if (query) {
      params.set("q", query);
    }

    if (limit !== undefined) {
      params.set("limit", String(limit));
    }

    const queryString = params.toString();
    const endpoint = `/api/v1/tools/search${queryString ? `?${queryString}` : ""}`;

    const response = await this.client.fetch<SearchResponse>(endpoint);

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
  async getFeatured(limit?: number): Promise<Tool[]> {
    return this.search("", limit);
  }
}
