import type { ContributorSearchTraceRecord } from "../contrib/search/types.js";

/**
 * Default model for the main librarian agent loop. Omitting `agentModelId`
 * uses this same platform default as the Context chat app.
 */
export const DEFAULT_AGENT_MODEL_ID = "kimi-k2.6-model" as const;

/**
 * Public model IDs currently accepted by the Query API for `agentModelId`.
 * Tool selection remains a managed internal stage even when this is set.
 */
export const AGENT_MODEL_IDS = [
  "kimi-k2.6-model",
  "glm-5.2-model",
  "deepseek-v4-pro-model",
  "deepseek-v4-flash-model",
  "qwen-3.7-plus-model",
  "qwen-3.7-max-model",
  "gpt-5.5-model",
  "claude-opus-model",
] as const;

export type AgentModelId = (typeof AGENT_MODEL_IDS)[number];
export type AgentModelIdInput = AgentModelId | (string & {});

/**
 * Configuration options for initializing the ContextClient
 */
export interface ContextClientOptions {
  /**
   * Your Context Protocol API key
   * @example "sk_live_abc123..."
   */
  apiKey: string;

  /**
   * Base URL for the Context Protocol API
   * @default "https://www.ctxprotocol.com"
   */
  baseUrl?: string;

  /**
   * Request timeout for non-streaming API calls in milliseconds.
   * @default 300000
   */
  requestTimeoutMs?: number;

  /**
   * Request timeout for establishing streaming API calls in milliseconds.
   * @default 600000
   */
  streamTimeoutMs?: number;
}

/**
 * An individual MCP tool exposed by a tool listing
 */
export interface McpToolRateLimitHints {
  /** Suggested request budget for this method */
  maxRequestsPerMinute?: number;

  /** Suggested parallel call ceiling for this method */
  maxConcurrency?: number;

  /** Suggested minimum delay between sequential calls */
  cooldownMs?: number;

  /** Whether this method already supports bulk/batch retrieval */
  supportsBulk?: boolean;

  /** Preferred batch-oriented methods to call instead of fan-out loops */
  recommendedBatchTools?: string[];

  /** Optional human-readable notes for execution behavior */
  notes?: string;
}

export type DiscoveryMode = "query" | "execute";
export type McpToolSurface = "answer" | "execute" | "both";
export type McpToolLatencyClass = "instant" | "fast" | "slow" | "streaming";
export type SuggestedPromptSource = "contributor" | "platform" | "sdk";

export interface SuggestedPrompt {
  /** Prompt text shown as a clickable example in the Context app */
  text: string;

  /** Where this prompt came from */
  source: SuggestedPromptSource;

  /** Optional display hint for the listing price */
  priceHint?: string;
}

export interface McpToolPricingMeta {
  executeUsd?: string;
  queryUsd?: string;
  [key: string]: unknown;
}

export interface McpToolMeta {
  /** Declared method surface */
  surface?: McpToolSurface;

  /** Whether this method can be selected in query mode */
  queryEligible?: boolean;

  /** Declared latency class for runtime gating */
  latencyClass?: McpToolLatencyClass;

  /** Method-level pricing metadata */
  pricing?: McpToolPricingMeta;

  /** Derived discovery flag for execute eligibility */
  executeEligible?: boolean;

  /** Derived discovery field for explicit execute pricing visibility */
  executePriceUsd?: string;

  /** Context injection requirements handled by the Context runtime */
  contextRequirements?: string[];

  /**
   * Optional runtime pacing hints.
   * Tool contributors can publish these to reduce rate-limit failures.
   */
  rateLimit?: McpToolRateLimitHints;
  rateLimitHints?: McpToolRateLimitHints;

  /** Flat aliases accepted for convenience */
  maxRequestsPerMinute?: number;
  maxConcurrency?: number;
  cooldownMs?: number;
  supportsBulk?: boolean;
  recommendedBatchTools?: string[];
  notes?: string;

  [key: string]: unknown;
}

export interface StructuredMethodGuidanceHints {
  /** Suggested call-order sequence extracted from method descriptions */
  callOrderHints?: string[];

  /** Parameter usage caveats extracted from method descriptions */
  parameterCaveats?: string[];

  /** Edge-case behavior notes extracted from method descriptions */
  edgeCaseNotes?: string[];
}

export interface McpTool {
  /** Name of the MCP tool method */
  name: string;

  /** Description of what this method does */
  description: string;

  /**
   * JSON Schema for the input arguments this tool accepts.
   * Used by LLMs to generate correct arguments.
   */
  inputSchema?: Record<string, unknown>;

  /**
   * JSON Schema for the output this tool returns.
   * Used by LLMs to understand the response structure.
   */
  outputSchema?: Record<string, unknown>;

  /** MCP metadata extensions (context injection, rate-limit hints) */
  _meta?: McpToolMeta;

  /** Explicit execute eligibility in discovery responses */
  executeEligible?: boolean;

