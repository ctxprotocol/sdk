import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextClient } from "../client.js";

function mockFetchJson(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
    headers: new Headers(),
  });
}

describe("Discovery Resource", () => {
  let client: ContextClient;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    client = new ContextClient({ apiKey: "ctx_test_key_1234567890abcdef12345678" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    client.close();
  });

  it("supports legacy string search signature", async () => {
    const mockFn = mockFetchJson({
      tools: [],
      mode: "query",
      query: "gas prices",
      count: 0,
    });
    globalThis.fetch = mockFn;

    await client.discovery.search("gas prices", 12);

    const [rawUrl] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/api/v1/tools/search");
    expect(url.searchParams.get("q")).toBe("gas prices");
    expect(url.searchParams.get("limit")).toBe("12");
  });

  it("forwards surface-aware discovery filters", async () => {
    const mockFn = mockFetchJson({
      tools: [],
      mode: "execute",
      query: "market data",
      count: 0,
    });
    globalThis.fetch = mockFn;

    await client.discovery.search({
      query: "market data",
      limit: 7,
      mode: "execute",
      surface: "execute",
      queryEligible: false,
      requireExecutePricing: true,
      excludeLatencyClasses: ["streaming", "slow"],
      excludeSlow: true,
    });

    const [rawUrl] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/api/v1/tools/search");
    expect(url.searchParams.get("q")).toBe("market data");
    expect(url.searchParams.get("limit")).toBe("7");
    expect(url.searchParams.get("mode")).toBe("execute");
    expect(url.searchParams.get("surface")).toBe("execute");
    expect(url.searchParams.get("queryEligible")).toBe("false");
    expect(url.searchParams.get("requireExecutePricing")).toBe("true");
    expect(url.searchParams.get("excludeLatency")).toBe("streaming,slow");
    expect(url.searchParams.get("excludeSlow")).toBe("true");
  });

  it("allows featured discovery in execute mode", async () => {
    const mockFn = mockFetchJson({
      tools: [],
      mode: "execute",
      query: "",
      count: 0,
    });
    globalThis.fetch = mockFn;

    await client.discovery.getFeatured(5, {
      mode: "execute",
      requireExecutePricing: true,
    });

    const [rawUrl] = mockFn.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/api/v1/tools/search");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("mode")).toBe("execute");
    expect(url.searchParams.get("requireExecutePricing")).toBe("true");
  });
});
