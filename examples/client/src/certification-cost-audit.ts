import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  ContextClient,
  ContextError,
  type QueryDeveloperTrace,
  type QueryResult,
  type Tool,
} from "@ctxprotocol/sdk";

type RunMode = "manual" | "auto";

type SuiteConfig = {
  server: "Polymarket" | "Kalshi";
  toolName: string;
  fallbackToolId: string;
  prompts: readonly string[];
  expectedZeroToolCost: boolean;
};

type CostBreakdown = {
  modelCostUsd: string;
  toolCostUsd: string;
  totalCostUsd: string;
  parsedModelCostUsd: number;
  parsedToolCostUsd: number;
  parsedTotalCostUsd: number;
  expectedTotalUsd: number;
  integrityDeltaUsd: number;
  integrityPass: boolean;
  expectedZeroToolCostPass: boolean;
};

type TraceSummary = {
  toolCalls: number;
  retryCount: number;
  selfHealCount: number;
  fallbackCount: number;
  failureCount: number;
  recoveryCount: number;
  completionChecks: number;
  loopCount: number;
  timelineLength: number;
  synthetic: boolean;
  source?: string;
  topStepTypes: Array<{ key: string; count: number }>;
  topMethods: Array<{ method: string; count: number }>;
  failureMessages: string[];
};

type ReportChecks = {
  execution: { pass: boolean };
  relevance: { pass: boolean; failures: string[] };
  freshness: { pass: boolean; ageMs: number | null; reason: string };
  tracePresence: { pass: boolean; reason: string };
  traceHealth: { pass: boolean; failures: string[] };
  costIntegrity: { pass: boolean; failures: string[] };
};

type PromptReport = {
  index: number;
  prompt: string;
  mode: RunMode;
  requestedTools: string[];
  pass: boolean;
  checks: ReportChecks;
  durationMs?: number;
  responsePreview?: string;
  toolsUsed?: Array<{ id: string; name: string; skillCalls: number }>;
  externalToolsUsed?: Array<{ id: string; name: string; skillCalls: number }>;
  totalSkillCalls?: number;
  developerTracePresent?: boolean;
  traceSummary?: TraceSummary;
  dataAgeMs?: number | null;
  cost?: CostBreakdown;
  idempotencyKey?: string;
  error?: {
    name: string;
    message: string;
    code?: string;
    statusCode?: number;
  };
};

const TRACE_THRESHOLDS = {
  retryMax: Number(process.env.TRACE_RETRY_MAX ?? "1"),
  selfHealMax: Number(process.env.TRACE_SELF_HEAL_MAX ?? "1"),
  loopMax: Number(process.env.TRACE_LOOP_MAX ?? "1"),
} as const;

const FRESHNESS_THRESHOLD_MINUTES = Number(
  process.env.FRESHNESS_THRESHOLD_MINUTES ?? "30"
);
const COST_INTEGRITY_TOLERANCE_USD = Number(
  process.env.COST_INTEGRITY_TOLERANCE_USD ?? "0.000001"
);

const KALSHI_PROMPTS = [
  "What are the top 10 most actively traded markets on Kalshi right now?",
  "Show me all Kalshi categories and how many series each one has",
  "Find markets where YES is priced between 5 and 15 cents as lottery ticket plays",
  "Analyze the orderbook depth and slippage for KXBITCOIN and tell me if I can get $1000 in without moving the price",
  "Search for 'Fed rate cut' markets, check their efficiency, then compare the best one against Polymarket",
  "Are there any arbitrage opportunities in Politics markets where YES + NO is under 99 cents?",
  "What is the sentiment and price trend for the top Trump tariffs market over the last 24 hours?",
  "Get the daily candlestick chart for a Bitcoin price market over the past 30 days",
  "Browse the Sports category sorted by volume and cross-reference the top result with Polymarket odds",
  "Find all settled markets in the Economics category from the past month with their resolution prices",
] as const;

const POLYMARKET_PROMPTS = [
  "What are the top 5 prediction markets by volume right now?",
  "Search for markets related to the 2028 presidential election",
  "How efficient is the pricing on the Trump vs Biden market? Is there arbitrage?",
  "Analyze whale flow on the Fed rate decision event who are the top holders and what is their cost basis?",
  "Show me markets between 30-70% probability with high volume that might be mispriced",
  "Analyze my Polymarket positions which ones have poor exit liquidity?",
  "Compare the Polymarket odds vs Kalshi odds on the next Fed meeting outcome",
  "Find correlated markets where a move in one should predict a move in another",
  "What are the orderbook depth and spread for all outcomes on event slug 'democratic-presidential-nominee-2028'?",
  "Browse all markets in the Politics category sorted by recent activity",
  "Build a high-conviction workflow: find mispriced markets, check whale positioning, then verify liquidity",
] as const;

