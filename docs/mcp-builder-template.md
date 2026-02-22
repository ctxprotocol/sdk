# MCP Builder Template

> **Purpose**: A universal template for designing "giga-brained" MCP servers for Context Protocol. Provide a Context7 library ID and the AI will automatically analyze the API, generate discovery questions, and architect your tools.

---

## Quick Start

### Option A: Automated with Context7 (Recommended)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          AUTOMATED WORKFLOW                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PHASE 1: Discovery                                                         │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                     │
│  │ Provide     │───▶│ AI fetches  │───▶│ AI analyzes │                     │
│  │ Context7 ID │    │ docs        │    │ endpoints   │                     │
│  └─────────────┘    └─────────────┘    └─────────────┘                     │
│                                              │                              │
│                                              ▼                              │
│  PHASE 2: Review & Iterate ◀──────── YOU ARE HERE ─────────────────────    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ AI presents:                                                        │   │
│  │  • Discovered endpoints                                             │   │
│  │  • Generated discovery questions                                    │   │
│  │  • Proposed tool architecture                                       │   │
│  │                                                                     │   │
│  │ You review and iterate:                                             │   │
│  │  • "Add question about X"                                           │   │
│  │  • "Remove tool Y, not valuable"                                    │   │
│  │  • "Combine tools A and B"                                          │   │
│  │  • "This question is wrong because..."                              │   │
│  │                                                                     │   │
│  │ ⚠️  DO NOT PROCEED TO BUILD UNTIL QUESTIONS ARE FINALIZED          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                              │                              │
│                                              ▼                              │
│  PHASE 3: Build                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                     │
│  │ Finalized   │───▶│ Generate    │───▶│ Implement   │                     │
│  │ questions   │    │ schemas     │    │ & deploy    │                     │
│  └─────────────┘    └─────────────┘    └─────────────┘                     │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Step 1: Start Discovery**
```
Use the MCP builder template at docs/mcp-builder-template.md.
Fetch the documentation using Context7 for [LIBRARY_ID].
Analyze all endpoints and generate discovery questions.
STOP and present for my review before designing tools.
```

**Step 2: Review & Iterate** (repeat until satisfied)
```
Review the generated questions. Iterate with feedback like:
- "Add a question about [X]"
- "Question 3 isn't valuable because [Y]"  
- "What if we combined [A] and [B]?"
- "I want tools that answer [specific question]"
```

**Step 3: Finalize & Build**
```
I approve the discovery questions. Now design the tool 
architecture with full schemas, then implement.
```

### Option B: Manual