  /** Explicit execute price visibility in discovery responses */
  executePriceUsd?: string | null;

  /** Whether this method has normalized structured guidance hints */
  hasStructuredGuidance?: boolean;

  /** Optional structured guidance hints derived from the method description */
  structuredGuidance?: StructuredMethodGuidanceHints;
}

/**
 * Represents a tool available on the Context Protocol marketplace
 */
export interface Tool {
  /** Unique identifier for the tool (UUID) */
  id: string;

  /** Human-readable name of the tool */
  name: string;

  /** Description of what the tool does */
  description: string;

  /** Clickable example questions shown in the Context app */
  suggestedPrompts?: SuggestedPrompt[];

  /** Price per execution in USDC */
  price: string;

  /** Tool category (e.g., "defi", "nft") */
  category?: string;

  /** Whether the tool is verified by Context Protocol */
  isVerified?: boolean;

  /** Tool type - currently always "mcp" */
  kind?: string;

  /**
   * Available MCP tool methods
   * Use items from this array as `toolName` when executing
   */
  mcpTools?: McpTool[];

  // Trust metrics (Level 2 - Reputation Ledger)
  /** Total number of queries processed */
  totalQueries?: number;

  /** Success rate percentage (0-100) */
  successRate?: string;

  /** Uptime percentage (0-100) */
  uptimePercent?: string;

  /** Total USDC staked by the developer */
  totalStaked?: string;

  /** Whether the tool has "Proven" status (100+ queries, >95% success, >98% uptime) */
  isProven?: boolean;
}

/**
 * Response from the tools search endpoint
 */
export interface SearchResponse {
  /** Array of matching tools */
  tools: Tool[];

  /** Discovery mode used by the server */
  mode?: DiscoveryMode;

  /** The search query that was used */
  query: string;

  /** Total number of results */
  count: number;
}

/**
 * Options for searching tools
 */
export interface SearchOptions {
  /** Search query (semantic search) */
  query?: string;

  /** Maximum number of results (1-50, default 10) */
  limit?: number;

  /** Discovery mode with billing semantics */
  mode?: DiscoveryMode;

  /** Optional explicit method surface filter */
  surface?: McpToolSurface;

  /** Require methods marked query eligible */
  queryEligible?: boolean;

  /** Require explicit method execute pricing */
  requireExecutePricing?: boolean;

  /** Exclude methods by latency class */
  excludeLatencyClasses?: McpToolLatencyClass[];

  /** Convenience switch to exclude slow methods in query mode */
  excludeSlow?: boolean;

  /**
   * Restrict discovery to the caller's favorite tools.
   * - `true`: force favorites-only discovery for this request
   * - `false`: force unrestricted discovery for this request
   * - omitted: use the account-level default from Context settings
   */
  favoritesOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Developer / tool management types
// ---------------------------------------------------------------------------

/**
 * Options for updating a tool listing via `client.developer.updateTool()`.
 * At least one field must be provided.
 */
export const ALLOWED_TOOL_CATEGORIES = [
  "Crypto & DeFi",
  "Financial Markets",
  "Business & Sales",
  "Marketing & SEO",
  "Legal & Regulatory",
  "Real World",
  "Developer Tools",
  "Research & Academia",
  "Utility",
  "Other",
] as const;

export type ToolCategory = (typeof ALLOWED_TOOL_CATEGORIES)[number];

export interface UpdateToolOptions {
  /** New display name for the tool */
  name?: string;

  /** New marketplace description */
  description?: string;

  /** Validated example questions shown as clickable prompts in the Context app */
  suggestedPrompts?: SuggestedPrompt[];

  /** New category -- must be one of the predefined marketplace categories */
  category?: ToolCategory | null;
}

/**
 * Response from updating a tool listing.
 */
export interface UpdateToolResult {
  id: string;
  name: string;
  description: string;
  suggestedPrompts: SuggestedPrompt[];
  category: string | null;
  updatedAt: string;
}

/**
 * Options for executing a tool
 */
export interface ExecuteOptions {
  /** The UUID of the tool to execute (from search results) */
  toolId: string;

  /** The specific MCP tool name to call (from tool's mcpTools array) */
  toolName: string;

  /** Arguments to pass to the tool */
  args?: Record<string, unknown>;

  /**
   * Optional idempotency key (UUID recommended).
   * Reuse the same key when retrying the same logical request.
   */
  idempotencyKey?: string;

  /** Explicit execute mode label for request clarity */
  mode?: "execute";

  /** Optional execute session identifier */
  sessionId?: string;

  /** Optional per-session spend budget envelope (USD) */
  maxSpendUsd?: string;

  /** Request session closure after this execute call settles */
  closeSession?: boolean;
}

export type ExecuteSessionStatus = "open" | "closed" | "expired";

export interface ExecuteSessionSpend {
  mode: "execute";
  sessionId: string | null;
  methodPrice: string;
  spent: string;
  remaining: string | null;
  maxSpend: string | null;

