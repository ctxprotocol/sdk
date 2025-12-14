/**
 * Context types for portfolio and protocol data injection.
 *
 * These types allow MCP tools to receive personalized user context
 * (wallet addresses, positions, balances) for analysis.
 *
 * @example
 * ```typescript
 * import type { PolymarketContext, UserContext, ToolRequirements } from "@ctxprotocol/sdk";
 *
 * // Build context for a user's portfolio
 * const context: UserContext = {
 *   wallet: { address: "0x...", chainId: 137 },
 *   polymarket: {
 *     walletAddress: "0x...",
 *     positions: [...],
 *     openOrders: [],
 *     fetchedAt: new Date().toISOString(),
 *   },
 * };
 *
 * // Declare context requirements for a tool
 * const requirements: ToolRequirements = {
 *   context: ["polymarket"],
 * };
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
// MCP tools that need user portfolio data MUST declare this explicitly.
// The Context marketplace uses this to determine which context to inject.
// ============================================================================

/**
 * Context requirement types supported by the Context marketplace.
 * Maps to protocol-specific context builders on the platform.
 *
 * @example
 * ```typescript
 * // Tool that needs Hyperliquid positions
 * requirements: {
 *   context: ["hyperliquid"]
 * }
 *
 * // Tool that needs multiple context types
 * requirements: {
 *   context: ["hyperliquid", "wallet"]
 * }
 * ```
 */
export type ContextRequirementType = "polymarket" | "hyperliquid" | "wallet";

/**
 * Tool-level requirements declaration.
 *
 * MCP tools that need user portfolio data MUST declare this explicitly
 * in their tool definition. The Context marketplace checks this field
 * to determine what context to inject.
 *
 * @example
 * ```typescript
 * const tool = {
 *   name: "analyze_my_positions",
 *   description: "Analyze your positions",
 *
 *   // ⭐ REQUIRED for portfolio tools
 *   requirements: {
 *     context: ["hyperliquid"],
 *   } satisfies ToolRequirements,
 *
 *   inputSchema: {
 *     type: "object",
 *     properties: {
 *       portfolio: {
 *         type: "object",
 *         description: "Portfolio context (injected by platform)",
 *       },
 *     },
 *     required: ["portfolio"],
 *   },
 * };
 * ```
 */
export interface ToolRequirements {
  /**
   * Context types required by this tool.
   * - "polymarket": User's Polymarket positions (prediction markets)
   * - "hyperliquid": User's Hyperliquid perp/spot positions
   * - "wallet": Generic EVM wallet context (address, balances)
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
