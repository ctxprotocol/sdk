import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import sharedQueryFixture from "../../../fixtures/query-response/full-grounded-answer.json" with {
  type: "json",
};
import { ContextClient } from "../client.js";
import { ContextError } from "../types.js";
import type {
  QueryResult,
  QueryStreamDeveloperTraceEvent,
  QueryStreamErrorEvent,
  QueryStreamToolStatusEvent,
  QueryStreamTextDeltaEvent,
  QueryStreamDoneEvent,
} from "../types.js";

type SharedQueryFixture = {
  groundedAnswer: Record<string, unknown>;
  capabilityMiss: Record<string, unknown>;
  clarificationRequired: Record<string, unknown>;
  ungroundedCapabilityMiss: Record<string, unknown>;
};

const SHARED_QUERY_FIXTURE = sharedQueryFixture as SharedQueryFixture;

// ============================================================================
// Helpers
// ============================================================================

/**
 * Mock a fetch response that returns an SSE stream body
 */
function mockFetchSSE(events: string[]) {
  const ssePayload = events.join("\n") + "\n";
  const encoder = new TextEncoder();
  const bytes = encoder.encode(ssePayload);

  let position = 0;
  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (position >= bytes.length) {
        return Promise.resolve({ done: true, value: undefined });
      }
      const chunk = bytes.slice(position);
      position = bytes.length;
      return Promise.resolve({ done: false, value: chunk });
    }),
    releaseLock: vi.fn(),
  };

  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: { getReader: () => reader },
  });
}

function buildDoneEvent(result: Record<string, unknown>) {
  return `data: ${JSON.stringify({
    type: "done",
    result,
  })}`;
}

function mockFetchRunResult(result: Record<string, unknown>) {
  return mockFetchSSE([buildDoneEvent(result), "data: [DONE]"]);
}

/**
 * Mock fetch for error responses
 */
function mockFetchError(
  error: string,
  code: string,
  status: number,
) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: "Error",
    json: () => Promise.resolve({ error, code }),
    headers: new Headers(),
  });
}

// ============================================================================
// Test data matching the actual endpoint response shapes
// ============================================================================

const MOCK_SUCCESS_RESPONSE = {
  success: true as const,
  response:
    "Based on the latest data, the top whale movements on Base include a $2.3M USDC transfer from 0xabc... to Uniswap V3.",
  toolsUsed: [
    { id: "tool-uuid-1", name: "Whale Tracker", skillCalls: 3 },
    { id: "tool-uuid-2", name: "Price Feed", skillCalls: 1 },
  ],
  cost: {
    totalCostUsd: "0.015400",
    toolCostUsd: "0.010000",
    modelCostUsd: "0.005400",
  },
  durationMs: 4200,
  orchestrationMetrics: {
    parityStage: "candidate",
    orchestrationMode: "agentic",
    firstPassSuccess: true,
    capabilityMissSignaled: false,
    rediscoveryExecuted: false,
  },
  querySession: {
    sessionId: "11111111-1111-4111-8111-111111111111",
    attemptId: "22222222-2222-4222-8222-222222222222",
    parentAttemptId: null,
    rootAttemptId: "22222222-2222-4222-8222-222222222222",
    mode: "initial" as const,
    origin: "initial_request" as const,
    status: "completed" as const,
    checkpoint: {
      currentStage: "synthesis",
      latestCheckpointArtifactId: "artifact-1",
      canonicalDatasetId: "dataset-1",
      executionProgramCurrentRevisionId: "rev-1",
    },
  },
};

const MOCK_EVIDENCE_RESPONSE = {
  ...MOCK_SUCCESS_RESPONSE,
  responseShape: "evidence_only" as const,
  response: "Structured evidence package with 2 evidence facts and medium confidence.",
  summary: "BTC net exchange flow is negative across the last 24h sample.",
  evidence: {
    facts: [
      {
        id: "fact-1",
        label: "Net BTC exchange flow",
        path: "aggregateFlow.netFlowUsd",
        relevanceScore: 0.93,
        value: -12_500_000,
      },
    ],
    sourceRefs: [
      {
        id: "source-1",
        provider: "Coinglass",
        dataset: "exchange flows",
        observedAt: "2026-03-23T12:00:00.000Z",
        publishedAt: null,
        artifactRef: "https://example.com/data.json",
        url: "https://example.com/data.json",
        note: "Canonical execution artifact",
      },
    ],
    assumptions: ["Used rolling 24h window."],
    knownUnknowns: ["No venue-specific catalyst evidence was available."],
    retrievalPlanReasonCodes: ["bounded_retrieval_first"],
  },
  artifacts: {
    dataUrl: "https://example.com/data.json",
    canonicalDataRef: {
      datasetId: "dataset-1",
      hash: "abc123",
      bytes: 2048,
      publicDataUrl: "https://example.com/data.json",
    },
    stageArtifactKinds: ["canonical-execution-data", "completeness-evaluation"],
  },
  view: {
    type: "timeseries" as const,
    label: "Timeseries",
  },
  freshness: {
    asOf: "2026-03-23T12:00:00.000Z",
    sourceTimestamps: ["2026-03-23T12:00:00.000Z"],
    note: "Most recent evidence timestamp: 2026-03-23T12:00:00.000Z",
  },
  confidence: {
    level: "medium" as const,
    reason: "Grounded in canonical execution data with one unresolved gap.",
    verifiedFactCount: 2,
    inferredFactCount: 0,
    gapCount: 1,
    gapSignals: [
      {
        code: "missing_catalyst",
        severity: "medium",
        detail: "No catalyst evidence was retrieved.",
      },
    ],
  },
  usage: {
    durationMs: 4200,
    cost: MOCK_SUCCESS_RESPONSE.cost,
    toolsUsed: MOCK_SUCCESS_RESPONSE.toolsUsed,
    outcomeType: "answer" as const,
    orchestrationMetrics: MOCK_SUCCESS_RESPONSE.orchestrationMetrics,
  },
};

