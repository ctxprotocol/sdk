import type { ExecuteOptions, ExecuteSessionResult, ExecuteSessionStartOptions, ExecutionResult } from "../types.js";
import type { ContextClient } from "../client.js";
/**
 * Tools resource for executing tools on the Context Protocol marketplace
 */
export declare class Tools {
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
//# sourceMappingURL=tools.d.ts.map