import type { UpdateToolOptions, UpdateToolResult } from "../types.js";
import type { ContextClient } from "../client.js";
/**
 * Developer resource for managing tool listings on the Context Protocol marketplace.
 *
 * Scoped to contributor/developer concerns (listing management), separate from
 * the consumer-facing `tools.execute()` and `query.run()`.
 */
export declare class Developer {
    private client;
    constructor(client: ContextClient);
    /**
     * Update a tool listing's metadata (name, description, category).
     *
     * Requires an API key belonging to the tool's owner.
     *
     * @param toolId - The UUID of the tool to update
     * @param updates - Fields to update (at least one required)
     * @returns The updated tool metadata
     *
     * @throws {ContextError} If authentication fails or the caller does not own the tool
     *
     * @example
     * ```typescript
     * const updated = await client.developer.updateTool("tool-uuid", {
     *   description: "Updated description with better showcase prompts",
     *   category: "crypto",
     * });
     * console.log(updated.updatedAt);
     * ```
     */
    updateTool(toolId: string, updates: UpdateToolOptions): Promise<UpdateToolResult>;
}
//# sourceMappingURL=developer.d.ts.map