  /** Optional lifecycle fields when the API returns session state */
  status?: ExecuteSessionStatus;
  expiresAt?: string;
  closeRequested?: boolean;
  pendingAccruedCount?: number;
  pendingAccruedUsd?: string;
}

/**
 * Successful execution response from the API
 */
export interface ExecuteApiSuccessResponse {
  success: true;
  mode: "execute";

  /** The result data from the tool execution */
  result: unknown;

  /** Information about the executed tool */
  tool: {
    id: string;
    name: string;
  };

  /** Method-level execute pricing used for this call */
  method: {
    name: string;
    executePriceUsd: string;
  };

  /** Spend envelope visibility for execute sessions */
  session: ExecuteSessionSpend;

  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Error response from the API
 */
export interface ExecuteApiErrorResponse {
  /** Human-readable error message */
  error: string;

  /** Explicit mode label for clarity */
  mode?: "execute";

  /** Error code for programmatic handling */
  code?: ContextErrorCode;

  /** URL to help resolve the issue */
  helpUrl?: string;

  /** Optional spend envelope context when available */
  session?: ExecuteSessionSpend;
}

/**
 * Raw API response from the execute endpoint
 */
export type ExecuteApiResponse = ExecuteApiSuccessResponse | ExecuteApiErrorResponse;

export interface ExecuteSessionStartOptions {
  /** Maximum spend budget for the session (USD string) */
  maxSpendUsd: string;
}

export interface ExecuteSessionApiSuccessResponse {
  success: true;
  mode: "execute";
  session: ExecuteSessionSpend;
}

export type ExecuteSessionApiResponse =
  | ExecuteSessionApiSuccessResponse
  | ExecuteApiErrorResponse;

export interface ExecuteSessionResult {
  mode: "execute";
  session: ExecuteSessionSpend;
}

/**
 * The resolved result returned to the user after SDK processing
 */
export interface ExecutionResult<T = unknown> {
  mode: "execute";

  /** The data returned by the tool */
  result: T;

  /** Information about the executed tool */
  tool: {
    id: string;
    name: string;
  };

  /** Method-level execute pricing used for this call */
  method: {
    name: string;
    executePriceUsd: string;
  };

  /** Spend envelope visibility for execute calls */
  session: ExecuteSessionSpend;

  /** Execution duration in milliseconds */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Query types (pay-per-response / agentic mode)
// ---------------------------------------------------------------------------

/**
 * Supported external orchestration depth hints for query execution.
 * The server decides the effective depth from the query; this is a soft hint.
 */
export type QueryDepth = "fast" | "auto" | "deep";
export type QueryOutcomeType = "answer" | "capability_miss";
export type QueryResponseShape = "answer_with_evidence" | "evidence_only";
export type QueryResponseEnvelopeViewType =
  | "table"
  | "leaderboard"
  | "heatmap"
  | "timeseries";

/**
 * Supported high-level chart kinds produced by the librarian's
 * code interpreter. Each chart artifact is a structured spec + data pair
 * the SDK consumer can render with their preferred chart library
 * (the first-party UI uses Recharts via shadcn/ui).
 */
export type QueryChartType =
  | "line"
  | "bar"
  | "area"
  | "scatter"
  | "composed"
  | "histogram"
  | "heatmap"
  | "candlestick";

/** Per-series rendering hint for a structured chart artifact. */
export type QueryChartSeriesType = "line" | "bar" | "area" | "scatter";

/** Axis kind hint used by structured chart artifacts. */
export type QueryChartAxisType = "time" | "category" | "number";

/** Axis value formatter hint used by structured chart artifacts. */
export type QueryChartValueFormat =
  | "number"
  | "percent"
  | "currency"
  | "compact";

/** Allowed primitive cell value inside a chart data row. */
export type QueryChartDataValue = string | number | null;

/** A single data row keyed by `xKey` plus each series key. */
export type QueryChartDataRow = Record<string, QueryChartDataValue>;

/** Single series entry inside a structured chart spec. */
export interface QueryChartSeries {
  key: string;
  label?: string;
  type?: QueryChartSeriesType;
  errorKey?: string;
  yAxis?: "left" | "right";
  satisfies?: string;
}

/** Optional axis configuration for a structured chart spec. */
export interface QueryChartAxis {
  type?: QueryChartAxisType;
  label?: string;
  format?: QueryChartValueFormat;
  valueScale?: "fraction" | "percent_points";
}

/** Structured chart spec describing layout for a chart artifact. */
export interface QueryChartSpec {
  type: QueryChartType;
  xKey: string;
  series: QueryChartSeries[];
  expectedMeasures?: string[];
  xAxis?: QueryChartAxis;
  yAxis?: QueryChartAxis;
  yAxisRight?: QueryChartAxis;
  legend?: boolean;
  stacked?: boolean;
  brush?: boolean;
  referenceLines?: Array<{
    axis: "x" | "y";
    value: string | number;
    label?: string;
  }>;
  referenceAreas?: Array<{
    x1?: string | number;
    x2?: string | number;
    y1?: number;
    y2?: number;
    label?: string;
  }>;
  yKey?: string;
  valueKey?: string;
  ohlc?: {
    openKey: string;
    highKey: string;
    lowKey: string;
    closeKey: string;
  };
}

/**
 * Computed artifact emitted by the librarian's code interpreter.
 *
 * Charts are returned as a structured `{ spec, data }` pair so SDK consumers
 * can render them with any compatible charting library. The first-party web UI
 * renders these specs with Recharts.
 */
export type QueryComputedArtifact = {
  kind: "chart";
  spec: QueryChartSpec;
  data: QueryChartDataRow[];
  title?: string;
};

export interface QueryToolCallFailureSample {
  /** Display name of the contributor tool whose call failed. */
  toolName: string;

