import type {
  ExecuteOptions,
  ExecuteApiResponse,
  ExecuteSessionApiResponse,
  ExecuteSessionResult,
  ExecuteSessionStartOptions,
  ExecutionResult,
} from "../types.js";
import { ContextError } from "../types.js";
import type { ContextClient } from "../client.js";

/**
 * Tools resource for executing tools on the Context Protocol marketplace
 */
export class Tools {
  constructor(private client: ContextClient) {}

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
  async execute<T = unknown>(options: ExecuteOptions): Promise<ExecutionResult<T>> {
    const {
      toolId,
      toolName,
      args,
      idempotencyKey,
      mode,
      sessionId,
      maxSpendUsd,
      closeSession,
    } = options;
    const headers = idempotencyKey
      ? { "Idempotency-Key": idempotencyKey }
      : undefined;

    const response = await this.client._fetch<ExecuteApiResponse>(
      "/api/v1/tools/execute",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          toolId,
          toolName,
          args,
          mode: mode ?? "execute",
          sessionId,
          maxSpendUsd,
          closeSession,
        }),
      }
    );

    // Handle error response
    if ("error" in response) {
      throw new ContextError(
        response.error,
        response.code,
        undefined, // Don't hardcode - this was a 200 OK with error body
        response.helpUrl
      );
    }

    // Handle success response
    if (response.success) {
      return {
        mode: response.mode,
        result: response.result as T,
        tool: response.tool,
        method: response.method,
        session: response.session,
        durationMs: response.durationMs,
      };
    }

    // Fallback - shouldn't reach here with valid API responses
    throw new ContextError("Unexpected response format from API");
  }

  /**
   * Start an execute session with a max spend budget.
   */
  async startSession(
    options: ExecuteSessionStartOptions
  ): Promise<ExecuteSessionResult> {
    const response = await this.client._fetch<ExecuteSessionApiResponse>(
      "/api/v1/tools/execute/sessions",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "execute",
          maxSpendUsd: options.maxSpendUsd,
        }),
      }
    );

    return this.resolveSessionLifecycleResponse(response);
  }

  /**
   * Fetch current execute session status by ID.
   */
  async getSession(sessionId: string): Promise<ExecuteSessionResult> {
    if (!sessionId) {
      throw new ContextError("sessionId is required");
    }

    const encodedSessionId = encodeURIComponent(sessionId);
    const response = await this.client._fetch<ExecuteSessionApiResponse>(
      `/api/v1/tools/execute/sessions/${encodedSessionId}`
    );

    return this.resolveSessionLifecycleResponse(response);
  }

  /**
   * Close an execute session by ID.
   */
  async closeSession(sessionId: string): Promise<ExecuteSessionResult> {
    if (!sessionId) {
      throw new ContextError("sessionId is required");
    }

    const encodedSessionId = encodeURIComponent(sessionId);
    const response = await this.client._fetch<ExecuteSessionApiResponse>(
      `/api/v1/tools/execute/sessions/${encodedSessionId}/close`,
      {
        method: "POST",
        body: JSON.stringify({ mode: "execute" }),
      }
    );

    return this.resolveSessionLifecycleResponse(response);
  }

  private resolveSessionLifecycleResponse(
    response: ExecuteSessionApiResponse
  ): ExecuteSessionResult {
    if ("error" in response) {
      throw new ContextError(
        response.error,
        response.code,
        undefined,
        response.helpUrl
      );
    }

    if (response.success) {
      return {
        mode: response.mode,
        session: response.session,
      };
    }

    throw new ContextError("Unexpected response format from API");
  }
}
