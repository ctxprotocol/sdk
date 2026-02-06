'use strict';

var jose = require('jose');

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
};

// src/context/index.ts
var CONTEXT_REQUIREMENTS_KEY = "x-context-requirements";
var META_CONTEXT_REQUIREMENTS_KEY = "contextRequirements";
var CONTEXT_PLATFORM_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs9YOgdpkmVQ5aoNovjsu
chJdV54OT7dUdbVXz914a7Px8EwnpDqhsvG7WO8xL8sj2Rn6ueAJBk+04Hy/P/UN
RJyp23XL5TsGmb4rbfg0ii0MiL2nbVXuqvAe3JSM2BOFZR5bpwIVIaa8aonfamUy
VXGc7OosF90ThdKjm9cXlVM+kV6IgSWc1502X7M3abQqRcTU/rluVXnky0eiWDQa
lfOKbr7w0u72dZjiZPwnNDsX6PEEgvfmoautTFYTQgnZjDzq8UimTcv3KF+hJ5Ep
weipe6amt9lzQzi8WXaFKpOXHQs//WDlUytz/Hl8pvd5craZKzo6Kyrg1Vfan7H3
TQIDAQAB
-----END PUBLIC KEY-----`;
var JWKS_URL = "https://ctxprotocol.com/.well-known/jwks.json";
var KEY_CACHE_TTL_MS = 36e5;
var cachedPublicKey = null;
var cacheTimestamp = 0;
async function getPlatformPublicKey() {
  const now = Date.now();
  if (cachedPublicKey && now - cacheTimestamp < KEY_CACHE_TTL_MS) {
    return cachedPublicKey;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5e3);
    const response = await fetch(JWKS_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const jwks = await response.json();
      if (jwks.keys && jwks.keys.length > 0) {
        const key = jwks.keys[0];
        if (key.x5c && key.x5c.length > 0) {
          const pem = `-----BEGIN CERTIFICATE-----
${key.x5c[0]}
-----END CERTIFICATE-----`;
          const { importX509 } = await import('jose');
          cachedPublicKey = await importX509(pem, "RS256");
          cacheTimestamp = now;
          return cachedPublicKey;
        }
      }
    }
  } catch {
  }
  cachedPublicKey = await jose.importSPKI(CONTEXT_PLATFORM_PUBLIC_KEY_PEM, "RS256");
  cacheTimestamp = now;
  return cachedPublicKey;
}
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
    const publicKey = await getPlatformPublicKey();
    const { payload } = await jose.jwtVerify(token, publicKey, {
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

// src/handshake/types.ts
function isHandshakeAction(value) {
  return typeof value === "object" && value !== null && "_action" in value && (value._action === "signature_request" || value._action === "transaction_proposal" || value._action === "auth_required");
}
function isSignatureRequest(value) {
  return isHandshakeAction(value) && value._action === "signature_request";
}
function isTransactionProposal(value) {
  return isHandshakeAction(value) && value._action === "transaction_proposal";
}
function isAuthRequired(value) {
  return isHandshakeAction(value) && value._action === "auth_required";
}
function createSignatureRequest(params) {
  return {
    _action: "signature_request",
    ...params
  };
}
function createTransactionProposal(params) {
  return {
    _action: "transaction_proposal",
    ...params
  };
}
function createAuthRequired(params) {
  return {
    _action: "auth_required",
    ...params
  };
}
function wrapHandshakeResponse(action) {
  const actionType = action._action.replace("_", " ");
  return {
    content: [
      {
        type: "text",
        text: `Handshake required: ${actionType}. Please approve in the Context app.`
      }
    ],
    structuredContent: {
      _meta: {
        handshakeAction: action
      },
      status: "handshake_required",
      message: action.meta?.description ?? `${actionType} required`
    }
  };
}

exports.CONTEXT_REQUIREMENTS_KEY = CONTEXT_REQUIREMENTS_KEY;
exports.ContextClient = ContextClient;
exports.ContextError = ContextError;
exports.Discovery = Discovery;
exports.META_CONTEXT_REQUIREMENTS_KEY = META_CONTEXT_REQUIREMENTS_KEY;
exports.Tools = Tools;
exports.createAuthRequired = createAuthRequired;
exports.createContextMiddleware = createContextMiddleware;
exports.createSignatureRequest = createSignatureRequest;
exports.createTransactionProposal = createTransactionProposal;
exports.isAuthRequired = isAuthRequired;
exports.isHandshakeAction = isHandshakeAction;
exports.isOpenMcpMethod = isOpenMcpMethod;
exports.isProtectedMcpMethod = isProtectedMcpMethod;
exports.isSignatureRequest = isSignatureRequest;
exports.isTransactionProposal = isTransactionProposal;
exports.verifyContextRequest = verifyContextRequest;
exports.wrapHandshakeResponse = wrapHandshakeResponse;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map