import type { QueryOptions, QueryResult, QueryStreamEvent } from "../types.js";
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
export declare class Query {
    private client;
    constructor(client: ContextClient);
    private normalizeResult;
    private buildPolicyErrorEvent;
    private buildSyntheticTraceFromRunResult;
    private buildSyntheticTraceFromStreamStatus;
    private mergeDeveloperTrace;
    private parseStreamEvent;
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
    run(options: QueryOptions | string): Promise<QueryResult>;
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
    stream(options: QueryOptions | string): AsyncGenerator<QueryStreamEvent>;
}
//# sourceMappingURL=query.d.ts.map