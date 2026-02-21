# @ctxprotocol/sdk

**The Universal Adapter for AI Agents.**

Connect your AI to the real world without managing API keys, hosting servers, or reading documentation.

Context Protocol is **npm for AI capabilities**. Just as you install packages to add functionality to your code, use the Context SDK to give your Agent instant access to thousands of live data sources and actions—from DeFi and Gas Oracles to Weather and Search.

[![npm version](https://img.shields.io/npm/v/@ctxprotocol/sdk.svg)](https://www.npmjs.com/package/@ctxprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

### 💰 $10,000 Developer Grant Program

We're funding the initial supply of MCP Tools for the Context Marketplace. **Become a Data Broker.**

- **🛠️ Build:** Create an MCP Server using this SDK (Solana data, Trading tools, Scrapers, etc.)
- **📦 List:** Publish it to the Context Registry
- **💵 Earn:** Get a **$250–$1,000 Grant** + earn USDC every time an agent queries your tool

👉 [**View Open Bounties & Apply Here**](https://docs.ctxprotocol.com/grants)

---

## Why use Context?

- **🔌 One Interface, Everything:** Stop integrating APIs one by one. Use a single SDK to access any tool in the marketplace.
- **🧠 Zero-Ops:** We're a gateway to the best MCP tools. Just send the JSON and get the result.
- **⚡️ Agentic Discovery:** Your Agent can search the marketplace at runtime to find tools it didn't know it needed.
- **💸 Dual-Surface Economics:** Use Query for pay-per-response intelligence or Execute for session-budgeted method calls.

## Who Is This SDK For?

| Role | What You Use |
|------|--------------|
| **AI Agent Developer** | `@ctxprotocol/sdk` — Query curated answers or Execute with explicit method pricing + sessions |
| **Tool Contributor (Data Broker)** | `@modelcontextprotocol/sdk` + `@ctxprotocol/sdk` — Standard MCP server + security middleware |

**For AI Agent Developers:** Use this SDK to search the marketplace, execute tools, and handle micro-payments.

**For Tool Contributors:** You need **both** SDKs:
- `@modelcontextprotocol/sdk` — Build your MCP server (tools, schemas, handlers)
- `@ctxprotocol/sdk` — Secure your endpoint with `createContextMiddleware()` and receive injected user portfolio data

See [Building MCP Servers](#building-mcp-servers-tool-contributors) and [Securing Your Tool](#-securing-your-tool) for the complete pattern.

## Installation

```bash
npm install @ctxprotocol/sdk
```

```bash
pnpm add @ctxprotocol/sdk
```

```bash
yarn add @ctxprotocol/sdk
```

## Prerequisites

Before using the API, complete setup at [ctxprotocol.com](https://ctxprotocol.com):

1. **Sign in** — Creates your embedded wallet
2. **Set spending cap** — Approve USDC spending on the ContextRouter (one-time setup)
3. **Fund wallet** — Add USDC for tool execution fees
4. **Generate API key** — In Settings page

## Two Modes: Precision vs Intelligence

The SDK offers two payment models to serve different use cases:

| Mode | Method | Payment Model | Settlement Shape | Use Case |
|------|--------|---------------|------------------|----------|
| **Execute** | `client.tools.execute()` | Per execute call | Session accrual + deferred batch flush | Deterministic pipelines, raw outputs, explicit spend envelopes |
| **Query** | `client.query.run()` | Pay-per-response | Deferred post-response | Complex questions, multi-tool synthesis, curated intelligence |

**Execute mode** gives you raw data and full control with explicit method pricing and session budgets:
```typescript
const session = await client.tools.startSession({ maxSpendUsd: "2.00" });
const executeTools = await client.discovery.search({
  query: "whale transactions",
  mode: "execute",
  surface: "execute",
  requireExecutePricing: true,
});

const result = await client.tools.execute({
  toolId: executeTools[0].id,
  toolName: executeTools[0].mcpTools[0].name,
  args: { chain: "base", limit: 20 },
  sessionId: session.session.sessionId ?? undefined,
});
console.log(result.session); // methodPrice, spent, remaining, maxSpend, ...
```

**Query mode** gives you curated answers — the server handles answer-safe tool discovery, multi-tool orchestration (up to 100 MCP calls per query turn), self-healing retries, completeness checks, model-aware context budgeting, and AI synthesis for one flat fee:
```typescript
const answer = await client.query.run({
  query: "What are the top whale movements on Base?",
  modelId: "glm-model",      // optional: choose a supported model
  includeDataUrl: true,      // optional: persist full execution data to blob
});
console.log(answer.response);   // AI-synthesized answer
console.log(answer.toolsUsed);  // Which tools were used
console.log(answer.cost);       // Cost breakdown
console.log(answer.dataUrl);    // Optional blob URL with full data
```

> Mixed listings are first-class: one listing can expose methods to both surfaces. Methods without `_meta.pricing.executeUsd` remain query-only until priced.

## Quick Start

```typescript
import { ContextClient } from "@ctxprotocol/sdk";

const client = new ContextClient({
  apiKey: "sk_live_...",
});

// Pay-per-response: Ask a question, get a curated answer
const answer = await client.query.run("What are the top whale movements on Base?");
console.log(answer.response);

// Execute surface: require explicit execute pricing
const tools = await client.discovery.search({
  query: "gas prices",
  mode: "execute",
  surface: "execute",
  requireExecutePricing: true,
});
const session = await client.tools.startSession({ maxSpendUsd: "1.00" });
const result = await client.tools.execute({
  toolId: tools[0].id,
  toolName: tools[0].mcpTools[0].name,
  args: { chainId: 1 },
  sessionId: session.session.sessionId ?? undefined,
});
console.log(result.result);
```

See the runnable dual-surface example in [`examples/client/src/index.ts`](./examples/client/src/index.ts).

---

## The Agentic Pattern: How to Build Autonomous Bots

The most powerful way to use this SDK is to let your LLM do the driving. Instead of hardcoding tool calls, follow this **Discovery → Schema → Execution** loop:

### 1. Discover

Let your Agent search for tools based on the user's intent.

```typescript
const tools = await client.discovery.search(userQuery);
```

### 2. Inspect Schemas

Feed the discovered tool schemas (`inputSchema`) directly to your LLM's system prompt. This allows the LLM to understand exactly how to format the arguments—just like reading a manual.

```typescript
const systemPrompt = `
You have access to the following tools:

${tools.map(t => `
Tool: ${t.name} (ID: ${t.id})
Description: ${t.description}
Price: ${t.price} USDC

Methods:
${t.mcpTools?.map(m => `
  - ${m.name}: ${m.description}
    Arguments: ${JSON.stringify(m.inputSchema, null, 2)}
    Returns: ${JSON.stringify(m.outputSchema, null, 2)}
`).join("\n") ?? "No methods available"}
`).join("\n---\n")}

To use a tool, respond with a JSON object: { "toolId": "...", "toolName": "...", "args": {...} }
`;
```

### 3. Execute

When the LLM generates the arguments, pass them directly to the SDK.

```typescript
// The LLM generates this object based on the schema you provided
const llmDecision = await myLLM.generate(userMessage, systemPrompt);

const result = await client.tools.execute({
  toolId: llmDecision.toolId,
  toolName: llmDecision.toolName,
  args: llmDecision.args,
});

// Feed a bounded, structured summary back to your LLM for synthesis.
// Prefer client.query.run() when you want server-managed synthesis.
const resultPreview = JSON.stringify(result.result, null, 2).slice(0, 50_000);
const resultKeys =
  result.result && typeof result.result === "object"
    ? Object.keys(result.result as Record<string, unknown>)
    : [];

const finalAnswer = await myLLM.generate(
  `Tool output keys: ${resultKeys.join(", ") || "(non-object result)"}\n\n` +
    `Tool output preview (truncated):\n${resultPreview}\n\n` +
    "Summarize this for the user and mention if more data may exist beyond the preview."
);
```

### Handling Data (Outputs)

Context Tools return raw, structured JSON data (via `structuredContent`). This allows your Agent to programmatically filter, sort, or analyze results before showing them to the user.

> **Note:** For large datasets (like CSVs or PDF analysis), the API may return a reference URL to keep your context window clean.

### Full Agentic Loop Example

```typescript
import { ContextClient, ContextError } from "@ctxprotocol/sdk";

const client = new ContextClient({ apiKey: process.env.CONTEXT_API_KEY! });

async function agentLoop(userQuery: string) {
  // 1. Discover relevant tools
  const tools = await client.discovery.search(userQuery);
  
  if (tools.length === 0) {
    return "I couldn't find any tools to help with that.";
  }

  // 2. Build the system prompt with schemas
  const toolDescriptions = tools.slice(0, 5).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    methods: t.mcpTools?.map(m => ({
      name: m.name,
      description: m.description,
      inputSchema: m.inputSchema,
    })),
  }));

  const systemPrompt = `You are an AI assistant with access to real-time tools.

Available tools:
${JSON.stringify(toolDescriptions, null, 2)}

If you need to use a tool, respond ONLY with JSON:
{ "toolId": "...", "toolName": "...", "args": {...} }

If you can answer without a tool, just respond normally.`;

  // 3. Ask the LLM what to do
  const llmResponse = await myLLM.chat(userQuery, systemPrompt);

  // 4. Check if LLM wants to use a tool
  try {
    const toolCall = JSON.parse(llmResponse);
    
    if (toolCall.toolId && toolCall.toolName) {
      // 5. Execute the tool
      const result = await client.tools.execute({
        toolId: toolCall.toolId,
        toolName: toolCall.toolName,
        args: toolCall.args || {},
      });

      // 6. Let LLM synthesize a bounded preview (avoid injecting giant JSON blobs)
      const resultPreview = JSON.stringify(result.result, null, 2).slice(0, 50_000);
      const resultKeys =
        result.result && typeof result.result === "object"
          ? Object.keys(result.result as Record<string, unknown>)
          : [];

      return await myLLM.chat(
        `Tool "${toolCall.toolName}" returned keys: ${resultKeys.join(", ") || "(non-object result)"}\n\n` +
        `Preview (truncated):\n${resultPreview}\n\n` +
        `Please provide a helpful response to the user's original question: "${userQuery}"`
      );
    }
  } catch {
    // LLM responded with text, not JSON - return as-is
    return llmResponse;
  }
}
```

---

## Configuration

### Client Options

| Option    | Type     | Required | Default                  | Description                    |
| --------- | -------- | -------- | ------------------------ | ------------------------------ |
| `apiKey`  | `string` | Yes      | —                        | Your Context Protocol API key  |
| `baseUrl` | `string` | No       | `https://ctxprotocol.com`| API base URL (for development) |

```typescript
// Production
const client = new ContextClient({
  apiKey: process.env.CONTEXT_API_KEY!,
});

// Local development
const client = new ContextClient({
  apiKey: "sk_test_...",
  baseUrl: "http://localhost:3000",
});
```

## API Reference

### Discovery

#### `client.discovery.search(query, limit?)`
#### `client.discovery.search(options)`

Search for tools with optional surface-aware filters.

```typescript
const tools = await client.discovery.search("ethereum gas", 10);

const executeTools = await client.discovery.search({
  query: "ethereum gas",
  mode: "execute",
  surface: "execute",
  requireExecutePricing: true,
});
```

#### `client.discovery.getFeatured(limit?, options?)`

Get featured/popular tools.

```typescript
const featured = await client.discovery.getFeatured(5);
const featuredExecute = await client.discovery.getFeatured(5, {
  mode: "execute",
  requireExecutePricing: true,
});
```

### Tools (Execute Surface)

Session lifecycle helpers use the canonical execute-scoped API contract:
`/api/v1/tools/execute/sessions...`

#### `client.tools.execute(options)`

Execute a single tool method. Execute calls can run inside session budgets.

```typescript
const session = await client.tools.startSession({ maxSpendUsd: "2.50" });

const result = await client.tools.execute({
  toolId: "uuid-of-tool",
  toolName: "get_gas_prices",
  args: { chainId: 1 },
  sessionId: session.session.sessionId ?? undefined,
});

console.log(result.method.executePriceUsd);
console.log(result.session);
```

#### `client.tools.startSession({ maxSpendUsd })`

```typescript
const started = await client.tools.startSession({ maxSpendUsd: "5.00" });
```

#### `client.tools.getSession(sessionId)`

```typescript
const status = await client.tools.getSession("sess_123");
```

#### `client.tools.closeSession(sessionId)`

```typescript
const closed = await client.tools.closeSession("sess_123");
```

### Query (Pay-Per-Response)

#### `client.query.run(options)`

Run an agentic query. The server discovers answer-safe tools, executes the full pipeline (up to 100 MCP calls per query turn), applies model-aware mediator/data budgeting, and returns an AI-synthesized answer.

```typescript
// Simple string
const answer = await client.query.run("What are the top whale movements on Base?");

// With options
const answer = await client.query.run({
  query: "Analyze whale activity on Base",
  tools: ["tool-uuid-1", "tool-uuid-2"],  // optional — auto-discover if omitted
  modelId: "kimi-model-thinking",          // optional
  includeData: true,                       // optional: include execution data inline
  includeDataUrl: true,                    // optional: include blob URL for full data
});

console.log(answer.response);     // AI-synthesized text
console.log(answer.toolsUsed);    // [{ id, name, skillCalls }]
console.log(answer.cost);         // { modelCostUsd, toolCostUsd, totalCostUsd }
console.log(answer.durationMs);   // Total time
console.log(answer.data);         // Optional execution data (when includeData=true)
console.log(answer.dataUrl);      // Optional blob URL (when includeDataUrl=true)
```

#### `client.query.stream(options)`

Same as `run()` but streams events in real-time via SSE.

```typescript
for await (const event of client.query.stream("What are the top whale movements?")) {
  switch (event.type) {
    case "tool-status":
      console.log(`Tool ${event.tool.name}: ${event.status}`);
      break;
    case "text-delta":
      process.stdout.write(event.delta);
      break;
    case "done":
      console.log("\nTotal cost:", event.result.cost.totalCostUsd);
      break;
  }
}
```

## Types

```typescript
import {
  // Auth utilities for tool contributors
  verifyContextRequest,
  isProtectedMcpMethod,
  isOpenMcpMethod,
} from "@ctxprotocol/sdk";

import type {
  // Client types
  ContextClientOptions,
  Tool,
  McpTool,
  ExecuteOptions,
  ExecutionResult,
  // Query types (pay-per-response)
  QueryOptions,
  QueryResult,
  QueryCost,
  QueryStreamEvent,
  ContextErrorCode,
  // Auth types (for MCP server contributors)
  VerifyRequestOptions,
  // Context types (for MCP server contributors receiving injected data)
  ContextRequirementType,
  HyperliquidContext,
  PolymarketContext,
  WalletContext,
  UserContext,
} from "@ctxprotocol/sdk";
```

### Tool

```typescript
interface Tool {
  id: string;
  name: string;
  description: string;
  price: string; // listing-level query price metadata
  category?: string;
  isVerified?: boolean;
  mcpTools?: McpTool[];
}
```

### McpTool

```typescript
interface McpTool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;   // JSON Schema for arguments
  outputSchema?: Record<string, unknown>;  // JSON Schema for response
  _meta?: {
    surface?: "answer" | "execute" | "both";
    queryEligible?: boolean;
    latencyClass?: "instant" | "fast" | "slow" | "streaming";
    pricing?: { executeUsd?: string; queryUsd?: string };
  };
  executeEligible?: boolean;
  executePriceUsd?: string | null;
}
```

### ExecutionResult (Execute Surface)

```typescript
interface ExecutionResult<T = unknown> {
  mode: "execute";
  result: T;
  tool: { id: string; name: string };
  method: { name: string; executePriceUsd: string };
  session: {
    sessionId: string | null;
    methodPrice: string;
    spent: string;
    remaining: string | null;
    maxSpend: string | null;
    status?: "open" | "closed" | "expired";
  };
  durationMs: number;
}
```

### QueryResult (Pay-Per-Response)

```typescript
interface QueryResult {
  response: string;                    // AI-synthesized answer
  toolsUsed: QueryToolUsage[];         // Tools used: { id, name, skillCalls }
  cost: QueryCost;                     // { modelCostUsd, toolCostUsd, totalCostUsd }
  durationMs: number;
  data?: unknown;                      // Optional execution data (includeData=true)
  dataUrl?: string;                    // Optional blob URL (includeDataUrl=true)
}
```

### Context Requirement Types (MCP Server Contributors)

```typescript
import type { ContextRequirementType } from "@ctxprotocol/sdk";

/** Context types supported by the marketplace */
type ContextRequirementType = "polymarket" | "hyperliquid" | "wallet";

// Usage: Add _meta.contextRequirements to your tool definition
const TOOLS = [{
  name: "analyze_my_positions",
  description: "...",
  
  // ⭐ Declare context requirements in _meta (MCP spec)
  _meta: {
    contextRequirements: ["wallet"] as ContextRequirementType[],
  },
  
  inputSchema: {
    type: "object",
    properties: { wallet: { type: "object" } },
    required: ["wallet"]
  },
}];
```

## Error Handling

The SDK throws `ContextError` with specific error codes. In an agentic context, you can feed errors back to your LLM so it can self-correct.

```typescript
import { ContextError } from "@ctxprotocol/sdk";

try {
  const result = await client.tools.execute({ ... });
} catch (error) {
  if (error instanceof ContextError) {
    switch (error.code) {
      case "no_wallet":
        // User needs to set up wallet
        console.log("Setup required:", error.helpUrl);
        break;
      case "insufficient_allowance":
        // User needs to set a spending cap
        console.log("Set spending cap:", error.helpUrl);
        break;
      case "payment_failed":
        // Insufficient USDC balance
        break;
      case "execution_failed":
        // Tool execution error - feed back to LLM to retry with different args
        const retryPrompt = `The tool failed with: ${error.message}. Try different arguments.`;
        break;
    }
  }
}
```

### Error Codes

| Code                     | Description                              | Agentic Handling                    |
| ------------------------ | ---------------------------------------- | ----------------------------------- |
| `unauthorized`           | Invalid API key                          | Check configuration                 |
| `no_wallet`              | Wallet not set up                        | Direct user to `helpUrl`            |
| `insufficient_allowance` | Spending cap not set                     | Direct user to `helpUrl`            |
| `payment_failed`         | USDC payment failed                      | Check balance                       |
| `execution_failed`       | Tool error                               | Feed error to LLM for retry         |

---

## 🔒 Securing Your Tool

If you're building an MCP server (tool contributor), you should verify that incoming requests are legitimate and originate from the Context Protocol Platform.

### The "Business in a Box" Promise

By adding 1 line of code to verify a JWT, Context saves you from building:
- A Stripe integration
- A User Management system
- API key management
- Refund and dispute logic

**The "Stripe Webhook" Analogy:**
Developers are used to verifying signatures for Stripe Webhooks or GitHub Apps. Context works the same way. When we send a request saying "Execute Tool (Authorized)", you verify the signature. Without this, anyone could curl your endpoint and drain your resources.

### Quick Implementation (1 Line)

```typescript
import express from "express";
import { createContextMiddleware } from "@ctxprotocol/sdk";

const app = express();
app.use(express.json());

// 1 line of code to secure your endpoint & handle payments
app.use("/mcp", createContextMiddleware());

app.post("/mcp", (req, res) => {
  // req.context contains verified JWT payload (on protected methods)
  // Handle MCP request...
});
```

### Free vs. Paid Strategy

| Tool Type | Security | Rationale |
|-----------|----------|-----------|
| **Free Tools ($0.00)** | Optional | Perfect for distribution and adoption |
| **Paid Tools ($0.01+)** | **Mandatory** | We cannot route payments to insecure endpoints |

### MCP Security Model

The SDK implements a **selective authentication** model — discovery is open, execution is protected:

| MCP Method | Auth Required | Why |
|------------|---------------|-----|
| `initialize` | ❌ No | Session setup |
| `tools/list` | ❌ No | Discovery - agents need to see your schemas |
| `resources/list` | ❌ No | Discovery |
| `prompts/list` | ❌ No | Discovery |
| `tools/call` | ✅ **Yes** | **Execution - costs money, runs your code** |

**What this means in practice:**
- ✅ `https://your-mcp.com/mcp` + `initialize` → Works without auth
- ✅ `https://your-mcp.com/mcp` + `tools/list` → Works without auth  
- ❌ `https://your-mcp.com/mcp` + `tools/call` → **Requires Context Protocol JWT**

This matches standard API patterns (OpenAPI schemas are public, GraphQL introspection is open).

### How It Works

The Context Platform signs **execution requests** (`tools/call`) using **RS256** (RSA-SHA256) asymmetric cryptography. Each request includes an `Authorization: Bearer <jwt>` header containing a signed JWT.

### Advanced: Manual Verification

For more control, you can use the lower-level utilities:

```typescript
import { 
  verifyContextRequest, 
  isProtectedMcpMethod, 
  ContextError 
} from "@ctxprotocol/sdk";

// Check if a method requires auth
if (isProtectedMcpMethod(body.method)) {
  const payload = await verifyContextRequest({
    authorizationHeader: req.headers.authorization,
    audience: "https://your-tool.com/mcp", // optional
  });
  // payload contains verified JWT claims
}
```

### Options

| Option                | Type     | Required | Description                                           |
| --------------------- | -------- | -------- | ----------------------------------------------------- |
| `authorizationHeader` | `string` | Yes      | The full Authorization header (e.g., `"Bearer eyJ..."`) |
| `audience`            | `string` | No       | Expected audience claim for stricter validation       |

### JWT Claims

The verified JWT payload includes standard claims:

- `iss` - Issuer (`https://ctxprotocol.com`)
- `sub` - Subject (user or request identifier)
- `aud` - Audience (your tool URL, if specified)
- `exp` - Expiration time
- `iat` - Issued at time

---

## Building MCP Servers (Tool Contributors)

Want to earn money by contributing tools to the Context marketplace? Build a standard MCP server that uses `outputSchema` and `structuredContent` from the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema):

