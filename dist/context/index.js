/**
 * Context types for portfolio and protocol data injection.
 *
 * These types allow MCP tools to receive personalized user context
 * (wallet addresses, positions, balances) for analysis.
 *
 * =============================================================================
 * DECLARING CONTEXT REQUIREMENTS
 * =============================================================================
 *
 * Context requirements are declared via `_meta.contextRequirements` at the tool level.
 * This is the primary mechanism that the Context Platform reads.
 *
 * Previously, `x-context-requirements` in inputSchema was recommended, but the MCP SDK
 * may strip extension properties during transport. Use `_meta` instead.
 *
 * @example
 * ```typescript
 * import { CONTEXT_REQUIREMENTS_KEY, type ContextRequirementType } from "@ctxprotocol/sdk";
 * import type { HyperliquidContext } from "@ctxprotocol/sdk";
 *
 * const tool = {
 *   name: "analyze_my_positions",
 *   _meta: {
 *     contextRequirements: ["hyperliquid"] as ContextRequirementType[],
 *   },
 *   inputSchema: {
 *     type: "object",
 *     properties: {
 *       portfolio: { type: "object" }
 *     },
 *     required: ["portfolio"]
 *   }
 * };
 *
 * // Your handler receives the injected context:
 * function handleAnalyzeMyPositions(args: { portfolio: HyperliquidContext }) {
 *   const { perpPositions, accountSummary } = args.portfolio;
 *   // ... analyze and return insights
 * }
 * ```
 *
 * @packageDocumentation
 */
// Wallet context types
export * from "./wallet.js";
// Protocol-specific context types
export * from "./polymarket.js";
export * from "./hyperliquid.js";
// ============================================================================
// CONTEXT REQUIREMENTS
//
// MCP tools that need user portfolio data MUST declare this in inputSchema.
// The MCP protocol only transmits standard fields (name, description,
// inputSchema, outputSchema). Custom fields get stripped by the MCP SDK.
// ============================================================================
/**
 * @deprecated Use `_meta.contextRequirements` instead (see META_CONTEXT_REQUIREMENTS_KEY).
 *
 * This key was designed for embedding requirements in inputSchema,
 * but the MCP SDK may strip `x-` prefixed extension properties during transport.
 * The `_meta.contextRequirements` approach is what the Context Platform reads.
 */
export const CONTEXT_REQUIREMENTS_KEY = "x-context-requirements";
/**
 * The key used inside `_meta` to declare context requirements.
 * This is the PRIMARY mechanism — the Context Platform reads `_meta.contextRequirements`.
 *
 * @example
 * ```typescript
 * const tool = {
 *   name: "analyze_my_positions",
 *   _meta: {
 *     [META_CONTEXT_REQUIREMENTS_KEY]: ["hyperliquid"] as ContextRequirementType[],
 *   },
 *   inputSchema: {
 *     type: "object",
 *     properties: { portfolio: { type: "object" } },
 *     required: ["portfolio"]
 *   }
 * };
 * ```
 */
export const META_CONTEXT_REQUIREMENTS_KEY = "contextRequirements";
//# sourceMappingURL=index.js.map