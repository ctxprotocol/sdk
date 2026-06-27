import { writeFile } from "node:fs/promises";

import { ContextClient, ContextError } from "@ctxprotocol/sdk";

const MERIDIAN_TOOL_ID = "e5e62fa5-28e1-42f4-8b84-f4866234df43";

const TESTS = [
  {
    id: "test-1-fast",
    label: "Fast — single exchange/product",
    query:
      "Use Meridian futures to get Binance Futures BTCUSDT close_price from 2026-06-24T00:00:00Z to 2026-06-26T00:00:00Z at 1d",
  },
  {
    id: "test-2-broad",
    label: "Broad — 10 assets x 4 venues x 6 months",
    query:
      "Use Meridian futures to get BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, SUIUSDT, LINKUSDT, and HYPEUSDT across Binance Futures, Bybit, OKX, and Hyperliquid from 2025-12-27T00:00:00Z to 2026-06-26T00:00:00Z at 1d resolution. Request close_price, dollar_volume, funding_rate, dollar_open_interest_close, premium, and liquidations_dollar_volume",
  },
  {
    id: "test-3-medium",
    label: "Medium — 2 assets x 2 venues, coverage + warnings",
    query:
      "Use Meridian futures to get BTCUSDT and ETHUSDT across Binance Futures and OKX from 2026-06-01T00:00:00Z to 2026-06-26T00:00:00Z at 1d. Request close_price and dollar_volume. Include coverage and warnings.",
  },
] as const;

type TestReport = {
  id: string;
  label: string;
  ok: boolean;
  durationMs?: number;
  totalSkillCalls?: number;
  toolsUsed?: Array<{ id: string; name: string; skillCalls: number }>;
  outcomeType?: string;
  responsePreview?: string;
  timeoutSignals?: string[];
  traceSummary?: {
    toolCalls: number;
    retryCount: number;
    selfHealCount: number;
    failureCount: number;
    loopCount: number;
  };
  error?: { message: string; code?: string };
};

function collectTimeoutSignals(
  trace: { timeline?: Array<{ message?: string; metadata?: Record<string, unknown> }> } | undefined,
  response: string | undefined
): string[] {
  const signals = new Set<string>();
  const haystacks: string[] = [];
  if (response) {
    haystacks.push(response);
  }
  for (const step of trace?.timeline ?? []) {
    if (typeof step.message === "string") {
      haystacks.push(step.message);
    }
    const meta = step.metadata;
    if (meta && typeof meta.error === "string") {
      haystacks.push(meta.error);
    }
  }
  for (const text of haystacks) {
    if (/timed out after \d+s/i.test(text)) {
      signals.add(text.slice(0, 200));
    }
    if (/MCP tool .* timed out/i.test(text)) {
      signals.add(text.slice(0, 200));
    }
  }
  return [...signals];
}

async function runOneTest(
  client: ContextClient,
  test: (typeof TESTS)[number]
): Promise<TestReport> {
  const startedAt = Date.now();
  console.log(`\n=== ${test.id}: ${test.label} ===`);
  console.log(`Query: ${test.query.slice(0, 120)}...`);

  try {
    const result = await client.query.run({
      query: test.query,
      tools: [MERIDIAN_TOOL_ID],
      includeData: true,
      includeDeveloperTrace: true,
    });

    const durationMs = result.durationMs ?? Date.now() - startedAt;
    const totalSkillCalls = result.toolsUsed.reduce(
      (sum, tool) => sum + Math.max(tool.skillCalls, 0),
      0
    );
    const timeoutSignals = collectTimeoutSignals(
      result.developerTrace,
      result.response
    );

    const report: TestReport = {
      id: test.id,
      label: test.label,
      ok: true,
      durationMs,
      totalSkillCalls,
      toolsUsed: result.toolsUsed,
      outcomeType: result.outcomeType,
      responsePreview: result.response.slice(0, 400),
      timeoutSignals,
      traceSummary: result.developerTrace?.summary
        ? {
            toolCalls: result.developerTrace.summary.toolCalls ?? 0,
            retryCount: result.developerTrace.summary.retryCount ?? 0,
            selfHealCount: result.developerTrace.summary.selfHealCount ?? 0,
            failureCount: result.developerTrace.summary.failureCount ?? 0,
            loopCount: result.developerTrace.summary.loopCount ?? 0,
          }
        : undefined,
    };

    console.log(`PASS — ${Math.round(durationMs / 1000)}s, ${totalSkillCalls} skill call(s)`);
    if (timeoutSignals.length > 0) {
      console.log(`WARN — timeout signals in trace/response: ${timeoutSignals.length}`);
      for (const signal of timeoutSignals) {
        console.log(`  • ${signal}`);
      }
    }
    return report;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message =
      error instanceof ContextError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    const code = error instanceof ContextError ? error.code : undefined;

    console.log(`FAIL — ${Math.round(durationMs / 1000)}s — ${message}`);

    return {
      id: test.id,
      label: test.label,
      ok: false,
      durationMs,
      error: { message, code },
      timeoutSignals: collectTimeoutSignals(undefined, message),
    };
  }
}

async function main() {
  const apiKey = process.env.CONTEXT_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Set CONTEXT_API_KEY (e.g. source context-sdk/.env.local before running)."
    );
  }

  const client = new ContextClient({
    apiKey,
    streamTimeoutMs: 15 * 60_000,
    requestTimeoutMs: 15 * 60_000,
  });

  const reports: TestReport[] = [];
  for (const test of TESTS) {
    reports.push(await runOneTest(client, test));
  }

  const outputPath = "meridian-live-timeout-test-results.json";
  await writeFile(outputPath, `${JSON.stringify(reports, null, 2)}\n`);
  console.log(`\nWrote ${outputPath}`);

  const passed = reports.filter((report) => report.ok).length;
  console.log(`\nSummary: ${passed}/${reports.length} passed`);
  for (const report of reports) {
    const status = report.ok ? "PASS" : "FAIL";
    const seconds = report.durationMs
      ? `${Math.round(report.durationMs / 1000)}s`
      : "?";
    const calls =
      report.totalSkillCalls !== undefined
        ? `${report.totalSkillCalls} skill call(s)`
        : "n/a";
    console.log(`  ${status} ${report.id}: ${seconds}, ${calls}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