1. **`outputSchema`** in tool definitions — JSON Schema describing your response
2. **`structuredContent`** in responses — Machine-readable data matching the schema

> **Note:** These are standard MCP features defined in the [MCP Tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema). While optional in vanilla MCP, Context requires them for payment verification, dispute resolution, and AI code generation.

### Why These Matter

| Requirement | Purpose |
|------------|---------|
| `outputSchema` | AI agents use this to generate type-safe code. Context uses it for dispute resolution. |
| `structuredContent` | Agents parse this for programmatic access. Text `content` is for humans. |

### Context Injection (Personalized Tools)

Building tools that analyze user data? Context automatically injects user context into your tools no authentication required.

**How it works:**
1. User connects their wallet in the Context app (we start with blockchain user data, but we're open to other client-side personal data types in the future)
2. When your tool is selected, the platform reads `_meta.contextRequirements` from your tool definition
3. Platform fetches the user's data (wallet balances, protocol positions, etc.)
4. Data is injected as an argument to your tool

**Key benefits:**
- **No Auth Required** — User data is injected automatically from connected wallets
- **Type-Safe** — Use SDK types like `WalletContext`, `PolymarketContext`, `HyperliquidContext`
- **Focus on Analysis** — You receive structured data, you provide insights

**What gets injected:**

```typescript
// For hyperliquid context requirement
interface HyperliquidContext {
  walletAddress: string;
  perpPositions: HyperliquidPerpPosition[];
  spotBalances: HyperliquidSpotBalance[];
  openOrders: HyperliquidOrder[];
  accountSummary: HyperliquidAccountSummary;
  fetchedAt: string;
}

// For polymarket context requirement
interface PolymarketContext {
  walletAddress: string;
  positions: PolymarketPosition[];
  openOrders: PolymarketOrder[];
  totalValue?: number;
  fetchedAt: string;
}

// For wallet context requirement
interface WalletContext {
  address: string;
  chainId: number;
  balances: TokenBalance[];
  fetchedAt: string;
}
```

### Context Requirements Declaration

If your tool needs user portfolio data, you **MUST** declare this using `_meta.contextRequirements` on the tool definition:

```typescript
import type { ContextRequirementType } from "@ctxprotocol/sdk";

const TOOLS = [{
  name: "analyze_my_positions",
  description: "Analyze your positions with personalized insights",

  // ⭐ `_meta` is standard MCP metadata:
  // - contextRequirements => context injection contract
  // - rateLimit => planner/runtime pacing hints for agentic loops
  _meta: {
    contextRequirements: ["wallet"] as ContextRequirementType[],
    rateLimit: {
      maxRequestsPerMinute: 30,
      cooldownMs: 2000,
      maxConcurrency: 1,
      supportsBulk: true,
      recommendedBatchTools: ["get_wallet_snapshot"],
      notes: "Hobby tier: prefer snapshot endpoints over fan-out loops.",
    },
  },

  inputSchema: {
    type: "object",
    properties: {
      wallet: {
        type: "object",
        description: "Wallet context (injected by platform)",
      },
    },
    required: ["wallet"],
  },
  outputSchema: { /* ... */ },
}];
```

**Why `_meta` at the tool level?**

The `_meta` field is part of the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-definition) for arbitrary tool metadata. The Context platform reads:
- `_meta.contextRequirements` for user-context injection
- `_meta.rateLimit` / `_meta.rateLimitHints` for planner + runtime pacing guidance

