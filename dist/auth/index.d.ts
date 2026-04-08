import { type JWTPayload } from "jose";
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
export declare function isProtectedMcpMethod(method: string): boolean;
/**
 * Determines if a given MCP method is explicitly open (no auth).
 *
 * @param method The MCP JSON-RPC method
 * @returns true if the method is known to be open
 */
export declare function isOpenMcpMethod(method: string): boolean;
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
export declare function verifyContextRequest(options: VerifyRequestOptions): Promise<JWTPayload>;
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
export declare function createContextMiddleware(options?: CreateContextMiddlewareOptions): (req: ContextRequest, res: ContextResponse, next: NextFunction) => Promise<void>;
export {};
//# sourceMappingURL=index.d.ts.map