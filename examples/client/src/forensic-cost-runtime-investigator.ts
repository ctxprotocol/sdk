import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type RunMode = "manual" | "auto" | "execute";

type ToolUsage = {
  id: string;
  name: string;
  skillCalls: number;
};

type TraceSummary = {
  toolCalls: number;
  retryCount: number;
  selfHealCount: number;
  loopCount: number;
  failureCount: number;
  recoveryCount: number;
  completionChecks: number;
  timelineLength: number;
};

type ImportTraceHit = {
  stepType: string;
  traceStatus: string;
  traceMessage: string;
};

type DeveloperTraceStep = {
  stepType?: string;
  event?: string;
  status?: string;
  message?: string;
  tool?: {
    id?: string;
    name?: string;
    method?: string;
  };
};

type DeveloperTrace = {
  summary?: {
    toolCalls?: number;
    retryCount?: number;
    selfHealCount?: number;
    loopCount?: number;
    failureCount?: number;
    recoveryCount?: number;
    completionChecks?: number;
  };
  timeline?: DeveloperTraceStep[];
};

type QuerySuccessResponse = {
  success: true;
  response: string;
  toolsUsed: ToolUsage[];
  cost: {
    modelCostUsd: string;
    toolCostUsd: string;
    totalCostUsd: string;
  };
  durationMs: number;
  developerTrace?: DeveloperTrace;
};

type ApiErrorResponse = {
  error: string;
  code?: string;
  helpUrl?: string;
};

type ExecuteSession = {
  mode: "execute";
  sessionId: string | null;
  methodPrice: string;
  spent: string;
  remaining: string | null;
  maxSpend: string | null;
  status?: string;
  expiresAt?: string;
  closeRequested?: boolean;
  pendingAccruedCount?: number;
  pendingAccruedUsd?: string;
};

type ExecuteSuccessResponse = {
  success: true;
  mode: "execute";
  result: unknown;
  tool: {
    id: string;
    name: string;
  };
  method: {
    name: string;
    executePriceUsd: string;
  };
  session: ExecuteSession;
  durationMs: number;
};

type ExecuteSessionSuccessResponse = {
  success: true;
  mode: "execute";
  session: ExecuteSession;
};

type ForensicRecord = {
  timestamp_utc: string;
  request_index: number;
  idempotency_key: string | "none";
  mode: RunMode;
  prompt: string;
  pinned_tool_ids: string[];
  tools_used: ToolUsage[];
  external_tools_used: ToolUsage[];
  modelCostUsd: string;
  toolCostUsd: string;
  totalCostUsd: string;
  developer_trace_summary: TraceSummary | null;
  import_trace_hits: ImportTraceHit[];
  wallet_before_usd: number | null;
  wallet_after_usd: number | null;
  observed_delta_usd: number | null;
  discrepancy_usd: number | null;
  retries: number;
  loops: number;
  execute_session_id: string | null;
  execute_session_spent_before_usd: number | null;
  execute_session_spent_after_usd: number | null;
  execute_session_pending_before_usd: number | null;
  execute_session_pending_after_usd: number | null;
  response_status: number;
  response_error_code?: string;
  response_error_message?: string;
  evidence_artifact: string;
};

type QueryCase = {
  mode: "manual" | "auto";
  prompt: string;
  pinnedToolIds: string[];
};

type ExecuteCase = {
  prompt: string;
  toolId: string;
  toolName: string;
  args: Record<string, unknown>;
  sessionKey: "kalshi" | "polymarket";
};

const BASE_URL = process.env.CONTEXT_BASE_URL ?? "https://www.ctxprotocol.com";
const API_KEY = process.env.CONTEXT_API_KEY;
if (!API_KEY) {
  throw new Error("Set CONTEXT_API_KEY before running this script.");
}

const KALSHI_TOOL_ID = "5cc326fb-500d-4c17-bc5f-ade143210636";
const POLYMARKET_TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const ODDS_API_TOOL_ID = "43979b21-bce9-4d49-9ddf-d7ad69722056";

const PROBLEM_PROMPT_A =
  "What is the sentiment and price trend for the top Trump tariffs market over the last 24 hours?";
const PROBLEM_PROMPT_B =
  "Browse the Sports category sorted by volume and cross-reference the top result with Polymarket odds";

const REPEAT_COUNT = Number(process.env.FORENSIC_REPEAT_COUNT ?? "4");