const SUITES: readonly SuiteConfig[] = [
  {
    server: "Polymarket",
    toolName: "Polymarket",
    fallbackToolId: "294100e8-c648-4e5f-a254-95a14b56e398",
    prompts: POLYMARKET_PROMPTS,
    expectedZeroToolCost: true,
  },
  {
    server: "Kalshi",
    toolName: "Kalshi",
    fallbackToolId: "5cc326fb-500d-4c17-bc5f-ade143210636",
    prompts: KALSHI_PROMPTS,
    expectedZeroToolCost: true,
  },
];

const OUTPUT_PATH =
  process.env.CERTIFICATION_OUTPUT_PATH ?? "certification-cost-audit-ts.json";

function parseModes(raw: string | undefined): RunMode[] {
  const source = raw ?? "manual";
  const parsed = source
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is RunMode => value === "manual" || value === "auto");
  if (parsed.length === 0) {
    return ["manual"];
  }
  return [...new Set(parsed)];
}

function parseUsd(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function buildCostBreakdown(result: QueryResult, expectZeroToolCost: boolean): CostBreakdown {
  const modelCostUsd = result.cost.modelCostUsd;
  const toolCostUsd = result.cost.toolCostUsd;
  const totalCostUsd = result.cost.totalCostUsd;
  const parsedModelCostUsd = parseUsd(modelCostUsd);
  const parsedToolCostUsd = parseUsd(toolCostUsd);
  const parsedTotalCostUsd = parseUsd(totalCostUsd);
  const expectedTotalUsd = parsedModelCostUsd + parsedToolCostUsd;
  const integrityDeltaUsd = Math.abs(parsedTotalCostUsd - expectedTotalUsd);
  const integrityPass =
    Number.isFinite(parsedModelCostUsd) &&
    Number.isFinite(parsedToolCostUsd) &&
    Number.isFinite(parsedTotalCostUsd) &&
    integrityDeltaUsd <= COST_INTEGRITY_TOLERANCE_USD;
  const expectedZeroToolCostPass = !expectZeroToolCost || parsedToolCostUsd === 0;
  return {
    modelCostUsd,
    toolCostUsd,
    totalCostUsd,
    parsedModelCostUsd,
    parsedToolCostUsd,
    parsedTotalCostUsd,
    expectedTotalUsd,
    integrityDeltaUsd,
    integrityPass,
    expectedZeroToolCostPass,
  };
}

function countTraceSteps(trace: QueryDeveloperTrace | undefined, key: string): number {
  const timeline = trace?.timeline ?? [];
  return timeline.filter(
    (step) => step.stepType === key || step.event === key
  ).length;
}

function summarizeTrace(trace: QueryDeveloperTrace | undefined): TraceSummary | undefined {
  if (!trace) {
    return undefined;
  }
  const timeline = trace.timeline ?? [];
  const stepTypeCounts = new Map<string, number>();
  const methodCounts = new Map<string, number>();
  const failureMessages: string[] = [];

  for (const step of timeline) {
    const stepKey = step.stepType || step.event || "unknown";
    stepTypeCounts.set(stepKey, (stepTypeCounts.get(stepKey) ?? 0) + 1);

    const toolRef = step.tool as { method?: unknown } | undefined;
    const method = typeof toolRef?.method === "string" ? toolRef.method : undefined;
    if (method) {
      methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
    }

    const status = String(step.status ?? "");
    const isFailureStep =
      step.stepType === "failure" ||
      step.event === "failure" ||
      /fail|error/i.test(status);
    if (!isFailureStep) {
      continue;
    }
    const message = step.message?.trim();
    if (message && failureMessages.length < 5) {
      failureMessages.push(message);
    }
  }

  const summary = trace.summary;
  const traceRecord = trace as Record<string, unknown>;
  const source = typeof traceRecord.source === "string" ? traceRecord.source : undefined;
  const synthetic = traceRecord.synthetic === true || source === "sdk-fallback";

  return {
    toolCalls: summary?.toolCalls ?? countTraceSteps(trace, "tool-call"),
    retryCount: summary?.retryCount ?? countTraceSteps(trace, "retry"),
    selfHealCount: summary?.selfHealCount ?? countTraceSteps(trace, "self-heal"),
    fallbackCount: summary?.fallbackCount ?? countTraceSteps(trace, "fallback"),
    failureCount: summary?.failureCount ?? countTraceSteps(trace, "failure"),
    recoveryCount: summary?.recoveryCount ?? countTraceSteps(trace, "recovery"),
    completionChecks:
      summary?.completionChecks ?? countTraceSteps(trace, "completion-check"),
    loopCount: summary?.loopCount ?? countTraceSteps(trace, "loop"),
    timelineLength: timeline.length,
    synthetic,
    source,
    topStepTypes: [...stepTypeCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    topMethods: [...methodCounts.entries()]
      .map(([method, count]) => ({ method, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    failureMessages,
  };
}

function isTimeSensitivePrompt(prompt: string): boolean {
  return (
    /\bright now\b/i.test(prompt) ||
    /\b24h\b/i.test(prompt) ||
    /\brecent\b/i.test(prompt) ||
    /\bpast\s+\d+\s+(hour|hours|day|days|month|months)\b/i.test(prompt) ||
    /\bpast month\b/i.test(prompt) ||
    /\btop\b/i.test(prompt) ||
    /\bsorted by recent\b/i.test(prompt)
  );
}

function extractLatestFetchedAt(value: unknown, depth = 0): number | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    let maxTs: number | null = null;
    for (const item of value) {
      const ts = extractLatestFetchedAt(item, depth + 1);
      if (ts !== null && (maxTs === null || ts > maxTs)) {
        maxTs = ts;
      }
    }
    return maxTs;
  }
  if (typeof value !== "object") {
    return null;
  }
  let maxTs: number | null = null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "fetchedAt" || key === "fetched_at") && typeof child === "string") {
      const parsed = Date.parse(child);
      if (Number.isFinite(parsed) && (maxTs === null || parsed > maxTs)) {
        maxTs = parsed;
      }
      continue;
    }
    const nested = extractLatestFetchedAt(child, depth + 1);
    if (nested !== null && (maxTs === null || nested > maxTs)) {
      maxTs = nested;
    }
  }
  return maxTs;
}