  /** MCP method name that was invoked when the failure occurred. */
  methodName: string;

  /** Truncated failure reason captured from the runtime error. */
  reason: string;
}

export interface QueryGroundingSummary {
  /** Marketplace methods registered in the iterative runtime, excluding control tools. */
  availableToolCount: number;

  /** Capped sample of method names available to the model. */
  availableMethodNamesSample: string[];

  /** Methods selected by retrieval/tool selection before runtime filtering. */
  selectedMethodCount: number;

  /** Capped list of selected methods that did not survive runtime filtering. */
  selectedButFilteredOut: string[];

  /** Grounded marketplace tool calls actually executed (successes only). */
  toolCallCount: number;

  /** Total marketplace method invocations attempted by the model (success + failure). */
  toolCallAttemptCount: number;

  /** Marketplace method invocations that completed without throwing. */
  toolCallSuccessCount: number;

  /** Marketplace method invocations that threw an error before returning data. */
  toolCallFailureCount: number;

  /** Capped sample of recent failed marketplace method invocations with reasons. */
  toolCallFailureSamples: QueryToolCallFailureSample[];

  /** True when the answer was grounded in at least one marketplace tool call. */
  grounded: boolean;
}

export interface QueryCapabilityMissPayload {
  message: string;
  missingCapabilities: string[];
  suggestedRewrites: string[];
  originalQuery: string;
}

export interface QueryAssumptionMetadata {
  mode: "auto";
  optionId: string;
  label: string;
  reason: string;
}

export type QueryAttemptForkReason =
  | "manual_fork"
  | "bounded_rediscovery"
  | "resume_replay"
  | "patch_retry"
  | "unknown";

/**
 * Options for the agentic query endpoint (pay-per-response).
 *
 * Unlike `execute()` which calls a single tool once, `query()` sends a
 * natural-language question and lets the server handle the live librarian
 * pipeline (`discover -> select -> iterative execute -> synthesize ->
 * settle`).
 * One flat fee covers up to 100 MCP skill calls per tool.
 */
export interface QueryOptions {
  /** The natural-language question to answer */
  query: string;

  /**
   * Optional tool IDs to use. When omitted the server discovers tools
   * automatically (Auto Mode). When provided, only these tools are used
   * (Manual Mode).
   */
  tools?: string[];

  /**
   * Restrict auto-discovery to the caller's favorite tools.
   * Ignored when `tools` is provided because manual tool selection wins.
   * - `true`: force favorites-only discovery for this request
   * - `false`: force unrestricted discovery for this request
   * - omitted: use the account-level default from Context settings
   */
  favoritesOnly?: boolean;

  /**
   * Resume a prior durable query attempt from its latest checkpoint.
   * Cannot be combined with `tools` or `forkFrom`.
   */
  resumeFrom?: QueryAttemptReference;

  /**
   * Fork a new durable query attempt from a previous attempt.
   * Optional `reason` keeps the server's non-breaking lineage metadata honest.
   * Cannot be combined with `tools` or `resumeFrom`.
   */
  forkFrom?: QueryForkReference;

  /**
   * Optional model ID for the main librarian agent loop.
   * Supported IDs are published by the Context API. This controls the
   * merged iterative execution + final response stage; internal tool
   * selection remains managed by the server.
   */
  agentModelId?: AgentModelIdInput;

  /**
   * Structured response mode for query answers. Defaults to `answer_with_evidence`
   * on the server when omitted. The runtime always produces a grounded result
   * (bounded evidence + computed artifacts + full-data references);
   * responseShape controls whether a prose synthesis layer is added on top.
   * - `answer_with_evidence`: prose answer plus the structured grounding (chat parity)
   * - `evidence_only`: structured grounding only, no prose — the agent-harness
   *   shape. Returns bounded evidence, `computedArtifacts`, and
   *   `artifacts.canonicalDataRef`/`dataUrl` references for full data.
   */
  responseShape?: QueryResponseShape;

  /**
   * Include bounded execution data inline in the query response.
   * Defaults to false for every responseShape. Large payloads are returned as
   * a preview object with `fullData.dataUrl`/`canonicalDataRef` instead of
   * unbounded raw rows.
   */
  includeData?: boolean;