const MOCK_DEVELOPER_TRACE = {
  summary: {
    toolCalls: 4,
    retryCount: 2,
    selfHealCount: 1,
    fallbackCount: 1,
    completionChecks: 3,
    loopCount: 2,
  },
  timeline: [
    {
      stepType: "tool-call",
      timestampMs: 120,
      tool: { id: "tool-uuid-1", name: "Whale Tracker", method: "get_whales" },
    },
    {
      stepType: "retry",
      timestampMs: 420,
      attempt: 2,
      message: "Retrying after transient provider timeout",
    },
  ],
  diagnostics: {
    selection: {
        selectedPolicy: "exploratory",
        debugScoutDeepMode: "deep",
        plannerReasoningStage: "focused",
        scoutEnabled: false,
        oneShotBias: false,
        candidateMethodCount: 12,
        scoutProbeStatus: "ready",
        scoutProbeAdequacy: "limited",
        scoutProbeConfidence: 0.81,
        scoutMetadataConfidence: 0.74,
        scoutProbeQuerySafeCandidateCount: 8,
        scoutProbeRankedMethodCount: 5,
        scoutProbeAmbiguityPoolCount: 2,
        scoutProbeShortlistedMethodCount: 2,
        scoutProbeMissingCapability: null,
        scoutPrePlanProbeCalls: 0,
        scoutPrePlanProbeBudgetReasonCode: null,
        scoutChangedInitialPlan: false,
        scoutChangedPlannerReasoningStage: false,
        scoutInitialSelectedPolicy: "exploratory",
        scoutInitialPlannerReasoningStage: "focused",
        scoutInitialReasonCode: "metadata_quality_deep",
        scoutFinalReasonCode: "selected_exploratory",
        scoutEvidenceAttachedToPlanning: true,
        scoutLlmSelectionUsed: true,
        scoutLlmSelectionFallback: false,
        scoutLlmSelectionLatencyMs: 183,
        selectedTools: [
        {
          toolId: "tool-uuid-1",
          toolName: "Whale Tracker",
          selectedMethodCount: 2,
          selectedMethods: ["get_whales", "get_whale_summary"],
          omittedSelectedMethodCount: 1,
        },
        ],
    },
    clarification: {
      orchestrationMode: "query",
      rolloutStage: "candidate",
      shadowMode: false,
      policy: "return",
      outcomeType: "clarification_required",
      triggered: true,
      optionCount: 2,
      candidateCount: 3,
      viableCandidateCount: 2,
      recommendedOptionId: "tool-1:analyze_event_outcome_liquidity",
      recommendedOptionReason: "Event-level interpretation stays broadest.",
      autoResolved: false,
      autoSelectEnabled: false,
      assumptionMade: null,
      missingCapability: null,
      decisionReasonCode: "semantic_scope_ambiguity",
      decisionSignals: ["multi_outcome_market_scope"],
      evidenceSources: {
        usesMethodSchemas: true,
        usesProbeArgs: true,
        usesMethodMetadata: true,
        usesToolSelectionContext: true,
        usesLlmSelection: true,
      },
      comparedOptionIds: [
        "tool-1:analyze_event_outcome_liquidity",
        "tool-1:analyze_market_liquidity",
      ],
      decisionStrategy: "llm_primary",
      judgeAttempted: true,
      judgeApplied: true,
      judgeOutcomeType: "clarification_required",
      judgeConfidence: 0.84,
      judgeReason: "Need the user to choose event-wide or single-outcome scope.",
      judgeError: null,
      validatorReason: null,
      fallbackReason: null,
      copyStrategy: "deterministic",
      rewriteAttempted: false,
      rewriteApplied: false,
      rewriteError: null,
      candidateSummaries: [],
    },
    verification: {
      evaluations: [
        {
          attempt: 2,
          isComplete: false,
          missingParts: ["Need one more venue-level confirmation."],
          canRetryWithSameTools: true,
          needsDifferentTools: false,
          suggestedFix: "Patch the program to fetch one more market snapshot.",
          missingCapability: null,
          capabilityConstrained: false,
          outcome: "retry_same_tools",
          parseFailed: false,
          rawDecisionText: "retry_same_tools",
        },
      ],
      repairEvents: [
        {
          attempt: 2,
          outcome: "attempted",
          semanticRetryCount: 1,
          maxSemanticRetries: 2,
          strategy: null,
          summary: null,
          failReason: null,
          requestedReplan: false,
          hadSyntaxFix: false,
          editCount: null,
          skipReason: null,
          boundedAnswerReason: null,
          blockingDiagnostics: [],
        },
        {
          attempt: 2,
          outcome: "patched",
          semanticRetryCount: 1,
          maxSemanticRetries: 2,
          strategy: "patch",
          summary: "Added one extra market snapshot call.",
          failReason: null,
          requestedReplan: false,
          hadSyntaxFix: false,
          editCount: 1,
          skipReason: null,
          boundedAnswerReason: null,
          blockingDiagnostics: [],
        },
      ],
      triggerNeedsDifferentTools: false,
      triggerMissingCapability: null,
    },
  },
};

