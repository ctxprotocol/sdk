'use strict';

// src/client/types.ts
var ContextError = class _ContextError extends Error {
  constructor(message, code, statusCode, helpUrl) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.helpUrl = helpUrl;
    this.name = "ContextError";
    Object.setPrototypeOf(this, _ContextError.prototype);
  }
};

// src/client/resources/discovery.ts
var Discovery = class {
  constructor(client) {
    this.client = client;
  }
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
  async search(query, limit) {
    const params = new URLSearchParams();
    if (query) {
      params.set("q", query);
    }
    if (limit !== void 0) {
      params.set("limit", String(limit));
    }
    const queryString = params.toString();
    const endpoint = `/api/v1/tools/search${queryString ? `?${queryString}` : ""}`;
    const response = await this.client._fetch(endpoint);
    return response.tools;
  }
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
  async getFeatured(limit) {
    return this.search("", limit);
  }
};

// src/client/resources/tools.ts
var Tools = class {
  constructor(client) {
    this.client = client;
  }
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
  async execute(options) {
    const { toolId, toolName, args } = options;
    const response = await this.client._fetch(
      "/api/v1/tools/execute",
      {
        method: "POST",
        body: JSON.stringify({ toolId, toolName, args })
      }
    );
    if ("error" in response) {
      throw new ContextError(
        response.error,
        response.code,
        void 0,
        // Don't hardcode - this was a 200 OK with error body
        response.helpUrl
      );
    }
    if (response.success) {
      return {
        result: response.result,
        tool: response.tool,
        durationMs: response.durationMs
      };
    }
    throw new ContextError("Unexpected response format from API");
  }
};

// src/client/resources/query.ts
var Query = class {
  constructor(client) {
    this.client = client;
  }
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
  async run(options) {
    const opts = typeof options === "string" ? { query: options } : options;
    const response = await this.client._fetch(
      "/api/v1/query",
      {
        method: "POST",
        body: JSON.stringify({
          query: opts.query,
          tools: opts.tools,
          stream: false
        })
      }
    );
    if ("error" in response) {
      throw new ContextError(
        response.error,
        response.code,
        void 0,
        response.helpUrl
      );
    }
    if (response.success) {
      return {
        response: response.response,
        toolsUsed: response.toolsUsed,
        cost: response.cost,
        durationMs: response.durationMs
      };
    }
    throw new ContextError("Unexpected response format from query API");
  }
  /**
   * Run an agentic query with streaming. Returns an async iterable that
   * yields events as the server processes the query in real-time.
   *
   * Event types:
   * - `tool-status` — A tool started executing or changed status
   * - `text-delta` — A chunk of the AI response text
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
   *     case "done":
   *       console.log("\nCost:", event.result.cost.totalCostUsd);
   *       break;
   *   }
   * }
   * ```
   */
  async *stream(options) {
    const opts = typeof options === "string" ? { query: options } : options;
    const response = await this.client._fetchRaw("/api/v1/query", {
      method: "POST",
      body: JSON.stringify({
        query: opts.query,
        tools: opts.tools,
        stream: true
      })
    });
    const body = response.body;
    if (!body) {
      throw new ContextError("No response body for streaming query");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;
            try {
              yield JSON.parse(data);
            } catch {
            }
          }
        }
      }
      if (buffer.trim().startsWith("data: ")) {
        const data = buffer.trim().slice(6);
        if (data !== "[DONE]") {
          try {
            yield JSON.parse(data);
          } catch {
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
};

// src/client/client.ts
var ContextClient = class {
  apiKey;
  baseUrl;
  _closed = false;
  /**
   * Discovery resource for searching tools
   */
  discovery;
  /**
   * Tools resource for executing tools (pay-per-request)
   */
  tools;
  /**
   * Query resource for agentic queries (pay-per-response).
   *
   * Unlike `tools.execute()` which calls a single tool once, `query` sends
   * a natural-language question and lets the server handle tool discovery,
   * multi-tool orchestration, self-healing, and AI synthesis — one flat fee.
   */
  query;
  /**
   * Creates a new Context Protocol client
   *
   * @param options - Client configuration options
   * @param options.apiKey - Your Context Protocol API key (format: sk_live_...)
   * @param options.baseUrl - Optional base URL override (defaults to https://ctxprotocol.com)
   */
  constructor(options) {
    if (!options.apiKey) {
      throw new ContextError("API key is required");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://ctxprotocol.com").replace(/\/$/, "");
    this.discovery = new Discovery(this);
    this.tools = new Tools(this);
    this.query = new Query(this);
  }
  /**
   * Close the client and clean up resources.
   * After calling close(), any in-flight requests may be aborted.
   */
  close() {
    this._closed = true;
  }
  /**
   * Internal method for making authenticated HTTP requests
   * Includes timeout (30s) and retry with exponential backoff for transient errors
   *
   * @internal
   */
  async _fetch(endpoint, options = {}) {
    if (this._closed) {
      throw new ContextError("Client has been closed");
    }
    const url = `${this.baseUrl}${endpoint}`;
    const maxRetries = 3;
    const timeoutMs = 3e4;
    let lastError;
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
            ...options.headers
          }
        });
        clearTimeout(timeout);
        if (!response.ok) {
          if (response.status >= 500 && attempt < maxRetries) {
            const delay = Math.min(1e3 * 2 ** attempt, 1e4);
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
          let errorCode;
          let helpUrl;
          try {
            const errorBody = await response.json();
            if (errorBody.error) {
              errorMessage = errorBody.error;
              errorCode = errorBody.code;
              helpUrl = errorBody.helpUrl;
            }
          } catch {
          }
          throw new ContextError(errorMessage, errorCode, response.status, helpUrl);
        }
        return response.json();
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof ContextError) {
          throw error;
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRetryable = lastError.name === "AbortError" || lastError.message.includes("fetch failed") || lastError.message.includes("ECONNRESET") || lastError.message.includes("ETIMEDOUT");
        if (isRetryable && attempt < maxRetries) {
          const delay = Math.min(1e3 * 2 ** attempt, 1e4);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (lastError.name === "AbortError") {
          throw new ContextError(
            `Request timed out after ${timeoutMs / 1e3}s`,
            void 0,
            408
          );
        }
        throw new ContextError(
          lastError.message,
          void 0,
          void 0
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
  async _fetchRaw(endpoint, options = {}) {
    if (this._closed) {
      throw new ContextError("Client has been closed");
    }
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        ...options.headers
      }
    });
    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      let errorCode;
      let helpUrl;
      try {
        const errorBody = await response.json();
        if (errorBody.error) {
          errorMessage = errorBody.error;
          errorCode = errorBody.code;
          helpUrl = errorBody.helpUrl;
        }
      } catch {
      }
      throw new ContextError(errorMessage, errorCode, response.status, helpUrl);
    }
    return response;
  }
};

exports.ContextClient = ContextClient;
exports.ContextError = ContextError;
exports.Discovery = Discovery;
exports.Query = Query;
exports.Tools = Tools;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map