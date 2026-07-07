import type {
  QueryOptions,
  QueryDeveloperTrace,
  QueryJobStartResult,
  QueryJobStatusResult,
  QueryPollOptions,
  QueryResult,
  QueryStreamEvent,
} from "../types.js";
import { ContextError } from "../types.js";
import type { ContextClient } from "../client.js";

/**
 * Internal HTTP status-check cadence for `poll()` / `runOrPoll()`.
 *
 * This is plain HTTP polling below any LLM boundary — it costs no model
 * tokens no matter how frequent it is. A slower interval would only delay
 * completion detection, so keep it fast. (If you are wiring polling into an
 * LLM agent, the thing to minimize is *model turns*: use `runOrPoll()` so the
 * whole wait happens inside one call.)
 */
const DEFAULT_QUERY_POLL_INTERVAL_MS = 5_000;

/**
 * Default client-side wait. The hosted Query compute ceiling is 1800s
 * (Vercel extended max duration) on every path, and the server fails a job
 * shortly after that window; default to slightly beyond it so the client
 * observes the terminal state instead of giving up while the server is
 * still legitimately working.
 */
const DEFAULT_QUERY_POLL_TIMEOUT_MS = 31 * 60_000;

/**
 * Query resource for pay-per-response agentic queries.
 *
 * Unlike `tools.execute()` which calls a single tool once (pay-per-request),
 * the Query resource sends a natural-language question and lets the server
 * handle the live librarian pipeline (`discover -> select -> metadata scout ->
 * iterative execute -> synthesize -> settle`) plus AI
 * synthesis — all for one flat fee.
 *
 * This is the "prepared meal" vs "raw ingredients" distinction:
 * - `tools.execute()` = raw data, full control, predictable cost
 * - `query.run()` / `query.stream()` = curated intelligence, one payment
 */
export class Query {
  constructor(private client: ContextClient) {}

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private normalizeResult(result: QueryResult): QueryResult {
    const candidate = result as QueryResult & { outcomeType?: string };
    if (
      candidate.outcomeType === "capability_miss" &&
      "capabilityMiss" in candidate &&
      candidate.capabilityMiss
    ) {
      return candidate;
    }
    return {
      ...candidate,
      outcomeType: "answer",
    };
  }

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
   * Since 0.21.0 this is backed by the durable job path (`start()` +
   * `poll()`), so one call reliably survives the full 1800s hosted compute
   * ceiling and transient connection drops — there is no held-open SSE
   * connection for proxies or client timeouts to kill. Use `stream()` when
   * you want real-time SSE events instead.
   *
   * @param options - Query options or a plain string question
   * @param pollOptions - Optional internal status-check cadence and max client wait
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
  async run(
    options: QueryOptions | string,
    pollOptions: QueryPollOptions = {}
  ): Promise<QueryResult> {
    return await this.runOrPoll(options, pollOptions);
  }

  /**
   * Start a durable async query job. Use this for long-running queries that
   * may exceed a single blocking SDK request.
   */
  async start(options: QueryOptions | string): Promise<QueryJobStartResult> {
    const opts = typeof options === "string" ? { query: options } : options;
    const headers = opts.idempotencyKey
      ? { "Idempotency-Key": opts.idempotencyKey }
      : undefined;

    return await this.client._fetch<QueryJobStartResult>(
      "/api/v1/query/jobs",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: opts.query,
          tools: opts.tools,
          resumeFrom: opts.resumeFrom,
          forkFrom: opts.forkFrom,
          agentModelId: opts.agentModelId,
          responseShape: opts.responseShape,
          favoritesOnly: opts.favoritesOnly,
          includeData: opts.includeData,
          includeDataUrl: opts.includeDataUrl,
          includeDeveloperTrace: opts.includeDeveloperTrace,
        }),
      }
    );
  }

  /**
   * Fetch the current status for a durable async query job.
   */
  async getStatus(jobId: string): Promise<QueryJobStatusResult> {
    return await this.client._fetch<QueryJobStatusResult>(
      `/api/v1/query/jobs/${jobId}`
    );
  }

  /**
   * Poll a durable query job until completion or failure.
   *
   * `timeoutMs` controls how long this client waits; the hosted job itself is
   * bounded by the 1800s server compute ceiling. If the status endpoint
   * reports the job exceeded the server-side window, the job is terminal and
   * should not be polled again. `intervalMs` is an HTTP check cadence and has
   * no effect on LLM token usage — leave it at the fast default.
   */
  async poll(
    jobId: string,
    options: QueryPollOptions = {}
  ): Promise<QueryJobStatusResult> {
    const intervalMs = options.intervalMs ?? DEFAULT_QUERY_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() <= deadline) {
      const status = await this.getStatus(jobId);
      if (status.status === "completed") {
        return status;
      }
      if (status.status === "failed") {
        throw new ContextError(status.error ?? "Context query job failed");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.sleep(Math.min(intervalMs, remainingMs));
    }

    throw new ContextError(`Context query job polling timed out after ${timeoutMs}ms`);
  }

  /**
   * Run a query through the durable job path and wait internally for completion.
   *
   * `run()` delegates here since 0.21.0, so the two are equivalent;
   * `runOrPoll()` is kept as an explicit alias. The entire wait happens
   * inside this single call (one model turn for LLM agents), instead of one
   * turn per `getStatus()` check, and the job is bounded by the 1800s hosted
   * compute ceiling.
   */
  async runOrPoll(
    options: QueryOptions | string,
    pollOptions: QueryPollOptions = {}
  ): Promise<QueryResult> {
    const opts = typeof options === "string" ? { query: options } : options;
    const job = await this.start(opts);
    const completed = await this.poll(job.jobId, pollOptions);
    if (completed.status === "completed" && completed.result) {
      const result = this.normalizeResult(completed.result);
      if (!result.developerTrace && opts.includeDeveloperTrace) {
        result.developerTrace = this.buildSyntheticTraceFromRunResult({
          toolsUsed: result.toolsUsed,
          durationMs: result.durationMs,
        });
      }
      return result;
    }
    throw new ContextError(
      completed.error ?? "Context query job completed without a result"
    );
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
        resumeFrom: opts.resumeFrom,
        forkFrom: opts.forkFrom,
        agentModelId: opts.agentModelId,
        responseShape: opts.responseShape,
        favoritesOnly: opts.favoritesOnly,
        includeData: opts.includeData,
        includeDataUrl: opts.includeDataUrl,
        includeDeveloperTrace: opts.includeDeveloperTrace,
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
        const normalizedResult = this.normalizeResult(event.result);
        let mergedTrace = this.mergeDeveloperTrace(
          aggregatedTrace,
          normalizedResult.developerTrace
        );
        if (!mergedTrace && opts.includeDeveloperTrace) {
          mergedTrace =
            statusTimeline.length > 0
              ? this.buildSyntheticTraceFromStreamStatus({
                  statusTimeline,
                  toolsUsed: normalizedResult.toolsUsed,
                  durationMs: normalizedResult.durationMs,
                })
              : this.buildSyntheticTraceFromRunResult({
                  toolsUsed: normalizedResult.toolsUsed,
                  durationMs: normalizedResult.durationMs,
                });
        }
        if (mergedTrace) {
          normalizedResult.developerTrace = mergedTrace;
        }
        event.result = normalizedResult;
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