1. Fill in [Section 1: API Context](#section-1-api-context) manually
2. Answer the [Discovery Questions](#section-2-discovery-questions)
3. Use the [Tool Design Framework](#section-3-tool-design-framework)
4. Follow the [Implementation Checklist](#section-5-implementation-checklist)

---

## Context7 Source

> **Instructions**: Provide the Context7 library ID. The AI will use Context7 MCP to fetch documentation and auto-generate the plan.

| Field | Value |
|-------|-------|
| **Context7 Library ID** | `/sammchardy/python-binance` |
| **Topics to Fetch** | `market data`, `websockets`, `account`, `trading` |

### AI Instructions Block

````markdown
## PHASE 1: DISCOVERY (auto-generated, then STOP)

### STEP 1: Fetch Documentation
Use Context7 MCP to fetch the library documentation:
```
1. Call resolve-library-id with libraryName if ID unknown
2. Call get-library-docs with context7CompatibleLibraryID, mode='code'
3. Call get-library-docs with topic='authentication' 
4. Call get-library-docs with topic='rate limits'
5. Fetch additional topics as needed (websockets, trading, etc.)
```

### STEP 2: Analyze & Categorize Endpoints  
From the fetched documentation, extract and present:
1. ALL available endpoints/methods (comprehensive list)
2. Categories (market data, account, trading, etc.)
3. Request/response schemas for key endpoints
4. Authentication requirements
5. Rate limits

### STEP 2.5: 🔍 DISCOVERY LAYER AUDIT (CRITICAL)
**DO NOT SKIP THIS STEP** - This is the most common gap in MCP servers.

Check if the API provides ways to list/enumerate ALL available:
- Categories/Types (e.g., `GET /categories`, `GET /types`)
- Tags/Labels (e.g., `GET /tags`, `GET /labels`)
- Groups/Collections (e.g., `GET /groups`, `GET /sports`)
- Regions/Markets (e.g., `GET /regions`, `GET /markets`)

For EACH discovered listing endpoint, note:
1. What identifiers does it return? (id, slug, key, etc.)
2. Can those IDs be used to filter other endpoints? (e.g., `GET /items?category_id=X`)
3. What is the hierarchy? (e.g., Category → Tags → Events → Markets)

⚠️ **Common Failure Pattern**: 
Only exposing "trending" or "popular" endpoints without the ability 
to list ALL available categories/types. This breaks cross-platform 
composability because agents can't discover what data exists.

Document the full data hierarchy:
```
[Top Level] → [Mid Level] → [Leaf Level] → [Identifiers for Analysis]
Example: Categories → Tags → Events → conditionId (for orderbook, trades, etc.)
```

### STEP 3: Generate Discovery Questions
Based on the API capabilities, propose:
1. 5-10 questions users would ask that REQUIRE MULTIPLE ENDPOINTS
2. For each question, show which endpoints would need to be combined
3. Rate each question's unique value potential (can users get this elsewhere?)

### 🛑 CHECKPOINT: STOP HERE AND WAIT FOR USER REVIEW

Present the following for user approval:
- Endpoints discovered
- Discovery questions generated  
- Initial assessment of unique value opportunities

Ask: "Please review. What questions should I add, remove, or modify?"

---

## PHASE 2: ITERATE (repeat until user approves)

Incorporate user feedback:
- Add/remove/modify questions as directed
- Re-assess which endpoints map to each question
- Update unique value assessments
- Present revised questions

Ask: "Are these discovery questions finalized? Say 'approved' to proceed to tool design."

---

## PHASE 3: BUILD (only after explicit approval)

### STEP 4: Design Tool Architecture
Based on APPROVED discovery questions:
- 4-8 Tier 1 Intelligence Tools (one per approved question)
- 3-5 Tier 2 Raw Data Tools (fundamental building blocks)
- Full input/output schemas for each tool
- Data composition diagrams

### STEP 5: Implementation
- Generate MCP server boilerplate (WITHOUT security middleware for local testing)
- Implement each tool
- Test locally with curl to verify all tools work
- Add `createContextMiddleware()` before deploying

### STEP 6: Deploy & Test Agentically
Deploy to VPS and test all endpoints using AI-assisted SSH:

```
1. Deploy server files to VPS
2. Run setup-servers.sh to start with PM2
3. Run setup-caddy-https.sh for HTTPS
4. SSH into server and test endpoints agentically
5. Register on Context Marketplace
```

See [Agentic Testing Workflow](#agentic-testing-workflow) below for details.
````

---

## Section 1: API Context

### 1.1 Project Overview

| Field | Value |
|-------|-------|
| **MCP Server Name** | `[your-mcp-name]` |
| **Domain** | `[e.g., Trading, Social, Analytics, Blockchain, etc.]` |
| **Target Users** | `[Who will use these tools?]` |
| **Unique Value Prop** | `[What can users do that they couldn't before?]` |
| **Listing Response Price** | `$[X.XX]` per response (Query surface) |
| **Execute Price Per Method** | `$[X.XX]` per call (Execute surface, optional) |

### 1.2 Required Dependencies

Tool contributors need **both** SDKs:

```bash
npm install @modelcontextprotocol/sdk @ctxprotocol/sdk express
npm install -D @types/express typescript
```

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | Build MCP server (tools, schemas, handlers) |
| `@ctxprotocol/sdk` | Security middleware (`createContextMiddleware`) + context types |
| `express` | HTTP server for web deployment |

### 1.3 API/SDK Documentation

> **Instructions**: 
> - **Automated (Option A)**: This section is AUTO-FILLED by Context7. Leave blank.
> - **Manual (Option B)**: Paste complete API documentation below.

#### Endpoints Discovered

<!-- AUTO-GENERATED: Context7 will populate this table -->

| Category | Endpoint/Method | Description | Auth Required |
|----------|-----------------|-------------|---------------|
| | | | |
| | | | |
| | | | |

#### Raw Documentation

```
<!-- For manual mode OR Context7 dumps raw docs here -->








```

### 1.4 Authentication & Rate Limits

| Aspect | Details |
|--------|---------|
| **Auth Type** | `[API Key / OAuth / JWT / None]` |
| **Auth Required For** | `[Which endpoints need auth?]` |
| **Rate Limits** | `[Requests per minute/hour]` |
| **Rate Limit Strategy** | `[How to handle: caching, queuing, etc.]` |

### 1.5 Available Data Categories

> **Instructions**: List all categories of data/functionality available from the API.

| Category | Endpoints/Methods | Data Type |
|----------|-------------------|-----------|
| Example: Market Data | `/ticker`, `/depth`, `/trades` | Real-time |
| Example: Historical | `/klines`, `/history` | Time-series |
| Example: Account | `/balance`, `/orders` | User-specific |
| | | |
| | | |
| | | |
| | | |
| | | |

---

## Section 2: Discovery Questions

> **Instructions**: 
> - **Automated (Option A)**: Context7 AI will analyze the API and generate these based on endpoint combinations.
> - **Manual (Option B)**: Answer these questions yourself.

### 2.1 User Intent Analysis

**What questions do your target users frequently ask?**

<!-- AUTO-GENERATED: Based on API capabilities, what complex questions could users ask? -->

```
1. 
2. 
3. 
4. 
5. 
```

**Which of these questions CANNOT be answered by a single API call?**

<!-- AUTO-GENERATED: Which questions require combining multiple endpoints? -->

```
1. 
2. 
3. 
```

**What data do users currently have to manually combine or analyze?**

<!-- AUTO-GENERATED: What multi-source insights are possible? -->

```
1. 
2. 
3. 
```

### 2.2 Value Assessment

**What would users pay $0.01-0.05 per response for?**

```
- 
- 
- 
```

**What insights are impossible to get elsewhere?**

```
- 
- 
- 
```

**What takes experts hours that could be automated?**

```
- 
- 
```

### 2.3 Data Composition Opportunities

> **Instructions**: Identify which API endpoints can be combined to create intelligence.

| User Question | Required Data Sources | Intelligence Added |
|---------------|----------------------|-------------------|
| Example: "What's the market sentiment?" | orderbook + volume + funding | Synthesis + scoring |
| | | |
| | | |
| | | |
| | | |

### 2.4 Discovery Layer Analysis

> **Instructions**: 🔍 **CRITICAL** - Map the API's enumeration/listing capabilities.

This analysis ensures your MCP exposes the FULL surface area of the API, not just "popular" or "trending" data.

#### 2.4.1 What Can Be Listed/Enumerated?

| Entity Type | List Endpoint | Returns | Used For Filtering |
|-------------|---------------|---------|-------------------|
| Example: Categories | `GET /categories` | id, label, slug | `GET /items?category=X` |
| Example: Tags | `GET /tags` | tag_id, name | `GET /events?tag_id=X` |
| Example: Sports | `GET /sports` | key, group, has_outrights | `GET /odds?sport=X` |
| | | | |
| | | | |
| | | | |

#### 2.4.2 Data Hierarchy Map

Draw the hierarchy from broadest to most specific:

```
[FILL IN YOUR API'S HIERARCHY]

Example (Prediction Markets):
┌─────────────────┐
│   Categories    │  GET /categories → returns id, slug
└────────┬────────┘
         │ filters
         ▼
┌─────────────────┐
│      Tags       │  GET /tags → returns tag_id, name
└────────┬────────┘
         │ filters
         ▼
┌─────────────────┐
│     Events      │  GET /events?tag_id=X → returns events with markets
└────────┬────────┘
         │ contains
         ▼
┌─────────────────┐
│     Markets     │  Each has conditionId, tokenId
└────────┬────────┘
         │
         ▼
    Used by: orderbook, trades, analysis tools
```

#### 2.4.3 Cross-Platform Composability Check

If your MCP might be used alongside OTHER data sources, answer:

| Question | Answer |
|----------|--------|
| What other platforms have overlapping data? | [e.g., "Polymarket sports ↔ Odds API futures"] |
| What entity types can be compared? | [e.g., "Championship predictions vs betting odds"] |
| What identifier is shared or correlatable? | [e.g., "Team names, event dates"] |
| Does your MCP expose the listing tools needed? | [ ] Yes / [ ] No - ADD THEM |

#### 2.4.4 Discovery Gap Analysis

For each listing endpoint in the API, check if your MCP exposes it:

| API Endpoint | Purpose | Exposed in MCP? | Tool Name |
|--------------|---------|-----------------|-----------|
| `GET /categories` | List all categories | ☐ Yes ☐ No | `get_all_categories` |
| `GET /tags` | List all tags | ☐ Yes ☐ No | `get_all_tags` |
| `GET /types` | List all types | ☐ Yes ☐ No | `get_all_types` |
| `GET /groups` | List all groups | ☐ Yes ☐ No | `get_all_groups` |
| | | | |

**⚠️ WARNING**: If any listing endpoint exists in the API but is NOT exposed in your MCP, you are creating a composability gap. Agents won't be able to discover all available data.

### 2.5 Competitive Analysis

**Can users get this from Claude/ChatGPT/Cursor directly?**

| Capability | Available Elsewhere? | Your Advantage |
|------------|---------------------|----------------|
| Raw API access | Yes (with MCP) | None |
| Combined data | Possible but unreliable | Pre-built, tested |
| Domain intelligence | No | Unique value ✓ |

---

## 🛑 REVIEW CHECKPOINT

> **STOP HERE** before proceeding to tool design. This is the most important step.

### Finalized Discovery Questions

Before building, you MUST approve the final list of questions your MCP will answer.

| # | Question | Endpoints Required | Unique Value? | APPROVED |
|---|----------|-------------------|---------------|----------|
| 1 | | | ☐ Yes ☐ No | ☐ |
| 2 | | | ☐ Yes ☐ No | ☐ |
| 3 | | | ☐ Yes ☐ No | ☐ |
| 4 | | | ☐ Yes ☐ No | ☐ |
| 5 | | | ☐ Yes ☐ No | ☐ |
| 6 | | | ☐ Yes ☐ No | ☐ |

### Quality Gate Checklist

Before approving, verify each question passes these tests:

- [ ] **Multi-source**: Requires 2+ endpoints to answer (not a simple passthrough)
- [ ] **Unique**: Users CANNOT easily get this from Claude/ChatGPT/Cursor
- [ ] **Valuable**: You would personally pay $0.01-0.05 for this answer
- [ ] **Actionable**: The answer helps users make decisions, not just see data
- [ ] **Algorithmic**: Requires domain expertise/logic, not just data aggregation

### 🎯 Surface & Pricing Checkpoint (MANDATORY)

Before proceeding to build, decide which surface(s) your MCP server targets:

- [ ] **Target surface decided**: Query only / Execute only / Both
- [ ] **Listing response price set**: $X.XX for Query surface (pay-per-response)
- [ ] **Execute pricing decided**: If targeting Execute surface, each method needs `_meta.pricing.executeUsd` (~1/100 of response price)
- [ ] **Rate limit hints planned**: If wrapping rate-limited APIs, plan `_meta.rateLimit` values per method

| Decision | Value |
|----------|-------|
| **Target surface** | [ ] Query only  [ ] Execute only  [ ] Both |
| **Listing response price** | $_____ |
| **Default execute price** | $_____ (or N/A if Query only) |

**⚠️ CRITICAL**: Without `_meta.pricing.executeUsd`, your methods are **invisible** on the Execute surface. SDK consumers cannot discover or call them. If you want Execute revenue, you must set execute pricing.

### 🔍 Discovery Layer Checklist (MANDATORY)

Before proceeding, verify your MCP has complete enumeration coverage:

- [ ] **Categories exposed**: If API has `GET /categories` (or similar), MCP has `get_all_categories`
- [ ] **Tags/Labels exposed**: If API has `GET /tags`, MCP has `get_all_tags`
- [ ] **Types/Groups exposed**: If API has `GET /types` or `GET /groups`, MCP exposes them
- [ ] **Filter-by-ID tools exist**: For each listing tool, there's a `browse_by_X` tool that uses the IDs
- [ ] **Data hierarchy documented**: Tool descriptions explain the hierarchy (Category → Tag → Event → Market)
- [ ] **Cross-platform hints**: Tool descriptions mention what OTHER MCPs/data sources can be combined
- [ ] **No "trending only" gaps**: Every entity type is accessible, not just popular/trending items

**⚠️ FAILURE PATTERN TO AVOID**: 
An agent asks "find all NBA markets" but your MCP only has `discover_trending_markets` 
which returns political events because they're trending. The agent CANNOT find NBA 
markets because there's no way to list all tags/categories.

**✅ SUCCESS PATTERN**:
Agent calls `get_all_tags` → finds "NBA" tag with tag_id → calls `browse_by_tag({ tag_id })` 
→ gets all NBA markets with conditionIds → can analyze any of them

### Iteration Log

Record feedback and changes made during review:

```
Iteration 1: [date]
- Added: 
- Removed: 
- Modified: 

Iteration 2: [date]
- Added: 
- Removed: 
- Modified: 

FINAL APPROVAL: [date] - Questions locked, proceeding to build.
```

---

## Section 3: Tool Design Framework

### 3.1 Architecture Pattern

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           YOUR MCP SERVER                                   │
│                         [your-mcp-name]                                     │
│                                                                             │
│         💰 RESPONSE PRICE: $X.XX (Query) | EXECUTE: $Y.YY/call (SDK)      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    TIER 1: INTELLIGENCE LAYER                         │  │
│  │            (Query Surface — Curated Intelligence Per Response)        │  │
│  │                                                                       │  │
│  │  These tools SYNTHESIZE multiple data sources into actionable        │  │
│  │  insights. They encode domain expertise and answer complex           │  │
│  │  questions that raw API calls cannot.                                │  │
│  │                                                                       │  │
│  │  Best for Query surface (pay-per-response):                          │  │
│  │  → 1 intelligence call = complete answer                             │  │
│  │  → Maximizes value per response turn                                  │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │   [tool_1]      │  │   [tool_2]      │  │   [tool_3]      │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
│  │                                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │   [tool_4]      │  │   [tool_5]      │  │   [tool_6]      │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    TIER 2: RAW DATA LAYER                             │  │
│  │          (Execute Surface — Normalized Data For SDK Consumers)        │  │
│  │                                                                       │  │
│  │  These tools provide normalized, structured data for agents          │  │
│  │  and SDK consumers to iterate over programmatically. Ideal           │  │
│  │  for the Execute surface (pay-per-call with session budgets).        │  │
│  │                                                                       │  │
│  │  Also used as Query fallback for custom agent composition            │  │
│  │                                                                       │  │
│  │  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐            │  │
│  │  │ [raw_1]   │ │ [raw_2]   │ │ [raw_3]   │ │ [raw_4]   │            │  │
│  │  └───────────┘ └───────────┘ └───────────┘ └───────────┘            │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                     │                                       │
│                                     ▼                                       │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                        EXTERNAL API LAYER                             │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Tier 1: Intelligence Tools Design

> **Instructions**: For each intelligence tool, fill out this template.

---

#### Intelligence Tool Template

```markdown
### Tool: `[tool_name]`

**Question Answered**: "[What question does this tool answer?]"

**Intelligence Type**: 
- [ ] Synthesis (combining multiple data sources)
- [ ] Analysis (statistical/mathematical processing)
- [ ] Prediction (forecasting based on patterns)
- [ ] Detection (anomaly/pattern recognition)
- [ ] Scoring (rating/ranking entities)
- [ ] Recommendation (actionable suggestions)

**Value Proposition**: [Why would someone pay for this?]

#### Data Composition

```
[tool_name] combines:
├── [API endpoint 1] → [what it provides]
├── [API endpoint 2] → [what it provides]
├── [API endpoint 3] → [what it provides]
└── [Processing/algorithm] → [intelligence added]
```

#### Context Requirements (Optional)

If your tool needs user portfolio data (e.g., positions, balances), declare it using `_meta`:

```json
{
  "_meta": {
    "contextRequirements": ["[hyperliquid|polymarket|wallet]"]
  }
}
```

> **Note**: `_meta` is part of the MCP spec for arbitrary tool metadata. The Context platform reads `_meta.contextRequirements` to inject user data automatically. See [Context Injection Guide](./context-injection.md).

#### Input Schema

```json
{
  "type": "object",
  "properties": {
    "portfolio": {
      "type": "object",
      "description": "User portfolio data (injected by platform if contextRequirements declared)"
    },
    "[param1]": {
      "type": "[string/number/boolean/array]",
      "description": "[What this parameter controls]",
      "default": "[sensible default]"
    },
    "[param2]": {
      "type": "[type]",
      "enum": ["[option1]", "[option2]"],
      "default": "[default]"
    }
  },
  "required": []
}
```

#### Output Schema

```json
{
  "type": "object",
  "properties": {
    "timestamp": {
      "type": "string",
      "format": "date-time"
    },
    "[primary_result]": {
      "type": "[type]",
      "description": "[The main insight/answer]"
    },
    "confidence": {
      "type": "number",
      "minimum": 0,
      "maximum": 1
    },
    "[supporting_data]": {
      "type": "object",
      "properties": {
        "[metric1]": { "type": "[type]" },
        "[metric2]": { "type": "[type]" }
      }
    },
    "recommendation": {
      "type": "string",
      "description": "Actionable recommendation"
    }
  },
  "required": ["timestamp", "[primary_result]"]
}
```

#### Cost & Value Assessment

| Factor | Value |
|--------|-------|
| Internal API calls per invocation | [X] calls |
| Computation complexity | [Low/Medium/High] |
| Queries saved vs raw approach | [X] queries |
| Unique value | [Low/Medium/High] |

> Note: The listing has a flat response price for Query surface. Execute pricing is per method call (~1/100 of response price). See [Pricing Guidelines](#section-6-pricing-guidelines).
```

---

### 3.3 Tier 1 Tools (Fill In)

<!-- Copy the template above for each intelligence tool -->

#### Tool 1: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Tool 2: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Tool 3: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Tool 4: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Tool 5: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Tool 6: `[name]`

**Question Answered**: ""

**Intelligence Type**: [ ]

**Data Composition**:
```
```

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

### 3.4 Tier 2: Raw Data Tools Design

> **Instructions**: Select 3-7 fundamental API endpoints to expose as fallback tools.

**Selection Criteria**:
- Most commonly needed data
- Building blocks for custom analysis
- Not covered by intelligence tools
- Low complexity, direct passthrough

---

#### Raw Tool Template

```markdown
### Tool: `get_[resource]`

**Purpose**: [One-line description]

**Maps to**: `[API endpoint]`

**API calls per invocation**: 1

**Input Schema**:
```json
{
  "type": "object",
  "properties": {
    "[param]": { "type": "[type]" }
  },
  "required": ["[param]"]
}
```

**Output Schema**:
```json
{
  "type": "object",
  "properties": {
    "[field]": { "type": "[type]" }
  }
}
```
```

---

### 3.5 Tier 2 Tools (Fill In)

#### Raw Tool 1: `get_[name]`

**Purpose**: 

**Maps to**: ``

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Raw Tool 2: `get_[name]`

**Purpose**: 

**Maps to**: ``

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Raw Tool 3: `get_[name]`

**Purpose**: 

**Maps to**: ``

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Raw Tool 4: `get_[name]`

**Purpose**: 

**Maps to**: ``

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

#### Raw Tool 5: `get_[name]`

**Purpose**: 

**Maps to**: ``

**Input Schema**:
```json
{
}
```

**Output Schema**:
```json
{
}
```

---

## Section 3.6: Discovery Layer Tools (REQUIRED)

> **Instructions**: These tools enable agents to discover ALL available data, not just trending/popular items.

### Why Discovery Tools Matter

```
WITHOUT DISCOVERY TOOLS:
─────────────────────────────────────────────────────────────────────
User: "Find NBA prediction markets"
Agent: Calls discover_trending_markets({ category: "sports" })
API: Returns political events (they're trending by volume)
Agent: ❌ Cannot find NBA markets - no way to enumerate sports tags

WITH DISCOVERY TOOLS:
─────────────────────────────────────────────────────────────────────
User: "Find NBA prediction markets"
Agent: Calls get_all_tags()
API: Returns [{id: "nba", label: "NBA"}, {id: "nfl", label: "NFL"}, ...]
Agent: Calls browse_by_tag({ tag_id: "nba" })
API: Returns all NBA markets with conditionIds
Agent: ✅ Can now analyze any NBA market
```

### Discovery Tool Pattern

For EACH listing endpoint in your API, create a tool pair:

```
┌─────────────────────┐          ┌─────────────────────┐
│   List All Tool     │────ID───▶│   Browse by Tool    │
│   get_all_[type]s   │          │   browse_by_[type]  │
└─────────────────────┘          └─────────────────────┘
      Returns IDs                  Uses IDs to filter
```

### Template: List All Tool

```typescript
{
  name: "get_all_[types]",
  description: `📂 DISCOVERY: List ALL available [types] on [Platform].

Returns [type] IDs that can be used with browse_by_[type] to filter data.

DATA FLOW:
  get_all_[types] → [type]_id → browse_by_[type] → items with identifiers → analysis tools

COMPOSABILITY WITH OTHER MCPs:
  [Describe which other data sources share similar data and how to correlate]

EXAMPLE:
  "Find all [X] markets" → Call this, then browse_by_[type]({ [type]_id: "..." })`,
  
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: { type: "number", default: 50 },
    },
    required: [],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      [types]: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "[Type] ID for filtering" },
            label: { type: "string", description: "Display name" },
            slug: { type: "string", description: "URL-friendly identifier" },
          },
        },
      },
      totalCount: { type: "number" },
      fetchedAt: { type: "string", format: "date-time" },
    },
  },
}
```

### Template: Browse By Tool

```typescript
{
  name: "browse_by_[type]",
  description: `🔍 BROWSE: Get all items within a specific [type].

INPUT: [type]_id from get_all_[types]

RETURNS: Items with:
  - Identifiers (conditionId, tokenId, etc.) for use with analysis tools
  - Current data (prices, volumes, etc.)
  - URLs/links for reference

DATA FLOW:
  browse_by_[type] → identifier → [analysis tools like orderbook, trades, etc.]

CROSS-PLATFORM COMPOSABILITY:
  [Describe how results can be compared with other MCPs]`,
  
  inputSchema: {
    type: "object" as const,
    properties: {
      [type]_id: {
        type: "string",
        description: "[Type] ID from get_all_[types]",
      },
      limit: { type: "number", default: 50 },
    },
    required: ["[type]_id"],
  },
  outputSchema: {
    type: "object" as const,
    properties: {
      [type]_id: { type: "string" },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            identifier: { type: "string", description: "ID for analysis tools" },
            // ... item-specific fields
          },
        },
      },
      totalCount: { type: "number" },
      fetchedAt: { type: "string", format: "date-time" },
    },
  },
}
```

### Example: Prediction Market Discovery Tools

```typescript
// Tool 1: List all categories
{
  name: "get_all_categories",
  description: "📂 DISCOVERY: List ALL categories (Politics, Crypto, Sports, etc.)",
  // Returns: [{ id, label, slug }]
}

// Tool 2: Browse by category
{
  name: "browse_category", 
  description: "🔍 BROWSE: Get all events in a category",
  // Input: category slug
  // Returns: events with conditionIds
}

// Tool 3: List all tags
{
  name: "get_all_tags",
  description: "🏷️ DISCOVERY: List ALL tags (NBA, Bitcoin, Trump, etc.)",
  // Returns: [{ id, label, slug }]
}

// Tool 4: Browse by tag
{
  name: "browse_by_tag",
  description: "🔍 BROWSE: Get all events with a specific tag",
  // Input: tag_id
  // Returns: events with conditionIds
}
```

### Cross-Platform Composability in Descriptions

**ALWAYS** include composability hints in tool descriptions:

```typescript
description: `...

CROSS-PLATFORM COMPOSABILITY:
  This data can be combined with [OTHER_MCP] for:
  - [Use case 1]: [How to compose]
  - [Use case 2]: [How to compose]
  
Example workflow:
  1. Call this tool → get [entity] at [price/value]
  2. Call [OTHER_MCP].[tool] → get [comparable data]
  3. Compare: [what to look for]`
```

### Discovery Tools Checklist

| API Has... | You MUST Expose... |
|------------|-------------------|
| `GET /categories` | `get_all_categories` + `browse_category` |
| `GET /tags` | `get_all_tags` + `browse_by_tag` |
| `GET /types` | `get_all_types` + `browse_by_type` |
| `GET /groups` | `get_all_groups` + `browse_by_group` |
| `GET /sports` | `get_all_sports` + `browse_by_sport` |
| `GET /regions` | `get_all_regions` + `browse_by_region` |

---

## Section 4: Output Schema Patterns

> **Important**: Context Protocol requires `outputSchema` for all paid tools. Use these patterns to ensure compliance and maximize AI usability.

### Pattern 1: Always Include Timestamps

```json
{
  "timestamp": {
    "type": "string",
    "format": "date-time",
    "description": "ISO 8601 timestamp of when this data was generated"
  }
}
```

### Pattern 2: Confidence Scoring

For any tool that provides analysis or predictions:

```json
{
  "confidence": {
    "type": "number",
    "minimum": 0,
    "maximum": 1,
    "description": "Confidence score (0 = low confidence, 1 = high confidence)"
  }
}
```

### Pattern 3: Categorical Results with Enums

Use enums for categorical outputs to enable type-safe AI code generation:

```json
{
  "status": {
    "type": "string",
    "enum": ["positive", "neutral", "negative"],
    "description": "Overall status assessment"
  },
  "severity": {
    "type": "string", 
    "enum": ["low", "medium", "high", "critical"]
  }
}
```

### Pattern 4: Actionable Recommendations

Include plain-English recommendations where appropriate:

```json
{
  "recommendation": {
    "type": "string",
    "description": "Actionable recommendation based on the analysis"
  },
  "suggested_actions": {
    "type": "array",
    "items": { "type": "string" },
    "description": "List of suggested next steps"
  }
}
```

### Pattern 5: Data Source Transparency

Document what data sources were used (important for trust and debugging):

```json
{
  "data_sources": {
    "type": "array",
    "items": { "type": "string" },
    "description": "API endpoints/sources used for this analysis"
  },
  "data_freshness": {
    "type": "string",
    "enum": ["real-time", "near-real-time", "cached", "historical"],
    "description": "How fresh the underlying data is"
  }
}
```

### Pattern 6: Nested Metrics Objects

Group related metrics together:

```json
{
  "metrics": {
    "type": "object",
    "properties": {
      "primary_metric": { "type": "number" },
      "secondary_metric": { "type": "number" },
      "trend": { 
        "type": "string",
        "enum": ["increasing", "stable", "decreasing"]
      }
    }
  }
}
```

### Pattern 7: Scored/Ranked Lists

For tools that return ranked results:

```json
{
  "results": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "name": { "type": "string" },
        "score": { "type": "number" },
        "rank": { "type": "integer" },
        "details": { "type": "object" }
      }
    }
  },
  "total_count": { "type": "integer" }
}
```

### Pattern 8: Summary + Details Structure

Provide both high-level summary and detailed breakdown:

```json
{
  "summary": {
    "type": "object",
    "properties": {
      "headline": { "type": "string" },
      "overall_score": { "type": "number" },
      "key_finding": { "type": "string" }
    }
  },
  "details": {
    "type": "array",
    "items": {
      "type": "object",
      "properties": {
        "category": { "type": "string" },
        "value": { "type": "number" },
        "analysis": { "type": "string" }
      }
    }
  }
}
```

---

## Section 5: Implementation Checklist

### Phase 1: Project Setup

- [ ] Create TypeScript MCP server project
- [ ] Install dependencies:
  ```bash
  npm init -y
  npm install @modelcontextprotocol/sdk typescript
  npm install -D @types/node ts-node
  ```
- [ ] Configure TypeScript (`tsconfig.json`)
- [ ] Set up API client for your service
- [ ] Configure authentication/API keys
- [ ] Implement rate limiting/caching strategy

### Phase 2: Discovery Layer Tools (CRITICAL - Do First)

- [ ] Identify ALL listing endpoints in the API (`GET /categories`, `GET /tags`, etc.)
- [ ] For EACH listing endpoint, implement `get_all_[type]` tool
- [ ] For EACH listing endpoint, implement `browse_by_[type]` tool
- [ ] Document the data hierarchy in tool descriptions
- [ ] Add cross-platform composability hints to descriptions
- [ ] Test: Can an agent find ANY item by category/tag/type? (not just trending)
- [ ] Verify: All listing endpoints from API are exposed in MCP

### Phase 3: Tier 2 Tools (Raw Data)

- [ ] Implement raw tool 1: `get_[name]`
- [ ] Implement raw tool 2: `get_[name]`
- [ ] Implement raw tool 3: `get_[name]`
- [ ] Implement raw tool 4: `get_[name]`
- [ ] Implement raw tool 5: `get_[name]`
- [ ] Add `outputSchema` to all Tier 2 tools
- [ ] Test each tool independently
- [ ] Verify `structuredContent` is returned correctly

### Phase 4: Tier 1 Tools (Intelligence)

- [ ] Implement intelligence tool 1: `[name]`
- [ ] Implement intelligence tool 2: `[name]`
- [ ] Implement intelligence tool 3: `[name]`
- [ ] Implement intelligence tool 4: `[name]`
- [ ] Implement intelligence tool 5: `[name]`
- [ ] Implement intelligence tool 6: `[name]`
- [ ] Fine-tune algorithms and scoring thresholds
- [ ] Add `outputSchema` to all Tier 1 tools
- [ ] Validate output against schemas

### Phase 5: MCP Server Integration

- [ ] Implement MCP server with tool registration
- [ ] Configure SSE or HTTP Streaming transport
- [ ] Implement `tools/list` handler
- [ ] Implement `tools/call` handler
- [ ] Add proper error handling
- [ ] Test with MCP inspector

### Phase 6: Context Protocol Compliance, Metadata & Security

- [ ] Ensure all tools have `outputSchema`
- [ ] Ensure all responses include `structuredContent`
- [ ] **Surface metadata**: Set `_meta.surface`, `_meta.queryEligible`, and `_meta.latencyClass` per method
- [ ] **Execute pricing**: If targeting Execute surface, set `_meta.pricing.executeUsd` per method (or use default execute price in contribute form)
- [ ] **Rate limit hints**: If wrapping rate-limited APIs, add `_meta.rateLimit` per method (see [Tool Metadata](https://docs.ctxprotocol.com/guides/tool-metadata#rate-limit-hints))
- [ ] **Context Injection**: For portfolio tools, add `_meta.contextRequirements`
- [ ] **Security**: Add `createContextMiddleware()` from `@ctxprotocol/sdk`
- [ ] **Security**: Apply middleware to MCP endpoint (`app.post("/mcp", verifyContextAuth, ...)`)
- [ ] Test integration with Context Protocol

> **⚠️ Security Note**: All paid tools MUST use `createContextMiddleware()`. This verifies JWT signatures from the Context platform, ensuring you only execute paid requests. Without it, anyone could curl your endpoint directly.

> **⚠️ Execute Visibility Note**: Methods without `_meta.pricing.executeUsd` are query-only and invisible on the Execute surface. Set execute pricing to unlock SDK-level revenue.

### Phase 7: Deployment & Listing

- [ ] Deploy MCP server (Vercel, Railway, etc.)
- [ ] Register server on Context marketplace
- [ ] Set tool pricing
- [ ] Write tool descriptions for discovery
- [ ] Create usage examples

---

## Section 6: Pricing Guidelines

### Context Protocol Dual-Surface Pricing Model

> **Important**: Context runs **one marketplace with two surfaces**. Your listing has a **response price** (Query surface) and optional **per-method execute pricing** (Execute surface). Both are set at listing time.

```
┌─────────────────────────────────────────────────────────────────┐
│                   DUAL-SURFACE PRICING MODEL                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   QUERY SURFACE (Context is the librarian)                     │
│   ─────────────────────────────────────────────────            │
│   Used via:  Context app OR client.query.run() in SDK          │
│   Pays:      $X once per response turn                         │
│   Gets:      AI-synthesized curated answer                     │
│   Platform:  Makes up to 100 MCP calls per turn internally     │
│   Example:   $0.10/response for premium intelligence           │
│                                                                 │
│   EXECUTE SURFACE (Your app/agent is the librarian)            │
│   ─────────────────────────────────────────────────            │
│   Used via:  client.tools.execute() in SDK                     │
│   Pays:      $Y per method call (session-budgeted)             │
│   Gets:      Raw structured data, spend envelope visibility    │
│   Session:   Deferred batch settlement                         │
│   Example:   $0.001/call for normalized market data            │
│                                                                 │
│   ⚠️  EXECUTE GATING RULE:                                     │
│   Methods WITHOUT _meta.pricing.executeUsd are INVISIBLE       │
│   on the Execute surface. Query-only until explicitly priced.  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Which Surface Are You Building For?

| Building for... | Your methods are... | Set `_meta.pricing.executeUsd`? |
|-----------------|---------------------|---------------------------------|
| **Query only** (curated intelligence for the Context app) | Answer-safe, synthesized | Optional (not required) |
| **Execute only** (raw/normalized data for SDK consumers) | Structured, agent-friendly | **Required** (or invisible to SDK) |
| **Both surfaces** (mixed listing) | Some curated, some raw | **Required** on execute-eligible methods |

### Pricing Ratio Guidance

Execute pricing should be **~1/100 of your listing response price**. A Query response bundles up to 100 method calls into one flat fee. When developers pay per-call, the per-call price must be proportionally lower.

| Listing Response Price (Query) | Execute Price Per Method | Ratio |
|-------------------------------|------------------------|-------|
| $0.01 | $0.0001 | 1/100 |
| $0.05 | $0.0005 | 1/100 |
| $0.10 | $0.001 | 1/100 |
| $0.25 | $0.0025 | 1/100 |

> The ~1/100 ratio is guidance, not a protocol-enforced rule. Adjust based on your API costs and value proposition.

### What This Means for Tool Design

| Surface | Approach | User Experience | Value Delivered |
|---------|----------|-----------------|-----------------|
| **Query** | Giga-brained tools | 1-3 calls = complete insight | High value per response |
| **Execute** | Normalized data tools | Agent iterates over structured data | Raw data, agent composes |
| **Both** | Mixed methods | Best of both worlds | Intelligence + raw access |

**Key Insight for Query**: Giga-brained tools deliver MORE value per response, making the user's flat fee go further.

**Key Insight for Execute**: Normalized, well-structured data (e.g., cross-exchange price feeds with consistent schemas) is extremely valuable for SDK consumers even if it's "raw" — the value is in the normalization and reliability.

### Setting Execute Pricing

**Simple path (recommended):** Set one default execute price in the marketplace contribute form. It fans out to every method's `_meta.pricing.executeUsd` automatically.

**Advanced path:** Set `_meta.pricing.executeUsd` per method in your MCP server code. Method-level values take precedence over the default.

```typescript
const TOOLS = [{
  name: "get_market_data",
  description: "Normalized cross-exchange market data",
  _meta: {
    surface: "both",
    queryEligible: true,
    latencyClass: "instant",
    pricing: {
      executeUsd: "0.001",  // Execute surface price per call
    },
  },
  inputSchema: { /* ... */ },
  outputSchema: { /* ... */ },
}];
```

### Pricing Factors

| Factor | Consider |
|--------|----------|
| **API costs** | Your upstream cost per call (for execute) or per ~100 calls (for query response) |
| **Compute costs** | Processing/intelligence computation |
| **Unique value** | Can users get this elsewhere? |
| **Surface mix** | Are you targeting Query users, Execute developers, or both? |

### Pricing Matrix

| MCP Server Type | Listing Response Price (Query) | Execute Price Per Method |
|-----------------|-------------------------------|------------------------|
| Basic utility | $0.01-0.02 | $0.0001-0.0002 |
| Multi-source aggregator | $0.02-0.05 | $0.0002-0.0005 |
| Intelligence platform | $0.05-0.10 | $0.0005-0.001 |
| Premium insights | $0.10-0.25 | $0.001-0.0025 |

### Pricing Strategy

1. **Set a listing response price** for the Query surface (flat fee per curated response)
2. **Optionally enable Execute pricing** to make your methods available to SDK consumers
3. **Use the ~1/100 ratio** as a starting point for execute vs response pricing
4. **Giga-brained intelligence tools** maximize Query value; **normalized raw data tools** maximize Execute value
5. **Mixed listings** let you serve both audiences from one MCP server

### Reference Implementation

See the [Coinglass contributor server](https://github.com/ctxprotocol/sdk/tree/main/examples/server/coinglass-contributor) for a production example with:
- Default execute price (`$0.001`) applied to all methods via `_meta.pricing.executeUsd`
- Explicit opt-out for query-only methods (`UNPRICED_EXECUTE_METHODS`)
- Per-method `_meta.rateLimit` hints derived from upstream API tier constraints

---

## Section 7: Algorithm Templates

### Template: Scoring Algorithm

```typescript
interface ScoreWeights {
  [factor: string]: number; // Weights should sum to 1.0
}

function calculateScore(
  factors: Record<string, number>,
  weights: ScoreWeights
): number {
  let score = 0;
  for (const [factor, value] of Object.entries(factors)) {
    score += value * (weights[factor] || 0);
  }
  return Math.max(0, Math.min(1, score)); // Clamp to 0-1
}

// Example usage:
const weights: ScoreWeights = {
  factor_a: 0.3,
  factor_b: 0.25,
  factor_c: 0.25,
  factor_d: 0.2,
};

const score = calculateScore({
  factor_a: 0.8,  // normalized 0-1
  factor_b: 0.6,
  factor_c: 0.9,
  factor_d: 0.4,
}, weights);
```

### Template: Anomaly Detection

```typescript
interface TimeSeriesPoint {
  timestamp: number;
  value: number;
}

function detectAnomalies(
  data: TimeSeriesPoint[],
  sigmaThreshold: number = 2
): TimeSeriesPoint[] {
  const values = data.map(d => d.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stdDev = Math.sqrt(
    values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length
  );
  
  return data.filter(point => 
    Math.abs(point.value - mean) > sigmaThreshold * stdDev
  );
}
```

### Template: Trend Detection

```typescript
type Trend = 'increasing' | 'decreasing' | 'stable';

function detectTrend(
  values: number[],
  threshold: number = 0.05
): Trend {
  if (values.length < 2) return 'stable';
  
  const first = values.slice(0, Math.floor(values.length / 2));
  const second = values.slice(Math.floor(values.length / 2));
  
  const firstAvg = first.reduce((a, b) => a + b, 0) / first.length;
  const secondAvg = second.reduce((a, b) => a + b, 0) / second.length;
  
  const changePercent = (secondAvg - firstAvg) / firstAvg;
  
  if (changePercent > threshold) return 'increasing';
  if (changePercent < -threshold) return 'decreasing';
  return 'stable';
}
```

### Template: Categorical Classification

```typescript
type Category = 'very_low' | 'low' | 'medium' | 'high' | 'very_high';

function classifyValue(
  value: number,
  thresholds: { veryLow: number; low: number; high: number; veryHigh: number }
): Category {
  if (value <= thresholds.veryLow) return 'very_low';
  if (value <= thresholds.low) return 'low';
  if (value >= thresholds.veryHigh) return 'very_high';
  if (value >= thresholds.high) return 'high';
  return 'medium';
}
```

---

## Section 8: MCP Server Boilerplate

### HTTP MCP Server with Security Middleware

This is the recommended pattern for Context Protocol deployment. It includes:
- `createContextMiddleware()` for JWT verification (required for paid tools)
- Streamable HTTP transport for web deployment
- `_meta.contextRequirements` for portfolio injection tools

```typescript
import "dotenv/config";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";

// ⭐ Import security middleware from Context SDK
import { createContextMiddleware } from "@ctxprotocol/sdk";

// Define your tools
const TOOLS = [
  {
    name: "your_tool_name",
    description: "What this tool does",
    inputSchema: {
      type: "object" as const,
      properties: {
        param1: {
          type: "string",
          description: "Parameter description",
        },
      },
      required: ["param1"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        result: { type: "string" },
        timestamp: { type: "string", format: "date-time" },
      },
      required: ["result", "timestamp"],
    },
  },
  
  // Example: Tool with portfolio injection (optional)
  {
    name: "analyze_my_portfolio",
    description: "Analyze user portfolio with personalized insights",
    
    // ⭐ Declare context requirements for portfolio injection
    _meta: {
      contextRequirements: ["hyperliquid"], // or "polymarket", "wallet"
    },
    
    inputSchema: {
      type: "object" as const,
      properties: {
        portfolio: {
          type: "object",
          description: "Portfolio context (injected by platform)",
        },
      },
      required: ["portfolio"],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        analysis: { type: "string" },
        riskScore: { type: "number" },
        timestamp: { type: "string", format: "date-time" },
      },
      required: ["analysis", "riskScore", "timestamp"],
    },
  },
];

// Create MCP server
const server = new Server(
  { name: "your-mcp-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Handle list tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "your_tool_name": {
      const result = await yourToolImplementation(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result, // Required for Context Protocol
      };
    }
    case "analyze_my_portfolio": {
      // Portfolio data is automatically injected by the platform
      const portfolio = args?.portfolio;
      const result = await analyzePortfolio(portfolio);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Tool implementations
async function yourToolImplementation(args: any) {
  return {
    result: "your result",
    timestamp: new Date().toISOString(),
  };
}

async function analyzePortfolio(portfolio: any) {
  // Portfolio contains user data injected by the platform
  return {
    analysis: `Found ${portfolio?.positions?.length || 0} positions`,
    riskScore: 0.5,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================================
// EXPRESS SERVER WITH SECURITY MIDDLEWARE
// ============================================================================

const app = express();
app.use(express.json());

// ⭐ Create security middleware (verifies JWT from Context platform)
const verifyContextAuth = createContextMiddleware();

// Health check (no auth required)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "your-mcp-server", version: "1.0.0" });
});

// Session management
const transports: Map<string, StreamableHTTPServerTransport> = new Map();

// ⭐ MCP endpoint with security middleware applied
app.post("/mcp", verifyContextAuth, async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId)!;
  } else if (!sessionId && isInitializeRequest(req.body)) {
    const newSessionId = randomUUID();
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => newSessionId,
      onsessioninitialized: (id) => transports.set(id, transport),
    });
    await server.connect(transport);
  } else {
    res.status(400).json({ error: "Bad Request: No valid session" });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

// Handle SSE for streaming (GET requests)
app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "No transport found for session" });
    return;
  }
  await transport.handleRequest(req, res);
});

// Start server
const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`MCP server running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
```

### Why Security Middleware Matters

| Tool Type | Security Required | What Happens Without It |
|-----------|-------------------|-------------------------|
| **Free ($0.00)** | Optional | Works, but anyone can call your API |
| **Paid ($0.01+)** | **Mandatory** | Context cannot route payments without verification |

The `createContextMiddleware()` verifies that requests come from the Context platform with a valid JWT signature. This is like verifying Stripe webhooks—without it, anyone could curl your endpoint and get free access.

### Alternative: Manual Verification

For more control, use the lower-level utilities:

```typescript
import { 
  verifyContextRequest, 
  isProtectedMcpMethod,
} from "@ctxprotocol/sdk";

// In your request handler:
if (isProtectedMcpMethod(req.body.method)) {
  const payload = await verifyContextRequest({
    authorizationHeader: req.headers.authorization,
  });
  // payload contains verified JWT claims
}
```

---

## Appendix: Notes & Decisions

> **Instructions**: Use this section to document implementation decisions, algorithm tuning, and lessons learned.

### Algorithm Tuning Notes

```
<!-- Document threshold values, weight adjustments, etc. -->
```

### API Quirks & Workarounds

```
<!-- Document any API-specific issues and how you handled them -->
```

### Performance Optimizations

```
<!-- Document caching strategies, batching, etc. -->
```

### Version History

| Version | Date | Changes |
|---------|------|---------|
| 0.1.0 | YYYY-MM-DD | Initial design |

---

## Checklist Before Submission

### Schema & Response Requirements
- [ ] All tools have `inputSchema` defined
- [ ] All tools have `outputSchema` defined
- [ ] All tool responses include `structuredContent`

### 🎯 Surface & Pricing Metadata (CRITICAL)
- [ ] Target surface decided (Query / Execute / Both)
- [ ] Listing response price set for Query surface
- [ ] If targeting Execute: `_meta.pricing.executeUsd` set per method (or default execute price in contribute form)
- [ ] `_meta.surface` set per method (`"answer"`, `"execute"`, or `"both"`)
- [ ] `_meta.queryEligible` set per method
- [ ] `_meta.latencyClass` set per method (`"instant"`, `"fast"`, `"slow"`, or `"streaming"`)
- [ ] If wrapping rate-limited APIs: `_meta.rateLimit` hints published per method

### 🔍 Discovery Layer Completeness (CRITICAL)
- [ ] ALL listing endpoints from API are exposed (`get_all_categories`, `get_all_tags`, etc.)
- [ ] ALL listing tools have corresponding browse tools (`browse_category`, `browse_by_tag`, etc.)
- [ ] Data hierarchy is documented in tool descriptions
- [ ] Cross-platform composability hints are included in descriptions
- [ ] An agent can find ANY item by category/tag/type (not just trending items)
- [ ] No "trending only" gaps exist in the MCP

### Security (Required for Paid Tools)
- [ ] `createContextMiddleware()` imported from `@ctxprotocol/sdk`
- [ ] Middleware applied to MCP endpoint
- [ ] Portfolio tools declare `_meta.contextRequirements` if needed

### Deployment
- [ ] Listing response price set for Query surface
- [ ] Execute pricing configured (if targeting Execute surface)
- [ ] Tool descriptions are clear and discoverable
- [ ] Error handling is implemented
- [ ] Rate limiting is handled
- [ ] Server is deployed and accessible
- [ ] `/health` endpoint returns server info

### Deployment Infrastructure (Context Protocol Servers)
- [ ] Server directory added to `examples/server/deploy.sh`
- [ ] Server entry added to `examples/server/setup-servers.sh`
- [ ] HTTPS route added to `examples/server/setup-caddy-https.sh`

---

## Appendix B: Deployment Infrastructure Updates

> **Instructions**: When adding a new MCP server to the Context Protocol infrastructure, update these three files.

### File 1: `examples/server/deploy.sh`

Add your server to the `PROJECTS` array:

```bash
# Find this line:
PROJECTS=("blocknative-contributor" "hyperliquid-contributor" "polymarket-contributor" "exa-contributor" "coinglass-contributor" "odds-api-contributor")

# Add your new server:
PROJECTS=("blocknative-contributor" "hyperliquid-contributor" "polymarket-contributor" "exa-contributor" "coinglass-contributor" "odds-api-contributor" "YOUR-NEW-SERVER-contributor")
```

### File 2: `examples/server/setup-servers.sh`

Add your server to the `SERVERS` array with a unique port:

```bash
# Find this section:
SERVERS=(
  "mcp-blocknative:blocknative-contributor:4001"
  "mcp-hyperliquid:hyperliquid-contributor:4002"
  "mcp-polymarket:polymarket-contributor:4003"
  "mcp-exa:exa-contributor:4004"
  "mcp-coinglass:coinglass-contributor:4005"
  "mcp-odds-api:odds-api-contributor:4006"
)

# Add your new server with the next available port:
SERVERS=(
  "mcp-blocknative:blocknative-contributor:4001"
  "mcp-hyperliquid:hyperliquid-contributor:4002"
  "mcp-polymarket:polymarket-contributor:4003"
  "mcp-exa:exa-contributor:4004"
  "mcp-coinglass:coinglass-contributor:4005"
  "mcp-odds-api:odds-api-contributor:4006"
  "mcp-YOUR-NEW-SERVER:YOUR-NEW-SERVER-contributor:4007"  # <-- NEW
)
```

Format: `"pm2-name:directory-name:port"`

### File 3: `examples/server/setup-caddy-https.sh`

**Step 1**: Add port variable in the configuration section:

```bash
# Find the port configuration section:
BLOCKNATIVE_PORT=4001
HYPERLIQUID_PORT=4002
POLYMARKET_PORT=4003
EXA_PORT=4004
COINGLASS_PORT=4005
ODDS_API_PORT=4006

# Add your new server port:
YOUR_NEW_SERVER_PORT=4007  # <-- NEW
```

**Step 2**: Add the route handler in the Caddyfile section (inside the heredoc):

```bash
# Find the last handle block before the fallback, add your new server:

    # YOUR NEW SERVER MCP Server (port ${YOUR_NEW_SERVER_PORT})
    # [Brief description of what your server does]
    # Supports: /mcp (HTTP streaming), /health
    handle /your-new-server/* {
        uri strip_prefix /your-new-server
        reverse_proxy localhost:${YOUR_NEW_SERVER_PORT} {
            # Critical for MCP streaming
            flush_interval -1
            transport http {
                read_timeout 0
            }
        }
    }

    # Fallback - return 404 for unknown paths
    handle {
        respond "Not Found" 404
    }
```

**Step 3**: Add firewall rule (if `CLOSE_RAW_PORTS="yes"`):

```bash
# Find the firewall section, add:
ufw deny ${YOUR_NEW_SERVER_PORT}/tcp
```

**Step 4**: Update the summary section to include your new endpoints:

```bash
# In the "Your new HTTPS endpoints:" section:
echo "  Your New Server: https://${DOMAIN}/your-new-server/mcp"

# In the "Health checks:" section:
echo "  Your New Server: https://${DOMAIN}/your-new-server/health"
```

### Deployment Checklist

After updating the scripts:

```bash
# 1. Deploy files to server
./examples/server/deploy.sh

# 2. SSH into the server
ssh ubuntu@62.72.22.174

# 3. Create .env file for new server
cd ~/mcp-servers/YOUR-NEW-SERVER-contributor
cp env.example .env
nano .env  # Add your API keys

# 4. Run setup script to install and start all servers
cd ~/mcp-servers
./setup-servers.sh

# 5. Update Caddy configuration for HTTPS
sudo ./setup-caddy-https.sh

# 6. Verify health check
curl https://mcp.ctxprotocol.com/your-new-server/health
```

### Port Allocation

| Port | Server | Status |
|------|--------|--------|
| 4001 | Blocknative | ✅ In use |
| 4002 | Hyperliquid | ✅ In use |
| 4003 | Polymarket | ✅ In use |
| 4004 | Exa | ✅ In use |
| 4005 | Coinglass | ✅ In use |
| 4006 | Odds API | ✅ In use |
| 4007 | [Available] | 🟢 Next |
| 4008 | [Available] | 🟢 |
| 4009 | [Available] | 🟢 |
| 4010 | [Available] | 🟢 |

