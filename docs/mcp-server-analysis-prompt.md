# MCP Server Analysis Prompt

> **Purpose**: Use this prompt to analyze any MCP server implementation and generate the perfect submission details for the Context Marketplace contribution form.

---

## Instructions for AI

When I provide you with an MCP server implementation (code files, README, or repository URL), analyze it and generate all the fields needed for the Context Marketplace submission form.

### Required Output Format

Generate a JSON object with the following fields, followed by a markdown explanation:

```json
{
  "name": "<Tool name - concise, memorable, max 255 chars>",
  "description": "<Rich description - max 5000 chars, see format below>",
  "category": "<One of the allowed categories>",
  "price": "<Price per query in USDC, 0.00 to 100.00, max 4 decimals>",
  "endpoint": "<The MCP endpoint URL>"
}
```

---

## Field Requirements

### 1. Name (required, max 255 chars)

- **Format**: `[Provider/Protocol] [Function]`
- **Examples**: 
  - `Blocknative Gas` 
  - `Polymarket Intelligence`
  - `CoinGecko Prices`
  - `Hyperliquid Trading`
- **Guidelines**:
  - Keep it short and memorable
  - Include the data source or protocol name
  - Describe the primary function
  - Avoid generic names like "Crypto Tool" or "DeFi Helper"

### 2. Description (required, max 5000 chars)

**Use this exact structure:**

```markdown
[One-line summary of what the tool does and its key value proposition.]

Features:
- [Key feature 1 with specific details]
- [Key feature 2 with specific details]
- [Key feature 3 with specific details]
- [Additional features as needed]

Agent tips:
- [Best practice for using this tool]
- [Common workflow or call sequence]
- [Any important parameters or considerations]
```

**Example:**
```markdown
Real-time gas prices for 50+ EVM chains including Ethereum, Base, Arbitrum, and Optimism.

Features:
- Gas estimates at multiple confidence levels (70-99%)
- EIP-1559 support (maxFeePerGas, maxPriorityFeePerGas)
- Estimated confirmation times in seconds
- Support for legacy and type-2 transactions

Agent tips:
- Call list_chains first to get all supported chainIds
- Gas prices returned in Gwei with confidence levels
- Use 99% confidence for time-sensitive transactions
```

### 3. Category (required, select one)

Choose the most appropriate category:

| Category | Description | Use When |
|----------|-------------|----------|
| `Network` | Gas, RPC, Nodes | Tool provides blockchain infrastructure data |
| `Actions` | Swaps, Lending, Execution | Tool performs on-chain actions or trading |
| `Market Data` | Crypto, Stocks, Forex | Tool provides price feeds, market analysis |
| `Real World` | Weather, Sports, News | Tool provides off-chain real-world data |
| `Social` | Identity, Governance | Tool handles social graphs, DAOs, identity |
| `Utility` | Search, Compute | General-purpose tools, computation |
| `Other` | Anything else | Only if nothing else fits |

### 4. Price (required, 0.00 to 100.00 USDC)

**Pricing Guidelines:**

| Tool Type | Suggested Price | Reasoning |
|-----------|-----------------|-----------|
| Free/promotional tools | `0.00` | Building user base, simple queries |
| Basic data queries | `0.001` - `0.01` | Low-cost, high-volume usage |
| Premium real-time data | `0.01` - `0.10` | Valuable, time-sensitive data |
| Complex analysis | `0.10` - `1.00` | Computational overhead, unique insights |
| Execution/trading tools | `0.50` - `5.00` | High-value actions, liability |
| Enterprise/rare data | `5.00` - `100.00` | Exclusive access, significant value |

**Notes:**
- Users pay **once per chat turn** (not per tool call within a turn)
- Max 4 decimal places (e.g., `0.0001`)
- Consider competitive pricing vs. similar tools

### 5. Endpoint (required, valid URL)

**Supported Transports:**

| Transport | Endpoint Format | Example |
|-----------|-----------------|---------|
| HTTP Streaming | `/mcp` | `https://api.example.com/mcp` |
| SSE (Server-Sent Events) | `/sse` | `https://api.example.com/sse` |

**Requirements:**
- Must be publicly accessible HTTPS URL
- Must implement MCP protocol correctly
- Must respond to `listTools()` for skill auto-discovery
- Should implement proper error handling

---

## Analysis Checklist

When analyzing an MCP server, extract:

### From the Code

1. **Tools/Skills Exposed**
   - List all tools from the `listTools()` implementation
   - Document input schemas for each tool
   - Note any `outputSchema` definitions (required for disputes)

2. **Data Sources**
   - What APIs or data sources does it connect to?
   - Are there rate limits or API keys required?
   - What's the data freshness/latency?

3. **Unique Value**
   - What makes this tool different from alternatives?
   - What specific problems does it solve?
   - Who is the target user (traders, researchers, developers)?

### From README/Documentation

1. **Setup Requirements**
   - Environment variables needed
   - External dependencies
   - Deployment instructions

2. **Usage Examples**
   - Example queries and responses
   - Common workflows
   - Edge cases and limitations

---

## Output Template

After analysis, provide:

```markdown
## Tool Submission Details

### Form Fields

**Name:** [Your suggested name]

**Description:**
```
[Full description using the format above]
```

**Category:** [Selected category]

**Price:** $[X.XX] USDC per query

**Endpoint:** [URL or placeholder if unknown]

### Rationale

**Why this name:** [Explanation]

**Why this category:** [Explanation]

**Why this price:** [Justification based on value and market]

### Discovered Skills

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| [tool_1] | [what it does] | [important params] |
| [tool_2] | [what it does] | [important params] |

### Notes for Developer

- [Any setup considerations]
- [Potential improvements]
- [Compliance with Data Broker Standard]
```

---

## Example Analysis Request

```
Please analyze this MCP server and generate submission details:

[Paste code, link to repo, or describe the server]
```

---

## Data Broker Standard Compliance

Remind developers about these requirements:

1. **outputSchema Required**: Tools MUST define `outputSchema` in their tool definitions for dispute resolution
2. **Deterministic Outputs**: Given the same inputs, tools should return consistent outputs
3. **Error Handling**: Return proper MCP error responses, not silent failures
4. **Documentation**: Include example inputs/outputs in tool descriptions

Reference: https://github.com/ctxprotocol/context#-the-data-broker-standard

---

## Quick Copy Template

For fast submissions, copy this template:

```json
{
  "name": "",
  "description": "",
  "category": "",
  "price": "0.00",
  "endpoint": ""
}
```

---

*Generated for Context Protocol SDK - https://github.com/ctxprotocol/sdk*
