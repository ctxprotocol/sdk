export { ContextClient, ContextClientOptions, ContextError, ContextErrorCode, Discovery, ExecuteApiErrorResponse, ExecuteApiResponse, ExecuteApiSuccessResponse, ExecuteOptions, ExecutionResult, McpTool, SearchOptions, SearchResponse, Tool, Tools } from './client/index.cjs';

/**
 * Wallet context types for portfolio tracking.
 *
 * These types represent wallet and token holdings that can be
 * injected into MCP tools for personalized analysis.
 *
 * @packageDocumentation
 */
/**
 * Base wallet context - address and chain info
 */
interface WalletContext {
    /** Wallet address (checksummed) */
    address: string;
    /** Chain ID (137 for Polygon, 1 for Ethereum, etc.) */
    chainId: number;
    /** Native token balance in wei (string for precision) */
    nativeBalance?: string;
}
/**
 * ERC20 token holdings
 */
interface ERC20TokenBalance {
    /** Token contract address */
    address: string;
    /** Token symbol (e.g., "USDC") */
    symbol: string;
    /** Token decimals */
    decimals: number;
    /** Balance in smallest unit (string for precision) */
    balance: string;
}
/**
 * Collection of ERC20 token balances
 */
interface ERC20Context {
    /** Array of token balances */
    tokens: ERC20TokenBalance[];
}

/**
 * Polymarket context types for portfolio tracking.
 *
 * These types represent Polymarket positions and orders that can be
 * injected into MCP tools for personalized portfolio analysis.
 *
 * @packageDocumentation
 */
/**
 * A single Polymarket position
 */
interface PolymarketPosition {
    /** The market's condition ID */
    conditionId: string;
    /** The specific outcome token ID */
    tokenId: string;
    /** Which outcome this position is for */
    outcome: "YES" | "NO";
    /** Number of shares held */
    shares: number;
    /** Average entry price (0-1 scale) */
    avgEntryPrice: number;
    /** Market question/title for display */
    marketTitle?: string;
}
/**
 * An open order on Polymarket
 */
interface PolymarketOrder {
    /** Order ID */
    orderId: string;
    /** The market's condition ID */
    conditionId: string;
    /** Order side */
    side: "BUY" | "SELL";
    /** Which outcome this order is for */
    outcome: "YES" | "NO";
    /** Limit price (0-1 scale) */
    price: number;
    /** Order size in shares */
    size: number;
    /** Amount already filled */
    filled: number;
}
/**
 * Complete Polymarket portfolio context.
 * This is what gets passed to MCP tools for personalized analysis.
 */
interface PolymarketContext {
    /** The wallet address this context is for */
    walletAddress: string;
    /** All open positions */
    positions: PolymarketPosition[];
    /** All open orders */
    openOrders: PolymarketOrder[];
    /** Total portfolio value in USD (sum of position values) */
    totalValue?: number;
    /** When this context was fetched (ISO 8601 string) */
    fetchedAt: string;
}

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

/**
 * Composite context for tools that need multiple data sources.
 *
 * This is the unified structure that can be passed to MCP tools
 * to provide comprehensive user context.
 */
interface UserContext {
    /** Base wallet information */
    wallet?: WalletContext;
    /** ERC20 token holdings */
    erc20?: ERC20Context;
    /** Polymarket positions and orders */
    polymarket?: PolymarketContext;
}

export type { ERC20Context, ERC20TokenBalance, PolymarketContext, PolymarketOrder, PolymarketPosition, UserContext, WalletContext };
