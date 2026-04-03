# MCP Tool Optimization Skill

> **The all-in-one post-build step for Context Marketplace contributors.**
> Replaces the old separate "generate listing" + "validate" workflow with a single
> skill that researches your vertical, proves differentiation, fixes issues,
> generates an optimal description, and pushes it to the marketplace automatically.

## When to Use This Skill

Load this skill into any AI coding agent (Cursor, Claude Code, Windsurf, Codex, etc.)
**after** you have:

1. Built your MCP server (using [mcp-builder-template.md](https://github.com/ctxprotocol/sdk/blob/main/docs/mcp-builder-template.md))
2. Registered it at [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute) and obtained your **Tool ID** and **API key**

Give the agent your server code, API key, and Tool ID. The skill handles everything
from alpha research through listing update.

## Required Inputs

Before starting, collect these from the contributor:

| Input | Where to get it | Used for |
|-------|----------------|----------|
| **Server source code** | The contributor's repo / workspace | Phase 0 context gathering |
| **MCP endpoint URL** | The deployed server URL | Direct MCP calls in Phase 6 |
| **CONTEXT_API_KEY** | [ctxprotocol.com/developer](https://ctxprotocol.com/developer) → API Keys | SDK calls and listing update |
| **TOOL_ID** | [ctxprotocol.com/developer/tools](https://ctxprotocol.com/developer/tools) → tool card | Listing update target |
| **Funded wallet** | [ctxprotocol.com/developer](https://ctxprotocol.com/developer) → Wallet | Required for query calls to succeed |

> **Important: Fund your wallet before running this skill.** The optimization process
> makes real query calls through the Context platform to validate your tool's responses.
> These calls go through the full librarian agentic flow, which requires a funded wallet
> to complete. If your wallet balance is zero, the validation queries will fail and the
> skill cannot verify your tool's quality. Deposit a small amount (a few dollars is
> sufficient for a full optimization run) at
> [ctxprotocol.com/developer](https://ctxprotocol.com/developer) before starting.

---

## Phase 0: Gather Context and Inputs

**Goal:** Build a complete picture of what the tool does before optimizing it.

### Steps

1. Read the contributor's server source code. Identify:
   - All tool methods (names, descriptions, input/output schemas)
   - The upstream data source(s): API subscriptions, custom pipelines, databases
   - The declared `_meta` on each method (surface, latencyClass, pricing, rateLimit)
   - Any context injection requirements

2. Call `tools/list` against the contributor's MCP endpoint to get the live method catalog.
   Compare with source code — flag any discrepancies.

3. Classify the tool into one or more **data source archetypes**:

   | Archetype | Description | Examples |
   |-----------|-------------|---------|
   | **Upstream API wrapper** | Wraps a third-party API subscription | CoinGecko, SensorTower, Crunchbase |
   | **Custom data pipeline** | Runs its own ingestion/computation | Smart money tracker, sentiment scorer |
   | **Multi-source normalizer** | Normalizes across multiple upstream APIs | Cross-exchange prices, multi-retailer catalog |
   | **Hybrid** | Combines upstream APIs with custom computation | Exchange flow analysis + news correlation |

4. Identify the tool's surface: **Query**, **Execute**, or **both**.

5. Collect the required inputs (API key, Tool ID, endpoint URL) from the contributor.

6. If Context7 MCP is available, fetch upstream API documentation to understand
   what the raw API provides vs. what the tool adds on top.

### Phase 0 Output

Produce a structured summary block:

```
PHASE_0_CONTEXT:
  archetype: <upstream_api_wrapper | custom_pipeline | multi_source_normalizer | hybrid>
  surface: <query | execute | both>
  upstream_sources: [list of data sources]
  method_count: N
  methods: [{ name, surface, latencyClass, hasOutputSchema }]
  endpoint_url: <url>
  tool_id: <id>
```

---

## Phase 1: Vertical Alpha Research

**Goal:** Identify where this tool creates unique value that free LLMs cannot replicate.

This phase is **mandatory** and **structurally enforced**. The skill will not proceed
to prompt generation without a valid alpha research artifact. This is the single most
important learning from our internal pipeline: without structural enforcement, agents
skip alpha research and generate generic test prompts.

### Research Framework by Archetype

**For upstream API wrappers:**

- **Fast-moving data:** Which endpoints return data that changes intraday or intra-hour?
  Free LLMs have stale training data — any live data is automatic differentiation.
- **Signal combinations:** Which pairs or triples of endpoints produce non-obvious
  signals when combined? (e.g., exchange flow + open interest + liquidations)
- **Screening and filtering:** Can the tool shortlist items by thresholds that
  would require manual dashboard work? (e.g., "markets with >$1M volume and <2% spread")
- **Cross-tool synthesis:** Can this tool's data combine with OTHER marketplace tools
  to produce insights neither can alone? (e.g., prediction market odds + derivatives positioning)
- **Upstream product gaps:** What does the upstream product's web UI do poorly that
  a programmatic tool can do better? (e.g., no API for multi-venue comparison)

**For custom data pipelines:**

- **Computed signals:** What does the pipeline compute that raw sources cannot?
- **Freshness advantage:** How often does the pipeline update vs. publicly available data?
- **Synthesis and scoring:** Does the pipeline produce composite scores, rankings,
  or classifications?
- **Unanswered questions:** What questions does this pipeline answer that no existing
  product answers?

**For multi-source normalizers:**

- **Cross-source patterns:** What patterns emerge from normalization that are invisible
  in any single source?
- **Consistency guarantees:** What guarantees does the normalizer provide that
  agents rely on (same schema, same pagination, same error semantics)?
- **Composition value:** What can an agent do with normalized data that it cannot
  do with fragmented sources?

### ENFORCEMENT GATE

Produce a structured `verticalAlphaResearch` artifact with:

- **At least 3 alpha categories** (e.g., "live data advantage", "signal combination", "screening")
- **At least 1 cross-tool synthesis opportunity** (how this tool combines with others)
- **At least 1 upstream/existing-product gap** (what the current product cannot do)

```json
{
  "verticalAlphaResearch": {
    "alphaCategories": [
      {
        "id": "live_data",
        "name": "Live Data Advantage",
        "description": "...",
        "relevantMethods": ["method_a", "method_b"],
        "differentiationStrength": "high"
      }
    ],
    "crossToolOpportunities": [
      {
        "partnerTool": "...",
        "combinedInsight": "...",
        "examplePrompt": "..."
      }
    ],
    "upstreamGaps": [
      {
        "gap": "...",
        "howToolFills": "..."
      }
    ]
  }
}
```

**IF THIS ARTIFACT IS MISSING OR INCOMPLETE → LOOP BACK. DO NOT PROCEED.**

---

## Phase 2: Generate Alpha-Grade Test Prompts

**Goal:** Generate 7–10 must-win prompts that prove this tool delivers value
users cannot get from ChatGPT for free.

### Prompt Requirements

Each prompt must:

1. **Require data that free LLMs lack** — stale training data, no tool access, no live data
2. **Have real consequence** — financial decisions, time savings, decision quality
3. **Be answerable by the current tool** — not aspirational features
4. **Be plausibly asked by a paying user** — not a test fixture or contrived scenario

### Distribution Targets

Ensure prompts cover these categories (not all required, but aim for diversity):

| Category | What it tests | Example pattern |
|----------|--------------|-----------------|
| **Live data** | Freshness advantage | "What is X right now?" |
| **Comparison/screening** | Filtering and ranking | "Which markets have X and Y?" |
| **Cross-tool synthesis** | Multi-tool combination | "Compare X data with Y data" |
| **Time-sensitive judgment** | Urgency and recency | "Did X change in the last 48 hours?" |
| **Ceiling-testing** | Maximum complexity | "Analyze X across N dimensions" |

### Linking Requirement

Each prompt **must** link to an `alphaCategory` from Phase 1. Unlinked prompts
are rejected — they indicate the prompt was not derived from alpha research.

### Phase 2 Output

```json
{
  "candidatePromptPool": [
    {
      "id": "prompt_1",
      "prompt": "...",
      "alphaCategory": "live_data",
      "category": "live_data",
      "expectedMethods": ["method_a"],
      "whyFreeCannotAnswer": "...",
      "realWorldConsequence": "..."
    }
  ]
}
```

---

## Phase 3: Free LLM Baseline Comparison

**Goal:** For each must-win prompt, test what a free frontier LLM (no tools)
produces. Classify differentiation.

### Procedure

For each prompt in `candidatePromptPool`:

1. Ask a free frontier LLM (e.g., ChatGPT, Gemini) the same question without
   any tool access.
2. Evaluate the response against what the tool would return.
3. Classify differentiation:

| Score | Meaning | Typical signal |
|-------|---------|---------------|
| `high_differentiation` | Free LLM hallucinates, gives stale/wrong data, or cannot answer | "I don't have access to real-time data" or confidently wrong numbers |
| `moderate_differentiation` | Free LLM gives partial answer but misses precision/freshness | Correct direction but wrong magnitude, stale by days/weeks |
| `low_differentiation` | Free LLM gives good-enough answer | Substantially correct and current |

### AUTO-CALIBRATION GATE

**Critical rule:** If a prompt's `whyFreeCannotAnswer` references live, real-time,
current, or intraday data AND the initial score is `moderate_differentiation`,
**auto-promote to `high_differentiation`**.

Free LLMs cannot access live data. Period. This auto-calibration corrects a
consistent agent bias we observed: agents under-score live-data prompts because
the free LLM's confident-sounding hallucination feels like a partial answer.

### STOP GATE

If more than half of must-win prompts score `low_differentiation`:

**STOP.** Report to the contributor that their tool's value proposition needs
rethinking before further optimization. The tool works, but it does not beat free
alternatives enough to justify a paid listing.

### Phase 3 Output

Update each prompt in `candidatePromptPool` with:

```json
{
  "freeBaseline": {
    "response": "...",
    "differentiation": "high_differentiation",
    "whyItBeatsFree": "...",
    "autoCalibrated": false
  }
}
```

---

## Phase 4: Data Quality Spot Check

**Goal:** Verify the tool returns accurate, useful data — not just structurally
valid responses.

### Level 1: Internal Consistency

Check tool output for:

- **Identical values across rows that should vary** — e.g., every market has the same volume
- **Capped/maxed-out fields masking real values** — e.g., all percentages are exactly 100%
- **Empty fields that are the whole point of the query** — e.g., `spread: null` on a spread query
- **Derived numbers that contradict each other** — e.g., `netFlow` doesn't equal `inflow - outflow`
- **Truncated results without disclosure** — e.g., returning 5 items when the query asked for top 20

### Level 2: External Accuracy (Wrong-Universe Detection)

**This is critical.** Data that is internally consistent but factually wrong is
worse than an error — it creates false confidence.

For at least one ranking/discovery method:

1. Call the tool's method directly
2. Call the upstream data source directly (or check their web UI)
3. Compare: Does the tool return the same top results?

**Common root causes of wrong-universe data:**

- Wrong sort parameter (sorting by name instead of volume)
- Missing pagination (returning page 1 of 5 as if it were everything)
- Category filters silently excluding results
- Stale cache returning yesterday's ranking

If Level 2 reveals discrepancies, **fix the contributor's code** before proceeding.
This is a code fix, not a metadata fix.

### Phase 4 Output

```json
{
  "dataQualityValidation": {
    "level1": {
      "passed": true,
      "issues": []
    },
    "level2": {
      "methodTested": "get_top_markets",
      "upstreamComparison": "...",
      "passed": true,
      "issues": []
    }
  }
}
```

---

## Phase 5: Latency and Metadata Audit

**Goal:** Ensure method metadata matches actual execution characteristics.

### Latency Classification Rules

| Actual behavior | Correct `latencyClass` |
|----------------|----------------------|
| Simple GET → upstream, single call | `fast` or `instant` |
| 2 sequential upstream calls | `fast` |
| 3+ sequential upstream calls | `slow` |
| Internal for-loop over candidates | `slow` |
| Pre-computed data from local DB | `instant` |
| Streaming/SSE response | `streaming` |

**Why this matters:** If a `slow` method is classified as `fast`, the platform
gives it a short timeout and it fails — appearing as a runtime bug when it's
actually a metadata bug.

### Metadata Checklist

For each method, verify:

- [ ] `_meta.latencyClass` matches actual execution cost
- [ ] `_meta.surface` is correct (query, execute, or both)
- [ ] `_meta.queryEligible` is set for methods that should appear in Query mode
- [ ] `outputSchema` is complete (not just `{ type: "object" }`)
- [ ] `structuredContent` is returned in responses (not just `content[0].text`)
- [ ] Methods chaining 3+ sequential upstream calls are in any `HEAVY_ANALYSIS_TOOLS` set

Fix misclassifications in the contributor's code.

### Phase 5 Output

```json
{
  "latencyAudit": {
    "methods": [
      {
        "name": "method_a",
        "declaredLatency": "fast",
        "actualLatency": "slow",
        "fix": "Moved to HEAVY_ANALYSIS_TOOLS"
      }
    ],
    "schemaCompleteness": "8/10 methods have complete outputSchema"
  }
}
```

---

## Phase 6: Iterative Optimization Loop

**Goal:** Run each must-win prompt through the tool and fix issues in a loop
until pass rate exceeds 85%.

### Procedure

For each prompt in `candidatePromptPool`:

1. **Execute** the prompt against the tool via direct MCP call
   (or via `client.query.run()` with the tool pinned)
2. **Evaluate** the response:
   - Did it return data? (not an error)
   - Is the data relevant to the prompt?
   - Does it match the expected methods from Phase 2?
   - Is the data quality acceptable per Phase 4 criteria?
3. **If failed:** Diagnose root cause:
   - Missing method (prompt requires capability the tool doesn't have)
   - Wrong parameters (prompt maps to wrong method or wrong args)
   - Data quality issue (method works but returns bad data)
   - Timeout (method too slow for its latency class)
   - Schema mismatch (output doesn't match declared schema)
4. **Fix** the contributor's code and **retry**

### Loop Control

- **Pass threshold:** ≥ 85% of must-win prompts succeed
- **Maximum iterations:** 5 (prevent infinite loops)
- **Per-iteration:** Fix 1–3 issues, then retest all failing prompts

If after 5 iterations the pass rate is still below 85%, report remaining failures
with root cause analysis. The contributor may need architectural changes beyond
what iterative fixing can accomplish.

### Phase 6 Output

```json
{
  "optimizationRuns": [
    {
      "iteration": 1,
      "passRate": "5/8",
      "failures": [
        {
          "promptId": "prompt_3",
          "rootCause": "timeout",
          "fix": "Added to HEAVY_ANALYSIS_TOOLS, increased latencyClass to slow"
        }
      ]
    },
    {
      "iteration": 2,
      "passRate": "7/8",
      "failures": [...]
    }
  ]
}
```

---

## Phase 7: Generate Optimized Description and Update Listing

**Goal:** Generate the best possible marketplace description and push it
to the listing programmatically.

### Description Generation

Using the methodology from [mcp-server-analysis-prompt.md](https://github.com/ctxprotocol/sdk/blob/main/docs/mcp-server-analysis-prompt.md),
generate a marketplace description that includes:

1. **Opening paragraph:** What the tool does and who it's for (1–2 sentences)
2. **Features section:** Highlight the alpha categories from Phase 1 — not just
   a list of methods, but the VALUE each method provides
3. **"Try asking" prompts:** Populated from the validated must-win prompts from
   Phase 6 (not generic examples). These are prompts proven to work and proven
   to beat free alternatives.
4. **Agent tips:** Technical guidance for AI agents calling the tool (parameter
   patterns, recommended call sequences, rate limit awareness)

### Programmatic Update

Use `@ctxprotocol/sdk` to push the description directly to the marketplace:

**TypeScript:**

```typescript
import { ContextClient } from "@ctxprotocol/sdk";

const client = new ContextClient({ apiKey: CONTEXT_API_KEY });
const updated = await client.developer.updateTool(TOOL_ID, {
  description: generatedDescription,
});
console.log("Listing updated at:", updated.updatedAt);
```

**Python:**

```python
from ctxprotocol import ContextClient

async with ContextClient(api_key=CONTEXT_API_KEY) as client:
    updated = await client.developer.update_tool(
        TOOL_ID,
        description=generated_description,
    )
    print("Listing updated at:", updated["updatedAt"])
```

### CONFIRMATION GATE

Before calling the update API, **show the contributor the generated description**
and ask for confirmation. Do not silently overwrite a description without the
contributor reviewing it.

Display the description in full, then ask:

```
This description will be pushed to your marketplace listing.
Review it and confirm to proceed, or request changes.
```

---

## Phase 8: Produce Final Optimization Artifact

**Goal:** Produce a machine-readable artifact that serves as proof of quality
for the contributor and the Context grants review team.

### Artifact Structure

Save as `optimization-artifact.json` alongside the contributor's server code:

```json
{
  "version": "1.0",
  "toolId": "...",
  "generatedAt": "ISO-8601",
  "verticalAlphaResearch": {
    "alphaCategories": [...],
    "crossToolOpportunities": [...],
    "upstreamGaps": [...]
  },
  "candidatePromptPool": [
    {
      "id": "prompt_1",
      "prompt": "...",
      "alphaCategory": "...",
      "freeBaseline": {
        "differentiation": "high_differentiation",
        "whyItBeatsFree": "...",
        "autoCalibrated": false
      },
      "testResult": "pass"
    }
  ],
  "dataQualityValidation": {
    "level1": { "passed": true, "issues": [] },
    "level2": { "methodTested": "...", "passed": true, "issues": [] }
  },
  "latencyAudit": {
    "methods": [...],
    "schemaCompleteness": "..."
  },
  "optimizationRuns": [...],
  "showcasePrompts": [
    "Top 7-10 validated prompts for the listing"
  ],
  "generatedDescription": "...",
  "descriptionUpdatedAt": "ISO-8601",
  "signoff": {
    "passRate": "7/8",
    "highDifferentiationCount": 5,
    "moderateDifferentiationCount": 2,
    "lowDifferentiationCount": 1,
    "overallStatus": "PASS"
  }
}
```

### Signoff Criteria

| Status | Condition |
|--------|-----------|
| **PASS** | ≥ 85% pass rate AND ≥ 5 high-differentiation prompts |
| **CONDITIONAL** | ≥ 85% pass rate but < 5 high-differentiation prompts |
| **FAIL** | < 85% pass rate OR > 50% low-differentiation prompts |
| **BLOCKED** | Could not complete due to infrastructure issues |

---

## Quick Reference: Structural Enforcement Gates

These gates prevent the most common failure modes. They are not optional.

| Gate | Phase | Blocks if... |
|------|-------|-------------|
| **Alpha Research Gate** | 1 → 2 | `verticalAlphaResearch` artifact missing or incomplete (< 3 categories, no cross-tool opportunity, no upstream gap) |
| **Prompt Linking Gate** | 2 → 3 | Any prompt lacks an `alphaCategory` link |
| **Auto-Calibration Gate** | 3 | Live-data prompt scored `moderate` — auto-promote to `high` |
| **Stop Gate** | 3 → 4 | > 50% of prompts are `low_differentiation` |
| **Data Quality Gate** | 4 → 5 | Level 2 (external accuracy) reveals wrong-universe data |
| **Latency Gate** | 5 → 6 | 3+ sequential call methods classified as `fast` |
| **Pass Rate Gate** | 6 → 7 | < 85% pass rate after 5 iterations |
| **Confirmation Gate** | 7 | Description not shown to contributor before update |

---

## Relationship to Other Docs

| Document | Status | When to use |
|----------|--------|------------|
| **mcp-builder-template.md** | Active | Step 1: Build the MCP server |
| **mcp-server-analysis-prompt.md** | Still valid | Standalone description generator (this skill includes description generation as Phase 7) |
| **mcp-contributor-deep-validation-system-prompt.md** | Lightweight alternative | Quick protocol-compliance check without full optimization |
| **mcp-tool-optimization-skill.md** (this doc) | **Recommended** | Full optimization: alpha research + validation + description update |

---

## Troubleshooting

### "I don't have a CONTEXT_API_KEY yet"

Register at [ctxprotocol.com/contribute](https://ctxprotocol.com/contribute) first,
then go to [Developer → API Keys](https://ctxprotocol.com/developer) to generate one.

### "The description update API returns 403"

Your API key must belong to the account that owns the tool. Verify you are using
the correct key and Tool ID.

### "Phase 3 says all my prompts are low_differentiation"

Your tool may be in a competitive space where free LLMs already do well. Consider:
- Adding live/real-time data endpoints (instant high differentiation)
- Building cross-source synthesis (combining data no single free LLM has)
- Targeting a more specific niche within your vertical

### "Phase 6 keeps failing on the same prompt after 5 iterations"

The prompt may require architectural changes (new methods, new data sources, or
a different approach). Mark it as out-of-scope and focus on passing prompts.
A tool with 7/8 passing is better than one stuck at 5/8 trying to force the 8th.

### "Phase 4 Level 2 reveals my data is wrong"

This is a contributor code bug, not a platform issue. Common fixes:
- Check sort parameters in upstream API calls
- Add pagination to fetch all results, not just page 1
- Verify category/filter parameters aren't silently excluding data
- Check if caching is serving stale results

---

## Example: Running This Skill

Here is how a contributor would invoke this skill in Cursor or Claude Code:

```
Load the mcp-tool-optimization-skill.md from context-sdk/docs/.

My server code is in ./server.ts (or provide the repo path).
My MCP endpoint is https://my-tool.example.com/mcp
My CONTEXT_API_KEY is sk_live_...
My TOOL_ID is abc-123-def

Run the full optimization workflow.
```

The agent will:
1. Read the server code and gather context (Phase 0)
2. Research the vertical for alpha angles (Phase 1)
3. Generate and test must-win prompts (Phases 2–3)
4. Check data quality and metadata (Phases 4–5)
5. Fix issues and retest in a loop (Phase 6)
6. Generate and push the optimal description (Phase 7)
7. Produce the final artifact (Phase 8)

A tool that works is table stakes. A tool that delivers insights users cannot get
from ChatGPT for free is what earns revenue and qualifies for Tier S grants.
