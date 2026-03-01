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
  McpToolMeta,
  McpToolRateLimitHints,
  SearchResponse,
  SearchOptions,
  ExecuteOptions,
  ExecuteSessionStartOptions,
  ExecuteSessionStatus,
  ExecuteSessionSpend,
  ExecuteSessionResult,
  ExecutionResult,
  ExecuteApiSuccessResponse,
  ExecuteApiErrorResponse,
  ExecuteApiResponse,
  ExecuteSessionApiSuccessResponse,
  ExecuteSessionApiResponse,
  // Query types (pay-per-response)
  QueryOptions,
  QueryResult,
  QueryToolUsage,
  QueryCost,
  QueryDeveloperTrace,
  QueryDeveloperTraceSummary,
  QueryDeveloperTraceStep,
  QueryDeveloperTraceToolRef,
  QueryDeveloperTraceLoopInfo,
  QueryApiSuccessResponse,
  QueryApiResponse,
  QueryStreamEvent,
  QueryStreamToolStatusEvent,
  QueryStreamTextDeltaEvent,
  QueryStreamDeveloperTraceEvent,
  QueryStreamDoneEvent,
  ContextErrorCode,
} from "./types.js";

// Error export
export { ContextError } from "./types.js";
