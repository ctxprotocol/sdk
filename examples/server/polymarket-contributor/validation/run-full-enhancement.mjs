import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { ContextError } from "@ctxprotocol/sdk";
import { config as loadDotEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const LOCAL_MCP_URL = "http://localhost:4003/mcp";
const LOCAL_CONTEXT_BASE_URL = "http://localhost:3000";
const FREE_MODEL_ID = "google/gemini-3-flash-preview";
const WALL_TIMEOUT_MS = 360_000;
const MAX_TRANSIENT_QUERY_RETRIES = 2;
const TRANSIENT_QUERY_RETRY_BASE_DELAY_MS = 1_500;

const PROMPT_POOL_PATH = path.resolve(
  __dirname,
  "full-enhancement-prompt-pool.json"
);
const SDK_ENV_PATH = path.resolve(__dirname, "../../../../.env.local");
const CONTEXT_ENV_PATH = path.resolve(__dirname, "../../../../../context/.env.local");
const OUTPUT_DIR = __dirname;

loadDotEnv({ path: SDK_ENV_PATH, override: false });
loadDotEnv({ path: CONTEXT_ENV_PATH, override: false });

function normalizeEnvString(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function serializeError(error) {
  if (error instanceof ContextError) {
    return {
      name: error.name,
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
      ...(typeof error.statusCode === "number"
        ? { statusCode: error.statusCode }
        : {}),
    };
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    name: "UnknownError",
    message: String(error),
  };
}

const TRANSIENT_QUERY_ERROR_PATTERNS = [
  /auth_unavailable/iu,
  /api key authentication is temporarily unavailable/iu,
  /an error occurred while executing a database query/iu,
  /"code":"query_failed"/iu,
  /\bquery_failed\b/iu,
  /stream query failed with status 500/iu,
  /stream query failed with status 503/iu,
  /\betimedout\b/iu,
];

function isTransientQueryFailure(errorLike) {
  const message =
    errorLike && typeof errorLike === "object" && typeof errorLike.message === "string"
      ? errorLike.message
      : "";
  return TRANSIENT_QUERY_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function getTransientRetryDelayMs(attempt) {
  return TRANSIENT_QUERY_RETRY_BASE_DELAY_MS * 2 ** attempt;
}

function assertPresent(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      if (part.type === "text" && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
}

function extractSseJson(text) {
  const dataLines = text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);

  if (dataLines.length === 0) {
    return tryParseJson(text);
  }

  return tryParseJson(dataLines.join("\n"));
}

function parseSseEvents(text) {
  return text
    .split(/\r?\n\r?\n/u)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) =>
      chunk
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
    )
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .map((data) => tryParseJson(data))
    .filter((event) => event && typeof event === "object");
}

async function runDirectStreamingQuery({ apiKey, requestBody, idempotencyKey }) {
  const response = await fetch(`${LOCAL_CONTEXT_BASE_URL}/api/v1/query`, {
    method: "POST",
    headers: {
      accept: "text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      ...requestBody,
      stream: true,
    }),
    signal: AbortSignal.timeout(WALL_TIMEOUT_MS),
  });

  const payload = await response.text();
  if (!response.ok) {
    throw new Error(
      `Stream query failed with status ${String(response.status)}: ${payload.slice(0, 400)}`
    );
  }

  const events = parseSseEvents(payload);
  const finalDoneEvent = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "done" &&
        event.result &&
        typeof event.result === "object"
    );

  if (!finalDoneEvent) {
    throw new Error(
      `Missing done result in stream payload: ${payload.slice(-1000)}`
    );
  }

  return finalDoneEvent.result;
}

function hasConcreteDataSignals(answer) {
  if (typeof answer !== "string" || answer.trim().length === 0) {
    return false;
  }

  return (
    /[$€£]\s?\d/iu.test(answer) ||
    /\b\d+(?:\.\d+)?%/u.test(answer) ||
    /\b\d[\d,]*(?:\.\d+)?\b/u.test(answer) ||
    /\bliquidity\b|\bvolume\b|\bspread\b|\bslippage\b|\bodds\b|\bprobab/iu.test(answer)
  );
}

function hasCurrentFreshnessCue(answer) {
  return /right now|currently|as of|live|today|current|latest|recent/iu.test(answer);
}