const MOCK_SSE_EVENTS = [
  'data: {"type":"tool-status","status":"discovering","tool":{"id":"","name":""}}',
  'data: {"type":"tool-status","status":"discovered","tool":{"id":"tool-uuid-1","name":"Whale Tracker"}}',
  'data: {"type":"tool-status","status":"planning","tool":{"id":"","name":""}}',
  'data: {"type":"tool-status","status":"executing","tool":{"id":"","name":""}}',
  'data: {"type":"tool-status","status":"tool-complete","tool":{"id":"","name":"get_whale_transactions"}}',
  'data: {"type":"tool-status","status":"synthesizing","tool":{"id":"","name":""}}',
  'data: {"type":"text-delta","delta":"Based on "}',
  'data: {"type":"text-delta","delta":"the latest "}',
  'data: {"type":"text-delta","delta":"data, "}',
  `data: ${JSON.stringify({
    type: "done",
    result: {
      response: "Based on the latest data, whale activity is up 15%.",
      toolsUsed: [{ id: "tool-uuid-1", name: "Whale Tracker", skillCalls: 2 }],
      cost: {
        totalCostUsd: "0.012000",
        toolCostUsd: "0.008000",
        modelCostUsd: "0.004000",
      },
      durationMs: 3800,
    },
  })}`,
  "data: [DONE]",
];

const MOCK_SSE_TRACE_EVENTS = [
  `data: ${JSON.stringify({
    type: "developer-trace",
    trace: {
      summary: { retryCount: 2, loopCount: 1 },
      timeline: [{ stepType: "retry", attempt: 2 }],
    },
  })}`,
  `data: ${JSON.stringify({
    type: "developer-trace",
    trace: {
      summary: { fallbackCount: 1, completionChecks: 3 },
      timeline: [{ stepType: "fallback", message: "Switched to backup branch" }],
    },
  })}`,
  `data: ${JSON.stringify({
    type: "done",
    result: {
      response: "Resolved with fallback branch.",
      toolsUsed: [{ id: "tool-uuid-1", name: "Whale Tracker", skillCalls: 2 }],
      cost: {
        totalCostUsd: "0.012000",
        toolCostUsd: "0.008000",
        modelCostUsd: "0.004000",
      },
      durationMs: 3800,
    },
  })}`,
  "data: [DONE]",
];

const MOCK_CLARIFICATION_RESULT = {
  response:
    "I found multiple plausible ways to interpret this request. Which direction should I take?",
  toolsUsed: [],
  cost: {
    totalCostUsd: "0.000000",
    toolCostUsd: "0.000000",
    modelCostUsd: "0.000000",
  },
  durationMs: 1100,
  outcomeType: "clarification_required" as const,
  querySession: {
    sessionId: "33333333-3333-4333-8333-333333333333",
    attemptId: "44444444-4444-4444-8444-444444444444",
    parentAttemptId: null,
    rootAttemptId: "44444444-4444-4444-8444-444444444444",
    mode: "initial" as const,
    origin: "initial_request" as const,
    status: "active" as const,
    checkpoint: {
      currentStage: "clarification",
      latestCheckpointArtifactId: "artifact-clarification",
      canonicalDatasetId: null,
      executionProgramCurrentRevisionId: null,
    },
  },
  clarification: {
    question: "Which direction should I take?",
    options: [
      {
        id: "tool-1:analyze_event_outcome_liquidity",
        toolId: "tool-1",
        toolName: "Polymarket",
        methodName: "analyze_event_outcome_liquidity",
        label: "Compare event-level liquidity",
        description: "Polymarket -> analyze_event_outcome_liquidity",
        fitScore: 9,
        recommended: true,
      },
      {
        id: "tool-1:analyze_market_liquidity",
        toolId: "tool-1",
        toolName: "Polymarket",
        methodName: "analyze_market_liquidity",
        label: "Analyze one specific outcome",
        description: "Polymarket -> analyze_market_liquidity",
        fitScore: 5,
        recommended: false,
      },
    ],
    allowFreeform: true,
    recommendedOptionId: "tool-1:analyze_event_outcome_liquidity",
    originalQuery: "Analyze liquidity for the World Cup winner market",
  },
};

const MOCK_AUTO_SELECTED_RESULT = {
  ...MOCK_SUCCESS_RESPONSE,
  outcomeType: "answer" as const,
  assumptionMade: {
    mode: "auto" as const,
    optionId: "tool-1:analyze_event_outcome_liquidity",
    label: "Compare event-level liquidity",
    reason:
      "Recommended because Polymarket.analyze_event_outcome_liquidity ranked highest after comparing probe fit, method contract details, and grounded query eligibility.",
  },
};

const MOCK_CAPABILITY_MISS_RESULT = {
  response:
    "I could not satisfy this request with grounded tool coverage. Try narrowing the venue or asking for supported market data instead.",
  toolsUsed: [],
  cost: {
    totalCostUsd: "0.000000",
    toolCostUsd: "0.000000",
    modelCostUsd: "0.000000",
  },
  durationMs: 950,
  outcomeType: "capability_miss" as const,
  querySession: {
    sessionId: "55555555-5555-4555-8555-555555555555",
    attemptId: "66666666-6666-4666-8666-666666666666",
    parentAttemptId: null,
    rootAttemptId: "66666666-6666-4666-8666-666666666666",
    mode: "initial" as const,
    origin: "initial_request" as const,
    status: "failed" as const,
    checkpoint: {
      currentStage: "capability-miss",
      latestCheckpointArtifactId: "artifact-capability-miss",
      canonicalDatasetId: null,
      executionProgramCurrentRevisionId: null,
    },
  },
  capabilityMiss: {
    message:
      "I could not satisfy this request with grounded tool coverage. Try narrowing the venue or asking for supported market data instead.",
    missingCapabilities: [
      "Need venue coverage that no selected tool exposes.",
    ],
    suggestedRewrites: [
      "Ask for a supported venue instead of Bybit.",
      "Request Polymarket market liquidity rather than perpetual order-book data.",
      "Name the exact supported market you want analyzed.",
    ],
    originalQuery: "Using only Polymarket data, give me live order-book imbalance for BTC perpetuals on Bybit.",
  },
};

