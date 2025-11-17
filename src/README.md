## Context SDK (Server-side)

This is a minimal developer-facing helper that contributors can use when exposing
HTTP tools to the Context marketplace.

```ts
import { z } from "zod";
import { defineHttpTool, executeHttpTool } from "@contextprotocol/sdk";

const blocknativeTool = defineHttpTool({
  name: "blocknative_gas_base",
  version: "0.1.0",
  inputSchema: z.object({
    endpoint: z.enum(["gas_price", "chains", "oracles"]).default("gas_price"),
    chainId: z.number().int().optional(),
    confidence: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: z.object({
    data: z.unknown(),
  }),
  async handler(input) {
    // Custom contributor logic goes here
    return {
      data: await fetchBlocknative(input),
    };
  },
});

export async function handler(request: Request) {
  const body = await request.json();
  const response = await executeHttpTool(blocknativeTool, body.input, {
    headers: Object.fromEntries(request.headers.entries()),
  });
  return Response.json(response);
}
```

The SDK intentionally stays tiny: it validates incoming payloads, executes the
contributor's handler, validates the output, and wraps everything in a consistent
`{ data, meta }` envelope that Context can consume safely.