function hasDecisionSignal(answer) {
  return /best|worst|rank|prefer|avoid|edge|tradable|liquid|cleanest|passive|conviction|risk\/reward/iu.test(
    answer
  );
}

function looksGeneric(answer) {
  return /cannot access live|can't access live|do not have real-time|i do not have access|it depends without current data/iu.test(
    answer
  );
}

function stripFetchedAt(value) {
  if (Array.isArray(value)) {
    return value.map(stripFetchedAt);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = Object.entries(value).filter(([key]) => key !== "fetchedAt");
  return Object.fromEntries(entries.map(([key, nested]) => [key, stripFetchedAt(nested)]));
}

function countMeaningfulNodes(value) {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countMeaningfulNodes(item), 0);
  }

  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (sum, item) => sum + countMeaningfulNodes(item),
      0
    );
  }

  if (typeof value === "string") {
    return value.trim().length > 0 ? 1 : 0;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? 1 : 0;
  }

  if (typeof value === "boolean") {
    return 1;
  }

  return 0;
}

function hasMeaningfulStructuredContent(structuredContent) {
  const normalized = stripFetchedAt(structuredContent);
  if (Array.isArray(normalized?.topSetups)) {
    return normalized.topSetups.length > 0;
  }

  if (countMeaningfulNodes(normalized) > 5) {
    return true;
  }

  if (!normalized || typeof normalized !== "object") {
    return false;
  }

  const knownListKeys = [
    "opportunities",
    "markets",
    "results",
    "bets",
    "events",
    "kalshiResults",
  ];
  const hasKnownList = knownListKeys.some((key) => Array.isArray(normalized[key]));
  if (!hasKnownList) {
    return false;
  }

  const hasSummary =
    typeof normalized.summary === "string" ||
    (normalized.summary && typeof normalized.summary === "object");
  const hasCountSignal =
    typeof normalized.count === "number" ||
    typeof normalized.totalCount === "number" ||
    (normalized.pagination &&
      typeof normalized.pagination === "object" &&
      typeof normalized.pagination.returned === "number") ||
    (normalized.summary &&
      typeof normalized.summary === "object" &&
      Object.values(normalized.summary).some((value) => typeof value === "number"));

  return hasSummary || hasCountSignal;
}

function extractFirstMarket(structuredContent) {
  const containers = [
    structuredContent?.markets,
    structuredContent?.results,
    structuredContent?.opportunities,
    structuredContent?.matchedMarkets,
  ];

  for (const container of containers) {
    if (Array.isArray(container) && container.length > 0) {
      const first = container[0];
      if (first && typeof first === "object") {
        const title =
          first.title ??
          first.market ??
          first.name ??
          first.question ??
          first.eventTitle ??
          null;
        const slug = first.slug ?? first.eventSlug ?? null;
        if (typeof title === "string" && title.trim().length > 0) {
          return {
            title: title.trim(),
            slug: typeof slug === "string" && slug.trim().length > 0 ? slug.trim() : null,
          };
        }
      }
    }
  }

  return null;
}

function buildToolText(result) {
  const structuredContentText =
    result.structuredContent && typeof result.structuredContent === "object"
      ? JSON.stringify(result.structuredContent, null, 2)
      : "";
  const text = extractTextParts(result.content);
  return [text, structuredContentText].filter(Boolean).join("\n").trim();
}

async function createMcpSession() {
  const response = await fetch(LOCAL_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "polymarket-full-enhancement",
          version: "1.0.0",
        },
      },
    }),
  });

  const sessionId = response.headers.get("mcp-session-id");
  const payload = await response.text();
  assertPresent(sessionId, `Missing MCP session id during initialize: ${payload}`);
  await fetch(LOCAL_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  return sessionId;
}

async function mcpJsonRpc(sessionId, method, params = {}) {
  const response = await fetch(LOCAL_MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method,
      params,
    }),
  });

  const text = await response.text();
  const json = extractSseJson(text);
  if (!json) {
    throw new Error(`Could not parse MCP response for ${method}: ${text}`);
  }
  if (json.error) {
    throw new Error(
      typeof json.error.message === "string"
        ? json.error.message
        : `Unknown MCP error for ${method}`
    );
  }
  return json.result;
}

