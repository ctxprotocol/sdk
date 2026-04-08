// ---------------------------------------------------------------------------
// Developer / tool management types
// ---------------------------------------------------------------------------
/**
 * Options for updating a tool listing via `client.developer.updateTool()`.
 * At least one field must be provided.
 */
export const ALLOWED_TOOL_CATEGORIES = [
    "Crypto & DeFi",
    "Financial Markets",
    "Business & Sales",
    "Marketing & SEO",
    "Legal & Regulatory",
    "Real World",
    "Developer Tools",
    "Research & Academia",
    "Utility",
    "Other",
];
/**
 * Error thrown by the Context Protocol client
 */
export class ContextError extends Error {
    code;
    statusCode;
    helpUrl;
    constructor(message, code, statusCode, helpUrl) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.helpUrl = helpUrl;
        this.name = "ContextError";
        Object.setPrototypeOf(this, ContextError.prototype);
    }
}
//# sourceMappingURL=types.js.map