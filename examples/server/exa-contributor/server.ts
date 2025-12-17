/**
 * Exa AI MCP Server Proxy
 *
 * This server proxies requests to Exa's official hosted MCP server.
 * It adds the API key and exposes the service via HTTP for deployment.
 *
 * See: https://github.com/exa-labs/exa-mcp-server
 */

import "dotenv/config";
import express, { type Request, type Response, type NextFunction } from "express";
import { verifyContextRequest, isProtectedMcpMethod, ContextError } from "@ctxprotocol/sdk";

const PORT = Number(process.env.PORT || 4004);
const EXA_API_KEY = process.env.EXA_API_KEY;

// Tools to enable (comma-separated)
const TOOLS_CONFIG = process.env.EXA_TOOLS || "web_search_exa,deep_search_exa,get_code_context_exa,crawling_exa,company_research_exa,linkedin_search_exa,deep_researcher_start,deep_researcher_check";

// Build the Exa MCP URL with API key and tools
function getExaMcpUrl(): string {
  const params = new URLSearchParams();
  if (EXA_API_KEY) {
    params.set("exaApiKey", EXA_API_KEY);
  }
  if (TOOLS_CONFIG) {
    params.set("tools", TOOLS_CONFIG);
  }
  return `https://mcp.exa.ai/mcp?${params.toString()}`;
}

const app = express();

// Parse JSON bodies
app.use(express.json());

// ============================================================================
// AUTH MIDDLEWARE - Verify Context Protocol Request Signature
// Only requires auth for protected methods (tools/call), not discovery (tools/list)
// ============================================================================

async function verifyContextAuth(req: Request, res: Response, next: NextFunction) {
  // Get the MCP method from the request body
  const method = req.body?.method as string | undefined;

  // Only require auth for protected methods (tools/call)
  // Discovery methods (tools/list, initialize, etc.) are open
  if (!method || !isProtectedMcpMethod(method)) {
    return next();
  }

  try {
    await verifyContextRequest({
      authorizationHeader: req.headers.authorization,
    });
    next();
  } catch (error) {
    console.error("Auth failed:", error instanceof Error ? error.message : error);
    const statusCode = error instanceof ContextError ? error.statusCode || 401 : 401;
    res.status(statusCode).json({ error: "Unauthorized: Invalid Context Protocol Signature" });
  }
}

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "exa-ai-proxy",
    version: "1.0.0",
    tools: TOOLS_CONFIG.split(","),
    upstream: "https://mcp.exa.ai/mcp",
  });
});

// Proxy all MCP requests to Exa's hosted server
app.all("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  if (!EXA_API_KEY) {
    res.status(500).json({ error: "EXA_API_KEY not configured" });
    return;
  }

  const exaUrl = getExaMcpUrl();

  try {
    // Forward the request to Exa's MCP server
    const fetchOptions: RequestInit = {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        "Accept": req.headers.accept || "application/json",
      },
    };

    // Include body for POST requests
    if (req.method === "POST" && req.body) {
      fetchOptions.body = JSON.stringify(req.body);
    }

    const response = await fetch(exaUrl, fetchOptions);

    // Check if it's a streaming response
    const contentType = response.headers.get("content-type") || "";
    
    // Set response headers
    res.status(response.status);
    res.setHeader("Content-Type", contentType);
    
    // Handle streaming responses (SSE or chunked)
    if (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")) {
      // Stream the response
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      
      if (response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
          }
        } catch (streamError) {
          console.error("Stream error:", streamError);
        } finally {
          res.end();
        }
      } else {
        res.end();
      }
    } else {
      // Non-streaming response
      const data = await response.text();
      res.send(data);
    }
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(502).json({
      error: "Failed to proxy to Exa MCP server",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Exa AI MCP Proxy Server v1.0.0`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Upstream: https://mcp.exa.ai/mcp`);
  console.log(`\n🛠️  Configured tools: ${TOOLS_CONFIG}\n`);
});
