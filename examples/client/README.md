# Context Protocol SDK Client Examples

This folder contains focused client examples:

- `src/query.ts` — Query mode (**start here**)
- `src/execute.ts` — Execute mode with session management
- `src/agent-routine.ts` — Recurring analyst routine with `evidence_only`, `dataUrl`, and optional pinned tools
- `src/index.ts` — Combined walkthrough of Query and Execute modes

## Prerequisites

Before running any example, complete setup at [ctxprotocol.com](https://ctxprotocol.com):

1. Sign in (creates your embedded wallet)
2. Set a spending cap
3. Fund your wallet with USDC
4. Create an API key

Set your API key using either method:

```bash
cp .env.example .env.local
# edit .env.local and replace sk_live_your_api_key_here
```

Or export it in your shell:

```bash
export CONTEXT_API_KEY="sk_live_your_api_key"
```

Optional routine overrides for `agent-routine.ts` are documented in `.env.example`.

## Install

```bash
pnpm install
```

## Run

```bash
pnpm run query
pnpm run routine
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

### `agent-routine.ts`

- Recurring routine shape for coding agents and scheduled reports
- `responseShape: "evidence_only"` with `includeDataUrl: true`
- Optional pinned tool IDs via `CONTEXT_ROUTINE_TOOL_IDS`
- `dataUrl` fetching with a placeholder client-side signal policy

### `index.ts`

- End-to-end combined flow that demonstrates both Query mode and Execute mode
- Method schema visibility for LLM prompt construction
- Full discovery + execution walkthrough in one file

## Internal dev scripts

`dev/` holds internal validation and forensic harnesses used by Context maintainers. They are not part of the public example surface and are safe to ignore unless you are debugging marketplace behavior.

Run one directly when needed:

```bash
tsx dev/btc-eth-chart.ts
```

Scripts in `dev/` may write generated JSON artifacts locally. Those outputs are gitignored.