  /**
   * Persist execution data to Vercel Blob and return a download URL.
   * Useful for large payload workflows where inline JSON is not ideal.
   */
  includeDataUrl?: boolean;

  /**
   * Include machine-readable developer trace output for this query response.
   * When enabled, the server may return summary counters plus diagnostics
   * for tool selection and iterative execution behavior.
   */
  includeDeveloperTrace?: boolean;

  /**
   * Optional idempotency key (UUID recommended).
   * Reuse the same key when retrying the same logical request.
   */
  idempotencyKey?: string;
}

/**
 * Tool reference attached to developer trace timeline steps.
 */
export interface QueryDeveloperTraceToolRef {
  id?: string;
  name?: string;
  method?: string;
  [key: string]: unknown;
}

/**
 * Loop metadata attached to developer trace timeline steps.
 */
export interface QueryDeveloperTraceLoopInfo {
  name?: string;
  iteration?: number;
  maxIterations?: number;
  [key: string]: unknown;
}

/**
 * Tool selection metadata attached to discovery diagnostics.
 */
export interface QueryDeveloperTraceToolSelection {
  toolId: string;
  toolName: string;
  selectedMethodCount: number;
  selectedMethods: string[];
  omittedSelectedMethodCount: number;
  priceUsd?: string;
}

/**
 * Execution-contract details handed to the iterative runtime.
 */
export interface QueryPlanningTraceDiagnostic {
  plannerQuery: string;
  scoutEvidenceAttached: boolean;
  scoutEvidencePromptBlock: string | null;
  allowedModules: string[];
}

/**
 * Rediscovery/fallback diagnostic details.
 */
export interface QueryRediscoveryTraceDiagnostic {
  considered: boolean;
  executed: boolean;
  skipReason: string | null;
  missingCapability: string | null;
  rediscoveryQuery: string | null;
  capabilityLooksLikeSearchNeed: boolean;
  allowSearchFallbackOnElapsedCap: boolean;
  searchFallbackUsed: boolean;
  preRediscoveryBudgetReasonCode: string | null;
  candidateSearchResults: QueryDeveloperTraceToolSelection[];
  selectedAlternatives: QueryDeveloperTraceToolSelection[];
  mergedTools: QueryDeveloperTraceToolSelection[];
  usingPaidFallback: boolean;
  branchPlan: QueryPlanningTraceDiagnostic | null;
}

export interface QueryCompletenessRepairEvent {
  attempt: number;
  outcome:
    | "attempted"
    | "skipped_by_guardrail"
    | "skipped_no_retry_budget"
    | "skipped_needs_different_tools"
    | "skipped_no_retry_path"
    | "patch_failed"
    | "replan_failed"
    | "patched"
    | "replanned";
  semanticRetryCount: number;
  maxSemanticRetries: number;
  strategy: "patch" | "replan" | null;
  summary: string | null;
  failReason: string | null;
  requestedReplan: boolean;
  hadSyntaxFix: boolean;
  editCount: number | null;
  skipReason: string | null;
  boundedAnswerReason:
    | "retry_guardrail_same_endpoint_fanout"
    | "retry_guardrail_upstream_abort"
    | null;
  blockingDiagnostics: Array<{
    code: string;
    severity: string;
    message: string;
  }>;
}

/**
 * Rich developer-trace diagnostics for managed query-runtime internals.
 */
export interface QueryDeveloperTraceDiagnostics {
  selection: {
    selectedPolicy: string;
    debugScoutDeepMode: string | null;
    plannerReasoningStage: string;
    scoutEnabled: boolean;
    oneShotBias: boolean;
    candidateMethodCount: number;
    scoutProbeStatus: string;
    scoutProbeAdequacy: string;
    scoutProbeConfidence: number;
    scoutMetadataConfidence: number;
    scoutProbeQuerySafeCandidateCount: number;
    scoutProbeRankedMethodCount: number;
    scoutProbeAmbiguityPoolCount: number;
    scoutProbeShortlistedMethodCount: number;
    scoutProbeMissingCapability: string | null;
    scoutPrePlanProbeCalls: number;
    scoutPrePlanProbeBudgetReasonCode: string | null;
    scoutChangedInitialPlan: boolean;
    scoutChangedPlannerReasoningStage: boolean;
    scoutInitialSelectedPolicy: string;
    scoutInitialPlannerReasoningStage: string;
    scoutInitialReasonCode: string;
    scoutFinalReasonCode: string;
    scoutEvidenceAttachedToPlanning: boolean;
    scoutLlmSelectionUsed: boolean;
    scoutLlmSelectionFallback: boolean;
    scoutLlmSelectionLatencyMs: number | null;
    selectedTools: QueryDeveloperTraceToolSelection[];
  };
  executionContract?: QueryPlanningTraceDiagnostic;
  cost?: {
    planningCostUsd: number;
    initialExecutionCostUsd: number;
    rediscoveryAdditionalCostUsd: number;
    synthesisCostUsd: number;
    totalModelCostUsd: number;
    toolCostUsd: number;
    totalChargedUsd: number;
  };
  verification: {
    evaluations: unknown[];
    repairEvents: QueryCompletenessRepairEvent[];
    triggerNeedsDifferentTools: boolean;
    triggerMissingCapability: string | null;
  };
  execution?: {
    reasoningEnabled: boolean;
    receivedReasoning: boolean;
    reasoningChars: number;
    scoutEvidenceInjected: boolean;
    stepBudget: number;
    completedStepCount: number;
    toolCallCount?: number;
    toolRegistry?: Omit<QueryGroundingSummary, "toolCallCount" | "grounded">;
  };
  contributorSearches?: ContributorSearchTraceRecord[];
  [key: string]: unknown;
}

/**
 * A single developer-trace timeline step.
 */
export interface QueryDeveloperTraceStep {
  stepType?: string;
  event?: string;
  status?: string;
  message?: string;
  timestampMs?: number;
  tool?: QueryDeveloperTraceToolRef;
  attempt?: number;
  loop?: QueryDeveloperTraceLoopInfo;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Aggregate counters that summarize developer-trace behavior.
 */
export interface QueryDeveloperTraceSummary {
  toolCalls?: number;
  retryCount?: number;
  selfHealCount?: number;
  fallbackCount?: number;
  failureCount?: number;
  recoveryCount?: number;
  completionChecks?: number;
  loopCount?: number;
  [key: string]: unknown;
}

/**
 * Full tool call record (untruncated) for debugging.
 */
export interface QueryDeveloperTraceToolCall {
  toolId?: string;
  toolName: string;
  args?: unknown;
  result: unknown;
}

/**
 * MCP method schema exposed in the developer trace.
 */
export interface QueryDeveloperTraceToolSchema {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/**
 * Developer Mode trace payload returned per query response (opt-in).
 */
export interface QueryDeveloperTrace {
  summary?: QueryDeveloperTraceSummary;
  timeline?: QueryDeveloperTraceStep[];
  requestId?: string;
  query?: string;
  source?: string;
  diagnostics?: QueryDeveloperTraceDiagnostics;
  initialCode?: string;
  finalCode?: string;
  executionTrace?: unknown[];
  executionProgram?: unknown;
  attemptCount?: number;
  executionSuccess?: boolean;
  executionResult?: unknown;
  toolCallHistory?: QueryDeveloperTraceToolCall[];
  toolSchemas?: QueryDeveloperTraceToolSchema[];
  [key: string]: unknown;
}

/**
 * Information about a tool that was used during a query response
 */
export interface QueryToolUsage {
  /** Tool ID */
  id: string;

