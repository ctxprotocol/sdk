# Context Protocol SDK — Basic Example

This example demonstrates how to use the `@ctxprotocol/sdk` to discover and execute AI tools on the Context Protocol marketplace.

## Prerequisites

Before running this example, complete the setup at [ctxprotocol.com](https://ctxprotocol.com):

1. **Sign in** — Creates your embedded wallet
2. **Enable Auto Pay** — Approve USDC spending
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
2. **Lists results** — Displays found tools with their methods (`mcpTools`)
3. **Executes a tool** — Calls the first method on the first matching tool
4. **Handles errors** — Demonstrates proper error handling with guidance

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
     - get_supported_chains: List supported chains

⚡ Executing: Gas Price Oracle → get_gas_prices

✅ Execution successful!

Tool: Gas Price Oracle
Result: {
  "gasPrice": "25.5",
  "unit": "gwei",
  "timestamp": "2024-01-15T10:30:00Z"
}

⏱️  Duration: 245ms
```

## Error Handling

The example demonstrates handling common error cases:

| Error Code               | Meaning                          | Solution                           |
| ------------------------ | -------------------------------- | ---------------------------------- |
| `no_wallet`              | Wallet not set up                | Visit settings page                |
| `insufficient_allowance` | Auto Pay not enabled             | Enable Auto Pay in settings        |
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
