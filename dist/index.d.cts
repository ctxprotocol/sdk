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
 * Hyperliquid context types for portfolio tracking.
 *
 * These types represent Hyperliquid perpetual positions, orders, and account
 * data that can be injected into MCP tools for personalized portfolio analysis.
 *
 * @packageDocumentation
 */
/**
 * Hyperliquid Perpetual Position
 */
interface HyperliquidPerpPosition {
    /** Asset symbol (e.g., "ETH", "BTC") */
    coin: string;
    /** Position size (positive = long, negative = short) */
    size: number;
    /** Entry price */
    entryPrice: number;
    /** Current mark price */
    markPrice?: number;
    /** Unrealized PnL in USD */
    unrealizedPnl: number;
    /** Liquidation price */
    liquidationPrice: number;
    /** Position value in USD */
    positionValue: number;
    /** Leverage info */
    leverage: {
        type: "cross" | "isolated";
        value: number;
    };
    /** Margin used for this position */
    marginUsed: number;
    /** Return on equity percentage */
    returnOnEquity: number;
    /** Cumulative funding paid/received */
    cumFunding: {
        allTime: number;
        sinceOpen: number;
    };
}
/**
 * Hyperliquid Open Order
 */
interface HyperliquidOrder {
    /** Order ID */
    oid: number;
    /** Asset symbol */
    coin: string;
    /** Order side: "B" = Buy, "A" = Ask/Sell */
    side: "B" | "A";
    /** Limit price */
    limitPrice: number;
    /** Order size */
    size: number;
    /** Original order size */
    originalSize: number;
    /** Order type */
    orderType: "Limit" | "Market" | "Stop" | "TakeProfit";
    /** Is reduce-only order */
    reduceOnly: boolean;
    /** Is trigger order */
    isTrigger: boolean;
    /** Trigger price (if trigger order) */
    triggerPrice?: number;
    /** Order timestamp */
    timestamp: number;
}
/**
 * Hyperliquid Spot Balance
 */
interface HyperliquidSpotBalance {
    /** Token symbol */
    token: string;
    /** Token balance */
    balance: number;
    /** USD value */
    usdValue?: number;
}
/**
 * Hyperliquid Account Summary
 */
interface HyperliquidAccountSummary {
    /** Total account value in USD */
    accountValue: number;
    /** Total margin used */
    totalMarginUsed: number;
    /** Total notional position value */
    totalNotionalPosition: number;
    /** Withdrawable amount */
    withdrawable: number;
    /** Cross margin summary */
    crossMargin: {
        accountValue: number;
        totalMarginUsed: number;
    };
}
/**
 * Complete Hyperliquid portfolio context.
 * This is what gets passed to MCP tools for personalized analysis.
 */
interface HyperliquidContext {
    /** The wallet address this context is for */
    walletAddress: string;
    /** Perpetual positions */
    perpPositions: HyperliquidPerpPosition[];
    /** Open orders */
    openOrders: HyperliquidOrder[];
    /** Spot balances */
    spotBalances: HyperliquidSpotBalance[];
    /** Account summary */
    accountSummary: HyperliquidAccountSummary;
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
type ContextRequirementType = "polymarket" | "hyperliquid" | "wallet";
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
interface ToolRequirements {
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
interface UserContext {
    /** Base wallet information */
    wallet?: WalletContext;
    /** ERC20 token holdings */
    erc20?: ERC20Context;
    /** Polymarket positions and orders */
    polymarket?: PolymarketContext;
    /** Hyperliquid perpetual positions and account data */
    hyperliquid?: HyperliquidContext;
}

export type { ContextRequirementType, ERC20Context, ERC20TokenBalance, HyperliquidAccountSummary, HyperliquidContext, HyperliquidOrder, HyperliquidPerpPosition, HyperliquidSpotBalance, PolymarketContext, PolymarketOrder, PolymarketPosition, ToolRequirements, UserContext, WalletContext };
