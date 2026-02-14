# Context Protocol SDK — Basic Example

This example demonstrates how to use the `@ctxprotocol/sdk` to discover and execute AI tools on the Context Protocol marketplace, including using schemas for LLM integration.

## Prerequisites

Before running this example, complete the setup at [ctxprotocol.com](https://ctxprotocol.com):

1. **Sign in** — Creates your embedded wallet
2. **Set spending cap** — Approve USDC spending on the ContextRouter
3. **Fund wallet** — Add USDC for tool payments
4. **Generate API key** — In Settings page

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Update the API key in `src/index.ts`:

```typescript
const client = new ContextClient({
  apiKey: "sk_live_your_actual_api_key",
});
```

Or use an environment variable:

```typescript
const client = new ContextClient({
  apiKey: process.env.CONTEXT_API_KEY!,
});
```

## Running the Example

```bash
pnpm start
```

## What This Example Does

1. **Discovers tools** — Searches for tools related to "gas prices"
2. **Lists results** — Displays found tools with their methods and **schemas**
3. **Shows LLM prompt generation** — Demonstrates how to use `inputSchema` and `outputSchema` for building AI agent prompts
4. **Executes a tool** — Calls the first method on the first matching tool
5. **Validates output** — Shows how the result matches the `outputSchema`
6. **Handles errors** — Demonstrates proper error handling with guidance

## Using Schemas for LLM Integration

Each MCP tool exposes JSON Schemas that describe inputs and outputs:

```typescript
const mcpTool = tool.mcpTools[0];

// inputSchema - tells the LLM what arguments to generate
console.log(mcpTool.inputSchema);
// { type: "object", properties: { chainId: { type: "number" } }, required: ["chainId"] }

// outputSchema - tells the LLM what response to expect
console.log(mcpTool.outputSchema);
// { type: "object", properties: { gasPrice: { type: "string" }, unit: { type: "string" } } }
```

### Building an LLM Prompt

```typescript
const prompt = `You have access to the following tool:

Tool: ${mcpTool.name}
Description: ${mcpTool.description}

Input Schema:
${JSON.stringify(mcpTool.inputSchema, null, 2)}

Output Schema:
${JSON.stringify(mcpTool.outputSchema, null, 2)}

Generate the correct arguments as JSON.`;
```

## Expected Output

```
🔍 Searching for gas price tools...

Found 1 tool(s):

1. Gas Price Oracle
   ID: uuid-string
   Description: Get current gas prices for blockchain networks
   Price: 0.001 USDC
   Category: defi
   Verified: ✓
   Available methods:
     - get_gas_prices: Get gas prices for a chain
       Input Schema: {"type":"object","properties":{"chainId":{"type":"number"}}}
       Output Schema: {"type":"object","properties":{"gasPrice":{"type":"string"}}}

📝 Example LLM Prompt Generation:

────────────────────────────────────────────────────────────
You have access to the following tool:

Tool: get_gas_prices
Description: Get gas prices for a chain

Input Schema:
{
  "type": "object",
  "properties": {
    "chainId": { "type": "number" }
  }
}

Output Schema:
{
  "type": "object",
  "properties": {
    "gasPrice": { "type": "string" },
    "unit": { "type": "string" }
  }
}

Generate the correct arguments as JSON to get gas prices for Ethereum mainnet.
────────────────────────────────────────────────────────────

⚡ Executing: Gas Price Oracle → get_gas_prices

✅ Execution successful!

Tool: Gas Price Oracle
Result: {
  "gasPrice": "25.5",
  "unit": "gwei"
}

⏱️  Duration: 245ms

📋 Output matches expected schema:
{
  "type": "object",
  "properties": {
    "gasPrice": { "type": "string" },
    "unit": { "type": "string" }
  }
}
```

## Error Handling

The example demonstrates handling common error cases:

| Error Code               | Meaning                          | Solution                           |
| ------------------------ | -------------------------------- | ---------------------------------- |
| `no_wallet`              | Wallet not set up                | Visit settings page                |
| `insufficient_allowance` | Spending cap not set             | Set spending cap in settings       |
| `payment_failed`         | USDC payment failed              | Check balance, retry               |
| `execution_failed`       | Tool execution error             | Check args, contact tool developer |

## Local Development

To test against a local server:

```typescript
const client = new ContextClient({
  apiKey: "sk_test_...",
  baseUrl: "http://localhost:3000",
});
```

## Links

- [Context Protocol](https://ctxprotocol.com)
- [SDK Documentation](https://github.com/ctxprotocol/sdk)
- [NPM Package](https://www.npmjs.com/package/@ctxprotocol/sdk)