const OUTPUT_JSONL_PATH = resolve(
  process.cwd(),
  process.env.FORENSIC_JSONL_PATH ?? "forensic-query-execute-ledger.jsonl"
);
const OUTPUT_SUMMARY_PATH = resolve(
  process.cwd(),
  process.env.FORENSIC_SUMMARY_PATH ?? "forensic-query-execute-summary.json"
);
const ARTIFACT_DIR = resolve(
  process.cwd(),
  process.env.FORENSIC_ARTIFACT_DIR ?? "forensic-artifacts"
);

function parseUsd(value: string | undefined | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWalletFromText(text: string | undefined): number | null {
  if (!text) {
    return null;
  }
  const match = text.match(/You have \\$(\\d+(?:\\.\\d+)?)/i);
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function countTraceSteps(trace: DeveloperTrace | undefined, key: string): number {
  const timeline = trace?.timeline ?? [];
  return timeline.filter((step) => step.stepType === key || step.event === key).length;
}

function summarizeTrace(trace: DeveloperTrace | undefined): TraceSummary | null {
  if (!trace) {
    return null;
  }
  const timeline = trace.timeline ?? [];
  const summary = trace.summary;
  return {
    toolCalls: summary?.toolCalls ?? countTraceSteps(trace, "tool-call"),
    retryCount: summary?.retryCount ?? countTraceSteps(trace, "retry"),
    selfHealCount: summary?.selfHealCount ?? countTraceSteps(trace, "self-heal"),
    loopCount: summary?.loopCount ?? countTraceSteps(trace, "loop"),
    failureCount: summary?.failureCount ?? countTraceSteps(trace, "failure"),
    recoveryCount: summary?.recoveryCount ?? countTraceSteps(trace, "recovery"),
    completionChecks:
      summary?.completionChecks ?? countTraceSteps(trace, "completion-check"),
    timelineLength: timeline.length,
  };
}

function collectImportTraceHits(trace: DeveloperTrace | undefined): ImportTraceHit[] {
  if (!trace?.timeline?.length) {
    return [];
  }
  const hits: ImportTraceHit[] = [];
  for (const step of trace.timeline) {
    const message = typeof step.message === "string" ? step.message : "";
    if (!message.includes('@lib/ai/skills/mcp')) {
      continue;
    }
    hits.push({
      stepType: step.stepType ?? step.event ?? "unknown",
      traceStatus: step.status ?? "unknown",
      traceMessage: message,
    });
  }
  return hits;
}

function inferExternalTools(
  toolsUsed: ToolUsage[],
  pinnedToolIds: string[]
): ToolUsage[] {
  if (pinnedToolIds.length === 0) {
    return toolsUsed;
  }
  const pinned = new Set(pinnedToolIds);
  return toolsUsed.filter((tool) => !pinned.has(tool.id));
}

async function httpJson(
  endpoint: string,
  options: {
    method: "GET" | "POST";
    idempotencyKey?: string;
    body?: Record<string, unknown>;
  }
): Promise<{
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  parsedBody: unknown;
}> {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    method: options.method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      ...(options.idempotencyKey
        ? { "Idempotency-Key": options.idempotencyKey }
        : {}),
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });

  const rawBody = await response.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = rawBody;
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of response.headers.entries()) {
    headers[key] = value;
  }

  return {
    status: response.status,
    headers,
    rawBody,
    parsedBody,
  };
}

async function writeArtifact(
  requestIndex: number,
  slug: string,
  payload: Record<string, unknown>
): Promise<string> {
  const path = resolve(ARTIFACT_DIR, `request-${requestIndex}-${slug}.json`);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

function toToolUsageArray(value: unknown): ToolUsage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: ToolUsage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const name = typeof record.name === "string" ? record.name : "";
    const skillCallsRaw = record.skillCalls;
    const skillCalls =
      typeof skillCallsRaw === "number" && Number.isFinite(skillCallsRaw)
        ? skillCallsRaw
        : 0;
    if (!id || !name) {
      continue;
    }
    normalized.push({ id, name, skillCalls });
  }
  return normalized;
}

function asErrorResponse(body: unknown): ApiErrorResponse | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.error !== "string") {
    return null;
  }
  return {
    error: record.error,
    code: typeof record.code === "string" ? record.code : undefined,
    helpUrl: typeof record.helpUrl === "string" ? record.helpUrl : undefined,
  };
}

