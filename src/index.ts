/**
 * @ctxprotocol/sdk
 *
 * Official TypeScript SDK for the Context Protocol.
 * Discover and execute AI tools programmatically.
 *
 * @packageDocumentation
 */

// Main client export
export { ContextClient } from "./client.js";

// Resource exports
export { Discovery } from "./resources/discovery.js";
export { Tools } from "./resources/tools.js";

// Type exports for full autocomplete support
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
  ContextErrorCode,
} from "./types.js";

// Error export
export { ContextError } from "./types.js";
