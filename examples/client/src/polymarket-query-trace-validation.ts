import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import {
  ContextClient,
  ContextError,
  type QueryDeveloperTrace,
} from "@ctxprotocol/sdk";

const apiKey = process.env.CONTEXT_API_KEY;
if (!apiKey) {
  throw new Error("Set CONTEXT_API_KEY before running this script.");
}

const POLYMARKET_TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const OUTPUT_PATH = "polymarket-query-trace-results-ts.json";

const prompts = [
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
};

type PromptReport = {
  index: number;
  prompt: string;
  ok: boolean;
  durationMs?: number;
  costUsd?: string;
  responsePreview?: string;
  toolsUsed?: Array<{ id: string; name: string; skillCalls: number }>;
  totalSkillCalls?: number;
  developerTracePresent?: boolean;
  traceSummary?: TraceSummary;
  topTimelineEvents?: Array<{ key: string; count: number }>;
  inefficiencySignals?: string[];
  error?: {
    name: string;
    message: string;
    code?: string;
    statusCode?: number;
  };
};

function countTraceSteps(
  trace: QueryDeveloperTrace | undefined,
  key: string
): number {
  const timeline = trace?.timeline ?? [];
  return timeline.filter(
    (step) => step.stepType === key || step.event === key
  ).length;
}

function summarizeTrace(trace: QueryDeveloperTrace | undefined): TraceSummary {
  const timeline = trace?.timeline ?? [];
  return {
    toolCalls: trace?.summary?.toolCalls ?? countTraceSteps(trace, "tool-call"),
    retryCount: trace?.summary?.retryCount ?? countTraceSteps(trace, "retry"),
    selfHealCount:
      trace?.summary?.selfHealCount ?? countTraceSteps(trace, "self-heal"),
    fallbackCount:
      trace?.summary?.fallbackCount ?? countTraceSteps(trace, "fallback"),
    failureCount:
      trace?.summary?.failureCount ?? countTraceSteps(trace, "failure"),
    recoveryCount:
      trace?.summary?.recoveryCount ?? countTraceSteps(trace, "recovery"),
    completionChecks:
      trace?.summary?.completionChecks ??
      countTraceSteps(trace, "completion-check"),
    loopCount: trace?.summary?.loopCount ?? countTraceSteps(trace, "loop"),
    timelineLength: timeline.length,
  };
}

