export { ContextClient, ContextClientOptions, ContextError, ContextErrorCode, Discovery, ExecuteApiErrorResponse, ExecuteApiResponse, ExecuteApiSuccessResponse, ExecuteOptions, ExecutionResult, McpTool, SearchOptions, SearchResponse, Tool, Tools } from './client/index.js';
import * as jose from 'jose';

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
declare const CONTEXT_REQUIREMENTS_KEY: "x-context-requirements";
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
type ContextRequirementType = "polymarket" | "hyperliquid" | "wallet";
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
interface ToolRequirements {
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

/**
 * Determines if a given MCP method requires authentication.
 *
 * Discovery methods (tools/list, resources/list, etc.) are open.
 * Execution methods (tools/call) require authentication.
 *
 * @param method The MCP JSON-RPC method (e.g., "tools/list", "tools/call")
 * @returns true if the method requires authentication
 *
 * @example
 * ```typescript
 * if (isProtectedMcpMethod(body.method)) {
 *   await verifyContextRequest({ authorizationHeader: req.headers.authorization });
 * }
 * ```
 */
declare function isProtectedMcpMethod(method: string): boolean;
/**
 * Determines if a given MCP method is explicitly open (no auth).
 *
 * @param method The MCP JSON-RPC method
 * @returns true if the method is known to be open
 */
declare function isOpenMcpMethod(method: string): boolean;
interface VerifyRequestOptions {
    /** The full Authorization header string (e.g. "Bearer eyJ...") */
    authorizationHeader?: string;
    /** Expected Audience (your tool URL) for stricter validation */
    audience?: string;
}
/**
 * Verifies that an incoming request originated from the Context Protocol Platform.
 *
 * @param options Contains the Authorization header
 * @returns The decoded payload if valid
 * @throws ContextError if invalid
 */
declare function verifyContextRequest(options: VerifyRequestOptions): Promise<jose.JWTPayload>;

export { CONTEXT_REQUIREMENTS_KEY, type ContextRequirementType, type ERC20Context, type ERC20TokenBalance, type HyperliquidAccountSummary, type HyperliquidContext, type HyperliquidOrder, type HyperliquidPerpPosition, type HyperliquidSpotBalance, type PolymarketContext, type PolymarketOrder, type PolymarketPosition, type ToolRequirements, type UserContext, type VerifyRequestOptions, type WalletContext, isOpenMcpMethod, isProtectedMcpMethod, verifyContextRequest };
