import type { ContextClientOptions } from "./types.js";
import { ContextError } from "./types.js";
import { Discovery } from "./resources/discovery.js";
import { Tools } from "./resources/tools.js";
import { Query } from "./resources/query.js";

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
export class ContextClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private _closed = false;

  /**
   * Discovery resource for searching tools
   */
  public readonly discovery: Discovery;

  /**
   * Tools resource for executing tools (pay-per-request)
   */
  public readonly tools: Tools;

  /**
   * Query resource for agentic queries (pay-per-response).
   *
   * Unlike `tools.execute()` which calls a single tool once, `query` sends
   * a natural-language question and lets the server handle tool discovery,
   * multi-tool orchestration, self-healing, and AI synthesis — one flat fee.
   */
  public readonly query: Query;

  /**
   * Creates a new Context Protocol client
   *
   * @param options - Client configuration options
   * @param options.apiKey - Your Context Protocol API key (format: sk_live_...)
   * @param options.baseUrl - Optional base URL override (defaults to https://ctxprotocol.com)
   */
  constructor(options: ContextClientOptions) {
    if (!options.apiKey) {
      throw new ContextError("API key is required");
    }

    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://ctxprotocol.com").replace(/\/$/, "");

    // Initialize resources
    this.discovery = new Discovery(this);
    this.tools = new Tools(this);
    this.query = new Query(this);
  }

  /**
   * Close the client and clean up resources.
   * After calling close(), any in-flight requests may be aborted.
   */
  close(): void {
    this._closed = true;
  }

  /**
   * Internal method for making authenticated HTTP requests
   * Includes timeout (30s) and retry with exponential backoff for transient errors
   *
   * @internal
   */
  async _fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    if (this._closed) {
      throw new ContextError("Client has been closed");
    }

    const url = `${this.baseUrl}${endpoint}`;
    const maxRetries = 3;
    const timeoutMs = 30_000;

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
            ...options.headers,
          },
        });

        clearTimeout(timeout);

        if (!response.ok) {
          // Retry on 5xx server errors
          if (response.status >= 500 && attempt < maxRetries) {
            const delay = Math.min(1000 * 2 ** attempt, 10_000);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }

          let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
          let errorCode: string | undefined;
          let helpUrl: string | undefined;

          try {
            const errorBody = await response.json();
            if (errorBody.error) {
              errorMessage = errorBody.error;
              errorCode = errorBody.code;
              helpUrl = errorBody.helpUrl;
            }
          } catch {
            // Use default error message if JSON parsing fails
          }

          throw new ContextError(errorMessage, errorCode, response.status, helpUrl);
        }

        return response.json() as Promise<T>;
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof ContextError) {
          throw error;
        }

        lastError = error instanceof Error ? error : new Error(String(error));

        // Retry on network errors and timeouts
        const isRetryable =
          lastError.name === "AbortError" ||
          lastError.message.includes("fetch failed") ||
          lastError.message.includes("ECONNRESET") ||
          lastError.message.includes("ETIMEDOUT");

        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 10_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (lastError.name === "AbortError") {
          throw new ContextError(
            `Request timed out after ${timeoutMs / 1000}s`,
            undefined,
            408
          );
        }

        throw new ContextError(
          lastError.message,
          undefined,
          undefined
        );
      }
    }

    throw lastError ?? new ContextError("Request failed after retries");
  }

  /**
   * Internal method for making authenticated HTTP requests that returns
   * the raw Response object. Used for streaming endpoints (SSE).
   *
   * @internal
   */
  async _fetchRaw(endpoint: string, options: RequestInit = {}): Promise<Response> {
    if (this._closed) {
      throw new ContextError("Client has been closed");
    }

    const url = `${this.baseUrl}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...options.headers,
      },
    });

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorCode: string | undefined;
      let helpUrl: string | undefined;

      try {
        const errorBody = await response.json();
        if (errorBody.error) {
          errorMessage = errorBody.error;
          errorCode = errorBody.code;
          helpUrl = errorBody.helpUrl;
        }
      } catch {
        // Use default error message if JSON parsing fails
      }

      throw new ContextError(errorMessage, errorCode, response.status, helpUrl);
    }

    return response;
  }
}
