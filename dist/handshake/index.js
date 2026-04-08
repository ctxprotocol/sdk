/**
 * Handshake Module
 *
 * Types and helpers for MCP tools that need user interaction
 * (signatures, transactions, OAuth).
 *
 * @example
 * ```typescript
 * import {
 *   createSignatureRequest,
 *   createTransactionProposal,
 *   createAuthRequired,
 *   wrapHandshakeResponse,
 * } from "@ctxprotocol/sdk/handshake";
 *
 * // In your tool handler:
 * if (needsSignature) {
 *   return wrapHandshakeResponse(createSignatureRequest({
 *     domain: { name: "MyProtocol", version: "1", chainId: 1 },
 *     types: { ... },
 *     primaryType: "Order",
 *     message: { ... },
 *     meta: { description: "Place order", protocol: "MyProtocol" }
 *   }));
 * }
 * ```
 */
// Type Guards
export { isHandshakeAction, isSignatureRequest, isTransactionProposal, isAuthRequired, } from "./types.js";
// Helper Functions
export { createSignatureRequest, createTransactionProposal, createAuthRequired, wrapHandshakeResponse, } from "./types.js";
//# sourceMappingURL=index.js.map