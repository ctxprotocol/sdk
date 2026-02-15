import type {
  QueryOptions,
  QueryApiResponse,
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
 * handle tool discovery, multi-tool orchestration, self-healing retries,
 * completeness checks, and AI synthesis — all for one flat fee.
 *
 * This is the "prepared meal" vs "raw ingredients" distinction:
 * - `tools.execute()` = raw data, full control, predictable cost
 * - `query.run()` / `query.stream()` = curated intelligence, one payment
 */
export class Query {
  constructor(private client: ContextClient) {}

  /**
   * Run an agentic query and wait for the full response.
   *
   * The server discovers relevant tools (or uses the ones you specify),
   * executes the full agentic pipeline (up to 100 MCP calls per tool),
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
    const headers = opts.idempotencyKey
      ? { "Idempotency-Key": opts.idempotencyKey }
      : undefined;

    const response = await this.client._fetch<QueryApiResponse>(
      "/api/v1/query",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: opts.query,
          tools: opts.tools,
          stream: false,
        }),
      }
    );

    // Handle error response
    if ("error" in response) {
      throw new ContextError(
        response.error,
        response.code,
        undefined,
        response.helpUrl
      );
    }

    // Handle success response
    if (response.success) {
      return {
        response: response.response,
        toolsUsed: response.toolsUsed,
        cost: response.cost,
        durationMs: response.durationMs,
      };
    }

    throw new ContextError("Unexpected response format from query API");
  }

  /**
   * Run an agentic query with streaming. Returns an async iterable that
   * yields events as the server processes the query in real-time.
   *
   * Event types:
   * - `tool-status` — A tool started executing or changed status
   * - `text-delta` — A chunk of the AI response text
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
   *     case "done":
   *       console.log("\nCost:", event.result.cost.totalCostUsd);
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
              yield JSON.parse(data) as QueryStreamEvent;
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
            yield JSON.parse(data) as QueryStreamEvent;
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
