import { jwtVerify, importSPKI, type JWTPayload } from "jose";
import { ContextError } from "../client/types.js";

// ============================================================================
// Express-compatible types (avoid requiring express as a dependency)
// ============================================================================

interface ContextRequest {
  headers: {
    authorization?: string;
    [key: string]: string | string[] | undefined;
  };
  body?: {
    method?: string;
    [key: string]: unknown;
  };
  context?: JWTPayload;
}

interface ContextResponse {
  status(code: number): ContextResponse;
  json(data: unknown): void;
}

type NextFunction = (error?: unknown) => void;

/**
 * Extended Request object with verified Context Protocol JWT payload.
 *
 * After `createContextMiddleware()` runs successfully on a protected method,
 * the `context` property contains the decoded JWT claims.
 */
export interface ContextMiddlewareRequest extends ContextRequest {
  /** The verified JWT payload from Context Protocol (available after auth) */
  context?: JWTPayload;
}

// ============================================================================
// Configuration
// ============================================================================

// The Context Protocol Public Key
// In a real scenario, this might be fetched from a well-known URL or passed in config.
// For now, we hardcode the Official Platform Public Key.
// Official Context Protocol Platform Public Key (RS256)
const CONTEXT_PLATFORM_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs9YOgdpkmVQ5aoNovjsu
chJdV54OT7dUdbVXz914a7Px8EwnpDqhsvG7WO8xL8sj2Rn6ueAJBk+04Hy/P/UN
RJyp23XL5TsGmb4rbfg0ii0MiL2nbVXuqvAe3JSM2BOFZR5bpwIVIaa8aonfamUy
VXGc7OosF90ThdKjm9cXlVM+kV6IgSWc1502X7M3abQqRcTU/rluVXnky0eiWDQa
lfOKbr7w0u72dZjiZPwnNDsX6PEEgvfmoautTFYTQgnZjDzq8UimTcv3KF+hJ5Ep
weipe6amt9lzQzi8WXaFKpOXHQs//WDlUytz/Hl8pvd5craZKzo6Kyrg1Vfan7H3
TQIDAQAB
-----END PUBLIC KEY-----`;

// ============================================================================
// JWKS Key Fetching (with hardcoded fallback)
// ============================================================================

const JWKS_URL = "https://ctxprotocol.com/.well-known/jwks.json";
const KEY_CACHE_TTL_MS = 3_600_000; // 1 hour

let cachedPublicKey: Awaited<ReturnType<typeof importSPKI>> | null = null;
let cacheTimestamp = 0;

/**
 * Get the platform public key, trying JWKS endpoint first with hardcoded fallback.
 * Caches the result for 1 hour.
 */
async function getPlatformPublicKey(): Promise<Awaited<ReturnType<typeof importSPKI>>> {
  const now = Date.now();

  // Return cached key if still valid
  if (cachedPublicKey && now - cacheTimestamp < KEY_CACHE_TTL_MS) {
    return cachedPublicKey;
  }

  // Try JWKS endpoint first
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(JWKS_URL, { signal: controller.signal });
    clearTimeout(timeout);

    if (response.ok) {
      const jwks = await response.json() as { keys?: Array<{ x5c?: string[]; kty?: string; n?: string; e?: string }> };
      if (jwks.keys && jwks.keys.length > 0) {
        const key = jwks.keys[0];
        // If the JWKS contains x5c (X.509 cert chain), extract the public key
        if (key.x5c && key.x5c.length > 0) {
          const pem = `-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`;
          const { importX509 } = await import("jose");
          cachedPublicKey = await importX509(pem, "RS256");
          cacheTimestamp = now;
          return cachedPublicKey;
        }
      }
    }
  } catch {
    // JWKS fetch failed - fall back to hardcoded key
  }

  // Fallback: use hardcoded key
  cachedPublicKey = await importSPKI(CONTEXT_PLATFORM_PUBLIC_KEY_PEM, "RS256");
  cacheTimestamp = now;
  return cachedPublicKey;
}

/**
 * MCP methods that require authentication.
 * - tools/call: Executes tool logic, may cost money
 * - resources/read: Reads potentially sensitive data
 * - prompts/get: Gets prompt content
 */
const PROTECTED_MCP_METHODS = new Set([
  "tools/call",
  // Uncomment these if you want to protect resource/prompt access:
  // "resources/read",
  // "prompts/get",
]);

/**
 * MCP methods that are always open (no auth required).
 * These are discovery/listing operations that return metadata only.
 */
const OPEN_MCP_METHODS = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "prompts/list",
  "ping",
  "notifications/initialized",
]);

// ============================================================================
// Method Classification
// ============================================================================

/**
 * Determines if a given MCP method requires authentication.
 *
 * Discovery methods (tools/list, resources/list, etc.) are open.
 * Execution methods (tools/call) require authentication.
 *
 * @param method The MCP JSON-RPC method (e.g., "tools/list", "tools/call")
 * @returns true if the method requires authentication
 *
 * @example
 * ```typescript
 * if (isProtectedMcpMethod(body.method)) {
 *   await verifyContextRequest({ authorizationHeader: req.headers.authorization });
 * }
 * ```
 */
export function isProtectedMcpMethod(method: string): boolean {
  return PROTECTED_MCP_METHODS.has(method);
}

/**
 * Determines if a given MCP method is explicitly open (no auth).
 *
 * @param method The MCP JSON-RPC method
 * @returns true if the method is known to be open
 */
export function isOpenMcpMethod(method: string): boolean {
  return OPEN_MCP_METHODS.has(method);
}

// ============================================================================
// Request Verification
// ============================================================================

export interface VerifyRequestOptions {
  /** The full Authorization header string (e.g. "Bearer eyJ...") */
  authorizationHeader?: string;
  /** Expected Audience (your tool URL) for stricter validation */
  audience?: string;
}

/**
 * Verifies that an incoming request originated from the Context Protocol Platform.
 *
 * @param options Contains the Authorization header
 * @returns The decoded payload if valid
 * @throws ContextError if invalid
 */
export async function verifyContextRequest(options: VerifyRequestOptions) {
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

    const { payload } = await jwtVerify(token, publicKey, {
      issuer: "https://ctxprotocol.com",
      audience: audience,
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

// ============================================================================
// Easy-Mode Middleware
// ============================================================================

export interface CreateContextMiddlewareOptions {
  /** Expected Audience (your tool URL) for stricter validation */
  audience?: string;
}

/**
 * Creates an Express/Connect-compatible middleware that secures your MCP endpoint.
 *
 * This is the "1 line of code" solution to secure your MCP server.
 * It automatically:
 * - Allows discovery methods (tools/list, initialize) without authentication
 * - Requires and verifies JWT for execution methods (tools/call)
 * - Attaches the verified payload to `req.context` for downstream use
 *
 * @param options Optional configuration
 * @returns Express-compatible middleware function
 *
 * @example
 * ```typescript
 * import express from "express";
 * import { createContextMiddleware } from "@ctxprotocol/sdk";
 *
 * const app = express();
 * app.use(express.json());
 *
 * // 1 line to secure your endpoint
 * app.use("/mcp", createContextMiddleware());
 *
 * app.post("/mcp", (req, res) => {
 *   // req.context contains verified JWT payload (on protected methods)
 *   // Handle MCP request...
 * });
 * ```
 */
export function createContextMiddleware(options: CreateContextMiddlewareOptions = {}) {
  return async function contextMiddleware(
    req: ContextRequest,
    res: ContextResponse,
    next: NextFunction
  ): Promise<void> {
    const method = req.body?.method as string | undefined;

    // Allow discovery methods without authentication
    // Discovery methods (tools/list, initialize, etc.) are open by design
    if (!method || !isProtectedMcpMethod(method)) {
      return next();
    }

    // Protected method - require authentication
    try {
      const payload = await verifyContextRequest({
        authorizationHeader: req.headers.authorization,
        audience: options.audience,
      });

      // Attach verified payload to request for downstream handlers
      req.context = payload;
      next();
    } catch (error) {
      const statusCode = error instanceof ContextError ? error.statusCode || 401 : 401;
      res.status(statusCode).json({ error: "Unauthorized" });
    }
  };
}


