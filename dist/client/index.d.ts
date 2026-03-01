/**
 * Configuration options for initializing the ContextClient
 */
interface ContextClientOptions {
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
interface McpToolRateLimitHints {
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
type DiscoveryMode = "query" | "execute";
type McpToolSurface = "answer" | "execute" | "both";
type McpToolLatencyClass = "instant" | "fast" | "slow" | "streaming";
interface McpToolPricingMeta {
    executeUsd?: string;
    queryUsd?: string;
    [key: string]: unknown;
}
interface McpToolMeta {
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
interface StructuredMethodGuidanceHints {
    /** Suggested call-order sequence extracted from method descriptions */
    callOrderHints?: string[];
    /** Parameter usage caveats extracted from method descriptions */
    parameterCaveats?: string[];
    /** Edge-case behavior notes extracted from method descriptions */
    edgeCaseNotes?: string[];
}
interface McpTool {
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
interface Tool {
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
interface SearchResponse {
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
interface SearchOptions {
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
interface ExecuteOptions {
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
type ExecuteSessionStatus = "open" | "closed" | "expired";
interface ExecuteSessionSpend {
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
interface ExecuteApiSuccessResponse {
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
interface ExecuteApiErrorResponse {
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
type ExecuteApiResponse = ExecuteApiSuccessResponse | ExecuteApiErrorResponse;
interface ExecuteSessionStartOptions {
    /** Maximum spend budget for the session (USD string) */
    maxSpendUsd: string;
}
interface ExecuteSessionApiSuccessResponse {
    success: true;
    mode: "execute";
    session: ExecuteSessionSpend;
}
type ExecuteSessionApiResponse = ExecuteSessionApiSuccessResponse | ExecuteApiErrorResponse;
interface ExecuteSessionResult {
    mode: "execute";
    session: ExecuteSessionSpend;
}
/**
 * The resolved result returned to the user after SDK processing
 */
interface ExecutionResult<T = unknown> {
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
/** Supported orchestration depth modes for query execution. */
type QueryDepth = "fast" | "auto" | "deep";
/**
 * Options for the agentic query endpoint (pay-per-response).
 *
 * Unlike `execute()` which calls a single tool once, `query()` sends a
 * natural-language question and lets the server handle tool discovery,
 * multi-tool orchestration, self-healing retries, and AI synthesis.
 * One flat fee covers up to 100 MCP skill calls per tool.
 */
interface QueryOptions {
    /** The natural-language question to answer */
    query: string;
    /**
     * Optional tool IDs to use. When omitted the server discovers tools
     * automatically (Auto Mode). When provided, only these tools are used
     * (Manual Mode).
     */
    tools?: string[];
    /**
     * Optional model ID for query orchestration/synthesis.
     * Supported IDs are published by the Context API.
     */
    modelId?: string;
    /**
     * Include execution data inline in the query response.
     * Useful for headless agents that need raw structured outputs.
     */
    includeData?: boolean;
    /**
     * Persist execution data to Vercel Blob and return a download URL.
     * Useful for large payload workflows where inline JSON is not ideal.
     */
    includeDataUrl?: boolean;
    /**
     * Include machine-readable developer trace output for this query response.
     * When enabled, the server may return timeline data describing retries,
     * fallbacks, loop checks, and intermediate recovery behavior.
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
     * Optional idempotency key (UUID recommended).
     * Reuse the same key when retrying the same logical request.
     */
    idempotencyKey?: string;
}
/**
 * Tool reference attached to developer trace timeline steps.
 */
interface QueryDeveloperTraceToolRef {
    id?: string;
    name?: string;
    method?: string;
    [key: string]: unknown;
}
/**
 * Loop metadata attached to developer trace timeline steps.
 */
interface QueryDeveloperTraceLoopInfo {
    name?: string;
    iteration?: number;
    maxIterations?: number;
    [key: string]: unknown;
}
/**
 * A single developer-trace timeline step.
 */
interface QueryDeveloperTraceStep {
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
interface QueryDeveloperTraceSummary {
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
interface QueryDeveloperTrace {
    summary?: QueryDeveloperTraceSummary;
    timeline?: QueryDeveloperTraceStep[];
    [key: string]: unknown;
}
/**
 * Information about a tool that was used during a query response
 */
interface QueryToolUsage {
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
interface QueryCost {
    /** AI model inference cost */
    modelCostUsd: string;
    /** Sum of all tool fees */
    toolCostUsd: string;
    /** Total cost (model + tools) */
    totalCostUsd: string;
}
/**
 * The resolved result of a pay-per-response query
 */
interface QueryResult {
    /** The AI-synthesized response text */
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
}
/**
 * Successful response from the /api/v1/query endpoint
 */
interface QueryApiSuccessResponse {
    success: true;
    response: string;
    toolsUsed: QueryToolUsage[];
    cost: QueryCost;
    durationMs: number;
    data?: unknown;
    dataUrl?: string;
    developerTrace?: QueryDeveloperTrace;
}
/**
 * Raw API response from the query endpoint
 */
type QueryApiResponse = QueryApiSuccessResponse | ExecuteApiErrorResponse;
/** Emitted when a tool starts or changes execution status */
interface QueryStreamToolStatusEvent {
    type: "tool-status";
    tool: {
        id: string;
        name: string;
    };
    status: string;
}
/** Emitted for each chunk of the AI response text */
interface QueryStreamTextDeltaEvent {
    type: "text-delta";
    delta: string;
}
/** Emitted when the server streams developer trace updates/chunks */
interface QueryStreamDeveloperTraceEvent {
    type: "developer-trace";
    trace: QueryDeveloperTrace;
}
/** Emitted when the full response is complete */
interface QueryStreamDoneEvent {
    type: "done";
    result: QueryResult;
}
/**
 * Union of all events emitted during a streaming query
 */
type QueryStreamEvent = QueryStreamToolStatusEvent | QueryStreamTextDeltaEvent | QueryStreamDeveloperTraceEvent | QueryStreamDoneEvent;
/**
 * Specific error codes returned by the Context Protocol API
 */
type ContextErrorCode = "unauthorized" | "no_wallet" | "insufficient_allowance" | "payment_failed" | "execution_failed" | "query_failed" | "invalid_tool_method" | "method_not_execute_eligible" | "invalid_max_spend" | "session_not_found" | "session_forbidden" | "session_closed" | "session_expired" | "max_spend_mismatch" | "session_budget_exceeded";
/**
 * Error thrown by the Context Protocol client
 */
declare class ContextError extends Error {
    readonly code?: (ContextErrorCode | string) | undefined;
    readonly statusCode?: number | undefined;
    readonly helpUrl?: string | undefined;
    constructor(message: string, code?: (ContextErrorCode | string) | undefined, statusCode?: number | undefined, helpUrl?: string | undefined);
}

/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
declare class Discovery {
    private client;
    constructor(client: ContextClient);
    /**
     * Search for tools matching a query string.
     *
     * Backward-compatible signatures:
     * - `search("gas prices", 10)`
     * - `search({ query: "gas prices", limit: 10, mode: "execute" })`
     */
    search(query: string, limit?: number): Promise<Tool[]>;
    search(options: SearchOptions): Promise<Tool[]>;
    /**
     * Get featured/popular tools (empty query search)
     *
     * @param limit - Maximum number of results (1-50, default 10)
     * @returns Array of featured tools
     *
     * @example
     * ```typescript
     * const featured = await client.discovery.getFeatured(5);
     * ```
     */
    getFeatured(limit?: number, options?: Omit<SearchOptions, "query" | "limit">): Promise<Tool[]>;
}

/**
 * Tools resource for executing tools on the Context Protocol marketplace
 */
declare class Tools {
    private client;
    constructor(client: ContextClient);
    /**
     * Execute a tool with the provided arguments
     *
     * @param options - Execution options
     * @param options.toolId - The UUID of the tool (from search results)
     * @param options.toolName - The specific MCP tool method to call (from tool's mcpTools array)
     * @param options.args - Arguments to pass to the tool
     * @returns The execution result with the tool's output data
     *
     * @throws {ContextError} With code `no_wallet` if wallet not set up
     * @throws {ContextError} With code `insufficient_allowance` if spending cap not set
     * @throws {ContextError} With code `payment_failed` if payment settlement fails
     * @throws {ContextError} With code `execution_failed` if tool execution fails
     *
     * @example
     * ```typescript
     * // First, search for a tool
     * const tools = await client.discovery.search("gas prices");
     * const tool = tools[0];
     *
     * // Execute a specific method from the tool's mcpTools
     * const result = await client.tools.execute({
     *   toolId: tool.id,
     *   toolName: tool.mcpTools[0].name, // e.g., "get_gas_prices"
     *   args: { chainId: 1 }
     * });
     *
     * console.log(result.result); // The tool's output
     * console.log(result.durationMs); // Execution time
     * ```
     */
    execute<T = unknown>(options: ExecuteOptions): Promise<ExecutionResult<T>>;
    /**
     * Start an execute session with a max spend budget.
     */
    startSession(options: ExecuteSessionStartOptions): Promise<ExecuteSessionResult>;
    /**
     * Fetch current execute session status by ID.
     */
    getSession(sessionId: string): Promise<ExecuteSessionResult>;
    /**
     * Close an execute session by ID.
     */
    closeSession(sessionId: string): Promise<ExecuteSessionResult>;
    private resolveSessionLifecycleResponse;
}

/**
 * Query resource for pay-per-response agentic queries.
 *
 * Unlike `tools.execute()` which calls a single tool once (pay-per-request),
 * the Query resource sends a natural-language question and lets the server
 * handle tool discovery, multi-tool orchestration, self-healing retries,
 * completeness checks, and AI synthesis — all for one flat fee.
 *
 * This is the "prepared meal" vs "raw ingredients" distinction:
 * - `tools.execute()` = raw data, full control, predictable cost
 * - `query.run()` / `query.stream()` = curated intelligence, one payment
 */
declare class Query {
    private client;
    constructor(client: ContextClient);
    private buildSyntheticTraceFromRunResult;
    private buildSyntheticTraceFromStreamStatus;
    private mergeDeveloperTrace;
    private parseStreamEvent;
    /**
     * Run an agentic query and wait for the full response.
     *
     * The server discovers relevant tools (or uses the ones you specify),
     * executes the full agentic pipeline (up to 100 MCP calls per tool),
     * and returns an AI-synthesized answer. Payment is settled after
     * successful execution via deferred settlement.
     *
     * @param options - Query options or a plain string question
     * @returns The complete query result with response text, tools used, and cost
     *
     * @throws {ContextError} With code `no_wallet` if wallet not set up
     * @throws {ContextError} With code `insufficient_allowance` if spending cap not set
     * @throws {ContextError} With code `payment_failed` if payment settlement fails
     * @throws {ContextError} With code `execution_failed` if the agentic pipeline fails
     *
     * @example
     * ```typescript
     * // Simple question — server discovers tools automatically
     * const answer = await client.query.run("What are the top whale movements on Base?");
     * console.log(answer.response);      // AI-synthesized answer
     * console.log(answer.toolsUsed);     // Which tools were used
     * console.log(answer.cost);          // Cost breakdown
     *
     * // With specific tools (Manual Mode)
     * const answer = await client.query.run({
     *   query: "Analyze whale activity",
     *   tools: ["tool-uuid-1", "tool-uuid-2"],
     * });
     * ```
     */
    run(options: QueryOptions | string): Promise<QueryResult>;
    /**
     * Run an agentic query with streaming. Returns an async iterable that
     * yields events as the server processes the query in real-time.
     *
     * Event types:
     * - `tool-status` — A tool started executing or changed status
     * - `text-delta` — A chunk of the AI response text
     * - `developer-trace` — Runtime trace metadata (when includeDeveloperTrace=true)
     * - `done` — The full response is complete (includes final `QueryResult`)
     *
     * @param options - Query options or a plain string question
     * @returns An async iterable of stream events
     *
     * @example
     * ```typescript
     * for await (const event of client.query.stream("What are the top whale movements?")) {
     *   switch (event.type) {
     *     case "tool-status":
     *       console.log(`Tool ${event.tool.name}: ${event.status}`);
     *       break;
     *     case "text-delta":
     *       process.stdout.write(event.delta);
     *       break;
     *     case "developer-trace":
     *       console.log("Trace summary:", event.trace.summary);
     *       break;
     *     case "done":
     *       console.log("\nCost:", event.result.cost.totalCostUsd);
     *       break;
     *   }
     * }
     * ```
     */
    stream(options: QueryOptions | string): AsyncGenerator<QueryStreamEvent>;
}

/**
 * The official TypeScript client for the Context Protocol.
 *
 * Use this client to discover and execute AI tools programmatically.
 *
 * @example
 * ```typescript
 * import { ContextClient } from "@contextprotocol/client";
 *
 * const client = new ContextClient({
 *   apiKey: "sk_live_..."
 * });
 *
 * // Pay-per-request: Execute a specific tool
 * const result = await client.tools.execute({
 *   toolId: "tool-uuid",
 *   toolName: "get_gas_prices",
 *   args: { chainId: 1 }
 * });
 *
 * // Pay-per-response: Ask a question, get a curated answer
 * const answer = await client.query.run("What are the top whale movements on Base?");
 * console.log(answer.response);
 * ```
 */
declare class ContextClient {
    private readonly apiKey;
    private readonly baseUrl;
    private readonly requestTimeoutMs;
    private readonly streamTimeoutMs;
    private _closed;
    /**
     * Discovery resource for searching tools
     */
    readonly discovery: Discovery;
    /**
     * Tools resource for executing tools (pay-per-request)
     */
    readonly tools: Tools;
    /**
     * Query resource for agentic queries (pay-per-response).
     *
     * Unlike `tools.execute()` which calls a single tool once, `query` sends
     * a natural-language question and lets the server handle tool discovery,
     * multi-tool orchestration, self-healing, and AI synthesis — one flat fee.
     */
    readonly query: Query;
    /**
     * Creates a new Context Protocol client
     *
     * @param options - Client configuration options
     * @param options.apiKey - Your Context Protocol API key (format: sk_live_...)
     * @param options.baseUrl - Optional base URL override (defaults to https://www.ctxprotocol.com)
     * @param options.requestTimeoutMs - Optional timeout for non-streaming requests (default 300000ms)
     * @param options.streamTimeoutMs - Optional timeout for establishing stream requests (default 600000ms)
     */
    constructor(options: ContextClientOptions);
    /**
     * Close the client and clean up resources.
     * After calling close(), any in-flight requests may be aborted.
     */
    close(): void;
    /**
     * Internal method for making authenticated HTTP requests
     * Includes timeout and retry with exponential backoff for transient errors
     *
     * @internal
     */
    _fetch<T>(endpoint: string, options?: RequestInit): Promise<T>;
    /**
     * Internal method for making authenticated HTTP requests that returns
     * the raw Response object. Used for streaming endpoints (SSE).
     * Includes a configurable timeout for stream setup.
     *
     * @internal
     */
    _fetchRaw(endpoint: string, options?: RequestInit): Promise<Response>;
}

export { ContextClient, type ContextClientOptions, ContextError, type ContextErrorCode, Discovery, type ExecuteApiErrorResponse, type ExecuteApiResponse, type ExecuteApiSuccessResponse, type ExecuteOptions, type ExecuteSessionApiResponse, type ExecuteSessionApiSuccessResponse, type ExecuteSessionResult, type ExecuteSessionSpend, type ExecuteSessionStartOptions, type ExecuteSessionStatus, type ExecutionResult, type McpTool, type McpToolMeta, type McpToolRateLimitHints, Query, type QueryApiResponse, type QueryApiSuccessResponse, type QueryCost, type QueryDeveloperTrace, type QueryDeveloperTraceLoopInfo, type QueryDeveloperTraceStep, type QueryDeveloperTraceSummary, type QueryDeveloperTraceToolRef, type QueryOptions, type QueryResult, type QueryStreamDeveloperTraceEvent, type QueryStreamDoneEvent, type QueryStreamEvent, type QueryStreamTextDeltaEvent, type QueryStreamToolStatusEvent, type QueryToolUsage, type SearchOptions, type SearchResponse, type Tool, Tools };
