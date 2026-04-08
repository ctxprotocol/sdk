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
 * These helpers define the contributor-side MCP response contract.
 * They do not create a headless Query API approval/resume flow; completing
 * a handshake currently requires the Context chat app UI.
 *
 * ## Action Types
 *
 * - `signature_request`: For EIP-712 signatures (Hyperliquid, Polymarket, etc.)
 * - `transaction_proposal`: For direct on-chain transactions (Uniswap, NFT mints)
 * - `auth_required`: For OAuth flows (Discord, Twitter, etc.)
 */
// === Type Guards ===
export function isHandshakeAction(value) {
    return (typeof value === "object" &&
        value !== null &&
        "_action" in value &&
        (value._action === "signature_request" ||
            value._action === "transaction_proposal" ||
            value._action === "auth_required"));
}
export function isSignatureRequest(value) {
    return isHandshakeAction(value) && value._action === "signature_request";
}
export function isTransactionProposal(value) {
    return isHandshakeAction(value) && value._action === "transaction_proposal";
}
export function isAuthRequired(value) {
    return isHandshakeAction(value) && value._action === "auth_required";
}
// === Helper Functions for Tool Developers ===
/**
 * Create a signature request response.
 * Return this from your tool when you need the user to sign EIP-712 typed data.
 *
 * Use this for platforms with proxy wallets (Hyperliquid, Polymarket, dYdX).
 * Benefits: No gas required, no network switching needed.
 */
export function createSignatureRequest(params) {
    return {
        _action: "signature_request",
        ...params,
    };
}
/**
 * Create a transaction proposal response.
 * Return this from your tool when you need the user to sign a direct on-chain transaction.
 *
 * Use this for protocols that don't use proxy wallets (Uniswap, NFT mints, etc.).
 * Note: May require network switching and gas.
 */
export function createTransactionProposal(params) {
    return {
        _action: "transaction_proposal",
        ...params,
    };
}
/**
 * Create an auth required response.
 * Return this from your tool when you need the user to authenticate via OAuth.
 */
export function createAuthRequired(params) {
    return {
        _action: "auth_required",
        ...params,
    };
}
// === MCP Response Helper ===
/**
 * Wrap a handshake action in the proper MCP response format.
 *
 * MCP tools should return handshake actions in `_meta.handshakeAction` to prevent
 * the MCP SDK from stripping unknown fields.
 * Headless Query clients may observe raw internal handshake markers in
 * execution data, but they cannot submit approval results through the
 * Query API today.
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
export function wrapHandshakeResponse(action) {
    const actionType = action._action.replace("_", " ");
    return {
        content: [
            {
                type: "text",
                text: `Handshake required: ${actionType}. Please approve in the Context app.`,
            },
        ],
        structuredContent: {
            _meta: {
                handshakeAction: action,
            },
            status: "handshake_required",
            message: action.meta?.description ?? `${actionType} required`,
        },
    };
}
//# sourceMappingURL=types.js.map