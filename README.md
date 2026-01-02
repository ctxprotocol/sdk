# @ctxprotocol/sdk

**The Universal Adapter for AI Agents.**

Connect your AI to the real world without managing API keys, hosting servers, or reading documentation.

Context Protocol is **npm for AI capabilities**. Just as you install packages to add functionality to your code, use the Context SDK to give your Agent instant access to thousands of live data sources and actions—from DeFi and Gas Oracles to Weather and Search.

[![npm version](https://img.shields.io/npm/v/@ctxprotocol/sdk.svg)](https://www.npmjs.com/package/@ctxprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why use Context?

- **🔌 One Interface, Everything:** Stop integrating APIs one by one. Use a single SDK to access any tool in the marketplace.
- **🧠 Zero-Ops:** We're a gateway to the best MCP tools. Just send the JSON and get the result.
- **⚡️ Agentic Discovery:** Your Agent can search the marketplace at runtime to find tools it didn't know it needed.
- **💸 Micro-Billing:** Pay only for what you use (e.g., $0.001/query). No monthly subscriptions for tools you rarely use.

## Who Is This SDK For?

| Role | What You Use |
|------|--------------|
| **AI Agent Developer** | `@ctxprotocol/sdk` — Query marketplace, execute tools, handle payments |
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
2. **Enable Auto Pay** — Approve USDC spending for tool payments
3. **Fund wallet** — Add USDC for tool execution fees
4. **Generate API key** — In Settings page

## Quick Start

```typescript
import { ContextClient } from "@ctxprotocol/sdk";

const client = new ContextClient({
  apiKey: "sk_live_...",
});

// Discover tools
const tools = await client.discovery.search("gas prices");

// Execute a tool
const result = await client.tools.execute({
  toolId: tools[0].id,
  toolName: tools[0].mcpTools[0].name,
  args: { chainId: 1 },
});

console.log(result.result);
```

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

// Feed the result back to your LLM for synthesis
const finalAnswer = await myLLM.generate(
  `The tool returned: ${JSON.stringify(result.result)}. Summarize this for the user.`
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

      // 6. Let LLM synthesize the result
      return await myLLM.chat(
        `Tool "${toolCall.toolName}" returned: ${JSON.stringify(result.result)}
        
Please provide a helpful response to the user's original question: "${userQuery}"`
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

Search for tools matching a query string.

```typescript
const tools = await client.discovery.search("ethereum gas", 10);
```

#### `client.discovery.getFeatured(limit?)`

Get featured/popular tools.

```typescript
const featured = await client.discovery.getFeatured(5);
```

### Tools

#### `client.tools.execute(options)`

Execute a tool method.

```typescript
const result = await client.tools.execute({
  toolId: "uuid-of-tool",
  toolName: "get_gas_prices",
  args: { chainId: 1 },
});
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
  price: string;
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
  inputSchema?: Record<string, unknown>;  // JSON Schema for arguments
  outputSchema?: Record<string, unknown>; // JSON Schema for response
}
```

### ExecutionResult

```typescript
interface ExecutionResult<T = unknown> {
  result: T;
  tool: { id: string; name: string };
  durationMs: number;
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
        // User needs to enable Auto Pay
        console.log("Enable Auto Pay:", error.helpUrl);
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
| `insufficient_allowance` | Auto Pay not enabled                     | Direct user to `helpUrl`            |
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
Developers are used to verifying signatures for Stripe Webhooks or GitHub Apps. Context works the same way. When we send a request saying "Execute Tool (Payment Confirmed)", you verify the signature. Without this, anyone could curl your endpoint and drain your resources.

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

### Security Model

The SDK implements a **selective authentication** model:

| MCP Method | Auth Required | Reason |
|------------|---------------|--------|
| `tools/list` | ❌ No | Discovery - just returns tool schemas |
| `tools/call` | ✅ Yes | Execution - runs code, may cost money |
| `initialize` | ❌ No | Session setup |
| `resources/list` | ❌ No | Discovery |
| `prompts/list` | ❌ No | Discovery |

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

### Context Injection (Portfolio Analysis Tools)

Building tools that analyze user portfolios? Context automatically injects user portfolio data into your tools—no authentication required from the user.

**📖 Read the full guide: [Context Injection Architecture](./docs/context-injection.md)**

**How it works:**
1. User links their wallet in Context app settings
2. When your tool is selected, the platform reads `inputSchema["x-context-requirements"]`
3. Platform fetches the user's portfolio data from protocol APIs
4. Data is injected as the `portfolio` argument to your tool

**Key benefits:**
- **No Auth Required** — User data is injected automatically from their linked wallets
- **Type-Safe** — Use SDK types like `PolymarketContext`, `HyperliquidContext`
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

  // ⭐ REQUIRED: Context requirements in _meta (MCP spec for arbitrary metadata)
  // The Context platform reads this to inject user data
  _meta: {
    contextRequirements: ["wallet"] as ContextRequirementType[],
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

The `_meta` field is part of the [MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#tool-definition) for arbitrary tool metadata. The Context platform reads `_meta.contextRequirements` to determine what user data to inject. This is preserved through MCP transport because it's a standard field.

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

### Schema Accuracy = Revenue

⚠️ **Important**: Your `outputSchema` is a contract. Context's "Robot Judge" validates that your `structuredContent` matches your declared schema. Schema violations result in automatic refunds to users.

### Server Dependencies

```bash
pnpm add @modelcontextprotocol/sdk express
pnpm add -D @types/express
```

## Payment Flow

When you execute a tool:

1. Your pre-approved USDC allowance is used
2. **90%** goes to the tool developer
3. **10%** goes to the protocol
4. Tool executes and returns results

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
