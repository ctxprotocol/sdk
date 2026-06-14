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
  SuggestedPrompt,
  SuggestedPromptSource,
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
  QueryCapabilityMissPayload,
  QueryAssumptionMetadata,
  QueryAttemptForkReason,
  QueryAttemptReference,
  QueryForkReference,
  QueryJobStartResult,
  QueryJobStatus,
  QueryJobStatusResult,
  QueryOutcomeType,
  QueryOptions,
  QueryPollOptions,
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
  QueryComputedArtifact,
  QueryChartType,
  QueryChartSeriesType,
  QueryChartAxisType,
  QueryChartValueFormat,
  QueryChartDataValue,
  QueryChartDataRow,
  QueryChartSeries,
  QueryChartAxis,
  QueryChartSpec,
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
  AgentModelId,
  AgentModelIdInput,
} from "./types.js";

// Error and constant exports
export {
  ContextError,
  ALLOWED_TOOL_CATEGORIES,
  AGENT_MODEL_IDS,
  DEFAULT_AGENT_MODEL_ID,
} from "./types.js";
