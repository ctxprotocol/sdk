/**
 * @ctxprotocol/sdk/client
 *
 * Client module for AI Agents to query marketplace and execute tools.
 *
 * @packageDocumentation
 */

// Main client export
export { ContextClient } from "./client.js";

// Resource exports
export { Discovery } from "./resources/discovery.js";
export { Tools } from "./resources/tools.js";
export { Query } from "./resources/query.js";

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
} from "./types.js";

// Error export
export { ContextError } from "./types.js";
