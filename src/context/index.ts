/**
 * Context types for portfolio and protocol data injection.
 *
 * These types allow MCP tools to receive personalized user context
 * (wallet addresses, positions, balances) for analysis.
 *
 * @example
 * ```typescript
 * import type { PolymarketContext, UserContext } from "@ctxprotocol/sdk";
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
 * ```
 *
 * @packageDocumentation
 */

// Wallet context types
export * from "./wallet.js";

// Protocol-specific context types
export * from "./polymarket.js";

// Re-import for composite type
import type { WalletContext, ERC20Context } from "./wallet.js";
import type { PolymarketContext } from "./polymarket.js";

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
  // Future protocols:
  // hyperliquid?: HyperliquidContext;
  // aave?: AaveContext;
}