function asQuerySuccess(body: unknown): QuerySuccessResponse | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.success !== true || typeof record.response !== "string") {
    return null;
  }
  const costRecord =
    record.cost && typeof record.cost === "object"
      ? (record.cost as Record<string, unknown>)
      : null;
  if (!costRecord) {
    return null;
  }
  if (
    typeof costRecord.modelCostUsd !== "string" ||
    typeof costRecord.toolCostUsd !== "string" ||
    typeof costRecord.totalCostUsd !== "string"
  ) {
    return null;
  }
  return {
    success: true,
    response: record.response,
    toolsUsed: toToolUsageArray(record.toolsUsed),
    cost: {
      modelCostUsd: costRecord.modelCostUsd,
      toolCostUsd: costRecord.toolCostUsd,
      totalCostUsd: costRecord.totalCostUsd,
    },
    durationMs:
      typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
        ? record.durationMs
        : 0,
    developerTrace:
      record.developerTrace && typeof record.developerTrace === "object"
        ? (record.developerTrace as DeveloperTrace)
        : undefined,
  };
}

function asExecuteSuccess(body: unknown): ExecuteSuccessResponse | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.success !== true || record.mode !== "execute") {
    return null;
  }
  const tool = record.tool as Record<string, unknown> | undefined;
  const method = record.method as Record<string, unknown> | undefined;
  const session = record.session as Record<string, unknown> | undefined;
  if (!tool || !method || !session) {
    return null;
  }
  if (
    typeof tool.id !== "string" ||
    typeof tool.name !== "string" ||
    typeof method.name !== "string" ||
    typeof method.executePriceUsd !== "string" ||
    typeof session.mode !== "string"
  ) {
    return null;
  }
  return {
    success: true,
    mode: "execute",
    result: record.result,
    tool: {
      id: tool.id,
      name: tool.name,
    },
    method: {
      name: method.name,
      executePriceUsd: method.executePriceUsd,
    },
    session: {
      mode: "execute",
      sessionId: typeof session.sessionId === "string" ? session.sessionId : null,
      methodPrice: typeof session.methodPrice === "string" ? session.methodPrice : "0",
      spent: typeof session.spent === "string" ? session.spent : "0",
      remaining: typeof session.remaining === "string" ? session.remaining : null,
      maxSpend: typeof session.maxSpend === "string" ? session.maxSpend : null,
      status: typeof session.status === "string" ? session.status : undefined,
      expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : undefined,
      closeRequested:
        typeof session.closeRequested === "boolean" ? session.closeRequested : undefined,
      pendingAccruedCount:
        typeof session.pendingAccruedCount === "number"
          ? session.pendingAccruedCount
          : undefined,
      pendingAccruedUsd:
        typeof session.pendingAccruedUsd === "string" ? session.pendingAccruedUsd : undefined,
    },
    durationMs:
      typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
        ? record.durationMs
        : 0,
  };
}

function asExecuteSessionSuccess(body: unknown): ExecuteSessionSuccessResponse | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (record.success !== true || record.mode !== "execute") {
    return null;
  }
  const session = record.session as Record<string, unknown> | undefined;
  if (!session) {
    return null;
  }
  if (
    typeof session.mode !== "string" ||
    typeof session.methodPrice !== "string" ||
    typeof session.spent !== "string"
  ) {
    return null;
  }
  return {
    success: true,
    mode: "execute",
    session: {
      mode: "execute",
      sessionId: typeof session.sessionId === "string" ? session.sessionId : null,
      methodPrice: session.methodPrice,
      spent: session.spent,
      remaining: typeof session.remaining === "string" ? session.remaining : null,
      maxSpend: typeof session.maxSpend === "string" ? session.maxSpend : null,
      status: typeof session.status === "string" ? session.status : undefined,
      expiresAt: typeof session.expiresAt === "string" ? session.expiresAt : undefined,
      closeRequested:
        typeof session.closeRequested === "boolean" ? session.closeRequested : undefined,
      pendingAccruedCount:
        typeof session.pendingAccruedCount === "number"
          ? session.pendingAccruedCount
          : undefined,
      pendingAccruedUsd:
        typeof session.pendingAccruedUsd === "string" ? session.pendingAccruedUsd : undefined,
    },
  };
}

