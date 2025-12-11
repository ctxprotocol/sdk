# Blocknative Gas MCP Server

A standard MCP server that exposes the Blocknative Gas Platform API. This example demonstrates how to build a **Context Protocol compliant** MCP server.

## What Makes This Context Protocol Compliant?

Context requires `outputSchema` and `structuredContent` from the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema) for all paid tools. While these are optional in vanilla MCP, Context requires them for payment verification and dispute resolution.

1. **`outputSchema`** in tool definitions - Defines the structure of your response data
2. **`structuredContent`** in responses - Machine-readable data matching the outputSchema

```typescript
// Tool definition with outputSchema (standard MCP feature, required by Context)
const TOOLS = [{
  name: "get_gas_price",
  inputSchema: { /* ... */ },
  outputSchema: {  // Standard MCP feature (required by Context)
    type: "object",
    properties: {
      chainId: { type: "number" },
      estimates: { type: "array", /* ... */ },
    },
    required: ["chainId", "estimates"],
  },
}];

// Response with structuredContent (standard MCP feature, required by Context)
function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],  // Backward compat
    structuredContent: data,  // Standard MCP feature (required by Context)
  };
}
```

## Why Are These Required?

1. **AI Agent Code Generation** - Agents use your `outputSchema` to write type-safe code
2. **Dispute Resolution** - Context's "Robot Judge" validates responses against your schema
3. **Type Safety** - `structuredContent` guarantees agents receive correctly typed data

## Setup

```bash
cd examples/server/blocknative-contributor
cp env.example .env      # add BLOCKNATIVE_API_KEY
pnpm install
pnpm run dev
```

Server runs on `http://localhost:4001`.

## Endpoints

- **SSE**: `http://localhost:4001/sse` - MCP connection
- **Health**: `http://localhost:4001/health` - Status check

## Available Tools

| Tool | Description |
|------|-------------|
| `get_gas_price` | Get gas price estimates at different confidence levels |
| `list_chains` | List all supported EVM chains |
| `get_oracles` | Get available gas price oracles for a network |

## Testing

```bash
# Health check
curl http://localhost:4001/health
```

Connect via MCP client to `/sse` endpoint to use the tools.

## Architecture

This server uses the standard MCP SDK (`@modelcontextprotocol/sdk`) with:
- Express for HTTP server
- SSE transport for MCP communication
- Blocknative API for gas data

The `outputSchema` and `structuredContent` fields are part of the [official MCP specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#output-schema) - no special SDK required. Context requires these for payment verification and dispute resolution.

## License

MIT
