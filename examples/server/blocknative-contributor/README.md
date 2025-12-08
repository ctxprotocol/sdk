# Blocknative Gas MCP Server

A standard MCP server that exposes the Blocknative Gas Platform API. This example demonstrates how to build a **Context Protocol compliant** MCP server.

## What Makes This Context Protocol Compliant?

Context Protocol extends MCP with two key requirements:

1. **`outputSchema`** in tool definitions - Defines the structure of your response data
2. **`structuredContent`** in responses - Machine-readable data matching the outputSchema

```typescript
// Tool definition with outputSchema (Context Protocol extension)
const TOOLS = [{
  name: "get_gas_price",
  inputSchema: { /* ... */ },
  outputSchema: {  // <-- Context Protocol extension
    type: "object",
    properties: {
      chainId: { type: "number" },
      estimates: { type: "array", /* ... */ },
    },
    required: ["chainId", "estimates"],
  },
}];

// Response with structuredContent (Context Protocol extension)
function successResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,  // <-- Context Protocol extension
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

The Context Protocol extensions (`outputSchema`, `structuredContent`) are simply additional fields - no special SDK required.

## License

MIT
