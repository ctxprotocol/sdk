import type { ContributorSearchTraceRecord } from "../contrib/search/types.js";

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

  /** Optional human-readable notes for planning */
  notes?: string;
}

export type DiscoveryMode = "query" | "execute";
export type McpToolSurface = "answer" | "execute" | "both";
export type McpToolLatencyClass = "instant" | "fast" | "slow" | "streaming";

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

  /** Declared latency class for planner/runtime gating */
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
   * Optional planner/runtime pacing hints.
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

/** Supported orchestration depth modes for query execution. */
export type QueryDepth = "fast" | "auto" | "deep";
export type QueryDeepMode = "deep" | "deep-light" | "deep-heavy";
export type QueryClarificationPolicy = "return" | "auto" | "error";
export type QueryOutcomeType =
  | "answer"
  | "clarification_required"
  | "capability_miss";
export type QueryResponseShape =
  | "answer"
  | "answer_with_evidence"
  | "evidence_only";
export type QueryResponseEnvelopeViewType =
  | "table"
  | "leaderboard"
  | "heatmap"
  | "timeseries";

export interface QueryClarificationOption {
  id: string;
  toolId: string;
  toolName: string;
  methodName: string;
  label: string;
  description: string;
  fitScore: number;
  recommended: boolean;
}

export interface QueryClarificationPayload {
  question: string;
  options: QueryClarificationOption[];
  allowFreeform: boolean;
  recommendedOptionId: string;
  originalQuery: string;
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

export type QueryClarificationDecisionReasonCode =
  | "rollout_disabled"
  | "no_grounded_candidates"
  | "single_grounded_interpretation"
  | "required_discriminator_ambiguity"
  | "contract_scope_ambiguity"
  | "cost_or_latency_ambiguity"
  | "semantic_scope_ambiguity"
  | "capability_miss";

export type QueryAttemptForkReason =
  | "manual_fork"
  | "clarification_branch"
  | "bounded_rediscovery"
  | "resume_replay"
  | "patch_retry"
  | "unknown";

export interface QueryClarificationEvidenceSources {
  usesMethodSchemas: boolean;
  usesProbeArgs: boolean;
  usesMethodMetadata: boolean;
  usesToolSelectionContext: boolean;
  usesLlmSelection: boolean;
}

export interface QueryClarificationCandidateSummary {
  optionId: string;
  fitScore: number;
  llmRelevanceScore: number | null;
  requiredParams: string[];
  unresolvedRequiredParams: string[];
  probeArgKeys: string[];
  inputFieldNames: string[];
  outputKeys: string[];
  latencyClass: string;
  executePriceUsd: string | null;
  queryEligible: boolean;
}

export interface QueryClarificationDiagnostics {
  orchestrationMode: string;
  rolloutStage: string;
  shadowMode: boolean;
  policy: QueryClarificationPolicy;
  outcomeType: QueryOutcomeType;
  triggered: boolean;
  optionCount: number;
  candidateCount: number;
  viableCandidateCount: number;
  recommendedOptionId: string | null;
  recommendedOptionReason: string | null;
  autoResolved: boolean;
  autoSelectEnabled: boolean;
  assumptionMade: QueryAssumptionMetadata | null;
  missingCapability: string | null;
  decisionReasonCode: QueryClarificationDecisionReasonCode;
  decisionSignals: string[];
  evidenceSources: QueryClarificationEvidenceSources;
  comparedOptionIds: string[];
  decisionStrategy: "deterministic" | "llm_primary";
  judgeAttempted: boolean;
  judgeApplied: boolean;
  judgeOutcomeType: QueryOutcomeType | null;
  judgeConfidence: number | null;
  judgeReason: string | null;
  judgeError: string | null;
  validatorReason: string | null;
  fallbackReason: string | null;
  copyStrategy: "deterministic" | "llm_rewritten";
  rewriteAttempted: boolean;
  rewriteApplied: boolean;
  rewriteError: string | null;
  candidateSummaries: QueryClarificationCandidateSummary[];
}

/**
 * Options for the agentic query endpoint (pay-per-response).
 *
 * Unlike `execute()` which calls a single tool once, `query()` sends a
 * natural-language question and lets the server handle discovery-first
 * orchestration (`discover/probe -> plan-from-evidence -> execute ->
 * bounded fallback`) plus synthesis.
 * One flat fee covers up to 100 MCP skill calls per tool.
 */
export interface QueryOptions {
  /** The natural-language question to answer */
  query: string;

  /**
   * How the SDK should handle clarification-required pre-plan situations:
   * - `return`: surface a structured clarification result to the caller
   * - `auto`: enable clarification auto-select and continue with the server's deterministic recommended option
   * - `error`: turn structured clarification/capability outcomes into terminal errors
   */
  clarificationPolicy?: QueryClarificationPolicy;

