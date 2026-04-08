import type { ContextClientOptions } from "./types.js";
import { Developer } from "./resources/developer.js";
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
export declare class ContextClient {
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
//# sourceMappingURL=client.d.ts.map