async function listTools(sessionId) {
  const result = await mcpJsonRpc(sessionId, "tools/list", {});
  return Array.isArray(result.tools) ? result.tools : [];
}

async function callTool(sessionId, name, args) {
  const result = await mcpJsonRpc(sessionId, "tools/call", {
    name,
    arguments: args,
  });

  return {
    raw: result,
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent:
      result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent
        : null,
    text: buildToolText(result),
  };
}

function buildSurfaceTable(tools) {
  return tools.map((tool) => {
    const meta = tool && typeof tool._meta === "object" && tool._meta !== null ? tool._meta : {};
    const pricing =
      meta.pricing && typeof meta.pricing === "object" && meta.pricing !== null
        ? meta.pricing
        : {};
    return {
      methodName: tool.name,
      surface: typeof meta.surface === "string" ? meta.surface : "both",
      queryEligible: meta.queryEligible !== false,
      executeUsd:
        typeof pricing.executeUsd === "string" && pricing.executeUsd.trim().length > 0
          ? pricing.executeUsd.trim()
          : null,
      latencyClass:
        typeof meta.latencyClass === "string" ? meta.latencyClass : "unknown",
      contextRequirements: Array.isArray(meta.contextRequirements)
        ? meta.contextRequirements
        : [],
    };
  });
}

function resolveSurfaceClassification(surfaceTable) {
  const hasQuery = surfaceTable.some(
    (row) =>
      (row.surface === "answer" || row.surface === "both") &&
      row.queryEligible !== false
  );
  const hasExecute = surfaceTable.some(
    (row) =>
      (row.surface === "execute" || row.surface === "both") &&
      typeof row.executeUsd === "string" &&
      row.executeUsd.length > 0
  );

  if (hasQuery && hasExecute) {
    return "mixed";
  }
  if (hasQuery) {
    return "query-only";
  }
  if (hasExecute) {
    return "execute-only";
  }
  return "invalid";
}

function buildDirectChecks(promptId) {
  switch (promptId) {
    case "balanced-liquidity-screen":
      return [
        {
          toolName: "find_moderate_probability_bets",
          args: {
            minPrice: 0.4,
            maxPrice: 0.6,
            minLiquidity: 1_000_000,
            category: "all",
            sortBy: "liquidity",
            limit: 10,
          },
        },
      ];
    case "politics-passive-spread-capture":
      return [
        {
          toolName: "find_arbitrage_opportunities",
          args: { category: "politics", limit: 12 },
        },
      ];
    case "multi-outcome-exit-ladder":
      return [
        {
          toolName: "analyze_event_outcome_liquidity",
          args: {
            query:
              "Analyze the top four outcomes in the most liquid live multi-outcome politics event right now and estimate exit slippage for size.",
            category: "politics",
            limit: 4,
            sortBy: "volume",
          },
        },
      ];
    case "fed-whale-concentration-flow":
      return [
        {
          toolName: "analyze_single_market_whales",
          args: { marketQuery: "Fed rate decision", hoursBack: 24 },
        },
        {
          toolName: "analyze_whale_flow",
          args: { marketQuery: "Fed rate decision", hoursBack: 24 },
        },
      ];
    case "geopolitics-tape-read":
      return [
        {
          toolName: "summarize_live_market_activity",
          args: {
            category: "geopolitics",
            endingWithinDays: 14,
            sortBy: "volume",
            tradeLimit: 25,
          },
        },
      ];
    case "politics-conviction-workflow":
      return [
        {
          toolName: "build_high_conviction_workflow",
          args: {
            category: "politics",
            candidateCount: 6,
            topSetups: 3,
            includeWhaleFlow: true,
            hoursBack: 24,
          },
        },
      ];
    case "sports-book-verified-dislocation":
      return [
        {
          toolName: "find_arbitrage_opportunities",
          args: { category: "sports", limit: 12 },
        },
      ];
    case "iran-contract-family-map":
      return [
        {
          toolName: "search_markets",
          args: {
            query: "boots on the ground iran polymarket",
            status: "live",
            limit: 8,
          },
        },
      ];
    case "recent-trades-open-interest-signal":
      return [
        {
          toolName: "summarize_live_market_activity",
          args: {
            endingWithinDays: 10,
            sortBy: "ending_soon",
            tradeLimit: 20,
          },
        },
      ];
    case "tag-regime-liquidity":
      return [
        {
          toolName: "discover_trending_markets",
          args: {
            sortBy: "volume",
            limit: 10,
          },
        },
      ];
    case "lower-vol-thesis-expression":
      return [
        {
          toolName: "get_bets_by_probability",
          args: {
            likelihood: "likely",
            category: "politics",
            limit: 8,
          },
        },
      ];
    default:
      return [];
  }
}

