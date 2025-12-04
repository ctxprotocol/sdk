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
     * @default "https://ctxprotocol.com"
     */
    baseUrl?: string;
}
/**
 * An individual MCP tool exposed by a tool listing
 */
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
    /** Type of tool (e.g., "mcp") */
    kind?: string;
    /**
     * Available MCP tool methods
     * Use items from this array as `toolName` when executing
     */
    mcpTools?: McpTool[];
    /** Creation timestamp */
    createdAt?: string;
    /** Last update timestamp */
    updatedAt?: string;
}
/**
 * Response from the tools search endpoint
 */
interface SearchResponse {
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
interface SearchOptions {
    /** Search query (semantic search) */
    query?: string;
    /** Maximum number of results (1-50, default 10) */
    limit?: number;
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
}
/**
 * Successful execution response from the API
 */
interface ExecuteApiSuccessResponse {
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
interface ExecuteApiErrorResponse {
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
type ExecuteApiResponse = ExecuteApiSuccessResponse | ExecuteApiErrorResponse;
/**
 * The resolved result returned to the user after SDK processing
 */
interface ExecutionResult<T = unknown> {
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
/**
 * Specific error codes returned by the Context Protocol API
 */
type ContextErrorCode = "unauthorized" | "no_wallet" | "insufficient_allowance" | "payment_failed" | "execution_failed";
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
     * Search for tools matching a query string
     *
     * @param query - The search query (e.g., "gas prices", "nft metadata")
     * @param limit - Maximum number of results (1-50, default 10)
     * @returns Array of matching tools
     *
     * @example
     * ```typescript
     * const tools = await client.discovery.search("gas prices");
     * console.log(tools[0].name); // "Gas Price Oracle"
     * console.log(tools[0].mcpTools); // Available methods
     * ```
     */
    search(query: string, limit?: number): Promise<Tool[]>;
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
    getFeatured(limit?: number): Promise<Tool[]>;
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
     * @throws {ContextError} With code `insufficient_allowance` if Auto Pay not enabled
     * @throws {ContextError} With code `payment_failed` if on-chain payment fails
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
 * // Discover tools
 * const tools = await client.discovery.search("gas prices");
 *
 * // Execute a tool method
 * const result = await client.tools.execute({
 *   toolId: tools[0].id,
 *   toolName: tools[0].mcpTools[0].name,
 *   args: { chainId: 1 }
 * });
 * ```
 */
declare class ContextClient {
    private readonly apiKey;
    private readonly baseUrl;
    /**
     * Discovery resource for searching tools
     */
    readonly discovery: Discovery;
    /**
     * Tools resource for executing tools
     */
    readonly tools: Tools;
    /**
     * Creates a new Context Protocol client
     *
     * @param options - Client configuration options
     * @param options.apiKey - Your Context Protocol API key (format: sk_live_...)
     * @param options.baseUrl - Optional base URL override (defaults to https://ctxprotocol.com)
     */
    constructor(options: ContextClientOptions);
    /**
     * Internal method for making authenticated HTTP requests
     * All requests include the Authorization header with the API key
     *
     * @internal
     */
    fetch<T>(endpoint: string, options?: RequestInit): Promise<T>;
}

export { ContextClient, type ContextClientOptions, ContextError, type ContextErrorCode, Discovery, type ExecuteApiErrorResponse, type ExecuteApiResponse, type ExecuteApiSuccessResponse, type ExecuteOptions, type ExecutionResult, type McpTool, type SearchOptions, type SearchResponse, type Tool, Tools };