  /** Tool name */
  name: string;

  /** Number of MCP skill calls made for this tool */
  skillCalls: number;
}

/**
 * Cost breakdown for a query response.
 * All values are strings representing USD amounts.
 */
export interface QueryCost {
  /** AI model inference cost */
  modelCostUsd: string;

  /** Sum of all tool fees */
  toolCostUsd: string;

  /** Total cost (model + tools) */
  totalCostUsd: string;
}

/**
 * High-level orchestration outcome metrics returned by the query API.
 */
export interface QueryOrchestrationMetrics {
  parityStage: string;
  orchestrationMode: string;
  /** Whether the first plan path succeeded without fallback. */
  firstPassSuccess: boolean;
  /** Whether execution signaled a missing capability on first pass. */
  capabilityMissSignaled: boolean;
  /** Whether bounded rediscovery/fallback executed. */
  rediscoveryExecuted: boolean;
}

export interface QueryAttemptReference {
  sessionId: string;
  attemptId: string;
}

/** Public fork handle for creating a new attempt from a prior Query session. */
export interface QueryForkReference extends QueryAttemptReference {
  reason?: QueryAttemptForkReason;
}

/**
 * Public continuation state returned by headless Query responses.
 * Internal selected-tool lineage remains durable server state but is not
 * exposed as chat-style payloads.
 */
export interface QuerySessionState {
  sessionId: string;
  attemptId: string;
  parentAttemptId: string | null;
  rootAttemptId: string;
  mode: "initial" | "resume" | "fork";
  origin: "initial_request" | "resume" | "fork";
  status: "active" | "completed" | "failed" | "aborted";
  checkpoint: {
    currentStage: string | null;
    latestCheckpointArtifactId: string | null;
    canonicalDatasetId: string | null;
    executionProgramCurrentRevisionId: string | null;
  };
}

export interface QueryResponseEnvelopeFact {
  id: string;
  label: string;
  path: string | null;
  relevanceScore: number | null;
  value: unknown;
}

export interface QueryResponseEnvelopeSourceRef {
  id: string;
  provider: string | null;
  dataset: string | null;
  observedAt: string | null;
  publishedAt: string | null;
  artifactRef: string | null;
  url: string | null;
  note: string | null;
}

export type QueryResponseEnvelopeTone =
  | "positive"
  | "negative"
  | "neutral"
  | "caution";

export type QueryControllerStopReason =
  | "complete_answer"
  | "bounded_runtime_budget"
  | "bounded_same_endpoint_guardrail"
  | "bounded_upstream_abort_guardrail"
  | "capability_miss";

export type QueryControllerIssueClass =
  | "missing_evidence"
  | "missing_capability"
  | "stale_data"
  | "wrong_tool_path";

export type QueryControllerAction =
  | "inspect_current_grounding"
  | "patch_current_program"
  | "bounded_rediscovery"
  | "return_capability_miss"
  | "return_bounded_answer"
  | "return_complete_answer";

export interface QueryResponseEnvelopeMarketAggregateFlow {
  netFlowUsd: number | null;
  grossInflowUsd: number | null;
  grossOutflowUsd: number | null;
  nativeNetFlow: number | null;
  nativeUnit: string | null;
  direction: "inflow" | "outflow" | "flat" | "mixed";
}

export interface QueryResponseEnvelopeMarketVenueBreakdown {
  venue: string;
  asset: string | null;
  netFlowUsd: number | null;
  grossInflowUsd: number | null;
  grossOutflowUsd: number | null;
  nativeNetFlow: number | null;
  nativeUnit: string | null;
  shareOfTotal: number | null;
  rank: number | null;
}

export interface QueryResponseEnvelopeCatalystRef {
  source: string;
  publishedAt: string | null;
  claim: string | null;
  relationToFlow: string | null;
  url: string | null;
}

export interface QueryResponseEnvelopeDerivativesContext {
  openInterestDirection: string | null;
  openInterestChangePct: number | null;
  liquidationBias: string | null;
  venues: string[];
  relationshipToSpotFlows: string | null;
}

export interface QueryResponseEnvelopeMarketIntelligence {
  asset: string | null;
  assets: string[] | null;
  timeWindow: string | null;
  asOf: string | null;
  aggregateFlow: QueryResponseEnvelopeMarketAggregateFlow | null;
  venueBreakdown: QueryResponseEnvelopeMarketVenueBreakdown[];
  catalystRefs: QueryResponseEnvelopeCatalystRef[];
  derivativesContext: QueryResponseEnvelopeDerivativesContext | null;
}

export interface QueryResponseEnvelopeViewMetric {
  label: string;
  value: string;
  tone?: QueryResponseEnvelopeTone;
}

export interface QueryResponseEnvelopeViewRow {
  key: string;
  cells: string[];
  tone?: QueryResponseEnvelopeTone;
  sourceRefIds?: string[];
}

export interface QueryResponseEnvelope {
  responseShape: QueryResponseShape;
  response: string;
  summary: string;
  outcome: {
    label: string;
    tone: QueryResponseEnvelopeTone;
    stopReason: QueryControllerStopReason;
    issueClass: QueryControllerIssueClass | null;
  };
  controller: {
    scope: "wedge" | "standard";
    nextAction: QueryControllerAction;
    actionsTaken: QueryControllerAction[];
    patchFirstProgramPreserved: boolean;
    executionProgramRevisionId: string | null;
    hardBudgetApplied: boolean;
  } | null;
  evidence: {
    facts: QueryResponseEnvelopeFact[];
    sourceRefs: QueryResponseEnvelopeSourceRef[];
    assumptions: string[];
    knownUnknowns: string[];
    retrievalPlanReasonCodes: string[];
    marketIntelligence?: QueryResponseEnvelopeMarketIntelligence | null;
  };
  artifacts: {
    dataUrl: string | null;
    canonicalDataRef: {
      datasetId: string;
      hash: string;
      bytes: number;
      publicDataUrl: string | null;
    } | null;
    stageArtifactKinds: string[];
  };
  view: {
    type: QueryResponseEnvelopeViewType;
    label: string;
    title?: string | null;
    metrics?: QueryResponseEnvelopeViewMetric[];
    columns?: string[];
    rows?: QueryResponseEnvelopeViewRow[];
  } | null;
  freshness: {
    asOf: string | null;
    sourceTimestamps: string[];
    note: string;
  };
  confidence: {
    level: "high" | "medium" | "low";
    reason: string;
    verifiedFactCount: number;
    inferredFactCount: number;
    gapCount: number;
    gapSignals: Array<{
      code: string;
      severity: string;
      detail: string;
    }>;
  };
  usage: {
    durationMs: number;
    cost: QueryCost;
    toolsUsed: QueryToolUsage[];
    outcomeType: QueryOutcomeType;
    orchestrationMetrics?: QueryOrchestrationMetrics;
  };
}

export interface QueryBaseResult {
  /** The answer text or machine-friendly summary returned for this query. */
  response: string;