async function runCrossrefChecks(sessionId) {
  const steps = [];
  const search = await callTool(sessionId, "search_markets", {
    query: "Trump election",
    category: "politics",
    status: "live",
    limit: 3,
  });
  steps.push({
    toolName: "search_markets",
    args: {
      query: "Trump election",
      category: "politics",
      status: "live",
      limit: 3,
    },
    ok: hasMeaningfulStructuredContent(search.structuredContent),
    textPreview: search.text.slice(0, 400),
    structuredKeys: search.structuredContent
      ? Object.keys(search.structuredContent)
      : [],
  });

  const firstMarket = extractFirstMarket(search.structuredContent);
  if (!firstMarket) {
    return steps;
  }

  const crossref = await callTool(sessionId, "polymarket_crossref_kalshi", {
    title: firstMarket.title,
    keywords: "Trump election presidency politics",
    ...(firstMarket.slug ? { polymarketSlug: firstMarket.slug } : {}),
    limit: 5,
  });
  steps.push({
    toolName: "polymarket_crossref_kalshi",
    args: {
      title: firstMarket.title,
      keywords: "Trump election presidency politics",
      ...(firstMarket.slug ? { polymarketSlug: firstMarket.slug } : {}),
      limit: 5,
    },
    ok: hasMeaningfulStructuredContent(crossref.structuredContent),
    textPreview: crossref.text.slice(0, 400),
    structuredKeys: crossref.structuredContent
      ? Object.keys(crossref.structuredContent)
      : [],
  });

  return steps;
}

async function runDirectAnswerability(sessionId, promptRecord) {
  if (promptRecord.id === "cross-venue-semantic-gap") {
    const steps = await runCrossrefChecks(sessionId);
    const passedCount = steps.filter((step) => step.ok).length;
    return {
      upstreamAnswerability:
        passedCount === steps.length
          ? "answerable"
          : passedCount > 0
            ? "partially_answerable"
            : "unanswerable_upstream",
      answerabilityNote:
        passedCount === steps.length
          ? "Live discovery produced a current Polymarket candidate and the Kalshi cross-reference step returned structured match data."
          : passedCount > 0
            ? "Polymarket discovery worked, but the cross-venue comparison step only partially resolved the answer path."
            : "The current direct MCP checks could not produce a usable cross-venue comparison path.",
      checks: steps,
    };
  }

  const plans = buildDirectChecks(promptRecord.id);
  const checks = [];

  for (const plan of plans) {
    try {
      const result = await callTool(sessionId, plan.toolName, plan.args);
      checks.push({
        toolName: plan.toolName,
        args: plan.args,
        ok: hasMeaningfulStructuredContent(result.structuredContent),
        textPreview: result.text.slice(0, 400),
        structuredKeys: result.structuredContent
          ? Object.keys(result.structuredContent)
          : [],
      });
    } catch (error) {
      checks.push({
        toolName: plan.toolName,
        args: plan.args,
        ok: false,
        error: serializeError(error),
      });
    }
    await sleep(250);
  }

  const passedCount = checks.filter((check) => check.ok).length;
  const upstreamAnswerability =
    passedCount === checks.length
      ? "answerable"
      : passedCount > 0
        ? "partially_answerable"
        : "unanswerable_upstream";

  const answerabilityNote =
    upstreamAnswerability === "answerable"
      ? "Direct MCP checks returned live structured data for the intended answer path."
      : upstreamAnswerability === "partially_answerable"
        ? "Direct MCP checks returned related live data, but the full buyer-facing answer still relies on synthesis or follow-up logic."
        : "The current direct MCP checks did not surface usable live data for this prompt.";

  return {
    upstreamAnswerability,
    answerabilityNote,
    checks,
  };
}

