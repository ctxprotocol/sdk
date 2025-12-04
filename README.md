# @ctxprotocol/sdk

**The Universal Adapter for AI Agents.**

Connect your AI to the real world without managing API keys, hosting servers, or reading documentation.

Context Protocol is **npm for AI capabilities**. Just as you install packages to add functionality to your code, use the Context SDK to give your Agent instant access to thousands of live data sources and actions—from DeFi and Gas Oracles to Weather and Search.

[![npm version](https://img.shields.io/npm/v/@ctxprotocol/sdk.svg)](https://www.npmjs.com/package/@ctxprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why use Context?

- **🔌 One Interface, Everything:** Stop integrating APIs one by one. Use a single SDK to access any tool in the marketplace.
- **🧠 Zero-Ops:** We host the MCP servers. You just send the JSON and get the result.
- **⚡️ Agentic Discovery:** Your Agent can search the marketplace at runtime to find tools it didn't know it needed.
- **💸 Micro-Billing:** Pay only for what you use (e.g., $0.001/query). No monthly subscriptions for tools you rarely use.

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
import type {
  ContextClientOptions,
  Tool,
  McpTool,
  ExecuteOptions,
  ExecutionResult,
  ContextErrorCode,
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

## Payment Flow

When you execute a tool:

1. Your pre-approved USDC allowance is used
2. **90%** goes to the tool developer
3. **10%** goes to the protocol
4. Tool executes and returns results

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
