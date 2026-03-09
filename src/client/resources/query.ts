import type {
  QueryOptions,
  QueryApiResponse,
  QueryDeveloperTrace,
  QueryResult,
  QueryStreamEvent,
} from "../types.js";
import { ContextError } from "../types.js";
import type { ContextClient } from "../client.js";

/**
 * Query resource for pay-per-response agentic queries.
 *
 * Unlike `tools.execute()` which calls a single tool once (pay-per-request),
 * the Query resource sends a natural-language question and lets the server
 * handle discovery-first orchestration (`discover/probe -> plan-from-evidence ->
 * execute -> bounded fallback`) plus AI synthesis — all for one flat fee.
 *
 * This is the "prepared meal" vs "raw ingredients" distinction:
 * - `tools.execute()` = raw data, full control, predictable cost
 * - `query.run()` / `query.stream()` = curated intelligence, one payment
 */
export class Query {
  constructor(private client: ContextClient) {}

  private buildSyntheticTraceFromRunResult(params: {
    toolsUsed: Array<{ id: string; name: string; skillCalls: number }>;
    durationMs: number;
  }): QueryDeveloperTrace {
    const timeline = params.toolsUsed.map((tool, index) => ({
      stepType: "tool-call",
      event: "tool-call",
      status: "success",
      timestampMs: index,
      tool: {
        id: tool.id,
        name: tool.name,
      },
      metadata: {
        skillCalls: tool.skillCalls,
        synthetic: true,
      },
    }));

    const toolCalls = params.toolsUsed.reduce(
      (sum, tool) => sum + Math.max(tool.skillCalls, 0),
      0
    );

    return {
      summary: {
        toolCalls,
        retryCount: 0,
        selfHealCount: 0,
        fallbackCount: 0,
        failureCount: 0,
        recoveryCount: 0,
        completionChecks: 0,
        loopCount: 0,
      },
      timeline,
      source: "sdk-fallback",
      synthetic: true,
      reason: "backend_trace_missing",
      durationMs: params.durationMs,
    };
  }

  private buildSyntheticTraceFromStreamStatus(params: {
    statusTimeline: Array<{
      status: string;
      tool: { id: string; name: string };
    }>;
    toolsUsed: Array<{ id: string; name: string; skillCalls: number }>;
    durationMs: number;
  }): QueryDeveloperTrace {
    const timeline = params.statusTimeline.map((entry, index) => ({
      stepType: "tool-status",
      event: "tool-status",
      status: entry.status,
      timestampMs: index,
      tool:
        entry.tool.name || entry.tool.id
          ? {
              id: entry.tool.id || undefined,
              name: entry.tool.name || undefined,
            }
          : undefined,
      metadata: { synthetic: true },
    }));

    const toolCallsFromUsage = params.toolsUsed.reduce(
      (sum, tool) => sum + Math.max(tool.skillCalls, 0),
      0
    );
    const toolCallsFromStatus = params.statusTimeline.filter(
      (entry) => entry.status === "tool-complete"
    ).length;
    const toolCalls = toolCallsFromUsage > 0 ? toolCallsFromUsage : toolCallsFromStatus;

    const retryCount = params.statusTimeline.filter((entry) =>
      /(retry|fix|reflect|recover)/i.test(entry.status)
    ).length;
    const completionChecks = params.statusTimeline.filter((entry) =>
      /complet/i.test(entry.status)
    ).length;

    return {
      summary: {
        toolCalls,
        retryCount,
        selfHealCount: retryCount,
        fallbackCount: 0,
        failureCount: 0,
        recoveryCount: 0,
        completionChecks,
        loopCount: retryCount,
      },
      timeline,
      source: "sdk-fallback",
      synthetic: true,
      reason: "backend_trace_missing",
      durationMs: params.durationMs,
    };
  }

  private mergeDeveloperTrace(
    first: QueryDeveloperTrace | undefined,
    second: QueryDeveloperTrace | undefined
  ): QueryDeveloperTrace | undefined {
    if (!first) return second;
    if (!second) return first;

    const firstTimeline = Array.isArray(first.timeline) ? first.timeline : [];
    const secondTimeline = Array.isArray(second.timeline) ? second.timeline : [];
    const mergedTimeline = [...firstTimeline, ...secondTimeline];

    return {
      ...first,
      ...second,
      summary: {
        ...(typeof first.summary === "object" && first.summary ? first.summary : {}),
        ...(typeof second.summary === "object" && second.summary
          ? second.summary
          : {}),
      },
      ...(mergedTimeline.length > 0 ? { timeline: mergedTimeline } : {}),
    };
  }

  private parseStreamEvent(rawData: string): QueryStreamEvent | undefined {
    const parsed = JSON.parse(rawData) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }

    const event = parsed as QueryStreamEvent;
    if (typeof (event as { type?: unknown }).type !== "string") {
      return undefined;
    }