function evaluateRelevance(response: string): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (response.trim().length < 120) {
    failures.push("short_response");
  }
  const degradedPatterns = [
    "i'm sorry, i cannot",
    "i am sorry, i cannot",
    "unable to",
    "tool encountered an error",
    "data retrieval failed",
    "not found in the database",
    "cannot provide",
  ];
  const lowered = response.toLowerCase();
  if (degradedPatterns.some((pattern) => lowered.includes(pattern))) {
    failures.push("degraded_or_incomplete_answer_text");
  }
  return { pass: failures.length === 0, failures };
}

async function resolveToolId(
  client: ContextClient,
  toolName: string,
  fallbackToolId: string
): Promise<{ id: string; source: "discovery" | "fallback" }> {
  const tools = await client.discovery.search({
    query: toolName,
    limit: 20,
    mode: "query",
  });
  const exact = tools.find((tool: Tool) => tool.name.toLowerCase() === toolName.toLowerCase());
  if (exact) {
    return { id: exact.id, source: "discovery" };
  }
  return { id: fallbackToolId, source: "fallback" };
}

function buildTraceHealthCheck(summary: TraceSummary | undefined): {
  pass: boolean;
  failures: string[];
} {
  if (!summary) {
    return { pass: false, failures: ["trace_missing"] };
  }
  const failures: string[] = [];
  if (summary.retryCount > TRACE_THRESHOLDS.retryMax) {
    failures.push(`retry_gt_${TRACE_THRESHOLDS.retryMax}:${summary.retryCount}`);
  }
  if (summary.selfHealCount > TRACE_THRESHOLDS.selfHealMax) {
    failures.push(`self_heal_gt_${TRACE_THRESHOLDS.selfHealMax}:${summary.selfHealCount}`);
  }
  if (summary.loopCount > TRACE_THRESHOLDS.loopMax) {
    failures.push(`loop_gt_${TRACE_THRESHOLDS.loopMax}:${summary.loopCount}`);
  }
  return { pass: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const apiKey = process.env.CONTEXT_API_KEY;
  if (!apiKey) {
    throw new Error("Set CONTEXT_API_KEY before running this script.");
  }

  const queryDepth = (process.env.QUERY_DEPTH as "fast" | "auto" | "deep" | undefined) ?? "deep";
  const modes = parseModes(process.env.AUDIT_MODES);
  const modelId = process.env.CONTEXT_MODEL_ID;
  const client = new ContextClient({ apiKey });

  const suiteRuns: Array<Record<string, unknown>> = [];
  let globalCostTotal = 0;

  for (const suite of SUITES) {
    const resolvedTool = await resolveToolId(client, suite.toolName, suite.fallbackToolId);
    for (const mode of modes) {
      const reports: PromptReport[] = [];
      let modeCumulativeCost = 0;

      console.log(
        `\n=== ${suite.server} | mode=${mode} | tool=${resolvedTool.id} (${resolvedTool.source}) ===`
      );

      for (let index = 0; index < suite.prompts.length; index += 1) {
        const prompt = suite.prompts[index];
        const idempotencyKey = randomUUID();
        const requestedTools = mode === "manual" ? [resolvedTool.id] : [];

        console.log(`\n[${suite.server} ${mode}] [${index + 1}/${suite.prompts.length}] ${prompt}`);
        try {
          const result = await client.query.run({
            query: prompt,
            ...(mode === "manual" ? { tools: [resolvedTool.id] } : {}),
            queryDepth,
            includeData: true,
            includeDeveloperTrace: true,
            ...(modelId ? { modelId } : {}),
            idempotencyKey,
          });

          const relevance = evaluateRelevance(result.response);
          const latestFetchedAtTs = extractLatestFetchedAt(result.data);
          const ageMs = latestFetchedAtTs === null ? null : Date.now() - latestFetchedAtTs;
          const freshness =
            isTimeSensitivePrompt(prompt) && ageMs === null
              ? { pass: false, ageMs: null, reason: "no_fetchedAt_for_time_sensitive_prompt" }
              : isTimeSensitivePrompt(prompt) && ageMs !== null && ageMs > FRESHNESS_THRESHOLD_MINUTES * 60_000
                ? {
                    pass: false,
                    ageMs,
                    reason: `stale_older_than_${FRESHNESS_THRESHOLD_MINUTES}m`,
                  }
                : isTimeSensitivePrompt(prompt)
                  ? { pass: true, ageMs, reason: `fresh_within_${FRESHNESS_THRESHOLD_MINUTES}m` }
                  : { pass: true, ageMs, reason: "not_time_sensitive" };

          const traceSummary = summarizeTrace(result.developerTrace);
          const tracePresence = !traceSummary
            ? { pass: false, reason: "trace_missing" }
            : traceSummary.synthetic
              ? { pass: false, reason: "trace_is_synthetic_sdk_fallback" }
              : { pass: true, reason: "trace_from_backend" };
          const traceHealth = buildTraceHealthCheck(traceSummary);

          const cost = buildCostBreakdown(result, suite.expectedZeroToolCost);
          const costFailures: string[] = [];
          if (!cost.integrityPass) {
            costFailures.push(
              `cost_mismatch_delta:${cost.integrityDeltaUsd.toFixed(12)}`
            );
          }
          if (!cost.expectedZeroToolCostPass) {
            costFailures.push(`non_zero_tool_cost:${cost.toolCostUsd}`);
          }

          const toolsUsed = result.toolsUsed.map((tool) => ({
            id: tool.id,
            name: tool.name,
            skillCalls: tool.skillCalls,
          }));
          const externalToolsUsed = toolsUsed.filter(
            (tool) => tool.id !== resolvedTool.id
          );
          if (mode === "manual" && externalToolsUsed.length > 0) {
            costFailures.push(
              `manual_mode_used_unexpected_tools:${externalToolsUsed
                .map((tool) => `${tool.name}:${tool.id}`)
                .join(",")}`
            );
          }
          if (cost.parsedToolCostUsd > 0 && externalToolsUsed.length > 0) {
            costFailures.push(
              `tool_cost_from_external_tools:${externalToolsUsed
                .map((tool) => `${tool.name}:${tool.id}`)
                .join(",")}`
            );
          }
          const totalSkillCalls = toolsUsed.reduce(
            (sum, tool) => sum + tool.skillCalls,
            0
          );
          modeCumulativeCost += Number.isFinite(cost.parsedTotalCostUsd)
            ? cost.parsedTotalCostUsd
            : 0;

          const checks: ReportChecks = {
            execution: { pass: true },
            relevance,
            freshness,
            tracePresence,
            traceHealth,
            costIntegrity: { pass: costFailures.length === 0, failures: costFailures },
          };
          const pass = Object.values(checks).every((check) => check.pass);

          reports.push({
            index: index + 1,
            prompt,
            mode,
            requestedTools,
            pass,
            checks,
            durationMs: result.durationMs,
            responsePreview: result.response.slice(0, 420),
            toolsUsed,
            externalToolsUsed,
            totalSkillCalls,
            developerTracePresent: Boolean(result.developerTrace),
            traceSummary,
            dataAgeMs: ageMs,
            cost,
            idempotencyKey,
          });

          console.log(
            `  cost model=${cost.modelCostUsd} tool=${cost.toolCostUsd} total=${cost.totalCostUsd} cumulative=${modeCumulativeCost.toFixed(6)}`
          );
          if (externalToolsUsed.length > 0) {
            console.log(
              `  external tools: ${externalToolsUsed
                .map((tool) => `${tool.name}:${tool.id}`)
                .join(", ")}`
            );
          }
          console.log(
            `  trace retries=${traceSummary?.retryCount ?? 0} selfHeal=${traceSummary?.selfHealCount ?? 0} loop=${traceSummary?.loopCount ?? 0} source=${traceSummary?.source ?? "unknown"}`
          );
          if (!pass && traceSummary?.failureMessages.length) {
            console.log(`  trace failures: ${traceSummary.failureMessages.join(" | ")}`);
          }
        } catch (error) {
          const errorReport: PromptReport = {
            index: index + 1,
            prompt,
            mode,
            requestedTools,
            pass: false,
            checks: {
              execution: { pass: false },
              relevance: { pass: false, failures: ["query_exception"] },
              freshness: { pass: false, ageMs: null, reason: "query_exception" },
              tracePresence: { pass: false, reason: "query_exception" },
              traceHealth: { pass: false, failures: ["query_exception"] },
              costIntegrity: { pass: false, failures: ["query_exception"] },
            },
            idempotencyKey,
          };
          if (error instanceof ContextError) {
            errorReport.error = {
              name: error.name,
              message: error.message,
              code: error.code,
              statusCode: error.statusCode,
            };
          } else if (error instanceof Error) {
            errorReport.error = {
              name: error.name,
              message: error.message,
            };
          } else {
            errorReport.error = {
              name: "UnknownError",
              message: "Unknown non-Error value thrown",
            };
          }
          reports.push(errorReport);
          console.log(
            `  failed: ${errorReport.error?.name ?? "Error"} ${errorReport.error?.code ? `[${errorReport.error.code}]` : ""} ${errorReport.error?.message ?? ""}`
          );
        }
      }

      const passCount = reports.filter((report) => report.pass).length;
      const failCount = reports.length - passCount;
      const executedReports = reports.filter((report) => report.checks.execution.pass);
      const totals = executedReports.reduce(
        (acc, report) => {
          const totalCost = report.cost?.parsedTotalCostUsd ?? 0;
          const modelCost = report.cost?.parsedModelCostUsd ?? 0;
          const toolCost = report.cost?.parsedToolCostUsd ?? 0;
          if (Number.isFinite(totalCost)) acc.totalCostUsd += totalCost;
          if (Number.isFinite(modelCost)) acc.modelCostUsd += modelCost;
          if (Number.isFinite(toolCost)) acc.toolCostUsd += toolCost;
          acc.totalDurationMs += report.durationMs ?? 0;
          acc.totalSkillCalls += report.totalSkillCalls ?? 0;
          return acc;
        },
        {
          modelCostUsd: 0,
          toolCostUsd: 0,
          totalCostUsd: 0,
          totalDurationMs: 0,
          totalSkillCalls: 0,
        }
      );

      globalCostTotal += totals.totalCostUsd;
      suiteRuns.push({
        server: suite.server,
        mode,
        toolName: suite.toolName,
        toolId: resolvedTool.id,
        toolIdSource: resolvedTool.source,
        promptCount: suite.prompts.length,
        passCount,
        failCount,
        totals: {
          ...totals,
          averageCostUsd:
            executedReports.length > 0
              ? Number((totals.totalCostUsd / executedReports.length).toFixed(6))
              : 0,
          averageDurationMs:
            executedReports.length > 0
              ? Math.round(totals.totalDurationMs / executedReports.length)
              : 0,
        },
        reports,
      });
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    queryDepth,
    modelId: modelId || null,
    thresholds: {
      freshnessThresholdMinutes: FRESHNESS_THRESHOLD_MINUTES,
      trace: TRACE_THRESHOLDS,
    },
    modes,
    suites: suiteRuns,
    globalSummary: {
      suiteRuns: suiteRuns.length,
      totalCostUsd: Number(globalCostTotal.toFixed(6)),
      totalPass: suiteRuns.reduce(
        (sum, suite) => sum + Number(suite.passCount ?? 0),
        0
      ),
      totalFail: suiteRuns.reduce(
        (sum, suite) => sum + Number(suite.failCount ?? 0),
        0
      ),
    },
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`\nSaved ${OUTPUT_PATH}`);
}

void main();