Because `_meta` is an MCP-standard field, these hints survive normal MCP transport and discovery.

**Available context types:**

| Type | Description | Injected Data |
|------|-------------|---------------|
| `"hyperliquid"` | Hyperliquid perpetuals & spot | `HyperliquidContext` |
| `"polymarket"` | Polymarket prediction markets | `PolymarketContext` |
| `"wallet"` | Generic EVM wallet | `WalletContext` |

### Example: Standard MCP Server

Build your server with the standard `@modelcontextprotocol/sdk`:

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Define tools with outputSchema (standard MCP feature, required by Context)
const TOOLS = [{
  name: "get_gas_price",
  description: "Get current gas prices",
  inputSchema: {
    type: "object",
    properties: {
      chainId: { type: "number", description: "EVM chain ID" },
    },
  },
  // 👇 Standard MCP feature (see: modelcontextprotocol.io/specification)
  outputSchema: {
    type: "object",
    properties: {
      gasPrice: { type: "number" },
      unit: { type: "string" },
    },
    required: ["gasPrice", "unit"],
  },
}];

// Standard MCP server setup
const server = new Server(
  { name: "my-gas-tool", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,  // outputSchema is included automatically
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const data = await fetchGasData(request.params.arguments.chainId);
  
  // 👇 Standard MCP feature (see: modelcontextprotocol.io/specification)
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],  // Backward compat
    structuredContent: data,  // Machine-readable, matches outputSchema
  };
});
```

### Example Servers

See complete working examples in `/examples/server/`:

- **[blocknative-contributor](./examples/server/blocknative-contributor)** — Gas price API (3 tools)
- **[hyperliquid-contributor](./examples/server/hyperliquid-contributor)** — DeFi analytics (16 tools)

### Execution Timeout & Product Design

⚠️ **Important**: MCP tool execution has a **~60 second timeout** (enforced at the platform/client level, not by MCP itself). This is intentional—it encourages building pre-computed insight products rather than raw data access.

**Best practice**: Run heavy queries offline (via cron jobs), store results in your database, and serve instant results via MCP. This is how Bloomberg, Nansen, and Arkham work—they don't give raw SQL access, they serve curated insights.

```typescript
// ❌ BAD: Raw access (timeout-prone, no moat)
{ name: "run_sql", description: "Run any SQL against blockchain data" }

