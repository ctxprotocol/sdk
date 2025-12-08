import type { ContextClientOptions } from "./types.js";
import { ContextError } from "./types.js";
import { Discovery } from "./resources/discovery.js";
import { Tools } from "./resources/tools.js";

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
export class ContextClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  /**
   * Discovery resource for searching tools
   */
  public readonly discovery: Discovery;

  /**
   * Tools resource for executing tools
   */
  public readonly tools: Tools;

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
  }

  /**
   * Internal method for making authenticated HTTP requests
   * All requests include the Authorization header with the API key
   *
   * @internal
   */
  async fetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
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

    return response.json() as Promise<T>;
  }
}
