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
export { Developer } from "./resources/developer.js";
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
  QueryClarificationPayload,
  QueryClarificationOption,
  QueryClarificationPolicy,
  QueryCapabilityMissPayload,
  QueryAssumptionMetadata,
  QueryAttemptForkReason,
  QueryAttemptReference,
  QueryForkReference,
  QueryOutcomeType,
  QueryDeepMode,
  QueryOptions,
  QueryResult,
  QuerySessionState,
  QueryToolUsage,
  QueryCost,
  QueryCompletenessRepairEvent,
  QueryDeveloperTrace,
  QueryDeveloperTraceDiagnostics,
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
  QueryStreamErrorEvent,
  ContextErrorCode,
  UpdateToolOptions,
  UpdateToolResult,
  ToolCategory,
} from "./types.js";

// Error and constant exports
export { ContextError, ALLOWED_TOOL_CATEGORIES } from "./types.js";