// ============================================================================
// Tests
// ============================================================================

describe("Query Resource", () => {
  let client: ContextClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ContextClient({ apiKey: "ctx_test_key_1234567890abcdef12345678" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
  });

  // ── query.run() ──────────────────────────────────────────────────────

  describe("query.run()", () => {
    it("sends correct request body with string shorthand", async () => {
      const mockFn = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);
      globalThis.fetch = mockFn;

      await client.query.run("What are the top whale movements?");

      // Verify the fetch call
      expect(mockFn).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFn.mock.calls[0];

      expect(url).toBe("https://www.ctxprotocol.com/api/v1/query");
      expect(opts.method).toBe("POST");
      expect(new Headers(opts.headers).get("Authorization")).toBe(
        "Bearer ctx_test_key_1234567890abcdef12345678",
      );

      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        query: "What are the top whale movements?",
        tools: undefined,
        stream: true,
      });
    });

    it("sends correct request body with options object", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      await client.query.run({
        query: "Analyze whale activity",
        tools: ["tool-uuid-1", "tool-uuid-2"],
      });

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body).toEqual({
        query: "Analyze whale activity",
        tools: ["tool-uuid-1", "tool-uuid-2"],
        stream: true,
      });
    });

    it("forwards model and data options for run()", async () => {
      const mockFn = mockFetchRunResult({
        ...MOCK_SUCCESS_RESPONSE,
        data: { summary: "tool output" },
        dataUrl: "https://example.public.blob.vercel-storage.com/data.json",
        developerTrace: MOCK_DEVELOPER_TRACE,
      });
      globalThis.fetch = mockFn;

      const result = await client.query.run({
        query: "Analyze whale activity",
        answerModelId: "glm-model",
        responseShape: "answer_with_evidence",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
      });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body).toEqual({
        query: "Analyze whale activity",
        tools: undefined,
        answerModelId: "glm-model",
        responseShape: "answer_with_evidence",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
        stream: true,
      });
      expect(result.data).toEqual({ summary: "tool output" });
      expect(result.dataUrl).toBe(
        "https://example.public.blob.vercel-storage.com/data.json",
      );
      expect(result.developerTrace?.summary?.retryCount).toBe(2);
    });

    it("forwards clarificationPolicy for run()", async () => {
      const mockFn = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);
      globalThis.fetch = mockFn;

      await client.query.run({
        query: "Analyze whale activity",
        clarificationPolicy: "auto",
      });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.clarificationPolicy).toBe("auto");
    });

    it("forwards resumeFrom for run()", async () => {
      const mockFn = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);
      globalThis.fetch = mockFn;

      await client.query.run({
        query: "Resume this query",
        resumeFrom: {
          sessionId: "77777777-7777-4777-8777-777777777777",
          attemptId: "88888888-8888-4888-8888-888888888888",
        },
      });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body.resumeFrom).toEqual({
        sessionId: "77777777-7777-4777-8777-777777777777",
        attemptId: "88888888-8888-4888-8888-888888888888",
      });
    });

    it("includes querySession in run() results when present", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      const result = await client.query.run("test query");
      expect(result.querySession).toEqual(MOCK_SUCCESS_RESPONSE.querySession);
    });

    it("includes developerTrace in run() result when present", async () => {
      globalThis.fetch = mockFetchRunResult({
        ...MOCK_SUCCESS_RESPONSE,
        developerTrace: MOCK_DEVELOPER_TRACE,
      });

      const result = await client.query.run("test query");
      expect(result.developerTrace).toEqual(MOCK_DEVELOPER_TRACE);
      expect(result.developerTrace?.diagnostics?.selection?.selectedPolicy).toBe(
        "exploratory",
      );
      expect(result.developerTrace?.diagnostics?.selection?.oneShotBias).toBe(
        false,
      );
      expect(
        result.developerTrace?.diagnostics?.selection?.scoutProbeAmbiguityPoolCount
      ).toBe(2);
      expect(
        result.developerTrace?.diagnostics?.verification?.repairEvents?.[1]
          ?.outcome
      ).toBe("patched");
      expect(
        result.developerTrace?.diagnostics?.clarification?.decisionStrategy
      ).toBe("llm_primary");
    });

    it("includes orchestrationMetrics in run() result when present", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      const result = await client.query.run("test query");
      expect(result.orchestrationMetrics).toEqual(
        MOCK_SUCCESS_RESPONSE.orchestrationMetrics,
      );
    });

    it("returns undefined developerTrace when API omits it", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      const result = await client.query.run("test query");
      expect(result.developerTrace).toBeUndefined();
    });

    it("builds synthetic developerTrace when requested and API omits it", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      const result = await client.query.run({
        query: "test query",
        includeDeveloperTrace: true,
      });

      expect(result.developerTrace).toBeDefined();
      expect(result.developerTrace?.synthetic).toBe(true);
      expect(result.developerTrace?.summary?.toolCalls).toBe(4);
      expect(result.developerTrace?.summary?.retryCount).toBe(0);
      expect(result.developerTrace?.timeline?.length).toBe(2);
    });

    it("forwards Idempotency-Key header for run options", async () => {
      const mockFn = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);
      globalThis.fetch = mockFn;

      await client.query.run({
        query: "Analyze whale activity",
        tools: ["tool-uuid-1", "tool-uuid-2"],
        idempotencyKey: "f4f14e22-7db1-4a2d-8b95-b5806f3fa677",
      });

      const [, opts] = mockFn.mock.calls[0];
      expect(new Headers(opts.headers).get("Idempotency-Key")).toBe(
        "f4f14e22-7db1-4a2d-8b95-b5806f3fa677",
      );
    });

    it("does not retry non-idempotent run() requests after a retryable fetch failure", async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce(mockFetchRunResult(MOCK_SUCCESS_RESPONSE)());
      globalThis.fetch = mockFn;

      await expect(client.query.run("test query")).rejects.toThrow(ContextError);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("does not retry idempotent run() requests after a retryable fetch failure", async () => {
      const mockFn = vi
        .fn()
        .mockRejectedValueOnce(new Error("fetch failed"))
        .mockResolvedValueOnce(mockFetchRunResult(MOCK_SUCCESS_RESPONSE)());
      globalThis.fetch = mockFn;

      await expect(
        client.query.run({
          query: "test query",
          idempotencyKey: "f4f14e22-7db1-4a2d-8b95-b5806f3fa677",
        }),
      ).rejects.toThrow(ContextError);
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("throws if the run() stream ends before a done event", async () => {
      const mockFn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "content-type": "text/event-stream" }),
          body: {
            getReader: () => ({
              read: vi
                .fn()
                .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("data: [DONE]\n") })
                .mockResolvedValueOnce({ done: true, value: undefined }),
              releaseLock: vi.fn(),
            }),
          },
        });
      globalThis.fetch = mockFn;

      await expect(client.query.run("test query")).rejects.toThrow(
        "Streaming query ended before done event",
      );
      expect(mockFn).toHaveBeenCalledTimes(1);
    });

    it("parses success response into QueryResult", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_SUCCESS_RESPONSE);

      const result: QueryResult = await client.query.run("test query");

      expect(result.response).toBe(MOCK_SUCCESS_RESPONSE.response);
      expect(result.outcomeType).toBe("answer");
      expect(result.toolsUsed).toHaveLength(2);
      expect(result.toolsUsed[0]).toEqual({
        id: "tool-uuid-1",
        name: "Whale Tracker",
        skillCalls: 3,
      });
      expect(result.cost).toEqual({
        totalCostUsd: "0.015400",
        toolCostUsd: "0.010000",
        modelCostUsd: "0.005400",
      });
      expect(result.durationMs).toBe(4200);
      expect(result.orchestrationMetrics).toEqual(
        MOCK_SUCCESS_RESPONSE.orchestrationMetrics,
      );
    });

    it("preserves structured evidence envelopes in QueryResult", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_EVIDENCE_RESPONSE);

      const result: QueryResult = await client.query.run({
        query: "Where is BTC flowing today?",
        responseShape: "evidence_only",
      });

      expect(result.outcomeType).toBe("answer");
      if (result.outcomeType === "answer") {
        expect(result.responseShape).toBe("evidence_only");
        expect(result.summary).toBe(MOCK_EVIDENCE_RESPONSE.summary);
        expect(result.evidence?.facts[0]?.label).toBe("Net BTC exchange flow");
        expect(result.artifacts?.canonicalDataRef?.datasetId).toBe("dataset-1");
        expect(result.usage?.outcomeType).toBe("answer");
      }
    });

    it("parses shared grounded answer fixture artifacts and grounding", async () => {
      globalThis.fetch = mockFetchRunResult(SHARED_QUERY_FIXTURE.groundedAnswer);

      const result: QueryResult = await client.query.run({
        query: "Compare BTC and ETH returns.",
        includeDeveloperTrace: true,
      });

      expect(result.outcomeType).toBe("answer");
      expect(result.grounding).toEqual({
        availableToolCount: 4,
        availableMethodNamesSample: [
          "Market Data.get_candles",
          "Market Data.get_funding_history",
          "Market Data.get_open_interest_history",
        ],
        selectedMethodCount: 3,
        selectedButFilteredOut: [],
        toolCallCount: 2,
        grounded: true,
      });
      expect(result.computedArtifacts).toHaveLength(1);
      expect(result.computedArtifacts?.[0]?.kind).toBe("chart");
      if (result.computedArtifacts?.[0]?.kind === "chart") {
        expect(result.computedArtifacts[0].spec.xKey).toBe("date");
        expect(result.computedArtifacts[0].data[1]?.btcReturn).toBe(0.034);
      }
      expect(
        result.developerTrace?.diagnostics?.execution?.toolRegistry
          ?.availableToolCount,
      ).toBe(4);
    });

    it("preserves expanded chart artifact specs for SDK consumers", async () => {
      globalThis.fetch = mockFetchRunResult({
        ...MOCK_SUCCESS_RESPONSE,
        computedArtifacts: [
          {
            kind: "chart",
            title: "Correlation Heatmap",
            spec: {
              type: "heatmap",
              xKey: "x",
              yKey: "y",
              valueKey: "value",
              expectedMeasures: ["correlation"],
              series: [
                {
                  key: "value",
                  label: "Correlation",
                  satisfies: "correlation",
                },
              ],
              yAxis: { label: "Asset" },
            },
            data: [
              { x: "BTC", y: "BTC", value: 1 },
              { x: "BTC", y: "ETH", value: 0.82 },
            ],
          },
          {
            kind: "chart",
            title: "BTC Daily Candles",
            spec: {
              type: "candlestick",
              xKey: "time",
              series: [{ key: "close", label: "Close" }],
              xAxis: { type: "time", label: "Date" },
              yAxis: { label: "Price", format: "currency" },
              ohlc: {
                openKey: "open",
                highKey: "high",
                lowKey: "low",
                closeKey: "close",
              },
            },
            data: [
              {
                time: "2026-04-01",
                open: 100,
                high: 104,
                low: 98,
                close: 102,
              },
            ],
          },
          {
            kind: "chart",
            title: "Probability and Volume",
            spec: {
              type: "composed",
              xKey: "market",
              expectedMeasures: ["probability", "volume"],
              series: [
                {
                  key: "probability",
                  label: "Probability",
                  satisfies: "probability",
                  yAxis: "left",
                },
                {
                  key: "volumeUsd",
                  label: "Volume",
                  satisfies: "volume",
                  yAxis: "right",
                },
              ],
              yAxis: { format: "percent", valueScale: "fraction" },
              yAxisRight: { format: "currency" },
            },
            data: [
              { market: "A", probability: 0.42, volumeUsd: 1_500_000 },
              { market: "B", probability: 0.31, volumeUsd: 900_000 },
            ],
          },
        ],
      });

      const result = await client.query.run("Render richer chart artifacts");

      expect(result.computedArtifacts).toHaveLength(3);
      const heatmap = result.computedArtifacts?.[0];
      expect(heatmap?.kind).toBe("chart");
      if (heatmap?.kind === "chart") {
        expect(heatmap.spec.type).toBe("heatmap");
        expect(heatmap.spec.expectedMeasures).toEqual(["correlation"]);
        expect(heatmap.spec.series[0]?.satisfies).toBe("correlation");
        expect(heatmap.spec.valueKey).toBe("value");
        expect(heatmap.data[1]?.value).toBe(0.82);
      }
      const candlestick = result.computedArtifacts?.[1];
      expect(candlestick?.kind).toBe("chart");
      if (candlestick?.kind === "chart") {
        expect(candlestick.spec.type).toBe("candlestick");
        expect(candlestick.spec.ohlc?.closeKey).toBe("close");
        expect(candlestick.spec.xAxis?.label).toBe("Date");
      }
      const mixedAxis = result.computedArtifacts?.[2];
      expect(mixedAxis?.kind).toBe("chart");
      if (mixedAxis?.kind === "chart") {
        expect(mixedAxis.spec.yAxis?.valueScale).toBe("fraction");
        expect(mixedAxis.spec.yAxisRight?.format).toBe("currency");
        expect(mixedAxis.spec.series[1]?.yAxis).toBe("right");
        expect(mixedAxis.spec.series[1]?.satisfies).toBe("volume");
      }
    });

    it("parses shared ungrounded runtime fixture as capability miss", async () => {
      globalThis.fetch = mockFetchRunResult(
        SHARED_QUERY_FIXTURE.ungroundedCapabilityMiss,
      );

      const result = await client.query.run({
        query: "Compare BTC and ETH returns.",
        clarificationPolicy: "return",
      });

      expect(result.outcomeType).toBe("capability_miss");
      expect(result.grounding?.grounded).toBe(false);
      expect(result.grounding?.availableToolCount).toBe(3);
      if (result.outcomeType === "capability_miss") {
        expect(result.capabilityMiss.missingCapabilities).toEqual([
          "runtime_did_not_invoke_selected_tools",
        ]);
      }
    });

    it("returns structured clarification results by default", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_CLARIFICATION_RESULT);

      const result = await client.query.run({
        query: "Analyze liquidity for the World Cup winner market",
        clarificationPolicy: "return",
      });

      expect(result.outcomeType).toBe("clarification_required");
      if (result.outcomeType === "clarification_required") {
        expect(result.clarification.options).toHaveLength(2);
        expect(result.clarification.recommendedOptionId).toBe(
          "tool-1:analyze_event_outcome_liquidity",
        );
      }
    });

    it("returns structured capability misses by default", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_CAPABILITY_MISS_RESULT);

      const result = await client.query.run({
        query:
          "Using only Polymarket data, give me live order-book imbalance for BTC perpetuals on Bybit.",
        clarificationPolicy: "return",
      });

      expect(result.outcomeType).toBe("capability_miss");
      if (result.outcomeType === "capability_miss") {
        expect(result.capabilityMiss.missingCapabilities).toEqual([
          "Need venue coverage that no selected tool exposes.",
        ]);
        expect(result.capabilityMiss.suggestedRewrites).toHaveLength(3);
      }
    });

    it("preserves server-side clarification auto-select assumptions", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_AUTO_SELECTED_RESULT);

      const result = await client.query.run({
        query: "Analyze liquidity for the World Cup winner market",
        clarificationPolicy: "auto",
      });

      expect(result.outcomeType).toBe("answer");
      if (result.outcomeType === "answer") {
        expect(result.assumptionMade?.mode).toBe("auto");
        expect(result.assumptionMade?.optionId).toBe(
          "tool-1:analyze_event_outcome_liquidity",
        );
      }
    });

    it("throws when clarificationPolicy is error and clarification is returned", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_CLARIFICATION_RESULT);

      await expect(
        client.query.run({
          query: "Analyze liquidity for the World Cup winner market",
          clarificationPolicy: "error",
        }),
      ).rejects.toThrow(ContextError);
    });

    it("throws when clarificationPolicy is error and capability miss is returned", async () => {
      globalThis.fetch = mockFetchRunResult(MOCK_CAPABILITY_MISS_RESULT);

      await expect(
        client.query.run({
          query:
            "Using only Polymarket data, give me live order-book imbalance for BTC perpetuals on Bybit.",
          clarificationPolicy: "error",
        }),
      ).rejects.toThrow(ContextError);
    });

    it("throws ContextError on insufficient_allowance", async () => {
      globalThis.fetch = mockFetchError(
        "Insufficient funds. Set a spending cap in the dashboard.",
        "insufficient_allowance",
        402,
      );

      await expect(
        client.query.run("test query"),
      ).rejects.toThrow(ContextError);

      try {
        await client.query.run("test query");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const ctxError = error as ContextError;
        expect(ctxError.message).toContain("Insufficient funds");
        expect(ctxError.code).toBe("insufficient_allowance");
        expect(ctxError.statusCode).toBe(402);
      }
    });

    it("throws ContextError on no_wallet", async () => {
      globalThis.fetch = mockFetchError(
        "Account not fully set up.",
        "no_wallet",
        400,
      );

      try {
        await client.query.run("test query");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const ctxError = error as ContextError;
        expect(ctxError.code).toBe("no_wallet");
      }
    });

    it("throws ContextError on query_failed", async () => {
      // Use 422 to avoid _fetch retry logic (retries on 5xx)
      globalThis.fetch = mockFetchError(
        "Query failed: Tool execution timed out",
        "query_failed",
        422,
      );

      try {
        await client.query.run("test query");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextError);
        const ctxError = error as ContextError;
        expect(ctxError.code).toBe("query_failed");
        expect(ctxError.statusCode).toBe(422);
      }
    });
  });

  // ── query.stream() ───────────────────────────────────────────────────

  describe("query.stream()", () => {
    it("sends correct request body with stream: true", async () => {
      const mockFn = mockFetchSSE(MOCK_SSE_EVENTS);
      globalThis.fetch = mockFn;

      // Consume the stream to trigger the fetch
      const events = [];
      for await (const event of client.query.stream("What are whale movements?")) {
        events.push(event);
      }

      // Verify fetch was called correctly
      expect(mockFn).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body).toEqual({
        query: "What are whale movements?",
        tools: undefined,
        stream: true,
      });
    });

    it("yields all event types in correct order", async () => {
      globalThis.fetch = mockFetchSSE(MOCK_SSE_EVENTS);

      const events = [];
      for await (const event of client.query.stream("test query")) {
        events.push(event);
      }

      // Should have: 6 tool-status + 3 text-delta + 1 done = 10 events
      expect(events).toHaveLength(10);

      // First events should be tool-status
      const statusEvents = events.filter(
        (e) => e.type === "tool-status",
      ) as QueryStreamToolStatusEvent[];
      expect(statusEvents).toHaveLength(6);
      expect(statusEvents[0].status).toBe("discovering");
      expect(statusEvents[1].status).toBe("discovered");
      expect(statusEvents[1].tool.name).toBe("Whale Tracker");

      // Text deltas
      const textEvents = events.filter(
        (e) => e.type === "text-delta",
      ) as QueryStreamTextDeltaEvent[];
      expect(textEvents).toHaveLength(3);
      expect(textEvents[0].delta).toBe("Based on ");
      expect(textEvents[1].delta).toBe("the latest ");
      expect(textEvents[2].delta).toBe("data, ");

      // Done event with full result
      const doneEvents = events.filter(
        (e) => e.type === "done",
      ) as QueryStreamDoneEvent[];
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].result.response).toContain("whale activity");
      expect(doneEvents[0].result.toolsUsed).toHaveLength(1);
      expect(doneEvents[0].result.cost.totalCostUsd).toBe("0.012000");
      expect(doneEvents[0].result.durationMs).toBe(3800);
    });

    it("stops on [DONE] sentinel", async () => {
      // Stream with [DONE] in the middle followed by more data
      globalThis.fetch = mockFetchSSE([
        'data: {"type":"text-delta","delta":"hello "}',
        "data: [DONE]",
        'data: {"type":"text-delta","delta":"should not appear"}',
      ]);

      const events = [];
      for await (const event of client.query.stream("test")) {
        events.push(event);
      }

      // Should only have 1 event (before [DONE])
      expect(events).toHaveLength(1);
      expect((events[0] as QueryStreamTextDeltaEvent).delta).toBe("hello ");
    });

    it("skips malformed SSE events gracefully", async () => {
      globalThis.fetch = mockFetchSSE([
        'data: {"type":"text-delta","delta":"valid "}',
        "data: {invalid json}",
        'data: {"type":"text-delta","delta":"also valid "}',
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream("test")) {
        events.push(event);
      }

      // Should have 2 valid events, malformed one skipped
      expect(events).toHaveLength(2);
    });

    it("supports options object with tools", async () => {
      globalThis.fetch = mockFetchSSE([
        'data: {"type":"text-delta","delta":"result "}',
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query: "test",
        tools: ["tool-1", "tool-2"],
      })) {
        events.push(event);
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.tools).toEqual(["tool-1", "tool-2"]);
    });

    it("forwards model and data options for stream()", async () => {
      globalThis.fetch = mockFetchSSE([
        'data: {"type":"text-delta","delta":"result "}',
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query: "test",
        answerModelId: "claude-sonnet-model",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
      })) {
        events.push(event);
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.answerModelId).toBe("claude-sonnet-model");
      expect(body.includeData).toBe(true);
      expect(body.includeDataUrl).toBe(true);
      expect(body.includeDeveloperTrace).toBe(true);
    });

    it("forwards clarificationPolicy for stream()", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_SUCCESS_RESPONSE),
        "data: [DONE]",
      ]);

      for await (const _event of client.query.stream({
        query: "test",
        clarificationPolicy: "auto",
      })) {
        // consume
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.clarificationPolicy).toBe("auto");
    });

    it("forwards forkFrom for stream()", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_SUCCESS_RESPONSE),
        "data: [DONE]",
      ]);

      for await (const _event of client.query.stream({
        query: "fork this query",
        forkFrom: {
          sessionId: "99999999-9999-4999-8999-999999999999",
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          reason: "bounded_rediscovery",
        },
      })) {
        // consume
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.forkFrom).toEqual({
        sessionId: "99999999-9999-4999-8999-999999999999",
        attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        reason: "bounded_rediscovery",
      });
    });

    it("yields structured clarification done events by default", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_CLARIFICATION_RESULT),
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query: "test",
        clarificationPolicy: "return",
      })) {
        events.push(event);
      }

      const doneEvent = events.find((event) => event.type === "done") as
        | QueryStreamDoneEvent
        | undefined;
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.result.outcomeType).toBe("clarification_required");
    });

    it("yields structured capability miss done events by default", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_CAPABILITY_MISS_RESULT),
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query:
          "Using only Polymarket data, give me live order-book imbalance for BTC perpetuals on Bybit.",
        clarificationPolicy: "return",
      })) {
        events.push(event);
      }

      const doneEvent = events.find((event) => event.type === "done") as
        | QueryStreamDoneEvent
        | undefined;
      expect(doneEvent).toBeDefined();
      expect(doneEvent?.result.outcomeType).toBe("capability_miss");
      if (doneEvent?.result.outcomeType === "capability_miss") {
        expect(doneEvent.result.capabilityMiss.suggestedRewrites).toHaveLength(3);
      }
    });

    it("turns structured clarification outcomes into error events when policy is error", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_CLARIFICATION_RESULT),
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query: "test",
        clarificationPolicy: "error",
      })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === "error") as
        | QueryStreamErrorEvent
        | undefined;
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.outcomeType).toBe("clarification_required");
      expect(errorEvent?.clarification?.recommendedOptionId).toBe(
        "tool-1:analyze_event_outcome_liquidity",
      );
      expect(errorEvent?.querySession).toEqual(MOCK_CLARIFICATION_RESULT.querySession);
      expect(events.some((event) => event.type === "done")).toBe(false);
    });

    it("turns structured capability miss outcomes into error events when policy is error", async () => {
      globalThis.fetch = mockFetchSSE([
        buildDoneEvent(MOCK_CAPABILITY_MISS_RESULT),
        "data: [DONE]",
      ]);

      const events = [];
      for await (const event of client.query.stream({
        query:
          "Using only Polymarket data, give me live order-book imbalance for BTC perpetuals on Bybit.",
        clarificationPolicy: "error",
      })) {
        events.push(event);
      }

      const errorEvent = events.find((event) => event.type === "error") as
        | QueryStreamErrorEvent
        | undefined;
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.outcomeType).toBe("capability_miss");
      expect(errorEvent?.capabilityMiss?.missingCapabilities).toEqual([
        "Need venue coverage that no selected tool exposes.",
      ]);
      expect(errorEvent?.querySession).toEqual(MOCK_CAPABILITY_MISS_RESULT.querySession);
      expect(events.some((event) => event.type === "done")).toBe(false);
    });

    it("handles developer-trace stream events and aggregates final trace", async () => {
      globalThis.fetch = mockFetchSSE(MOCK_SSE_TRACE_EVENTS);

      const events = [];
      for await (const event of client.query.stream("test query")) {
        events.push(event);
      }

      const traceEvents = events.filter(
        (e) => e.type === "developer-trace",
      ) as QueryStreamDeveloperTraceEvent[];
      expect(traceEvents).toHaveLength(2);
      expect(traceEvents[0].trace.summary?.retryCount).toBe(2);
      expect(traceEvents[1].trace.summary?.fallbackCount).toBe(1);

      const doneEvents = events.filter(
        (e) => e.type === "done",
      ) as QueryStreamDoneEvent[];
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].result.developerTrace?.summary?.retryCount).toBe(2);
      expect(doneEvents[0].result.developerTrace?.summary?.fallbackCount).toBe(1);
      expect(doneEvents[0].result.developerTrace?.summary?.completionChecks).toBe(
        3,
      );
      expect(doneEvents[0].result.developerTrace?.timeline).toHaveLength(2);
    });

    it("builds synthetic done trace from stream status when requested and backend omits trace", async () => {
      globalThis.fetch = mockFetchSSE(MOCK_SSE_EVENTS);

      const events = [];
      for await (const event of client.query.stream({
        query: "test query",
        includeDeveloperTrace: true,
      })) {
        events.push(event);
      }

      const doneEvents = events.filter(
        (e) => e.type === "done",
      ) as QueryStreamDoneEvent[];
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0].result.developerTrace).toBeDefined();
      expect(doneEvents[0].result.developerTrace?.synthetic).toBe(true);
      expect(doneEvents[0].result.developerTrace?.summary?.toolCalls).toBe(2);
      expect(doneEvents[0].result.developerTrace?.timeline?.length).toBeGreaterThan(
        0,
      );
    });

    it("forwards Idempotency-Key header for stream options", async () => {
      const mockFn = mockFetchSSE([
        'data: {"type":"text-delta","delta":"result "}',
        "data: [DONE]",
      ]);
      globalThis.fetch = mockFn;

      const events = [];
      for await (const event of client.query.stream({
        query: "test",
        tools: ["tool-1", "tool-2"],
        idempotencyKey: "21118fda-33be-4d66-8df5-0e50b3371f54",
      })) {
        events.push(event);
      }

      const [, opts] = mockFn.mock.calls[0];
      expect(opts.headers["Idempotency-Key"]).toBe(
        "21118fda-33be-4d66-8df5-0e50b3371f54",
      );
    });

    it("throws on error response from server", async () => {
      globalThis.fetch = mockFetchError(
        "Insufficient funds",
        "insufficient_allowance",
        402,
      );

      await expect(async () => {
        for await (const _event of client.query.stream("test")) {
          // Should not reach here
        }
      }).rejects.toThrow(ContextError);
    });
  });
});
