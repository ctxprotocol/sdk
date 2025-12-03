# @ctxprotocol/sdk

The official TypeScript SDK for the [Context Protocol](https://ctxprotocol.com) — the monetization layer for MCP. Discover and execute AI tools programmatically.

[![npm version](https://img.shields.io/npm/v/@ctxprotocol/sdk.svg)](https://www.npmjs.com/package/@ctxprotocol/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

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

Before using the API, you must complete setup via the web dashboard:

1. **Sign in** at [ctxprotocol.com](https://ctxprotocol.com) — Creates your embedded wallet
2. **Enable Auto Pay** — Approve USDC spending for tool payments
3. **Fund wallet** — Add USDC for tool execution fees
4. **Generate API key** — In Settings page

## Quick Start

```typescript
import { ContextClient } from "@ctxprotocol/sdk";

// Initialize the client with your API key
const client = new ContextClient({
  apiKey: "sk_live_...",
});

// 1. Discover tools
const tools = await client.discovery.search("gas prices");
console.log(tools[0].name);        // "Gas Price Oracle"
console.log(tools[0].mcpTools);    // Available methods

// 2. Execute a tool method
const result = await client.tools.execute({
  toolId: tools[0].id,
  toolName: tools[0].mcpTools[0].name,  // e.g., "get_gas_prices"
  args: { chainId: 1 },
});

console.log(result.result);     // Tool output data
console.log(result.durationMs); // Execution time in ms
```

## Configuration

### Client Options

| Option    | Type     | Required | Default                  | Description                    |
| --------- | -------- | -------- | ------------------------ | ------------------------------ |
| `apiKey`  | `string` | Yes      | —                        | Your Context Protocol API key  |
| `baseUrl` | `string` | No       | `https://ctxprotocol.com`| API base URL (for development) |

```typescript
// Production usage
const client = new ContextClient({
  apiKey: process.env.CONTEXT_API_KEY!,
});

// Development/testing with local server
const devClient = new ContextClient({
  apiKey: "sk_test_...",
  baseUrl: "http://localhost:3000",
});
```

## API Reference

### Discovery

#### `client.discovery.search(query, limit?)`

Search for tools matching a query string.

```typescript
const tools = await client.discovery.search("gas prices", 10);

// Returns: Tool[]
// [
//   {
//     id: "uuid-string",
//     name: "Gas Price Oracle",
//     description: "Get current gas prices",
//     price: "0.001",
//     category: "defi",
//     isVerified: true,
//     kind: "mcp",
//     mcpTools: [
//       { name: "get_gas_prices", description: "Get gas prices for a chain" },
//       { name: "get_supported_chains", description: "List supported chains" }
//     ]
//   }
// ]
```

#### `client.discovery.getFeatured(limit?)`

Get featured/popular tools.

```typescript
const featured = await client.discovery.getFeatured(5);
```

### Tools

#### `client.tools.execute(options)`

Execute a tool method with the provided arguments.

```typescript
const result = await client.tools.execute({
  toolId: "uuid-of-tool",           // From search results
  toolName: "get_gas_prices",        // From tool's mcpTools array
  args: { chainId: 1 },              // Tool-specific arguments
});

// Returns: ExecutionResult<T>
// {
//   result: { gasPrice: "25.5", unit: "gwei", ... },
//   tool: { id: "uuid", name: "Gas Price Oracle" },
//   durationMs: 245
// }
```

## Types

All types are exported for full TypeScript autocomplete support:

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
  kind?: string;
  mcpTools?: McpTool[];
}

interface McpTool {
  name: string;
  description: string;
}
```

### ExecuteOptions

```typescript
interface ExecuteOptions {
  toolId: string;    // UUID of the tool
  toolName: string;  // MCP method name from mcpTools array
  args?: Record<string, unknown>;
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

The SDK throws `ContextError` for all API errors with specific error codes:

```typescript
import { ContextClient, ContextError } from "@ctxprotocol/sdk";

try {
  const result = await client.tools.execute({
    toolId: "...",
    toolName: "...",
    args: {},
  });
} catch (error) {
  if (error instanceof ContextError) {
    console.error("Error:", error.message);
    console.error("Code:", error.code);
    console.error("HTTP Status:", error.statusCode);

    // Handle specific error cases
    switch (error.code) {
      case "no_wallet":
        console.log("Please set up your wallet at", error.helpUrl);
        break;
      case "insufficient_allowance":
        console.log("Please enable Auto Pay at", error.helpUrl);
        break;
      case "payment_failed":
        console.log("Payment transaction failed");
        break;
      case "execution_failed":
        console.log("Tool execution failed");
        break;
    }
  }
}
```

### Error Codes

| Code                     | Description                              |
| ------------------------ | ---------------------------------------- |
| `unauthorized`           | Missing or invalid API key               |
| `no_wallet`              | User hasn't set up wallet via dashboard  |
| `insufficient_allowance` | Auto Pay not enabled or allowance too low|
| `payment_failed`         | On-chain payment transaction failed      |
| `execution_failed`       | MCP tool execution error                 |

## Authentication

All requests are automatically authenticated using the Bearer token scheme:

```
Authorization: Bearer sk_live_...
```

Your API key should be kept secret. Use environment variables in production:

```typescript
const client = new ContextClient({
  apiKey: process.env.CONTEXT_API_KEY!,
});
```

## Payment Flow

When you execute a tool:

1. Your pre-approved USDC allowance is used for payment
2. **90%** goes to the tool developer
3. **10%** goes to the protocol
4. Tool executes and returns results

Ensure your wallet has sufficient USDC balance before executing paid tools.

## Links

- [Context Protocol](https://ctxprotocol.com) — Main website
- [GitHub](https://github.com/ctxprotocol/context) — Main project repository
- [SDK Repository](https://github.com/ctxprotocol/sdk) — This SDK
- [NPM Package](https://www.npmjs.com/package/@ctxprotocol/sdk)

## Requirements

- Node.js 18.0.0 or later (for native `fetch` support)
- TypeScript 5.0+ (recommended)

## License

MIT