// ✅ GOOD: Pre-computed product (instant, defensible)
{ name: "get_smart_money_wallets", description: "Top 100 wallets that timed market tops" }
```

See the [full documentation](https://docs.ctxprotocol.com/guides/build-tools#execution-limits--product-design) for detailed guidance.

### Schema Accuracy = Revenue

⚠️ **Important**: Your `outputSchema` is a contract. Context's "Robot Judge" validates that your `structuredContent` matches your declared schema. Schema violations result in automatic refunds to users.

### Server Dependencies

```bash
pnpm add @modelcontextprotocol/sdk express
pnpm add -D @types/express
```

## Payment Flow

Context uses surface-aware deferred settlement:

1. **Query surface** settles after each response turn
2. **Execute surface** accrues per-call spend into execute sessions, then flushes batches
3. Your USDC spending cap (ERC-20 allowance on ContextRouter) is still the global ceiling
4. **90%** goes to the tool developer, **10%** goes to the protocol
5. Session responses expose `methodPrice`, `spent`, `remaining`, and `maxSpend` on each execute call

## Documentation

| Document | Description |
|----------|-------------|
| [MCP Builder Template](./docs/mcp-builder-template.md) | **Start here!** AI-powered template for designing MCP servers with Cursor. Generates discovery questions and tool schemas automatically. |
| [Context Injection Guide](./docs/context-injection.md) | Architecture guide for building portfolio analysis tools with automatic user data injection |
| [Polymarket Example](./examples/server/polymarket-contributor) | Complete MCP server for Polymarket intelligence |
| [Hyperliquid Example](./examples/server/hyperliquid-contributor) | Complete MCP server for Hyperliquid analytics |
| [Blocknative Example](./examples/server/blocknative-contributor) | Simple gas price MCP server |

## Links

- [Context Protocol](https://ctxprotocol.com) — Main website
- [GitHub](https://github.com/ctxprotocol/context) — Main project
- [SDK Repository](https://github.com/ctxprotocol/sdk) — This SDK
- [NPM Package](https://www.npmjs.com/package/@ctxprotocol/sdk)

## Requirements

- Node.js 18+ (for native `fetch`)
- TypeScript 5+ (recommended)

## License

MIT
