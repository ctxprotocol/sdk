# Exa AI MCP Server

A proxy server that exposes Exa's official hosted MCP server via your own endpoint.

> 🔒 **Security**: This server is secured with Context Protocol Request Signing. Requests must come from the Context Platform or a client with a valid signing key.

## What is Exa?

Exa is an AI-powered search engine that provides:
- **Web Search**: Real-time web searches with optimized results
- **Code Search**: Find code snippets, documentation, and examples from GitHub, docs, and StackOverflow
- **Deep Search**: Smart query expansion with high-quality summaries
- **Company Research**: Comprehensive company information
- **LinkedIn Search**: Search for companies and people on LinkedIn

## How This Works

This server proxies requests to Exa's official hosted MCP at `https://mcp.exa.ai/mcp`:

1. Receives MCP requests at `/mcp`
2. Forwards them to Exa's hosted MCP with your API key
3. Preserves the streamable MCP headers and normalizes search responses when Exa returns text-only payloads

This approach:
- Uses Exa's official HTTP streaming endpoint
- Always up-to-date with Exa's latest features
- Consistent `/mcp` endpoint like other MCP servers
- Keeps legacy callers working while surfacing `web_search_advanced_exa` for richer structured search

## Setup

```bash
cd examples/server/exa-contributor
cp env.example .env      # add your EXA_API_KEY from https://dashboard.exa.ai/api-keys
pnpm install
pnpm run dev
```

Server runs on `http://localhost:4004`.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `4004` |
| `EXA_API_KEY` | Your Exa API key (required) | - |
| `EXA_TOOLS` | Comma-separated list of tools to enable | `web_search_exa,web_search_advanced_exa,get_code_context_exa,crawling_exa` |

### Available Tools

| Tool | Description |
|------|-------------|
| `web_search_exa` | Real-time web searches with optimized results |
| `web_search_advanced_exa` | Structured search with richer filters and JSON-style results |
| `get_code_context_exa` | Search code snippets, docs, and examples |
| `deep_search_exa` | Deep web search with smart query expansion |
| `crawling_exa` | Extract content from specific URLs |
| `company_research_exa` | Comprehensive company research |
| `linkedin_search_exa` | Search LinkedIn for companies and people |
| `people_search_exa` | Current people-search surface when enabled upstream |
| `deep_researcher_start` | Start a deep AI research task |
| `deep_researcher_check` | Check research task status |

### Notes

- If a legacy config still includes `deep_search_exa`, the proxy also enables `web_search_advanced_exa`.
- Rich `web_search_exa` calls that include filters like `category`, `freshness`, or `numResults` are upgraded to `web_search_advanced_exa` upstream.
- Text-only Exa search results are normalized into `structuredContent.results` so downstream callers can consume them as data instead of raw prose.

## Endpoints

- **MCP**: `http://localhost:4004/mcp` - MCP streaming endpoint
- **Health**: `http://localhost:4004/health` - Status check

## Testing

```bash
# Health check
curl http://localhost:4004/health

# Test MCP endpoint
curl -X POST http://localhost:4004/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

## Get Your API Key

1. Go to [Exa Dashboard](https://dashboard.exa.ai/api-keys)
2. Create an account or sign in
3. Generate an API key
4. Add it to your `.env` file

## License

MIT


