# FMP Contributor Validation

Read-only financial market intelligence over the official Financial Modeling Prep (FMP) "stable" REST API
(`https://financialmodelingprep.com/stable`). Auth is a contributor-hosted API key passed as the `apikey`
query parameter; no per-user context injection is required.

Upstream Context7 docs used for the initial contributor build:

- https://context7.com/websites/site_financialmodelingprep_developer/llms.txt?tokens=10000

A concatenated snapshot of the upstream docs at build time is saved alongside this file:

- `context7-fmp-contributor-upstream-snapshot.txt`

## Reference library (evaluated, not used as a runtime dependency)

`JerBouma/financetoolkit` was registered as an opensrc reference (`@.opensrc-refs/financetoolkit/`). It is a
Python (pandas/scikit-learn) analytics layer that sits *on top of* the same FMP API and computes 200+ ratios.
It is intentionally **not** used as a runtime dependency here because this contributor is a Node/TypeScript
Express + `@ctxprotocol/sdk` server deployed via `tsx`/pm2; adopting a Python toolkit would break the deploy
wiring and add heavy native deps. We instead wrap the raw FMP endpoints directly and can mirror its
high-value ratio ideas in TypeScript if the pipeline shows demand.

## Run the pipeline

```
/run-pipeline fmp-contributor https://context7.com/websites/site_financialmodelingprep_developer/llms.txt?tokens=10000
```
