# Context SDK
> Server-side helpers for publishing HTTP tools to the Context marketplace.

The Context SDK is a tiny server-side helper for contributors who want to
expose HTTP-based tools to the Context marketplace in a safe, typed, and
consistent way.

---

## Install

Using **pnpm**:

```bash
pnpm add @contextprotocol/sdk zod
```

Using **npm**:

```bash
npm install @contextprotocol/sdk zod
```

---

## Quick start

Define a tool with input/output schemas and a handler, then expose it via a
single HTTP endpoint:

```ts
import { z } from "zod";
import { defineHttpTool, executeHttpTool } from "@contextprotocol/sdk";

const tool = defineHttpTool({
  name: "blocknative_gas_base",
  inputSchema: z.object({ chainId: z.number().default(8453) }),
  outputSchema: z.object({
    endpoint: z.string(),
    data: z.unknown(),
  }),
  async handler(input) {
    const response = await fetch("https://your-endpoint", {
      method: "POST",
      body: JSON.stringify(input),
    });

    return {
      endpoint: "gas_price",
      data: await response.json(),
    };
  },
});

export async function handler(req: Request) {
  const body = await req.json();
  const result = await executeHttpTool(tool, body.input, {
    headers: Object.fromEntries(req.headers.entries()),
  });

  return Response.json(result);
}
```

See `examples/blocknative-contributor/` for a full Express server that wraps
the Blocknative Gas Platform.

---

## Scripts

From the repo root:

- **Build** – bundle to `dist/`:

  ```bash
  pnpm run build
  ```

- **Lint** – Biome checks:

  ```bash
  pnpm run lint
  ```

- **Test** – Vitest (add tests as needed):

  ```bash
  pnpm run test
  ```

---

## Publishing (for maintainers)

Install dependencies, build once to ensure everything compiles, then publish:

```bash
pnpm install
pnpm run build
pnpm publish --access public
```