function extractOpenRouterText(value) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      if (typeof item.text === "string") {
        return item.text;
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

async function runFreeBaseline(prompt, apiKey) {
  const request = {
    model: FREE_MODEL_ID,
    messages: [{ role: "user", content: prompt }],
  };
  const startedAt = new Date().toISOString();
  const start = Date.now();

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": LOCAL_CONTEXT_BASE_URL,
        "X-Title": "Polymarket full enhancement validation",
      },
      body: JSON.stringify(request),
    });

    const latencyMs = Date.now() - start;
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${await response.text()}`);
    }

    const json = await response.json();
    const answer = extractOpenRouterText(json.choices?.[0]?.message?.content);
    return {
      evaluation: {
        answer,
        latencyMs,
        hasData: hasConcreteDataSignals(answer),
        fresh: !looksGeneric(answer) && hasCurrentFreshnessCue(answer),
        actionable: hasDecisionSignal(answer),
      },
      raw: {
        startedAt,
        latencyMs,
        request,
        response: json,
      },
    };
  } catch (error) {
    return {
      evaluation: {
        answer: "",
        latencyMs: Date.now() - start,
        hasData: false,
        fresh: false,
        actionable: false,
        error: serializeError(error),
      },
      raw: {
        startedAt,
        latencyMs: Date.now() - start,
        request,
        error: serializeError(error),
      },
    };
  }
}

async function runPaidPrompt(prompt, apiKey) {
  const startedAt = new Date().toISOString();
  const transport = "stream";

  for (let attempt = 0; attempt <= MAX_TRANSIENT_QUERY_RETRIES; attempt += 1) {
    const queryOptions = {
      query: prompt,
      tools: [TOOL_ID],
      responseShape: "answer_with_evidence",
      queryDepth: "deep",
      includeDeveloperTrace: true,
      clarificationPolicy: "return",
      idempotencyKey: randomUUID(),
    };
    const requestBody = {
      query: queryOptions.query,
      tools: queryOptions.tools,
      responseShape: queryOptions.responseShape,
      queryDepth: queryOptions.queryDepth,
      includeDeveloperTrace: queryOptions.includeDeveloperTrace,
      clarificationPolicy: queryOptions.clarificationPolicy,
      stream: true,
    };

    try {
      const result = await runDirectStreamingQuery({
        apiKey,
        requestBody,
        idempotencyKey: queryOptions.idempotencyKey,
      });

      const answer = result.response;
      const toolsUsed = Array.isArray(result.toolsUsed)
        ? result.toolsUsed.map((tool) => ({
            id: tool.id,
            name: tool.name,
            skillCalls: tool.skillCalls,
          }))
        : [];
      const toolCalls =
        result.developerTrace?.summary?.toolCalls ??
        toolsUsed.reduce((sum, tool) => sum + (tool.skillCalls ?? 0), 0);
      const outcomeType = result.outcomeType ?? "answer";
      const qualityScore = Math.max(
        0,
        Math.min(
          5,
          (outcomeType === "answer" ? 2 : 0) +
            (toolCalls > 0 ? 1 : 0) +
            (hasConcreteDataSignals(answer) ? 1 : 0) +
            (hasDecisionSignal(answer) ? 1 : 0) +
            (hasCurrentFreshnessCue(answer) ? 1 : 0) -
            (looksGeneric(answer) ? 2 : 0)
        )
      );

      if (toolCalls === 0 && attempt < MAX_TRANSIENT_QUERY_RETRIES) {
        const retryDelayMs = getTransientRetryDelayMs(attempt);
        console.log(
          `    answer returned without tool calls; retrying in ${retryDelayMs}ms`
        );
        await sleep(retryDelayMs);
        continue;
      }

      return {
        evaluation: {
          answer,
          latencyMs: result.durationMs,
          transport,
          outcomeType,
          toolCalls,
          toolsUsed,
          developerTraceSummary: result.developerTrace?.summary ?? null,
          dataUrl:
            typeof result.dataUrl === "string" && result.dataUrl.length > 0
              ? result.dataUrl
              : null,
          hasData: hasConcreteDataSignals(answer),
          actionable: hasDecisionSignal(answer),
          fresh:
            hasCurrentFreshnessCue(answer) ||
            /current|latest|right now|as of|today|fetched|updated/iu.test(answer),
          looksGeneric: looksGeneric(answer),
          qualityScore,
        },
        raw: {
          startedAt,
          transport,
          queryOptions,
          requestBody,
          result,
          retryCount: attempt,
        },
      };
    } catch (error) {
      const serialized = serializeError(error);
      const shouldRetry =
        attempt < MAX_TRANSIENT_QUERY_RETRIES && isTransientQueryFailure(serialized);

      if (shouldRetry) {
        const retryDelayMs = getTransientRetryDelayMs(attempt);
        console.log(
          `    transient local query failure (${serialized.message}); retrying in ${retryDelayMs}ms`
        );
        await sleep(retryDelayMs);
        continue;
      }

      return {
        evaluation: {
          answer: "",
          latencyMs: null,
          transport,
          outcomeType: /timeout/iu.test(serialized.message) ? "timeout" : "error",
          toolCalls: 0,
          toolsUsed: [],
          developerTraceSummary: null,
          dataUrl: null,
          hasData: false,
          actionable: false,
          fresh: false,
          looksGeneric: true,
          qualityScore: 0,
          error: serialized,
        },
        raw: {
          startedAt,
          transport,
          queryOptions,
          requestBody,
          error: serialized,
          retryCount: attempt,
        },
      };
    }
  }
}

function classifyDifferentiation(freeEvaluation, paidEvaluation) {
  if (paidEvaluation.outcomeType !== "answer" || paidEvaluation.toolCalls === 0) {
    return "low_differentiation";
  }

  if (
    freeEvaluation.error ||
    !freeEvaluation.hasData ||
    !freeEvaluation.fresh ||
    looksGeneric(freeEvaluation.answer)
  ) {
    return "high_differentiation";
  }

  if (
    paidEvaluation.qualityScore >= 4 &&
    (!freeEvaluation.actionable || !hasDecisionSignal(freeEvaluation.answer))
  ) {
    return "moderate_differentiation";
  }

  if (
    paidEvaluation.qualityScore > 0 &&
    paidEvaluation.qualityScore > (freeEvaluation.hasData ? 2 : 1)
  ) {
    return "moderate_differentiation";
  }

  return "low_differentiation";
}

function determinePromptStatus(paidEvaluation) {
  return (
    paidEvaluation.outcomeType === "answer" &&
    paidEvaluation.toolCalls > 0 &&
    paidEvaluation.qualityScore >= 4 &&
    paidEvaluation.looksGeneric !== true
  );
}

function buildComparisonNote(promptRecord, answerability, freeEvaluation, paidEvaluation) {
  if (answerability.upstreamAnswerability === "unanswerable_upstream") {
    return "Direct MCP checks could not prove a reliable live answer path for this prompt.";
  }

  if (paidEvaluation.outcomeType === "clarification_required") {
    return "Paid query asked for clarification instead of landing the live answer.";
  }

  if (paidEvaluation.outcomeType === "timeout") {
    return "Paid query timed out before completing the answer.";
  }

  if (freeEvaluation.error || !freeEvaluation.hasData || !freeEvaluation.fresh) {
    return "The free Gemini baseline did not land fresh venue-specific data, while the paid query had a live tool-backed answer path.";
  }

  if (!freeEvaluation.actionable && paidEvaluation.actionable) {
    return "The free Gemini baseline was generic, while the paid query was more decision-ready and trader-specific.";
  }

  return `${promptRecord.id} stayed closer to parity than expected; the paid answer still needs to prove stronger separation on current specificity and actionability.`;
}

function summarizeRuns(promptRuns) {
  const total = promptRuns.length;
  const passed = promptRuns.filter((run) => run.status === "pass").length;
  const mustWinRuns = promptRuns.filter((run) => run.mustWin);
  const mustWinPassed = mustWinRuns.filter((run) => run.status === "pass").length;
  const differentiationCounts = {
    high: promptRuns.filter(
      (run) => run.differentiation === "high_differentiation"
    ).length,
    moderate: promptRuns.filter(
      (run) => run.differentiation === "moderate_differentiation"
    ).length,
    low: promptRuns.filter((run) => run.differentiation === "low_differentiation")
      .length,
  };

  return {
    totalPrompts: total,
    passedPrompts: passed,
    passRate: total === 0 ? 0 : Number((passed / total).toFixed(4)),
    mustWinPromptCount: mustWinRuns.length,
    mustWinPassedPrompts: mustWinPassed,
    mustWinPassRate:
      mustWinRuns.length === 0
        ? 0
        : Number((mustWinPassed / mustWinRuns.length).toFixed(4)),
    differentiationCounts,
    baselineBeatenRate:
      mustWinRuns.length === 0
        ? 0
        : Number(
            (
              mustWinRuns.filter((run) => run.differentiation !== "low_differentiation")
                .length / mustWinRuns.length
            ).toFixed(4)
          ),
  };
}

async function writeProgressCheckpoint(params) {
  const progressPath = path.join(
    OUTPUT_DIR,
    "full-enhancement-progress.latest.json"
  );
  const checkpoint = {
    generatedAt: new Date().toISOString(),
    runType: "full-enhancement",
    toolId: TOOL_ID,
    localMcpUrl: LOCAL_MCP_URL,
    localContextBaseUrl: LOCAL_CONTEXT_BASE_URL,
    freeModelId: FREE_MODEL_ID,
    surfaceClassification: params.surfaceClassification,
    surfaceTable: params.surfaceTable,
    promptPoolSource: path.basename(PROMPT_POOL_PATH),
    completedPrompts: params.promptRuns.length,
    totalPrompts: params.totalPrompts,
    latestPromptId: params.latestPromptId,
    promptRuns: params.promptRuns,
    summary: summarizeRuns(params.promptRuns),
    rawPromptRuns: params.rawPromptRuns,
  };

  await writeFile(progressPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
}

async function main() {
  const contextApiKey = normalizeEnvString(process.env.CONTEXT_API_KEY);
  const openRouterApiKey = normalizeEnvString(process.env.OPENROUTER_API_KEY);

  assertPresent(contextApiKey, "Missing CONTEXT_API_KEY in context-sdk/.env.local");
  assertPresent(openRouterApiKey, "Missing OPENROUTER_API_KEY in context/.env.local");

  const promptPool = JSON.parse(await readFile(PROMPT_POOL_PATH, "utf8"));
  const sessionId = await createMcpSession();
  const tools = await listTools(sessionId);
  const surfaceTable = buildSurfaceTable(tools);
  const surfaceClassification = resolveSurfaceClassification(surfaceTable);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const promptRuns = [];
  const rawPromptRuns = [];

  for (let index = 0; index < promptPool.length; index += 1) {
    const promptRecord = promptPool[index];
    console.log(`\n[${index + 1}/${promptPool.length}] ${promptRecord.id}`);

    console.log("  direct MCP answerability...");
    const answerability = await runDirectAnswerability(sessionId, promptRecord);
    await sleep(300);

    console.log("  free Gemini baseline...");
    const freeRun = await runFreeBaseline(promptRecord.prompt, openRouterApiKey);
    await sleep(300);

    console.log("  paid local query...");
    const paidRun = await runPaidPrompt(promptRecord.prompt, contextApiKey);

    const differentiation = classifyDifferentiation(
      freeRun.evaluation,
      paidRun.evaluation
    );
    const status = determinePromptStatus(paidRun.evaluation) ? "pass" : "fail";

    promptRuns.push({
      id: promptRecord.id,
      prompt: promptRecord.prompt,
      mustWin: promptRecord.mustWin,
      category: promptRecord.category,
      alphaCategory: promptRecord.alphaCategory,
      showcaseCandidate: promptRecord.showcaseCandidate === true,
      status,
      transport: paidRun.evaluation.transport,
      qualityScore: paidRun.evaluation.qualityScore,
      latencyMs: paidRun.evaluation.latencyMs,
      toolsUsed: paidRun.evaluation.toolsUsed,
      toolCalls: paidRun.evaluation.toolCalls,
      outcomeType: paidRun.evaluation.outcomeType,
      upstreamAnswerability: answerability.upstreamAnswerability,
      answerabilityNote: answerability.answerabilityNote,
      differentiation,
      freeLlmBaselineBeaten: differentiation !== "low_differentiation",
      comparisonNote: buildComparisonNote(
        promptRecord,
        answerability,
        freeRun.evaluation,
        paidRun.evaluation
      ),
      freeBaseline: {
        modelId: FREE_MODEL_ID,
        answerPreview: freeRun.evaluation.answer.slice(0, 500),
        hasData: freeRun.evaluation.hasData,
        fresh: freeRun.evaluation.fresh,
        actionable: freeRun.evaluation.actionable,
        latencyMs: freeRun.evaluation.latencyMs,
        ...(freeRun.evaluation.error ? { error: freeRun.evaluation.error } : {}),
      },
      paidQuery: {
        answerPreview: paidRun.evaluation.answer.slice(0, 500),
        transport: paidRun.evaluation.transport,
        hasData: paidRun.evaluation.hasData,
        fresh: paidRun.evaluation.fresh,
        actionable: paidRun.evaluation.actionable,
        looksGeneric: paidRun.evaluation.looksGeneric,
        developerTraceSummary: paidRun.evaluation.developerTraceSummary,
        dataUrl: paidRun.evaluation.dataUrl,
        ...(paidRun.evaluation.error ? { error: paidRun.evaluation.error } : {}),
      },
    });

    rawPromptRuns.push({
      id: promptRecord.id,
      prompt: promptRecord.prompt,
      category: promptRecord.category,
      alphaCategory: promptRecord.alphaCategory,
      showcaseCandidate: promptRecord.showcaseCandidate === true,
      mustWin: promptRecord.mustWin,
      whyUsersCare: promptRecord.whyUsersCare,
      whyWebSearchBaselineWeak: promptRecord.whyWebSearchBaselineWeak,
      upstreamDataFields: promptRecord.upstreamDataFields,
      synthesisRequired: promptRecord.synthesisRequired,
      expectedMethods: promptRecord.expectedMethods,
      answerability,
      freeRun: freeRun.raw,
      paidRun: paidRun.raw,
    });

    await writeProgressCheckpoint({
      surfaceClassification,
      surfaceTable,
      promptRuns,
      rawPromptRuns,
      totalPrompts: promptPool.length,
      latestPromptId: promptRecord.id,
    });

    const errorSummary = paidRun.evaluation.error
      ? ` error=${paidRun.evaluation.error.message}`
      : "";
    console.log(
      `  status=${status} transport=${paidRun.evaluation.transport} outcome=${paidRun.evaluation.outcomeType} latencyMs=${String(
        paidRun.evaluation.latencyMs
      )} answerability=${answerability.upstreamAnswerability} differentiation=${differentiation} toolCalls=${paidRun.evaluation.toolCalls}${errorSummary}`
    );
    await sleep(500);
  }

  const summary = summarizeRuns(promptRuns);
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const latestPath = path.join(OUTPUT_DIR, "full-enhancement-results.latest.json");
  const timestampedPath = path.join(
    OUTPUT_DIR,
    `full-enhancement-results-${timestamp}.json`
  );

  const output = {
    generatedAt: new Date().toISOString(),
    runType: "full-enhancement",
    toolId: TOOL_ID,
    localMcpUrl: LOCAL_MCP_URL,
    localContextBaseUrl: LOCAL_CONTEXT_BASE_URL,
    freeModelId: FREE_MODEL_ID,
    surfaceClassification,
    surfaceTable,
    promptPoolSource: path.basename(PROMPT_POOL_PATH),
    promptRuns,
    summary,
    rawPromptRuns,
  };

  await writeFile(latestPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await writeFile(timestampedPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log("\nSaved:");
  console.log(`  ${latestPath}`);
  console.log(`  ${timestampedPath}`);
  console.log(
    `Pass rate: ${Math.round(summary.passRate * 100)}% (${summary.passedPrompts}/${summary.totalPrompts})`
  );
  console.log(
    `Must-win baseline beaten rate: ${Math.round(summary.baselineBeatenRate * 100)}%`
  );
}

void main().catch((error) => {
  const serialized = serializeError(error);
  console.error(serialized.message);
  process.exitCode = 1;
});