function buildQueryCases(): QueryCase[] {
  const cases: QueryCase[] = [
    {
      mode: "manual",
      prompt: "What are the top 5 prediction markets by volume right now?",
      pinnedToolIds: [POLYMARKET_TOOL_ID],
    },
    {
      mode: "auto",
      prompt: "What are the top 5 prediction markets by volume right now?",
      pinnedToolIds: [],
    },
    {
      mode: "manual",
      prompt: "What are the top 10 most actively traded markets on Kalshi right now?",
      pinnedToolIds: [KALSHI_TOOL_ID],
    },
    {
      mode: "auto",
      prompt: "What are the top 10 most actively traded markets on Kalshi right now?",
      pinnedToolIds: [],
    },
    {
      mode: "manual",
      prompt: "Compare the Polymarket odds vs Kalshi odds on the next Fed meeting outcome",
      pinnedToolIds: [POLYMARKET_TOOL_ID],
    },
    {
      mode: "auto",
      prompt: "Compare the Polymarket odds vs Kalshi odds on the next Fed meeting outcome",
      pinnedToolIds: [],
    },
  ];

  for (let i = 0; i < REPEAT_COUNT; i += 1) {
    cases.push(
      {
        mode: "manual",
        prompt: PROBLEM_PROMPT_A,
        pinnedToolIds: [KALSHI_TOOL_ID],
      },
      {
        mode: "auto",
        prompt: PROBLEM_PROMPT_A,
        pinnedToolIds: [],
      },
      {
        mode: "manual",
        prompt: PROBLEM_PROMPT_B,
        pinnedToolIds: [KALSHI_TOOL_ID],
      },
      {
        mode: "auto",
        prompt: PROBLEM_PROMPT_B,
        pinnedToolIds: [],
      }
    );
  }

  return cases;
}

function buildExecuteCases(): ExecuteCase[] {
  return [
    {
      prompt: "execute:get_events(limit=1) on Kalshi",
      toolId: KALSHI_TOOL_ID,
      toolName: "get_events",
      args: { limit: 1 },
      sessionKey: "kalshi",
    },
    {
      prompt: "execute:get_markets(limit=1) on Kalshi",
      toolId: KALSHI_TOOL_ID,
      toolName: "get_markets",
      args: { limit: 1 },
      sessionKey: "kalshi",
    },
    {
      prompt: "execute:get_events(limit=1) on Polymarket",
      toolId: POLYMARKET_TOOL_ID,
      toolName: "get_events",
      args: { limit: 1 },
      sessionKey: "polymarket",
    },
    {
      prompt: "execute:get_top_markets(limit=1) on Polymarket",
      toolId: POLYMARKET_TOOL_ID,
      toolName: "get_top_markets",
      args: { limit: 1 },
      sessionKey: "polymarket",
    },
  ];
}

