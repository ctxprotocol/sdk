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
   * @default "https://ctxprotocol.com"
   */
  baseUrl?: string;
}

/**
 * An individual MCP tool exposed by a tool listing
 */
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
}

/**
 * Successful execution response from the API
 */
export interface ExecuteApiSuccessResponse {
  success: true;

  /** The result data from the tool execution */
  result: unknown;

  /** Information about the executed tool */
  tool: {
    id: string;
    name: string;
  };

  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Error response from the API
 */
export interface ExecuteApiErrorResponse {
  /** Human-readable error message */
  error: string;

  /** Error code for programmatic handling */
  code?: ContextErrorCode;

  /** URL to help resolve the issue */
  helpUrl?: string;
}

/**
 * Raw API response from the execute endpoint
 */
export type ExecuteApiResponse = ExecuteApiSuccessResponse | ExecuteApiErrorResponse;

/**
 * The resolved result returned to the user after SDK processing
 */
export interface ExecutionResult<T = unknown> {
  /** The data returned by the tool */
  result: T;

  /** Information about the executed tool */
  tool: {
    id: string;
    name: string;
  };

  /** Execution duration in milliseconds */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Query types (pay-per-response / agentic mode)
// ---------------------------------------------------------------------------

/**
 * Options for the agentic query endpoint (pay-per-response).
 *
 * Unlike `execute()` which calls a single tool once, `query()` sends a
 * natural-language question and lets the server handle tool discovery,
 * multi-tool orchestration, self-healing retries, and AI synthesis.
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
 * The resolved result of a pay-per-response query
 */
export interface QueryResult {
  /** The AI-synthesized response text */
  response: string;

  /** Tools that were used to answer the query */
  toolsUsed: QueryToolUsage[];

  /** Cost breakdown */
  cost: QueryCost;

  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Successful response from the /api/v1/query endpoint
 */
export interface QueryApiSuccessResponse {
  success: true;
  response: string;
  toolsUsed: QueryToolUsage[];
  cost: QueryCost;
  durationMs: number;
}

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

/** Emitted when the full response is complete */
export interface QueryStreamDoneEvent {
  type: "done";
  result: QueryResult;
}

/**
 * Union of all events emitted during a streaming query
 */
export type QueryStreamEvent =
  | QueryStreamToolStatusEvent
  | QueryStreamTextDeltaEvent
  | QueryStreamDoneEvent;

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
  | "query_failed";

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
