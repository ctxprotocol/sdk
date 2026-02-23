# Context Protocol SDK Client Examples

This folder contains three focused client examples:

- `src/query.ts` — Query mode (**start here**)
- `src/execute.ts` — Execute mode with session management
- `src/index.ts` — Combined walkthrough of both modes

## Prerequisites

Before running any example, complete setup at [ctxprotocol.com](https://ctxprotocol.com):

1. Sign in (creates your embedded wallet)
2. Set a spending cap
3. Fund your wallet with USDC
4. Create an API key

Then export your key:

```bash
export CONTEXT_API_KEY="sk_live_your_api_key"
```

## Install

```bash
pnpm install
```

## Run

```bash
pnpm run query
pnpm run execute
pnpm start
```

## What each example shows

### `query.ts`

- `client.query.run()` simple string overload (auto-discovery mode)
- Manual selected-tools mode with `tools: ["tool-uuid"]`
- Query response fields: `response`, `toolsUsed`, `cost`, `durationMs`
- `ContextError` handling for common query/payment failures

### `execute.ts`

- Execute-eligible discovery with `mode: "execute"` and execute pricing filters
- Session lifecycle: `startSession` -> multiple `execute` calls -> `closeSession`
- Spend tracking via `result.session.spent` and `result.session.remaining`
- `ContextError` handling for execute/session lifecycle errors

### `index.ts`

- End-to-end combined flow that demonstrates both Query mode and Execute mode
- Method schema visibility for LLM prompt construction
- Full discovery + execution walkthrough in one file
