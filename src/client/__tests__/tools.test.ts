import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextClient } from "../client.js";
import { ContextError } from "../types.js";

function mockFetchJson(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  });
}

describe("Tools Resource", () => {
  let client: ContextClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ContextClient({ apiKey: "ctx_test_key_1234567890abcdef12345678" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
  });

  it("returns execute mode and spend envelope fields", async () => {
    const mockFn = mockFetchJson({
      success: true,
      mode: "execute",
      result: { value: 42 },
      tool: { id: "tool-1", name: "Market Data" },
      method: { name: "get_price", executePriceUsd: "0.05" },
      session: {
        mode: "execute",
        sessionId: "sess_123",
        methodPrice: "0.05",
        spent: "0.05",
        remaining: "0.95",
        maxSpend: "1",
        status: "open",
        expiresAt: "2026-02-22T00:00:00.000Z",
        closeRequested: true,
        pendingAccruedCount: 2,
        pendingAccruedUsd: "0.10",
      },
      durationMs: 980,
    });
    globalThis.fetch = mockFn;

    const result = await client.tools.execute({
      toolId: "tool-1",
      toolName: "get_price",
      args: { symbol: "ETH" },
      mode: "execute",
      sessionId: "sess_123",
      maxSpendUsd: "1",
      closeSession: true,
    });

    const [, opts] = mockFn.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toEqual({
      toolId: "tool-1",
      toolName: "get_price",
      args: { symbol: "ETH" },
      mode: "execute",
      sessionId: "sess_123",
      maxSpendUsd: "1",
      closeSession: true,
    });

    expect(result.mode).toBe("execute");
    expect(result.method.executePriceUsd).toBe("0.05");
    expect(result.session.methodPrice).toBe("0.05");
    expect(result.session.spent).toBe("0.05");
    expect(result.session.remaining).toBe("0.95");
    expect(result.session.maxSpend).toBe("1");
    expect(result.session.status).toBe("open");
    expect(result.session.expiresAt).toBe("2026-02-22T00:00:00.000Z");
    expect(result.session.closeRequested).toBe(true);
    expect(result.session.pendingAccruedCount).toBe(2);
    expect(result.session.pendingAccruedUsd).toBe("0.10");
  });

  it("propagates session budget errors", async () => {
    globalThis.fetch = mockFetchJson({
      error: "This execute call costs $0.8, which exceeds the session maxSpend of $0.5.",
      code: "session_budget_exceeded",
      mode: "execute",
      session: {
        mode: "execute",
        sessionId: null,
        methodPrice: "0.8",
        spent: "0.8",
        remaining: "0",
        maxSpend: "0.5",
      },
    });

    await expect(
      client.tools.execute({
        toolId: "tool-1",
        toolName: "get_expensive_data",
        maxSpendUsd: "0.5",
      })
    ).rejects.toThrow(ContextError);

    try {
      await client.tools.execute({
        toolId: "tool-1",
        toolName: "get_expensive_data",
        maxSpendUsd: "0.5",
      });
    } catch (error) {
      const ctxError = error as ContextError;
      expect(ctxError.code).toBe("session_budget_exceeded");
    }
  });

  it("starts execute sessions with explicit max spend", async () => {
    const mockFn = mockFetchJson({
      success: true,
      mode: "execute",
      session: {
        mode: "execute",
        sessionId: "sess_start",
        methodPrice: "0",
        spent: "0",
        remaining: "5",
        maxSpend: "5",
        status: "open",
      },
    });
    globalThis.fetch = mockFn;

    const result = await client.tools.startSession({ maxSpendUsd: "5" });
    const [rawUrl, opts] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);
    const body = JSON.parse(opts.body);

    expect(url.pathname).toBe("/api/v1/tools/execute/sessions");
    expect(opts.method).toBe("POST");
    expect(body).toEqual({
      mode: "execute",
      maxSpendUsd: "5",
    });
    expect(result.session.sessionId).toBe("sess_start");
    expect(result.session.maxSpend).toBe("5");
  });

  it("fetches execute session status by ID", async () => {
    const mockFn = mockFetchJson({
      success: true,
      mode: "execute",
      session: {
        mode: "execute",
        sessionId: "sess_status",
        methodPrice: "0",
        spent: "1.2",
        remaining: "3.8",
        maxSpend: "5",
        status: "open",
      },
    });
    globalThis.fetch = mockFn;

    const result = await client.tools.getSession("sess_status");
    const [rawUrl, opts] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);

    expect(url.pathname).toBe("/api/v1/tools/execute/sessions/sess_status");
    expect(opts.method ?? "GET").toBe("GET");
    expect(result.session.spent).toBe("1.2");
  });

  it("closes execute sessions by ID", async () => {
    const mockFn = mockFetchJson({
      success: true,
      mode: "execute",
      session: {
        mode: "execute",
        sessionId: "sess_close",
        methodPrice: "0",
        spent: "1.2",
        remaining: "3.8",
        maxSpend: "5",
        status: "closed",
      },
    });
    globalThis.fetch = mockFn;

    const result = await client.tools.closeSession("sess_close");
    const [rawUrl, opts] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);
    const body = JSON.parse(opts.body);

    expect(url.pathname).toBe("/api/v1/tools/execute/sessions/sess_close/close");
    expect(opts.method).toBe("POST");
    expect(body).toEqual({ mode: "execute" });
    expect(result.session.status).toBe("closed");
  });
});
