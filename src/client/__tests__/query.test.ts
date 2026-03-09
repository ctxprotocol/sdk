import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextClient } from "../client.js";
import { ContextError } from "../types.js";
import type {
  QueryResult,
  QueryStreamDeveloperTraceEvent,
  QueryStreamToolStatusEvent,
  QueryStreamTextDeltaEvent,
  QueryStreamDoneEvent,
} from "../types.js";

// ============================================================================
// Helpers
// ============================================================================

/**
 * Mock a successful JSON response from fetch
 */
function mockFetchJson(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  });
}

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
        modelId: "glm-model",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
        queryDepth: "auto",
        debugScoutDeepMode: "deep-light",
      });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body).toEqual({
        query: "Analyze whale activity",
        tools: undefined,
        modelId: "glm-model",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
        queryDepth: "auto",
        debugScoutDeepMode: "deep-light",
        stream: true,
      });
      expect(result.data).toEqual({ summary: "tool output" });
      expect(result.dataUrl).toBe(
        "https://example.public.blob.vercel-storage.com/data.json",
      );
      expect(result.developerTrace?.summary?.retryCount).toBe(2);
    });

    it("includes developerTrace in run() result when present", async () => {
      globalThis.fetch = mockFetchRunResult({
        ...MOCK_SUCCESS_RESPONSE,
        developerTrace: MOCK_DEVELOPER_TRACE,
      });

      const result = await client.query.run("test query");
      expect(result.developerTrace).toEqual(MOCK_DEVELOPER_TRACE);
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
        modelId: "claude-sonnet-model",
        includeData: true,
        includeDataUrl: true,
        includeDeveloperTrace: true,
        queryDepth: "deep",
        debugScoutDeepMode: "deep-heavy",
      })) {
        events.push(event);
      }

      const body = JSON.parse(
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
      );
      expect(body.modelId).toBe("claude-sonnet-model");
      expect(body.includeData).toBe(true);
      expect(body.includeDataUrl).toBe(true);
      expect(body.includeDeveloperTrace).toBe(true);
      expect(body.queryDepth).toBe("deep");
      expect(body.debugScoutDeepMode).toBe("deep-heavy");
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
