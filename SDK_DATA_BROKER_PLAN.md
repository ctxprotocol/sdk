# SDK Implementation Plan: "Data Broker" Features

This document outlines the architecture decision for supporting "Data Brokers" (Tool Contributors) in the Context Protocol ecosystem.

## Decision: No Server SDK Module

After evaluation, we decided **NOT** to build a `@ctxprotocol/sdk/server` module. Here's why:

### The Original Plan

The original plan was to create helpers like `defineTool()` and `createContextServer()` to make it easier for developers to build Context-compliant MCP servers.

### Why We Decided Against It

| Helper | Actual Value | Verdict |
|--------|--------------|---------|
| `zodToOutputSchema()` | Marginal - JSON Schema is already readable | ❌ Not essential |
| `structuredResult()` | Saves 2 lines per tool | ❌ Trivial to DIY |
| `createContextServer()` | Hides MCP SDK from developers | ❌ Adds friction, not value |

**Key insight**: The helpers would add a learning curve and dependency without providing meaningful value. Developers already know how to build MCP servers with `@modelcontextprotocol/sdk`.

### The Simpler Approach

**Tool Contributors (Data Brokers) don't need our SDK.**

They just need to:
1. Use the standard `@modelcontextprotocol/sdk` to build their MCP server
2. Add `outputSchema` to their tool definitions (Context Protocol extension)
3. Add `structuredContent` to their responses (Context Protocol extension)

That's it. Two fields. No SDK dependency required.

## Context Protocol Extensions

### 1. `outputSchema` (in tool definitions)

```typescript
const TOOLS = [{
  name: "get_gas_price",
  description: "Get current gas prices",
  inputSchema: { /* standard MCP */ },
  outputSchema: {  // 👈 Context Protocol extension
    type: "object",
    properties: {
      gasPrice: { type: "number" },
      unit: { type: "string" },
    },
    required: ["gasPrice", "unit"],
  },
}];
```

**Purpose:**
- AI agents use this to generate type-safe code
- Context's "Robot Judge" uses this for dispute resolution

### 2. `structuredContent` (in responses)

```typescript
return {
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data,  // 👈 Context Protocol extension
};
```

**Purpose:**
- Provides machine-readable data for agents
- Must match the declared `outputSchema`

## SDK Architecture (Final)

```
@ctxprotocol/sdk
├── src/
│   ├── client/           # For AI Agent developers
│   │   ├── client.ts     # ContextClient class
│   │   ├── resources/    # Discovery, Tools
│   │   └── types.ts
│   └── index.ts          # Re-exports client
```

The SDK is **client-only** — for AI agents to query the marketplace and execute tools.

## Example Servers

Instead of SDK abstractions, we provide **reference implementations**:

- `examples/server/blocknative-contributor/` — Gas price API (3 tools)
- `examples/server/hyperliquid-contributor/` — DeFi analytics (16 tools)

These are fully functional MCP servers that developers can copy and adapt.

## Future Consideration: Runtime Validation

The one area where a server SDK *might* provide value is **runtime validation** — automatically checking that responses match the declared `outputSchema`. This would help data brokers avoid disputes caused by schema mismatches.

If we decide to add this later, it would be a small, focused utility:

```typescript
import { validateResponse } from "@ctxprotocol/sdk/validation";

// In your handler
const data = await fetchData();
validateResponse(data, outputSchema);  // Throws if mismatch
return { content: [...], structuredContent: data };
```

But for v1, this is not needed. Documentation + examples are sufficient.

## Value Proposition (Revised)

| Stakeholder | What They Get |
|-------------|---------------|
| **AI Agent Developer** | `@ctxprotocol/sdk` — Query marketplace, execute tools, handle payments |
| **Tool Contributor** | Documentation + examples — Build standard MCP servers with 2 extra fields |
| **Protocol** | Verifiable responses via `outputSchema` + `structuredContent` |

The simplest solution wins. No unnecessary abstractions.