  /** Tools that were used to answer the query */
  toolsUsed: QueryToolUsage[];

  /** Cost breakdown */
  cost: QueryCost;

  /** Total duration in milliseconds */
  durationMs: number;

  /**
   * Bounded execution data from tools.
   * Returned only when `includeData` is true. Small payloads may be returned
   * directly; large payloads are returned as a truncation object with a
   * structured preview and `fullData.dataUrl`/`canonicalDataRef`.
   */
  data?: unknown;

  /** Optional blob URL for persisted execution data (when includeDataUrl=true) */
  dataUrl?: string;

  /** Optional derived artifacts emitted by code_interpreter in answer mode. */
  computedArtifacts?: QueryComputedArtifact[];

  /** Public grounding summary for marketplace tool execution. */
  grounding?: QueryGroundingSummary;

  /** Optional machine-readable Developer Mode trace payload */
  developerTrace?: QueryDeveloperTrace;

  /** Optional orchestration outcome metrics for benchmarking and rollout analysis */
  orchestrationMetrics?: QueryOrchestrationMetrics;

  /** Typed public stop reason for the final outcome. */
  stopReason?: QueryControllerStopReason;

  /** Typed issue class exposed by the bounded controller contract. */
  issueClass?: QueryControllerIssueClass | null;

  /** Ordered public controller actions taken before the final outcome. */
  actionsTaken?: QueryControllerAction[];

