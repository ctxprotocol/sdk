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
- Generate MCP server boilerplate
- Implement each tool
- Test and validate schemas
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
| **Server Price** | `$[X.XX]` (100 queries included) |

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

**What would users pay $0.01-0.05 per query for?**

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

### 2.4 Competitive Analysis

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
│                    💰 SERVER PRICE: $X.XX (100 queries included)            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    TIER 1: INTELLIGENCE LAYER                         │  │
│  │                  (Primary Product — High Value Per Call)              │  │
│  │                                                                       │  │
│  │  These tools SYNTHESIZE multiple data sources into actionable        │  │
│  │  insights. They encode domain expertise and answer complex           │  │
│  │  questions that raw API calls cannot.                                │  │
│  │                                                                       │  │
│  │  Why this matters with 100-query budget:                             │  │
│  │  → 1 intelligence call = complete answer                             │  │
│  │  → User gets MORE value from their 100 queries                       │  │
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
│  │                   (Fallback — For Agent Composition)                  │  │
│  │                                                                       │  │
│  │  These tools provide direct API access for edge cases where          │  │
│  │  intelligence tools don't cover the use case. The AI agent           │  │
│  │  can compose these for custom analysis.                              │  │
│  │                                                                       │  │
│  │  Trade-off: Uses more of the 100-query budget per answer             │  │
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

> Note: Individual tools don't have prices. The MCP server has ONE price for 100 queries total.
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

### Phase 2: Tier 2 Tools (Raw Data)

- [ ] Implement raw tool 1: `get_[name]`
- [ ] Implement raw tool 2: `get_[name]`
- [ ] Implement raw tool 3: `get_[name]`
- [ ] Implement raw tool 4: `get_[name]`
- [ ] Implement raw tool 5: `get_[name]`
- [ ] Add `outputSchema` to all Tier 2 tools
- [ ] Test each tool independently
- [ ] Verify `structuredContent` is returned correctly

### Phase 3: Tier 1 Tools (Intelligence)

- [ ] Implement intelligence tool 1: `[name]`
- [ ] Implement intelligence tool 2: `[name]`
- [ ] Implement intelligence tool 3: `[name]`
- [ ] Implement intelligence tool 4: `[name]`
- [ ] Implement intelligence tool 5: `[name]`
- [ ] Implement intelligence tool 6: `[name]`
- [ ] Fine-tune algorithms and scoring thresholds
- [ ] Add `outputSchema` to all Tier 1 tools
- [ ] Validate output against schemas

### Phase 4: MCP Server Integration

- [ ] Implement MCP server with tool registration
- [ ] Configure SSE or HTTP Streaming transport
- [ ] Implement `tools/list` handler
- [ ] Implement `tools/call` handler
- [ ] Add proper error handling
- [ ] Test with MCP inspector

### Phase 5: Context Protocol Compliance & Security

- [ ] Ensure all tools have `outputSchema`
- [ ] Ensure all responses include `structuredContent`
- [ ] **Security**: Add `createContextMiddleware()` from `@ctxprotocol/sdk`
- [ ] **Security**: Apply middleware to MCP endpoint (`app.post("/mcp", verifyContextAuth, ...)`)
- [ ] **Context Injection**: For portfolio tools, add `_meta.contextRequirements` 
- [ ] Test integration with Context Protocol

> **⚠️ Security Note**: All paid tools MUST use `createContextMiddleware()`. This verifies JWT signatures from the Context platform, ensuring you only execute paid requests. Without it, anyone could curl your endpoint directly.

### Phase 6: Deployment & Listing

- [ ] Deploy MCP server (Vercel, Railway, etc.)
- [ ] Register server on Context marketplace
- [ ] Set tool pricing
- [ ] Write tool descriptions for discovery
- [ ] Create usage examples

---

## Section 6: Pricing Guidelines

### Context Protocol Pricing Model

> **Important**: Context Protocol uses a **per-MCP-server** pricing model, NOT per-tool pricing.

```
┌─────────────────────────────────────────────────────────────────┐
│                     PRICING MODEL                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│   User pays: $X (once per turn)                                │
│              ↓                                                  │
│   User gets: 100 queries to ANY tool on your MCP server        │
│                                                                 │
│   Example:                                                      │
│   - MCP Server Price: $0.05                                    │
│   - Tools available: 10 tools (6 intelligence + 4 raw)         │
│   - User can call: any combination up to 100 total calls       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### What This Means for Tool Design

Since users get 100 queries per payment, the value proposition shifts:

| Approach | User Experience | Value Delivered |
|----------|-----------------|-----------------|
| **Giga-brained tools** | 1-3 calls = complete insight | High value per call |
| **Raw endpoint tools** | 10-20 calls to compose answer | Agent does the work |

**Key Insight**: Giga-brained tools deliver MORE value per call, making the 100-query budget go further.

### Pricing Factors

| Factor | Consider |
|--------|----------|
| **API costs** | Your cost to serve 100 queries to external APIs |
| **Compute costs** | Processing/intelligence computation |
| **Unique value** | Can users get this elsewhere? |
| **Target market** | What will your users pay? |

### Pricing Matrix

| MCP Server Type | Description | Suggested Price |
|-----------------|-------------|-----------------|
| Basic utility | Simple wrappers, single data source | $0.01-0.02 |
| Multi-source aggregator | Combines 2-3 APIs | $0.02-0.05 |
| Intelligence platform | Giga-brained analysis tools | $0.05-0.10 |
| Premium insights | Unique, high-value alpha | $0.10-0.25 |

### Pricing Strategy

1. **Price the SERVER, not individual tools** - All tools share one price
2. **Consider the 100-query budget** - What can users accomplish with 100 calls?
3. **Giga-brained = better value** - Users need fewer calls to get answers
4. **Calculate your costs** - API calls × 100 queries = your floor price

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

### Security (Required for Paid Tools)
- [ ] `createContextMiddleware()` imported from `@ctxprotocol/sdk`
- [ ] Middleware applied to MCP endpoint
- [ ] Portfolio tools declare `_meta.contextRequirements` if needed

### Deployment
- [ ] Pricing is set for the MCP server
- [ ] Tool descriptions are clear and discoverable
- [ ] Error handling is implemented
- [ ] Rate limiting is handled
- [ ] Server is deployed and accessible
- [ ] `/health` endpoint returns server info

