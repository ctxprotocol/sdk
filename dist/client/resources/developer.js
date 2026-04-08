import { ALLOWED_TOOL_CATEGORIES, ContextError } from "../types.js";
/**
 * Developer resource for managing tool listings on the Context Protocol marketplace.
 *
 * Scoped to contributor/developer concerns (listing management), separate from
 * the consumer-facing `tools.execute()` and `query.run()`.
 */
export class Developer {
    client;
    constructor(client) {
        this.client = client;
    }
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
    async updateTool(toolId, updates) {
        if (!toolId) {
            throw new ContextError("toolId is required");
        }
        if (updates.name === undefined &&
            updates.description === undefined &&
            updates.category === undefined) {
            throw new ContextError("At least one field required: name, description, or category");
        }
        if (updates.category !== undefined &&
            updates.category !== null &&
            !ALLOWED_TOOL_CATEGORIES.includes(updates.category)) {
            throw new ContextError(`category must be one of: ${ALLOWED_TOOL_CATEGORIES.join(", ")}`);
        }
        const encodedToolId = encodeURIComponent(toolId);
        return this.client._fetch(`/api/v1/tools/${encodedToolId}`, {
            method: "PATCH",
            body: JSON.stringify(updates),
        }, { retry: false });
    }
}
//# sourceMappingURL=developer.js.map