async function main(): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });

  const records: ForensicRecord[] = [];
  let requestIndex = 1;
  let lastKnownWalletUsd: number | null = null;

  const sessionsByKey: Record<"kalshi" | "polymarket", string | null> = {
    kalshi: null,
    polymarket: null,
  };

  const startedJsonl = {
    generatedAt: new Date().toISOString(),
    note: "forensic-query-execute-ledger",
    oddsApiToolId: ODDS_API_TOOL_ID,
    queryRepeatCount: REPEAT_COUNT,
  };
  await writeFile(OUTPUT_JSONL_PATH, `${JSON.stringify(startedJsonl)}\n`, "utf8");

  const queryCases = buildQueryCases();
  for (const queryCase of queryCases) {
    const idempotencyKey = randomUUID();
    const walletBefore = lastKnownWalletUsd;
    const body: Record<string, unknown> = {
      query: queryCase.prompt,
      queryDepth: "deep",
      includeData: true,
      includeDeveloperTrace: true,
      stream: false,
      ...(queryCase.mode === "manual" ? { tools: queryCase.pinnedToolIds } : {}),
    };

    const response = await httpJson("/api/v1/query", {
      method: "POST",
      idempotencyKey,
      body,
    });
    const success = asQuerySuccess(response.parsedBody);
    const error = asErrorResponse(response.parsedBody);

    const toolsUsed = success?.toolsUsed ?? [];
    const externalToolsUsed = inferExternalTools(toolsUsed, queryCase.pinnedToolIds);
    const traceSummary = summarizeTrace(success?.developerTrace);
    const importTraceHits = collectImportTraceHits(success?.developerTrace);
    const retries = traceSummary?.retryCount ?? 0;
    const loops = traceSummary?.loopCount ?? 0;

    const errorMessage = error?.error;
    const walletFromError = parseWalletFromText(errorMessage);
    if (walletFromError !== null) {
      lastKnownWalletUsd = walletFromError;
    }

    const walletAfter = lastKnownWalletUsd;
    const observedDelta =
      walletBefore !== null && walletAfter !== null
        ? walletBefore - walletAfter
        : null;
    const totalCostUsd = success?.cost.totalCostUsd ?? "0";
    const totalCostNum = parseUsd(totalCostUsd) ?? 0;
    const discrepancy =
      observedDelta === null ? null : observedDelta - totalCostNum;

    const evidencePath = await writeArtifact(requestIndex, "query", {
      request: {
        endpoint: "/api/v1/query",
        method: "POST",
        idempotencyKey,
        body,
      },
      response,
    });

    const record: ForensicRecord = {
      timestamp_utc: new Date().toISOString(),
      request_index: requestIndex,
      idempotency_key: idempotencyKey,
      mode: queryCase.mode,
      prompt: queryCase.prompt,
      pinned_tool_ids: queryCase.pinnedToolIds,
      tools_used: toolsUsed,
      external_tools_used: externalToolsUsed,
      modelCostUsd: success?.cost.modelCostUsd ?? "0",
      toolCostUsd: success?.cost.toolCostUsd ?? "0",
      totalCostUsd,
      developer_trace_summary: traceSummary,
      import_trace_hits: importTraceHits,
      wallet_before_usd: walletBefore,
      wallet_after_usd: walletAfter,
      observed_delta_usd: observedDelta,
      discrepancy_usd: discrepancy,
      retries,
      loops,
      execute_session_id: null,
      execute_session_spent_before_usd: null,
      execute_session_spent_after_usd: null,
      execute_session_pending_before_usd: null,
      execute_session_pending_after_usd: null,
      response_status: response.status,
      ...(error?.code ? { response_error_code: error.code } : {}),
      ...(errorMessage ? { response_error_message: errorMessage } : {}),
      evidence_artifact: evidencePath,
    };

    records.push(record);
    await writeFile(
      OUTPUT_JSONL_PATH,
      `${JSON.stringify(record)}\n`,
      {
        encoding: "utf8",
        flag: "a",
      }
    );

    requestIndex += 1;
  }

  async function ensureSession(sessionKey: "kalshi" | "polymarket"): Promise<string> {
    const existing = sessionsByKey[sessionKey];
    if (existing) {
      return existing;
    }
    const started = await httpJson("/api/v1/tools/execute/sessions", {
      method: "POST",
      body: {
        mode: "execute",
        maxSpendUsd: "0.050000",
      },
    });
    const parsed = asExecuteSessionSuccess(started.parsedBody);
    const sessionId = parsed?.session.sessionId;
    if (!sessionId) {
      throw new Error(
        `Failed to start execute session for ${sessionKey}: ${started.rawBody}`
      );
    }
    sessionsByKey[sessionKey] = sessionId;
    return sessionId;
  }

  async function getSessionSnapshot(sessionId: string): Promise<ExecuteSession | null> {
    const snapshot = await httpJson(`/api/v1/tools/execute/sessions/${encodeURIComponent(sessionId)}`, {
      method: "GET",
    });
    const parsed = asExecuteSessionSuccess(snapshot.parsedBody);
    return parsed?.session ?? null;
  }

  const executeCases = buildExecuteCases();
  for (let i = 0; i < executeCases.length; i += 1) {
    const executeCase = executeCases[i];
    const idempotencyKey = randomUUID();
    const sessionId = await ensureSession(executeCase.sessionKey);

    const sessionBefore = await getSessionSnapshot(sessionId);
    const spentBefore = parseUsd(sessionBefore?.spent) ?? 0;
    const pendingBefore = parseUsd(sessionBefore?.pendingAccruedUsd) ?? 0;

    const response = await httpJson("/api/v1/tools/execute", {
      method: "POST",
      idempotencyKey,
      body: {
        toolId: executeCase.toolId,
        toolName: executeCase.toolName,
        args: executeCase.args,
        mode: "execute",
        sessionId,
        closeSession: false,
      },
    });

    const success = asExecuteSuccess(response.parsedBody);
    const error = asErrorResponse(response.parsedBody);
    const sessionAfter = success?.session ?? (await getSessionSnapshot(sessionId));

    const spentAfter = parseUsd(sessionAfter?.spent) ?? spentBefore;
    const pendingAfter = parseUsd(sessionAfter?.pendingAccruedUsd) ?? pendingBefore;
    const observedDelta = spentAfter - spentBefore;
    const totalCost = parseUsd(success?.method.executePriceUsd) ?? 0;
    const discrepancy = observedDelta - totalCost;

    const walletBefore = lastKnownWalletUsd;
    const walletFromError = parseWalletFromText(error?.error);
    if (walletFromError !== null) {
      lastKnownWalletUsd = walletFromError;
    }
    const walletAfter = lastKnownWalletUsd;

    const evidencePath = await writeArtifact(requestIndex, "execute", {
      request: {
        endpoint: "/api/v1/tools/execute",
        method: "POST",
        idempotencyKey,
        body: {
          toolId: executeCase.toolId,
          toolName: executeCase.toolName,
          args: executeCase.args,
          mode: "execute",
          sessionId,
          closeSession: false,
        },
      },
      sessionBefore,
      response,
      sessionAfter,
    });

    const toolsUsed = success
      ? [{ id: success.tool.id, name: success.tool.name, skillCalls: 1 }]
      : [];

    const record: ForensicRecord = {
      timestamp_utc: new Date().toISOString(),
      request_index: requestIndex,
      idempotency_key: idempotencyKey,
      mode: "execute",
      prompt: executeCase.prompt,
      pinned_tool_ids: [executeCase.toolId],
      tools_used: toolsUsed,
      external_tools_used: [],
      modelCostUsd: "0.000000",
      toolCostUsd: success?.method.executePriceUsd ?? "0.000000",
      totalCostUsd: success?.method.executePriceUsd ?? "0.000000",
      developer_trace_summary: null,
      import_trace_hits: [],
      wallet_before_usd: walletBefore,
      wallet_after_usd: walletAfter,
      observed_delta_usd: observedDelta,
      discrepancy_usd: discrepancy,
      retries: 0,
      loops: 0,
      execute_session_id: sessionId,
      execute_session_spent_before_usd: spentBefore,
      execute_session_spent_after_usd: spentAfter,
      execute_session_pending_before_usd: pendingBefore,
      execute_session_pending_after_usd: pendingAfter,
      response_status: response.status,
      ...(error?.code ? { response_error_code: error.code } : {}),
      ...(error?.error ? { response_error_message: error.error } : {}),
      evidence_artifact: evidencePath,
    };

    records.push(record);
    await writeFile(
      OUTPUT_JSONL_PATH,
      `${JSON.stringify(record)}\n`,
      {
        encoding: "utf8",
        flag: "a",
      }
    );

    requestIndex += 1;
  }

  for (const sessionId of Object.values(sessionsByKey)) {
    if (!sessionId) {
      continue;
    }
    await httpJson(`/api/v1/tools/execute/sessions/${encodeURIComponent(sessionId)}/close`, {
      method: "POST",
      body: { mode: "execute" },
    });
  }

  const discrepancyThreshold = 0.0001;
  const microThreshold = 0.000001;
  const withObserved = records.filter((record) => record.observed_delta_usd !== null);
  const firstDiscrepancy = withObserved.find((record) => {
    const discrepancy = record.discrepancy_usd;
    if (discrepancy === null) {
      return false;
    }
    return Math.abs(discrepancy) > discrepancyThreshold;
  });
  const firstMicroRounding = withObserved.find((record) => {
    const discrepancy = record.discrepancy_usd;
    if (discrepancy === null) {
      return false;
    }
    return Math.abs(discrepancy) > microThreshold;
  });

  const importErrorRecords = records.filter((record) => record.import_trace_hits.length > 0);
  const firstImportErrorRecord = importErrorRecords[0] ?? null;

  const summary = {
    generatedAt: new Date().toISOString(),
    oddsApiToolId: ODDS_API_TOOL_ID,
    totals: {
      requestCount: records.length,
      queryCount: records.filter((record) => record.mode !== "execute").length,
      executeCount: records.filter((record) => record.mode === "execute").length,
      totalReportedCostUsd: records.reduce((sum, record) => {
        const parsed = parseUsd(record.totalCostUsd);
        return sum + (parsed ?? 0);
      }, 0),
    },
    discrepancyThreshold,
    microThreshold,
    firstDiscrepancy: firstDiscrepancy ?? null,
    firstMicroRounding: firstMicroRounding ?? null,
    firstImportErrorRecord,
    importErrorCount: importErrorRecords.length,
    importErrorRate:
      records.length === 0 ? 0 : importErrorRecords.length / records.length,
    records,
  };

  await writeFile(OUTPUT_SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

  console.log(`Wrote ledger JSONL: ${OUTPUT_JSONL_PATH}`);
  console.log(`Wrote summary JSON: ${OUTPUT_SUMMARY_PATH}`);
}

void main();