  /**
   * Optional tool IDs to use. When omitted the server discovers tools
   * automatically (Auto Mode). When provided, only these tools are used
   * (Manual Mode).
   */
  tools?: string[];

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
   * Optional answer model ID for final synthesis.
   * Supported IDs are published by the Context API. Ignored when
   * `responseShape` is `evidence_only` because synthesis is skipped.
   */
  answerModelId?: string;

  /**
   * Structured response mode for query answers.
   * - `answer`: backward-compatible natural-language answer
   * - `answer_with_evidence`: prose answer plus a structured evidence package
   * - `evidence_only`: structured evidence package with a machine-friendly summary
   */
  responseShape?: QueryResponseShape;

  /**
   * Include execution data inline in the query response.
   * Useful for headless agents that need raw structured outputs.
   * Handshake completion remains a chat-only flow today; raw execution data
   * is not a typed resume/callback contract for approvals.
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
   * for lane selection, scout probe adequacy, and bounded fallback behavior.
   */
  includeDeveloperTrace?: boolean;

  /**
   * Query orchestration depth mode:
   * - `fast`: lower-latency path
   * - `auto`: server decides between fast/deep
   * - `deep`: full completeness-oriented path
   */
  queryDepth?: QueryDepth;

  /**
   * Development/testing only: force the server's internal deep lane.
   * `deep` is the canonical value. Legacy `deep-light` / `deep-heavy`
   * aliases are still accepted temporarily for compatibility and normalize
   * to the same runtime lane. Invalid when `queryDepth` is `fast`.
   */
  debugScoutDeepMode?: QueryDeepMode;

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
 * Tool selection metadata attached to discovery/planning diagnostics.
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
 * Initial planner diagnostic details.
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
 * Rich developer-trace diagnostics for discovery-first orchestration internals.
 */
export interface QueryDeveloperTraceDiagnostics {
  selection: {
    selectedDepth: string;
    deepMode: string | null;
    debugScoutDeepMode: string | null;
    plannerReasoningStage: string;
    scoutEnabled: boolean;
    preserveFastOneShot: boolean;
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
    scoutInitialSelectedDepth: string;
    scoutInitialDeepMode: string | null;
    scoutInitialPlannerReasoningStage: string;
    scoutInitialReasonCode: string;
    scoutFinalReasonCode: string;
    scoutEvidenceAttachedToPlanning: boolean;
    scoutLlmSelectionUsed: boolean;
    scoutLlmSelectionFallback: boolean;
    scoutLlmSelectionLatencyMs: number | null;
    selectedTools: QueryDeveloperTraceToolSelection[];
  };
  planning: {
    initial: QueryPlanningTraceDiagnostic;
  };
  cost?: {
    planningCostUsd: number;
    initialExecutionCostUsd: number;
    rediscoveryAdditionalCostUsd: number;
    synthesisCostUsd: number;
    totalModelCostUsd: number;
    toolCostUsd: number;
    totalChargedUsd: number;
  };
  completeness: {
    evaluations: unknown[];
    repairEvents: QueryCompletenessRepairEvent[];
    triggerNeedsDifferentTools: boolean;
    triggerMissingCapability: string | null;
  };
  rediscovery: QueryRediscoveryTraceDiagnostic | null;
  clarification?: QueryClarificationDiagnostics;
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
 * Developer Mode trace payload returned per query response (opt-in).
 */
export interface QueryDeveloperTrace {
  summary?: QueryDeveloperTraceSummary;
  timeline?: QueryDeveloperTraceStep[];
  requestId?: string;
  query?: string;
  source?: string;
  diagnostics?: QueryDeveloperTraceDiagnostics;
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
 * Internal selected-tool lineage, Scout reuse, and clarification snapshots
 * remain durable server state but are not exposed as chat-style payloads.
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

export interface QueryResponseEnvelope {
  responseShape: Exclude<QueryResponseShape, "answer">;
  response: string;
  summary: string;
  evidence: {
    facts: QueryResponseEnvelopeFact[];
    sourceRefs: QueryResponseEnvelopeSourceRef[];
    assumptions: string[];
    knownUnknowns: string[];
    retrievalPlanReasonCodes: string[];
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

  /** Optional execution data from tools (when includeData=true) */
  data?: unknown;

  /** Optional blob URL for persisted execution data (when includeDataUrl=true) */
  dataUrl?: string;

  /** Optional machine-readable Developer Mode trace payload */
  developerTrace?: QueryDeveloperTrace;

  /** Optional orchestration outcome metrics for benchmarking and rollout analysis */
  orchestrationMetrics?: QueryOrchestrationMetrics;

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
      outcomeType: "clarification_required";
      clarification: QueryClarificationPayload;
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
  clarification?: QueryClarificationPayload;
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
