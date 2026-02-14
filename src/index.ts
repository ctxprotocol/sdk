/**
 * @ctxprotocol/sdk
 *
 * Official TypeScript SDK for the Context Protocol.
 *
 * For AI Agents to discover and execute tools from the Context marketplace.
 *
 * @example
 * ```typescript
 * import { ContextClient } from "@ctxprotocol/sdk";
 *
 * const client = new ContextClient({ apiKey: "sk_live_..." });
 *
 * // Search for tools
 * const tools = await client.discovery.search({ query: "gas price" });
 *
 * // Execute a tool
 * const result = await client.tools.execute({
 *   toolId: "blocknative/get_gas_price",
 *   args: { chainId: 8453 },
 * });
 * ```
 *
 * @packageDocumentation
 */

// Re-export everything from client module for backwards compatibility
export {
  ContextClient,
  Discovery,
  Tools,
  Query,
  ContextError,
} from "./client/index.js";

export type {
  ContextClientOptions,
  Tool,
  McpTool,
  SearchResponse,
  SearchOptions,
  ExecuteOptions,
  ExecutionResult,
  ExecuteApiSuccessResponse,
  ExecuteApiErrorResponse,
  ExecuteApiResponse,
  // Query types (pay-per-response)
  QueryOptions,
  QueryResult,
  QueryToolUsage,
  QueryCost,
  QueryApiSuccessResponse,
  QueryApiResponse,
  QueryStreamEvent,
  QueryStreamToolStatusEvent,
  QueryStreamTextDeltaEvent,
  QueryStreamDoneEvent,
  ContextErrorCode,
} from "./client/index.js";

// Context types for portfolio injection
export * from "./context/index.js";

// Auth utilities for verifying platform requests
export {
  verifyContextRequest,
  isProtectedMcpMethod,
  isOpenMcpMethod,
  createContextMiddleware,
} from "./auth/index.js";
export type {
  VerifyRequestOptions,
  CreateContextMiddlewareOptions,
  ContextMiddlewareRequest,
} from "./auth/index.js";

// Handshake types and helpers for tools that need user interaction
// (signatures, transactions, OAuth)
export {
  createSignatureRequest,
  createTransactionProposal,
  createAuthRequired,
  wrapHandshakeResponse,
  isHandshakeAction,
  isSignatureRequest,
  isTransactionProposal,
  isAuthRequired,
} from "./handshake/index.js";
export type {
  HandshakeMeta,
  EIP712Domain,
  EIP712TypeField,
  SignatureRequest,
  TransactionProposalMeta,
  TransactionProposal,
  AuthRequiredMeta,
  AuthRequired,
  HandshakeAction,
} from "./handshake/index.js";
