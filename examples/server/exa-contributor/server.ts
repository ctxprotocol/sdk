/**
 * Exa AI MCP Server Proxy
 *
 * This server proxies requests to Exa's official hosted MCP server.
 * It adds the API key and exposes the service via HTTP for deployment.
 *
 * See: https://github.com/exa-labs/exa-mcp-server
 */

import "dotenv/config";
import express, { type Request, type Response } from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";

const PORT = Number(process.env.PORT || 4004);
const EXA_API_KEY = process.env.EXA_API_KEY;

const DEFAULT_EXA_TOOLS = [
  "web_search_exa",
  "web_search_advanced_exa",
  "get_code_context_exa",
  "crawling_exa",
] as const;

const EXA_TEXT_SEARCH_TOOLS = new Set([
  "web_search_exa",
  "web_search_advanced_exa",
  "company_research_exa",
  "linkedin_search_exa",
  "people_search_exa",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const ADVANCED_SEARCH_ARG_KEYS = [
  "category",
  "endCrawlDate",
  "endPublishedDate",
  "excludeDomains",
  "excludeText",
  "freshness",
  "includeDomains",
  "includeText",
  "numResults",
  "startCrawlDate",
  "startPublishedDate",
  "type",
] as const;

type JsonRpcToolCallParams = {
  name?: unknown;
  arguments?: unknown;
};

type JsonRpcRequestBody = {
  method?: unknown;
  params?: JsonRpcToolCallParams;
};

type JsonRpcResponseBody = {
  result?: {
    content?: unknown;
    structuredContent?: unknown;
  };
};

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasStringValue(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseConfiguredTools(rawTools: string | undefined): string[] {
  const configuredTools =
    rawTools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter((tool) => tool.length > 0) ?? [];

  const resolvedTools =
    configuredTools.length > 0 ? configuredTools : [...DEFAULT_EXA_TOOLS];

  // Preserve legacy tools, but also surface the current structured search method.
  if (
    resolvedTools.includes("deep_search_exa") &&
    !resolvedTools.includes("web_search_advanced_exa")
  ) {
    resolvedTools.push("web_search_advanced_exa");
  }

  return Array.from(new Set(resolvedTools));
}

const ENABLED_TOOLS = parseConfiguredTools(process.env.EXA_TOOLS);
const ENABLED_TOOL_SET = new Set(ENABLED_TOOLS);
const TOOLS_CONFIG = ENABLED_TOOLS.join(",");

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

function buildUpstreamHeaders(req: Request): Headers {
  const headers = new Headers();

  for (const [name, rawValue] of Object.entries(req.headers)) {
    if (rawValue === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    if (Array.isArray(rawValue)) {
      headers.set(name, rawValue.join(", "));
      continue;
    }

    headers.set(name, rawValue);
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/event-stream");
  }

  if (!headers.has("content-type") && req.method !== "GET" && req.method !== "HEAD") {
    headers.set("content-type", "application/json");
  }

  return headers;
}

function applyUpstreamHeaders(upstreamResponse: globalThis.Response, res: Response): void {
  for (const [name, value] of upstreamResponse.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    res.setHeader(name, value);
  }
}

function shouldUpgradeToAdvancedSearch(
  toolName: string,
  args: Record<string, unknown>
): boolean {
  if (!ENABLED_TOOL_SET.has("web_search_advanced_exa")) {
    return false;
  }

  if (toolName === "deep_search_exa") {
    return !hasStringValue(args.objective) && hasStringValue(args.query);
  }

  if (toolName !== "web_search_exa") {
    return false;
  }

  for (const key of ADVANCED_SEARCH_ARG_KEYS) {
    if (args[key] !== undefined) {
      return true;
    }
  }

  return false;
}

function rewriteToolCallRequest(body: unknown): unknown {
  if (Array.isArray(body)) {
    return body.map((item) => rewriteToolCallRequest(item));
  }

  if (!isObjectRecord(body) || body.method !== "tools/call" || !isObjectRecord(body.params)) {
    return body;
  }

  const toolName = body.params.name;
  const args = isObjectRecord(body.params.arguments) ? body.params.arguments : {};

  if (!hasStringValue(toolName) || !shouldUpgradeToAdvancedSearch(toolName, args)) {
    return body;
  }

  console.log("[exa-proxy] Rewriting tool call to web_search_advanced_exa", {
    originalToolName: toolName,
  });

  return {
    ...body,
    params: {
      ...body.params,
      name: "web_search_advanced_exa",
      arguments: args,
    },
  };
}

function getRequestedToolName(body: unknown): string | null {
  if (!isObjectRecord(body) || body.method !== "tools/call" || !isObjectRecord(body.params)) {
    return null;
  }

  return hasStringValue(body.params.name) ? body.params.name : null;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseExaSearchTextEntry(entry: string): Record<string, unknown> | null {
  const lines = entry
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2 || !lines[0]?.startsWith("Title: ") || !lines[1]?.startsWith("URL: ")) {
    return null;
  }

  const title = lines[0].slice("Title: ".length).trim();
  const url = lines[1].slice("URL: ".length).trim();
  const publishedLine = lines.find((line) => line.startsWith("Published: "));
  const authorLine = lines.find((line) => line.startsWith("Author: "));
  const highlightsIndex = lines.findIndex((line) => line === "Highlights:");
  const text =
    highlightsIndex >= 0
      ? lines.slice(highlightsIndex + 1).join("\n").trim()
      : lines.slice(2).join("\n").trim();

  if (title.length === 0 || url.length === 0 || text.length === 0) {
    return null;
  }

  return {
    title,
    url,
    publishedDate: publishedLine
      ? publishedLine.slice("Published: ".length).trim()
      : null,
    author: authorLine ? authorLine.slice("Author: ".length).trim() : null,
    text,
    snippet: text.length > 280 ? `${text.slice(0, 277)}...` : text,
  };
}

function parseExaSearchText(text: string): Record<string, unknown> | null {
  const normalized = text.trim();
  if (!normalized.startsWith("Title: ")) {
    return null;
  }

  const entries = normalized
    .split(/\n(?=Title:\s)/)
    .map((entry) => parseExaSearchTextEntry(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  if (entries.length === 0) {
    return null;
  }

  return {
    results: entries,
    resultCount: entries.length,
    rawText: normalized,
    normalizedByProxy: true,
  };
}

function extractSingleTextResult(responseBody: JsonRpcResponseBody): string | null {
  const content = responseBody.result?.content;
  if (!Array.isArray(content) || content.length !== 1) {
    return null;
  }

  const [block] = content;
  if (!isObjectRecord(block) || block.type !== "text" || !hasStringValue(block.text)) {
    return null;
  }

  return block.text;
}

function normalizeToolCallResponsePayload(
  payload: unknown,
  requestedToolName: string | null
): unknown {
  if (
    requestedToolName === null ||
    !EXA_TEXT_SEARCH_TOOLS.has(requestedToolName) ||
    !isObjectRecord(payload) ||
    !isObjectRecord(payload.result)
  ) {
    return payload;
  }

  if (payload.result.structuredContent !== undefined) {
    return payload;
  }

  const textResult = extractSingleTextResult(payload as JsonRpcResponseBody);
  if (!textResult) {
    return payload;
  }

  const parsedJson = tryParseJson(textResult);
  const structuredContent =
    (isObjectRecord(parsedJson) || Array.isArray(parsedJson))
      ? parsedJson
      : parseExaSearchText(textResult);

  if (!structuredContent) {
    return payload;
  }

  return {
    ...payload,
    result: {
      ...payload.result,
      structuredContent,
    },
  };
}

function parseSsePayload(bodyText: string): { eventName: string | null; payload: unknown } | null {
  const lines = bodyText.split("\n");
  let eventName: string | null = null;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const parsedPayload = tryParseJson(dataLines.join("\n"));
  if (parsedPayload === null) {
    return null;
  }

  return {
    eventName,
    payload: parsedPayload,
  };
}

function serializeSsePayload(payload: unknown, eventName: string | null): string {
  const lines: string[] = [];
  if (eventName) {
    lines.push(`event: ${eventName}`);
  }
  lines.push(`data: ${JSON.stringify(payload)}`);
  return `${lines.join("\n")}\n\n`;
}

function normalizeResponseBody(
  bodyText: string,
  contentType: string,
  requestedToolName: string | null
): string {
  if (!requestedToolName) {
    return bodyText;
  }

  if (contentType.includes("text/event-stream")) {
    const parsed = parseSsePayload(bodyText);
    if (!parsed) {
      return bodyText;
    }

    const normalizedPayload = normalizeToolCallResponsePayload(
      parsed.payload,
      requestedToolName
    );
    if (normalizedPayload === parsed.payload) {
      return bodyText;
    }

    return serializeSsePayload(normalizedPayload, parsed.eventName);
  }

  if (contentType.includes("application/json")) {
    const parsedPayload = tryParseJson(bodyText);
    if (parsedPayload === null) {
      return bodyText;
    }

    const normalizedPayload = normalizeToolCallResponsePayload(
      parsedPayload,
      requestedToolName
    );
    return normalizedPayload === parsedPayload
      ? bodyText
      : JSON.stringify(normalizedPayload);
  }

  return bodyText;
}

const app = express();

// Parse JSON bodies
app.use(express.json());

// Auth middleware using @ctxprotocol/sdk - 1 line!
const verifyContextAuth = createContextMiddleware();

// Health check endpoint
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "exa-ai-proxy",
    version: "1.1.0",
    tools: ENABLED_TOOLS,
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
    const rewrittenBody =
      req.method === "POST" ? rewriteToolCallRequest(req.body) : req.body;
    const requestedToolName =
      req.method === "POST" ? getRequestedToolName(rewrittenBody) : null;

    const fetchOptions: RequestInit = {
      method: req.method,
      headers: buildUpstreamHeaders(req),
    };

    if (req.method !== "GET" && req.method !== "HEAD" && rewrittenBody !== undefined) {
      fetchOptions.body = JSON.stringify(rewrittenBody);
    }

    const response = await fetch(exaUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";

    res.status(response.status);
    applyUpstreamHeaders(response, res);

    if (req.method === "POST") {
      const bodyText = await response.text();
      const normalizedBody = normalizeResponseBody(
        bodyText,
        contentType,
        requestedToolName
      );
      res.send(normalizedBody);
      return;
    }

    if (contentType.includes("text/event-stream") || contentType.includes("application/x-ndjson")) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            res.write(value);
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
  console.log(`\n🚀 Exa AI MCP Proxy Server v1.1.0`);
  console.log(`🔒 Context Protocol Security Enabled`);
  console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔗 Upstream: https://mcp.exa.ai/mcp`);
  console.log(`\n🛠️  Configured tools: ${TOOLS_CONFIG}\n`);
});