  /** Optional controller summary for bounded wedge-style answers. */
  controller?: QueryResponseEnvelope["controller"];

  /**
   * Optional public durable continuation handles for resume/fork flows.
   * Query exposes handle-based continuation, not chat-style continuation payloads.
   */
  querySession?: QuerySessionState;
}

/**
 * The resolved result of a pay-per-response query
 */
export type QueryResult =
  | (QueryBaseResult &
      Partial<QueryResponseEnvelope> & {
      outcomeType: "answer";
      assumptionMade?: QueryAssumptionMetadata;
    })
  | (QueryBaseResult & {
      outcomeType: "capability_miss";
      capabilityMiss: QueryCapabilityMissPayload;
    });

/**
 * Successful response from the /api/v1/query endpoint
 */
export type QueryApiSuccessResponse = { success: true } & QueryResult;

/**
 * Raw API response from the query endpoint
 */
export type QueryApiResponse = QueryApiSuccessResponse | ExecuteApiErrorResponse;

export type QueryJobStatus = "queued" | "running" | "completed" | "failed";

export interface QueryJobStartResult {
  status: QueryJobStatus;
  jobId: string;
  pollingTool?: string;
  message?: string;
  progress?: unknown;
  querySession?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface QueryJobStatusResult {
  status: QueryJobStatus;
  jobId: string;
  progress?: unknown;
  querySession?: unknown;
  result: QueryResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface QueryPollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Query stream event types
// ---------------------------------------------------------------------------

/** Emitted when a tool starts or changes execution status */
export interface QueryStreamToolStatusEvent {
  type: "tool-status";
  tool: { id: string; name: string };
  status: string;
}

/** Emitted for each chunk of the AI response text */
export interface QueryStreamTextDeltaEvent {
  type: "text-delta";
  delta: string;
}

/** Emitted when the server streams developer trace updates/chunks */
export interface QueryStreamDeveloperTraceEvent {
  type: "developer-trace";
  trace: QueryDeveloperTrace;
}

/** Emitted when the full response is complete */
export interface QueryStreamDoneEvent {
  type: "done";
  result: QueryResult;
}

/** Emitted when the server reports a recoverable or terminal query error */
export interface QueryStreamErrorEvent {
  type: "error";
  error: string;
  code?: ContextErrorCode | string;
  scope?: string;
  reasonCode?: string;
  outcomeType?: Exclude<QueryOutcomeType, "answer">;
  capabilityMiss?: QueryCapabilityMissPayload;
  querySession?: QuerySessionState;
}

/**
 * Union of all events emitted during a streaming query
 */
export type QueryStreamEvent =
  | QueryStreamToolStatusEvent
  | QueryStreamTextDeltaEvent
  | QueryStreamDeveloperTraceEvent
  | QueryStreamDoneEvent
  | QueryStreamErrorEvent;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Specific error codes returned by the Context Protocol API
 */
export type ContextErrorCode =
  | "unauthorized"
  | "no_wallet"
  | "insufficient_allowance"
  | "payment_failed"
  | "execution_failed"
  | "query_failed"
  | "invalid_tool_method"
  | "method_not_execute_eligible"
  | "invalid_max_spend"
  | "wallet_link_required"
  | "action_requires_signature"
  | "session_not_found"
  | "session_forbidden"
  | "session_closed"
  | "session_expired"
  | "max_spend_mismatch"
  | "session_budget_exceeded";

/**
 * Error thrown by the Context Protocol client
 */
export class ContextError extends Error {
  constructor(
    message: string,
    public readonly code?: ContextErrorCode | string,
    public readonly statusCode?: number,
    public readonly helpUrl?: string
  ) {
    super(message);
    this.name = "ContextError";
    Object.setPrototypeOf(this, ContextError.prototype);
  }
}
