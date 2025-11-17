# Context SDK
> Server-side helpers for publishing HTTP tools to the Context marketplace.

## Install
pnpm add @contextprotocol/sdk zod
# or npm install @contextprotocol/sdk zod

## Quick start
import { z } from "zod";
import { defineHttpTool, executeHttpTool } from "@contextprotocol/sdk";

const tool = defineHttpTool({
  name: "blocknative_gas_base",
  inputSchema: z.object({ chainId: z.number().default(8453) }),
  outputSchema: z.object({
    endpoint: z.string(),
    data: z.unknown()
  }),
  async handler(input) {
    const response = await fetch("https://your-endpoint", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return {
      endpoint: "gas_price",
      data: await response.json()
    };
  }
});

export async function handler(req: Request) {
  const body = await req.json();
  const result = await executeHttpTool(tool, body.input, {
    headers: Object.fromEntries(req.headers.entries())
  });
  return Response.json(result);
}

See `examples/blocknative-contributor/` for a full Express server that wraps the Blocknative Gas Platform.

## Commands
- `pnpm run build` – bundle to `dist/`
- `pnpm run lint` – Biome checks
- `pnpm run test` – Vitest (add tests as needed)

## Publishing
pnpm install
pnpm run build
pnpm publish --access public

# 8. Install deps (adjust if you use npm/yarn)
pnpm install

# 9. Build once to ensure everything compiles
pnpm run build
