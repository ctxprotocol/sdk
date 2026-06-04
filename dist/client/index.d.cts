import { ao as UpdateToolOptions, ap as UpdateToolResult, T as Tool, O as SearchOptions, P as ExecuteOptions, Y as ExecutionResult, U as ExecuteSessionStartOptions, X as ExecuteSessionResult, a5 as QueryOptions, a6 as QueryResult, ai as QueryStreamEvent, F as ContextClientOptions } from '../types-Bo6qWbqy.cjs';
export { D as AGENT_MODEL_IDS, aF as ALLOWED_TOOL_CATEGORIES, G as AgentModelId, H as AgentModelIdInput, B as ContextError, aq as ContextErrorCode, E as DEFAULT_AGENT_MODEL_ID, _ as ExecuteApiErrorResponse, $ as ExecuteApiResponse, Z as ExecuteApiSuccessResponse, a1 as ExecuteSessionApiResponse, a0 as ExecuteSessionApiSuccessResponse, W as ExecuteSessionSpend, V as ExecuteSessionStatus, M as McpTool, K as McpToolMeta, L as McpToolRateLimitHints, ah as QueryApiResponse, ag as QueryApiSuccessResponse, as as QueryAssumptionMetadata, a2 as QueryAttemptForkReason, a3 as QueryAttemptReference, ar as QueryCapabilityMissPayload, aC as QueryChartAxis, ax as QueryChartAxisType, aA as QueryChartDataRow, az as QueryChartDataValue, aB as QueryChartSeries, aw as QueryChartSeriesType, aD as QueryChartSpec, av as QueryChartType, ay as QueryChartValueFormat, aa as QueryCompletenessRepairEvent, au as QueryComputedArtifact, a9 as QueryCost, Q as QueryDeveloperTrace, ab as QueryDeveloperTraceDiagnostics, af as QueryDeveloperTraceLoopInfo, ad as QueryDeveloperTraceStep, ac as QueryDeveloperTraceSummary, ae as QueryDeveloperTraceToolRef, a4 as QueryForkReference, at as QueryOutcomeType, a7 as QuerySessionState, al as QueryStreamDeveloperTraceEvent, am as QueryStreamDoneEvent, an as QueryStreamErrorEvent, ak as QueryStreamTextDeltaEvent, aj as QueryStreamToolStatusEvent, a8 as QueryToolUsage, N as SearchResponse, I as SuggestedPrompt, J as SuggestedPromptSource, aE as ToolCategory } from '../types-Bo6qWbqy.cjs';

/**
 * Developer resource for managing tool listings on the Context Protocol marketplace.
 *
 * Scoped to contributor/developer concerns (listing management), separate from
 * the consumer-facing `tools.execute()` and `query.run()`.
 */
declare class Developer {
    private client;
    constructor(client: ContextClient);
    /**
     * Update a tool listing's metadata (name, description, category).
     *
     * Requires an API key belonging to the tool's owner.
     *
     * @param toolId - The UUID of the tool to update
     * @param updates - Fields to update (at least one required)
     * @returns The updated tool metadata
     *
     * @throws {ContextError} If authentication fails or the caller does not own the tool
     *
     * @example
     * ```typescript
     * const updated = await client.developer.updateTool("tool-uuid", {
     *   description: "Updated description with better showcase prompts",
     *   category: "crypto",
     * });
     * console.log(updated.updatedAt);
     * ```
     */
    updateTool(toolId: string, updates: UpdateToolOptions): Promise<UpdateToolResult>;
}

/**
 * Discovery resource for searching and finding tools on the Context Protocol marketplace
 */
declare class Discovery {
    private client;
    constructor(client: ContextClient);
    /**
     * Fetch a single marketplace tool by its unique ID.
     */
    get(toolId: string): Promise<Tool>;
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
 * handle the live librarian pipeline (`discover -> select -> metadata scout ->
 * iterative execute -> synthesize -> settle`) plus AI
 * synthesis — all for one flat fee.
 *
 * This is the "prepared meal" vs "raw ingredients" distinction:
 * - `tools.execute()` = raw data, full control, predictable cost
 * - `query.run()` / `query.stream()` = curated intelligence, one payment
 */
declare class Query {
    private client;
    constructor(client: ContextClient);
    private normalizeResult;
    private buildSyntheticTraceFromRunResult;
    private buildSyntheticTraceFromStreamStatus;
    private mergeDeveloperTrace;
    private parseStreamEvent;
    /**
     * Run an agentic query and wait for the full response.
     *
     * The server discovers relevant tools (or uses the ones you specify),
     * executes the discovery-first pipeline (up to 100 MCP calls per tool),
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
     * - `error` — A structured query/runtime error emitted before stream completion
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
     *     case "error":
     *       console.error("Stream error:", event.error);
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
     * Developer resource for managing tool listings (contributor/developer concerns).
     */
    readonly developer: Developer;
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
     * a natural-language question and lets the server handle discovery,
     * metadata scout, iterative execution, and AI synthesis —
     * one flat fee.
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
    _fetch<T>(endpoint: string, options?: RequestInit, fetchOptions?: {
        retry?: boolean;
    }): Promise<T>;
    /**
     * Internal method for making authenticated HTTP requests that returns
     * the raw Response object. Used for streaming endpoints (SSE).
     * Includes a configurable timeout for stream setup.
     *
     * @internal
     */
    _fetchRaw(endpoint: string, options?: RequestInit): Promise<Response>;
}

export { ContextClient, ContextClientOptions, Developer, Discovery, ExecuteOptions, ExecuteSessionResult, ExecuteSessionStartOptions, ExecutionResult, Query, QueryOptions, QueryResult, QueryStreamEvent, SearchOptions, Tool, Tools, UpdateToolOptions, UpdateToolResult };
