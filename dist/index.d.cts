export { ContextClient, ContextClientOptions, ContextError, ContextErrorCode, Discovery, ExecuteApiErrorResponse, ExecuteApiResponse, ExecuteApiSuccessResponse, ExecuteOptions, ExecutionResult, McpTool, SearchOptions, SearchResponse, Tool, Tools } from './client/index.cjs';
import { JWTPayload } from 'jose';

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

interface ContextRequest {
    headers: {
        authorization?: string;
        [key: string]: string | string[] | undefined;
    };
    body?: {
        method?: string;
        [key: string]: unknown;
    };
    context?: JWTPayload;
}
interface ContextResponse {
    status(code: number): ContextResponse;
    json(data: unknown): void;
}
type NextFunction = (error?: unknown) => void;
/**
 * Extended Request object with verified Context Protocol JWT payload.
 *
 * After `createContextMiddleware()` runs successfully on a protected method,
 * the `context` property contains the decoded JWT claims.
 */
interface ContextMiddlewareRequest extends ContextRequest {
    /** The verified JWT payload from Context Protocol (available after auth) */
    context?: JWTPayload;
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
declare function verifyContextRequest(options: VerifyRequestOptions): Promise<JWTPayload>;
interface CreateContextMiddlewareOptions {
    /** Expected Audience (your tool URL) for stricter validation */
    audience?: string;
}
/**
 * Creates an Express/Connect-compatible middleware that secures your MCP endpoint.
 *
 * This is the "1 line of code" solution to secure your MCP server.
 * It automatically:
 * - Allows discovery methods (tools/list, initialize) without authentication
 * - Requires and verifies JWT for execution methods (tools/call)
 * - Attaches the verified payload to `req.context` for downstream use
 *
 * @param options Optional configuration
 * @returns Express-compatible middleware function
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { createContextMiddleware } from "@ctxprotocol/sdk";
 *
 * const app = express();
 * app.use(express.json());
 *
 * // 1 line to secure your endpoint
 * app.use("/mcp", createContextMiddleware());
 *
 * app.post("/mcp", (req, res) => {
 *   // req.context contains verified JWT payload (on protected methods)
 *   // Handle MCP request...
 * });
 * ```
 */
declare function createContextMiddleware(options?: CreateContextMiddlewareOptions): (req: ContextRequest, res: ContextResponse, next: NextFunction) => Promise<void>;

/**
 * Handshake Types for MCP Tool Developers
 *
 * Use these types when your tool needs to request user interaction
 * before completing an action (signatures, transactions, OAuth).
 *
 * @see https://docs.ctxprotocol.com/guides/handshake-architecture
 *
 * ## Usage Pattern
 *
 * Tools return handshake actions in the `_meta.handshakeAction` field
 * of their MCP response. The Context platform intercepts these and
 * presents the appropriate UI to the user.
 *
 * ## Action Types
 *
 * - `signature_request`: For EIP-712 signatures (Hyperliquid, Polymarket, etc.)
 * - `transaction_proposal`: For direct on-chain transactions (Uniswap, NFT mints)
 * - `auth_required`: For OAuth flows (Discord, Twitter, etc.)
 */
type HandshakeMeta = {
    /** Human-readable description of the action */
    description: string;
    /** Protocol name (e.g., "Hyperliquid", "Polymarket") */
    protocol?: string;
    /** Action verb (e.g., "Place Order", "Place Bid") */
    action?: string;
    /** Token symbol if relevant */
    tokenSymbol?: string;
    /** Human-readable token amount */
    tokenAmount?: string;
    /** UI warning level */
    warningLevel?: "info" | "caution" | "danger";
};
type EIP712Domain = {
    /** Domain name (e.g., "Hyperliquid", "ClobAuthDomain") */
    name: string;
    /** Domain version */
    version: string;
    /** Chain ID (informational - signing is chain-agnostic) */
    chainId: number;
    /** Optional verifying contract address */
    verifyingContract?: `0x${string}`;
};
type EIP712TypeField = {
    name: string;
    type: string;
};
/**
 * Signature Request
 *
 * Use this for platforms with proxy wallets (Hyperliquid, Polymarket, dYdX).
 *
 * Benefits:
 * - No gas required (user signs a message, not a transaction)
 * - No network switching needed (signing is chain-agnostic)
 * - Works with Privy embedded wallets on any chain
 *
 * @example
 * ```typescript
 * return {
 *   structuredContent: {
 *     _meta: {
 *       handshakeAction: createSignatureRequest({
 *         domain: { name: "Hyperliquid", version: "1", chainId: 42161 },
 *         types: { Order: [...] },
 *         primaryType: "Order",
 *         message: { asset: 4, isBuy: true, ... },
 *         meta: { description: "Place Long ETH order", protocol: "Hyperliquid" }
 *       })
 *     }
 *   }
 * };
 * ```
 */
type SignatureRequest = {
    _action: "signature_request";
    /** EIP-712 domain separator */
    domain: EIP712Domain;
    /** EIP-712 type definitions */
    types: Record<string, EIP712TypeField[]>;
    /** The primary type being signed */
    primaryType: string;
    /** The message data to sign */
    message: Record<string, unknown>;
    /** UI metadata for the approval card */
    meta?: HandshakeMeta;
    /**
     * Optional: Tool name to call with the signature result.
     * If provided, the platform will call this tool with { signature, originalParams }
     * after the user signs.
     */
    callbackToolName?: string;
};
type TransactionProposalMeta = HandshakeMeta & {
    /** Estimated gas cost (informational - Context may sponsor) */
    estimatedGas?: string;
    /** Link to contract on block explorer */
    explorerUrl?: string;
};
/**
 * Transaction Proposal
 *
 * Use this for protocols without proxy wallets (Uniswap, NFT mints, etc.).
 *
 * Note: May require network switching and gas fees.
 *
 * @example
 * ```typescript
 * return {
 *   structuredContent: {
 *     _meta: {
 *       handshakeAction: createTransactionProposal({
 *         chainId: 8453,
 *         to: "0x...",
 *         data: "0x...",
 *         meta: { description: "Swap 100 USDC for ETH", protocol: "Uniswap" }
 *       })
 *     }
 *   }
 * };
 * ```
 */
type TransactionProposal = {
    _action: "transaction_proposal";
    /** EVM chain ID (e.g., 137 for Polygon, 8453 for Base) */
    chainId: number;
    /** Target contract address */
    to: `0x${string}`;
    /** Encoded calldata */
    data: `0x${string}`;
    /** Wei to send (as string, default "0") */
    value?: string;
    /** UI metadata for the approval card */
    meta?: TransactionProposalMeta;
};
type AuthRequiredMeta = {
    /** Human-friendly service name */
    displayName?: string;
    /** Permissions being requested */
    scopes?: string[];
    /** Description of what access is needed */
    description?: string;
    /** Tool's icon URL */
    iconUrl?: string;
    /** How long authorization lasts */
    expiresIn?: string;
};
/**
 * Auth Required
 *
 * Use this when your tool needs the user to authenticate with an external service.
 *
 * @example
 * ```typescript
 * if (!hasUserToken(contextDid)) {
 *   return {
 *     structuredContent: {
 *       _meta: {
 *         handshakeAction: createAuthRequired({
 *           provider: "discord",
 *           authUrl: "https://your-server.com/oauth/discord",
 *           meta: { displayName: "Discord Bot", scopes: ["send_messages"] }
 *         })
 *       }
 *     }
 *   };
 * }
 * ```
 */
type AuthRequired = {
    _action: "auth_required";
    /** Service identifier (e.g., "discord", "slack") */
    provider: string;
    /** Your OAuth initiation endpoint (MUST be HTTPS) */
    authUrl: string;
    /** UI metadata for the auth card */
    meta?: AuthRequiredMeta;
};
type HandshakeAction = SignatureRequest | TransactionProposal | AuthRequired;
declare function isHandshakeAction(value: unknown): value is HandshakeAction;
declare function isSignatureRequest(value: unknown): value is SignatureRequest;
declare function isTransactionProposal(value: unknown): value is TransactionProposal;
declare function isAuthRequired(value: unknown): value is AuthRequired;
/**
 * Create a signature request response.
 * Return this from your tool when you need the user to sign EIP-712 typed data.
 *
 * Use this for platforms with proxy wallets (Hyperliquid, Polymarket, dYdX).
 * Benefits: No gas required, no network switching needed.
 */
declare function createSignatureRequest(params: Omit<SignatureRequest, "_action">): SignatureRequest;
/**
 * Create a transaction proposal response.
 * Return this from your tool when you need the user to sign a direct on-chain transaction.
 *
 * Use this for protocols that don't use proxy wallets (Uniswap, NFT mints, etc.).
 * Note: May require network switching and gas.
 */
declare function createTransactionProposal(params: Omit<TransactionProposal, "_action">): TransactionProposal;
/**
 * Create an auth required response.
 * Return this from your tool when you need the user to authenticate via OAuth.
 */
declare function createAuthRequired(params: Omit<AuthRequired, "_action">): AuthRequired;
/**
 * Wrap a handshake action in the proper MCP response format.
 *
 * MCP tools should return handshake actions in `_meta.handshakeAction` to prevent
 * the MCP SDK from stripping unknown fields.
 *
 * @example
 * ```typescript
 * // In your tool handler:
 * return wrapHandshakeResponse(createSignatureRequest({
 *   domain: { name: "Hyperliquid", version: "1", chainId: 42161 },
 *   types: { Order: [...] },
 *   primaryType: "Order",
 *   message: orderData,
 *   meta: { description: "Place order", protocol: "Hyperliquid" }
 * }));
 * ```
 */
declare function wrapHandshakeResponse(action: HandshakeAction): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    structuredContent: {
        _meta: {
            handshakeAction: HandshakeAction;
        };
        status: string;
        message: string;
    };
};

export { type AuthRequired, type AuthRequiredMeta, CONTEXT_REQUIREMENTS_KEY, type ContextMiddlewareRequest, type ContextRequirementType, type CreateContextMiddlewareOptions, type EIP712Domain, type EIP712TypeField, type ERC20Context, type ERC20TokenBalance, type HandshakeAction, type HandshakeMeta, type HyperliquidAccountSummary, type HyperliquidContext, type HyperliquidOrder, type HyperliquidPerpPosition, type HyperliquidSpotBalance, type PolymarketContext, type PolymarketOrder, type PolymarketPosition, type SignatureRequest, type ToolRequirements, type TransactionProposal, type TransactionProposalMeta, type UserContext, type VerifyRequestOptions, type WalletContext, createAuthRequired, createContextMiddleware, createSignatureRequest, createTransactionProposal, isAuthRequired, isHandshakeAction, isOpenMcpMethod, isProtectedMcpMethod, isSignatureRequest, isTransactionProposal, verifyContextRequest, wrapHandshakeResponse };