    return event;
  }

  /**
   * Run an agentic query and wait for the full response.
   *
   * The server discovers relevant tools (or uses the ones you specify),
   * executes the discovery-first pipeline (up to 100 MCP calls per tool),
   * and returns an AI-synthesized answer. Payment is settled after
   * successful execution via deferred settlement.
   *
   * @param options - Query options or a plain string question
   * @returns The complete query result with response text, tools used, and cost
   *
   * @throws {ContextError} With code `no_wallet` if wallet not set up
   * @throws {ContextError} With code `insufficient_allowance` if spending cap not set
   * @throws {ContextError} With code `payment_failed` if payment settlement fails
   * @throws {ContextError} With code `execution_failed` if the agentic pipeline fails
   *
   * @example
   * ```typescript
   * // Simple question — server discovers tools automatically
   * const answer = await client.query.run("What are the top whale movements on Base?");
   * console.log(answer.response);      // AI-synthesized answer
   * console.log(answer.toolsUsed);     // Which tools were used
   * console.log(answer.cost);          // Cost breakdown
   *
   * // With specific tools (Manual Mode)
   * const answer = await client.query.run({
   *   query: "Analyze whale activity",
   *   tools: ["tool-uuid-1", "tool-uuid-2"],
   * });
   * ```
   */
  async run(options: QueryOptions | string): Promise<QueryResult> {
    const opts = typeof options === "string" ? { query: options } : options;
    let terminalError:
      | { error: string; code?: string; scope?: string; reasonCode?: string }
      | undefined;

    for await (const event of this.stream(opts)) {
      if (event.type === "error") {
        terminalError = {
          error: event.error,
          ...(event.code ? { code: event.code } : {}),
          ...(event.scope ? { scope: event.scope } : {}),
          ...(event.reasonCode ? { reasonCode: event.reasonCode } : {}),
        };
        continue;
      }

      if (event.type === "done") {
        return event.result;
      }
    }

    if (terminalError) {
      throw new ContextError(terminalError.error, terminalError.code);
    }

    throw new ContextError("Streaming query ended before done event");
  }

  /**
   * Run an agentic query with streaming. Returns an async iterable that
   * yields events as the server processes the query in real-time.
   *
   * Event types:
   * - `tool-status` — A tool started executing or changed status
   * - `text-delta` — A chunk of the AI response text
   * - `developer-trace` — Runtime trace metadata (when includeDeveloperTrace=true)
   * - `error` — A structured query/runtime error emitted before stream completion
   * - `done` — The full response is complete (includes final `QueryResult`)
   *
   * @param options - Query options or a plain string question
   * @returns An async iterable of stream events
   *
   * @example
   * ```typescript
   * for await (const event of client.query.stream("What are the top whale movements?")) {
   *   switch (event.type) {
   *     case "tool-status":
   *       console.log(`Tool ${event.tool.name}: ${event.status}`);
   *       break;
   *     case "text-delta":
   *       process.stdout.write(event.delta);
   *       break;
   *     case "developer-trace":
   *       console.log("Trace summary:", event.trace.summary);
   *       break;
   *     case "done":
   *       console.log("\nCost:", event.result.cost.totalCostUsd);
   *       break;
   *     case "error":
   *       console.error("Stream error:", event.error);
   *       break;
   *   }
   * }
   * ```
   */
  async *stream(
    options: QueryOptions | string
  ): AsyncGenerator<QueryStreamEvent> {
    const opts = typeof options === "string" ? { query: options } : options;
    const headers = opts.idempotencyKey
      ? { "Idempotency-Key": opts.idempotencyKey }
      : undefined;

    const response = await this.client._fetchRaw("/api/v1/query", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: opts.query,
        tools: opts.tools,
        modelId: opts.modelId,
        includeData: opts.includeData,
        includeDataUrl: opts.includeDataUrl,
        includeDeveloperTrace: opts.includeDeveloperTrace,
        queryDepth: opts.queryDepth,
        debugScoutDeepMode: opts.debugScoutDeepMode,
        stream: true,
      }),
    });

    const body = response.body;
    if (!body) {
      throw new ContextError("No response body for streaming query");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let aggregatedTrace: QueryDeveloperTrace | undefined;
    const statusTimeline: Array<{
      status: string;
      tool: { id: string; name: string };
    }> = [];

    const parseAndHydrateEvent = (
      rawData: string
    ): QueryStreamEvent | undefined => {
      const event = this.parseStreamEvent(rawData);
      if (!event) {
        return undefined;
      }

      if (event.type === "developer-trace") {
        aggregatedTrace = this.mergeDeveloperTrace(aggregatedTrace, event.trace);
        return event;
      }

      if (event.type === "tool-status") {
        statusTimeline.push({
          status: event.status,
          tool: {
            id: event.tool.id,
            name: event.tool.name,
          },
        });
        return event;
      }

      if (event.type === "done") {
        let mergedTrace = this.mergeDeveloperTrace(
          aggregatedTrace,
          event.result.developerTrace
        );
        if (!mergedTrace && opts.includeDeveloperTrace) {
          mergedTrace =
            statusTimeline.length > 0
              ? this.buildSyntheticTraceFromStreamStatus({
                  statusTimeline,
                  toolsUsed: event.result.toolsUsed,
                  durationMs: event.result.durationMs,
                })
              : this.buildSyntheticTraceFromRunResult({
                  toolsUsed: event.result.toolsUsed,
                  durationMs: event.result.durationMs,
                });
        }
        if (mergedTrace) {
          event.result.developerTrace = mergedTrace;
        }
      }

      return event;
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6);
            if (data === "[DONE]") return;
            try {
              const event = parseAndHydrateEvent(data);
              if (event) {
                yield event;
              }
            } catch {
              // Skip malformed SSE events
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim().startsWith("data: ")) {
        const data = buffer.trim().slice(6);
        if (data !== "[DONE]") {
          try {
            const event = parseAndHydrateEvent(data);
            if (event) {
              yield event;
            }
          } catch {
            // Skip malformed SSE events
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
