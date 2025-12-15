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
 * Since the MCP protocol only transmits standard fields (name, description,
 * inputSchema, outputSchema), context requirements MUST be embedded in the
 * inputSchema using the "x-context-requirements" JSON Schema extension.
 *
 * @example
 * ```typescript
 * import { CONTEXT_REQUIREMENTS_KEY, type ContextRequirementType } from "@ctxprotocol/sdk";
 * import type { HyperliquidContext } from "@ctxprotocol/sdk";
 *
 * const tool = {
 *   name: "analyze_my_positions",
 *   inputSchema: {
 *     type: "object",
 *     [CONTEXT_REQUIREMENTS_KEY]: ["hyperliquid"] as ContextRequirementType[],
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

// Re-import for composite type
import type { WalletContext, ERC20Context } from "./wallet.js";
import type { PolymarketContext } from "./polymarket.js";
import type { HyperliquidContext } from "./hyperliquid.js";

// ============================================================================
// CONTEXT REQUIREMENTS
//
// MCP tools that need user portfolio data MUST declare this in inputSchema.
// The MCP protocol only transmits standard fields (name, description,
// inputSchema, outputSchema). Custom fields get stripped by the MCP SDK.
// ============================================================================

/**
 * JSON Schema extension key for declaring context requirements.
 *
 * WHY THIS APPROACH?
 * - MCP protocol only transmits: name, description, inputSchema, outputSchema
 * - Custom fields like `requirements` get stripped by MCP SDK during transport
 * - JSON Schema allows custom "x-" prefixed extension properties
 * - inputSchema is preserved end-to-end through MCP transport
 *
 * @example
 * ```typescript
 * import { CONTEXT_REQUIREMENTS_KEY } from "@ctxprotocol/sdk";
 *
 * const tool = {
 *   name: "analyze_my_positions",
 *   inputSchema: {
 *     type: "object",
 *     [CONTEXT_REQUIREMENTS_KEY]: ["hyperliquid"],
 *     properties: { portfolio: { type: "object" } },
 *     required: ["portfolio"]
 *   }
 * };
 * ```
 */
export const CONTEXT_REQUIREMENTS_KEY = "x-context-requirements" as const;

/**
 * Context requirement types supported by the Context marketplace.
 * Maps to protocol-specific context builders on the platform.
 *
 * @example
 * ```typescript
 * inputSchema: {
 *   type: "object",
 *   "x-context-requirements": ["hyperliquid"] as ContextRequirementType[],
 *   properties: { portfolio: { type: "object" } },
 *   required: ["portfolio"]
 * }
 * ```
 */
export type ContextRequirementType = "polymarket" | "hyperliquid" | "wallet";

/**
 * @deprecated The `requirements` field at tool level gets stripped by MCP SDK.
 * Use `x-context-requirements` inside `inputSchema` instead.
 *
 * @example
 * ```typescript
 * // ❌ OLD (doesn't work - stripped by MCP SDK)
 * { requirements: { context: ["hyperliquid"] } }
 *
 * // ✅ NEW (works - preserved through MCP transport)
 * { inputSchema: { "x-context-requirements": ["hyperliquid"], ... } }
 * ```
 */
export interface ToolRequirements {
  /**
   * @deprecated Use `x-context-requirements` in inputSchema instead.
   */
  context?: ContextRequirementType[];
}

/**
 * Composite context for tools that need multiple data sources.
 *
 * This is the unified structure that can be passed to MCP tools
 * to provide comprehensive user context.
 */
export interface UserContext {
  /** Base wallet information */
  wallet?: WalletContext;
  /** ERC20 token holdings */
  erc20?: ERC20Context;
  /** Polymarket positions and orders */
  polymarket?: PolymarketContext;
  /** Hyperliquid perpetual positions and account data */
  hyperliquid?: HyperliquidContext;
  // Future protocols:
  // aave?: AaveContext;
}
