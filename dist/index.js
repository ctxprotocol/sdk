import { importSPKI, jwtVerify } from 'jose';

// src/client/types.ts
var ContextError = class extends Error {
  constructor(message, code, statusCode, helpUrl) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.helpUrl = helpUrl;
    this.name = "ContextError";
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
    const response = await this.client.fetch(endpoint);
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
  async execute(options) {
    const { toolId, toolName, args } = options;
    const response = await this.client.fetch(
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
        400,
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

// src/client/client.ts
var ContextClient = class {
  apiKey;
  baseUrl;
  /**
   * Discovery resource for searching tools
   */
  discovery;
  /**
   * Tools resource for executing tools
   */
  tools;
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
  }
  /**
   * Internal method for making authenticated HTTP requests
   * All requests include the Authorization header with the API key
   *
   * @internal
   */
  async fetch(endpoint, options = {}) {
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
    return response.json();
  }
};

// src/context/index.ts
var CONTEXT_REQUIREMENTS_KEY = "x-context-requirements";
var CONTEXT_PLATFORM_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----`;
var PROTECTED_MCP_METHODS = /* @__PURE__ */ new Set([
  "tools/call"
  // Uncomment these if you want to protect resource/prompt access:
  // "resources/read",
  // "prompts/get",
]);
var OPEN_MCP_METHODS = /* @__PURE__ */ new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "prompts/list",
  "ping",
  "notifications/initialized"
]);
function isProtectedMcpMethod(method) {
  return PROTECTED_MCP_METHODS.has(method);
}
function isOpenMcpMethod(method) {
  return OPEN_MCP_METHODS.has(method);
}
async function verifyContextRequest(options) {
  const { authorizationHeader, audience } = options;
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    throw new ContextError(
      "Missing or invalid Authorization header",
      "unauthorized",
      401
    );
  }
  const token = authorizationHeader.split(" ")[1];
  try {
    const publicKey = await importSPKI(CONTEXT_PLATFORM_PUBLIC_KEY_PEM, "RS256");
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "https://ctxprotocol.com",
      audience
    });
    return payload;
  } catch (error) {
    throw new ContextError(
      "Invalid Context Protocol signature",
      "unauthorized",
      401
    );
  }
}
function createContextMiddleware(options = {}) {
  return async function contextMiddleware(req, res, next) {
    const method = req.body?.method;
    if (!method || !isProtectedMcpMethod(method)) {
      return next();
    }
    try {
      const payload = await verifyContextRequest({
        authorizationHeader: req.headers.authorization,
        audience: options.audience
      });
      req.context = payload;
      next();
    } catch (error) {
      const statusCode = error instanceof ContextError ? error.statusCode || 401 : 401;
      res.status(statusCode).json({ error: "Unauthorized" });
    }
  };
}

export { CONTEXT_REQUIREMENTS_KEY, ContextClient, ContextError, Discovery, Tools, createContextMiddleware, isOpenMcpMethod, isProtectedMcpMethod, verifyContextRequest };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map