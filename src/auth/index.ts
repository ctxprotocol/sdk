import { jwtVerify, importSPKI } from "jose";
import { ContextError } from "../client/types.js";

// The Context Protocol Public Key
// In a real scenario, this might be fetched from a well-known URL or passed in config.
// For now, we hardcode the Official Platform Public Key.
// TODO: REPLACE THIS WITH THE ACTUAL GENERATED PUBLIC KEY FROM THE PLATFORM SETUP
const CONTEXT_PLATFORM_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
-----END PUBLIC KEY-----`;

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
    const publicKey = await importSPKI(CONTEXT_PLATFORM_PUBLIC_KEY_PEM, "RS256");

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