function topTimelineEvents(
  trace: QueryDeveloperTrace | undefined
): Array<{ key: string; count: number }> {
  const counts = new Map<string, number>();
  for (const step of trace?.timeline ?? []) {
    const key = step.stepType || step.event || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

function inefficiencySignals(summary: TraceSummary): string[] {
  const signals: string[] = [];
  if (summary.retryCount > 0) {
    signals.push(`retry:${summary.retryCount}`);
  }
  if (summary.selfHealCount > 0) {
    signals.push(`self-heal:${summary.selfHealCount}`);
  }
  if (summary.fallbackCount > 0) {
    signals.push(`fallback:${summary.fallbackCount}`);
  }
  if (summary.failureCount > 0) {
    signals.push(`failure:${summary.failureCount}`);
  }
  if (summary.loopCount > 0) {
    signals.push(`loop:${summary.loopCount}`);
  }
  if (summary.completionChecks > 2) {
    signals.push(`completion-checks:${summary.completionChecks}`);
  }
  return signals;
}

async function runStreamProbe(client: ContextClient): Promise<{
  eventCounts: {
    toolStatus: number;
    textDelta: number;
    developerTrace: number;
    done: number;
  };
  doneTracePresent: boolean;
}> {
  const eventCounts = {
    toolStatus: 0,
    textDelta: 0,
    developerTrace: 0,
    done: 0,
  };
  let doneTracePresent = false;

  for await (const event of client.query.stream({
    query: "Top 3 politics markets by recent volume",
    tools: [POLYMARKET_TOOL_ID],
    queryDepth: "deep",
    includeDeveloperTrace: true,
  })) {
    if (event.type === "tool-status") {
      eventCounts.toolStatus += 1;
      continue;
    }
    if (event.type === "text-delta") {
      eventCounts.textDelta += 1;
      continue;
    }
    if (event.type === "developer-trace") {
      eventCounts.developerTrace += 1;
      continue;
    }
    if (event.type === "done") {
      eventCounts.done += 1;
      doneTracePresent = Boolean(event.result.developerTrace);
    }
  }

  return { eventCounts, doneTracePresent };
}

async function main(): Promise<void> {
  const client = new ContextClient({ apiKey });
  const reports: PromptReport[] = [];

  for (let index = 0; index < prompts.length; index += 1) {
    const prompt = prompts[index];
    console.log(`\n[${index + 1}/${prompts.length}] ${prompt}`);

    try {
      const result = await client.query.run({
        query: prompt,
        tools: [POLYMARKET_TOOL_ID],
        queryDepth: "deep",
        includeData: true,
        includeDeveloperTrace: true,
      });

      const traceSummary = summarizeTrace(result.developerTrace);
      const signals = inefficiencySignals(traceSummary);
      const toolsUsed = result.toolsUsed.map((tool) => ({
        id: tool.id,
        name: tool.name,
        skillCalls: tool.skillCalls,
      }));

      reports.push({
        index: index + 1,
        prompt,
        ok: true,
        durationMs: result.durationMs,
        costUsd: result.cost.totalCostUsd,
        responsePreview: result.response.slice(0, 320),
        toolsUsed,
        totalSkillCalls: toolsUsed.reduce(
          (sum, tool) => sum + tool.skillCalls,
          0
        ),
        developerTracePresent: Boolean(result.developerTrace),
        traceSummary,
        topTimelineEvents: topTimelineEvents(result.developerTrace),
        inefficiencySignals: signals,
      });

      console.log(
        `  duration=${result.durationMs}ms cost=${result.cost.totalCostUsd} skillCalls=${reports.at(-1)?.totalSkillCalls ?? 0}`
      );
      console.log(
        `  trace retries=${traceSummary.retryCount} selfHeal=${traceSummary.selfHealCount} fallback=${traceSummary.fallbackCount} loop=${traceSummary.loopCount}`
      );
      if (signals.length > 0) {
        console.log(`  signals: ${signals.join(", ")}`);
      }
    } catch (error) {
      if (error instanceof ContextError) {
        reports.push({
          index: index + 1,
          prompt,
          ok: false,
          error: {
            name: error.name,
            message: error.message,
            code: error.code,
            statusCode: error.statusCode,
          },
        });
      } else if (error instanceof Error) {
        reports.push({
          index: index + 1,
          prompt,
          ok: false,
          error: {
            name: error.name,
            message: error.message,
          },
        });
      } else {
        reports.push({
          index: index + 1,
          prompt,
          ok: false,
          error: {
            name: "UnknownError",
            message: "Unknown non-Error value thrown",
          },
        });
      }

      const lastError = reports.at(-1)?.error;
      console.log(
        `  failed: ${lastError?.name ?? "Error"} ${lastError?.code ? `[${lastError.code}]` : ""} ${lastError?.message ?? ""}`
      );
    }

    await sleep(500);
  }

  const okReports = reports.filter((report) => report.ok);
  const streamProbe = await runStreamProbe(client);
  const totals = okReports.reduce(
    (acc, report) => {
      const summary = report.traceSummary;
      acc.costUsd += Number(report.costUsd ?? "0");
      acc.durationMs += report.durationMs ?? 0;
      acc.skillCalls += report.totalSkillCalls ?? 0;
      if (summary) {
        acc.retryCount += summary.retryCount;
        acc.selfHealCount += summary.selfHealCount;
        acc.fallbackCount += summary.fallbackCount;
        acc.failureCount += summary.failureCount;
        acc.recoveryCount += summary.recoveryCount;
        acc.completionChecks += summary.completionChecks;
        acc.loopCount += summary.loopCount;
      }
      return acc;
    },
    {
      costUsd: 0,
      durationMs: 0,
      skillCalls: 0,
      retryCount: 0,
      selfHealCount: 0,
      fallbackCount: 0,
      failureCount: 0,
      recoveryCount: 0,
      completionChecks: 0,
      loopCount: 0,
    }
  );

  const output = {
    generatedAt: new Date().toISOString(),
    toolId: POLYMARKET_TOOL_ID,
    promptCount: prompts.length,
    successCount: okReports.length,
    failureCount: reports.length - okReports.length,
    totals: {
      ...totals,
      averageDurationMs:
        okReports.length > 0 ? Math.round(totals.durationMs / okReports.length) : 0,
      averageCostUsd:
        okReports.length > 0
          ? Number((totals.costUsd / okReports.length).toFixed(6))
          : 0,
    },
    streamProbe,
    reports,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  console.log("\nRun complete.");
  console.log(
    `Saved ${OUTPUT_PATH} with ${okReports.length}/${prompts.length} successful prompts.`
  );
}

void main();
