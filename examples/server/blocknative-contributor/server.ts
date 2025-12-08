/**
 * Blocknative Gas MCP Server
 *
 * A standard MCP server built with @modelcontextprotocol/sdk.
 * Demonstrates how to build a Context Protocol compliant server with:
 * - outputSchema (Context Protocol extension for typed responses)
 * - structuredContent (machine-readable response data)
 */

import "dotenv/config";
import express, { type Request, type Response } from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";

const BLOCKNATIVE_BASE_URL = "https://api.blocknative.com";

// ============================================================================
// TOOL DEFINITIONS
//
// Standard MCP tool definitions with:
// - inputSchema: JSON Schema for tool arguments (MCP standard)
// - outputSchema: JSON Schema for response data (Context Protocol extension)
//
// The outputSchema is used by:
// 1. AI agents to generate type-safe code
// 2. Context's dispute resolution system to validate responses
// ============================================================================

const TOOLS = [
  {
    name: "get_gas_price",
    description:
      "Get current gas price estimates for a specific EVM chain. Returns estimates at different confidence levels with maxFeePerGas, maxPriorityFeePerGas, and estimated confirmation times.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "number",
          description:
            "The chain ID (e.g., 1 for Ethereum Mainnet, 8453 for Base, 137 for Polygon). Defaults to 8453 (Base) if not specified.",
        },
        confidence: {
          type: "number",
          description:
            "Confidence level from 1-99 for gas price estimate. Higher values mean more likely to be included but potentially higher cost.",
          minimum: 1,
          maximum: 99,
        },
      },
    },
    // Context Protocol extension: outputSchema defines the response structure
    outputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "number",
          description: "The chain ID for the gas price estimates",
        },
        estimates: {
          type: "array",
          description:
            "Gas price estimates at different confidence levels. Array always contains 5 estimates sorted by confidence (highest first). To find cheapest gas, use the LAST item (lowest confidence = lowest price).",
          items: {
            type: "object",
            properties: {
              confidence: {
                type: "number",
                description:
                  "Confidence level that transaction will be included. API returns exactly these values: 99, 95, 90, 80, 70.",
              },
              maxFeePerGas: {
                type: "number",
                description: "Max fee per gas in Gwei.",
              },
              maxPriorityFeePerGas: {
                type: "number",
                description: "Max priority fee per gas in Gwei",
              },
              estimatedSeconds: {
                type: "number",
                description: "Estimated time to confirmation in seconds",
              },
            },
          },
        },
        fetchedAt: {
          type: "string",
          description: "ISO timestamp of when data was fetched",
        },
      },
      required: ["chainId", "estimates", "fetchedAt"],
    },
  },
  {
    name: "list_chains",
    description:
      "Get all supported EVM chains with their chain IDs, labels, and network info.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        chains: {
          type: "array",
          description: "List of supported chains",
          items: {
            type: "object",
            properties: {
              chainId: {
                type: "number",
                description: "The chain ID (e.g., 1 for Ethereum, 8453 for Base)",
              },
              label: {
                type: "string",
                description: "Human-readable chain name",
              },
              system: {
                type: "string",
                description: "System identifier (e.g., ethereum)",
              },
              network: {
                type: "string",
                description: "Network type (e.g., main, goerli)",
              },
            },
          },
        },
        fetchedAt: {
          type: "string",
          description: "ISO timestamp of when data was fetched",
        },
      },
      required: ["chains", "fetchedAt"],
    },
  },
  {
    name: "get_oracles",
    description: "Get available gas price oracles for a blockchain network.",
    inputSchema: {
      type: "object" as const,
      properties: {
        chainId: {
          type: "number",
          description: "The chain ID to get oracles for (e.g., 1 for Ethereum)",
        },
        system: {
          type: "string",
          description:
            'The blockchain system (e.g., "ethereum"). Use with network parameter as an alternative to chainId.',
        },
        network: {
          type: "string",
          description:
            'The network name (e.g., "main"). Use with system parameter as an alternative to chainId.',
        },
      },
    },
    outputSchema: {
      type: "object" as const,
      properties: {
        oracles: {
          type: "array",
          description: "List of available gas price oracles",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Oracle name" },
              label: { type: "string", description: "Human-readable oracle label" },
              system: { type: "string", description: "System identifier" },
              network: { type: "string", description: "Network type" },
            },
          },
        },
        fetchedAt: {
          type: "string",
          description: "ISO timestamp of when data was fetched",
        },
      },
      required: ["oracles", "fetchedAt"],
    },
  },
];

// ============================================================================
// MCP SERVER SETUP (Standard @modelcontextprotocol/sdk pattern)
// ============================================================================

const server = new Server(
  { name: "blocknative-gas", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Handle tools/list - returns tool definitions including outputSchema
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tools/call - executes tool and returns structuredContent
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest): Promise<CallToolResult> => {
    const { name, arguments: args } = request.params;

    const apiKey = process.env.BLOCKNATIVE_API_KEY;
    if (!apiKey) {
      return errorResult("BLOCKNATIVE_API_KEY is not configured");
    }

    try {
      switch (name) {
        case "get_gas_price": {
          const chainId = (args?.chainId as number) ?? 8453;
          const confidence = args?.confidence as number | undefined;

          const url = buildBlocknativeUrl({ endpoint: "gas_price", chainId, confidence });
          const response = await fetch(url.toString(), {
            headers: { Authorization: apiKey },
            cache: "no-store",
          });

          if (!response.ok) {
            const details = await response.text();
            throw new Error(`Blocknative API error (${response.status}): ${details.slice(0, 200)}`);
          }

          const payload = await response.json();
          const parsed = parseGasPricePayload(payload);

          // Return with structuredContent for Context Protocol
          return successResult({
            chainId,
            estimates: parsed.estimates,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "list_chains": {
          const url = buildBlocknativeUrl({ endpoint: "chains" });
          const response = await fetch(url.toString(), {
            headers: { Authorization: apiKey },
            cache: "no-store",
          });

          if (!response.ok) {
            const details = await response.text();
            throw new Error(`Blocknative API error (${response.status}): ${details.slice(0, 200)}`);
          }

          const payload = await response.json();
          const chains = parseChainsPayload(payload);

          return successResult({
            chains,
            fetchedAt: new Date().toISOString(),
          });
        }

        case "get_oracles": {
          const chainId = args?.chainId as number | undefined;
          const system = args?.system as string | undefined;
          const network = args?.network as string | undefined;

          const url = buildBlocknativeUrl({ endpoint: "oracles", chainId, system, network });
          const response = await fetch(url.toString(), {
            headers: { Authorization: apiKey },
            cache: "no-store",
          });

          if (!response.ok) {
            const details = await response.text();
            throw new Error(`Blocknative API error (${response.status}): ${details.slice(0, 200)}`);
          }

          const payload = await response.json();
          const oracles = parseOraclesPayload(payload);

          return successResult({
            oracles,
            fetchedAt: new Date().toISOString(),
          });
        }

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : "Unknown error");
    }
  }
);

// ============================================================================
// RESPONSE HELPERS
//
// Context Protocol requires:
// - content: Human-readable text (standard MCP)
// - structuredContent: Machine-readable data matching outputSchema
// ============================================================================

function successResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    // Context Protocol extension: structuredContent for typed responses
    structuredContent: data,
  };
}

function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ============================================================================
// EXPRESS + SSE TRANSPORT (Standard MCP pattern)
// ============================================================================

const app = express();
app.use(express.json());

const transports: Record<string, SSEServerTransport> = {};

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", server: "blocknative-gas", version: "1.0.0" });
});

app.get("/sse", async (_req: Request, res: Response) => {
  console.log("New SSE connection established");
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    console.log(`SSE connection closed: ${transport.sessionId}`);
    delete transports[transport.sessionId];
  });

  await server.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];

  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).json({ error: "No transport found for sessionId" });
  }
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`\n🚀 Blocknative Gas MCP Server v1.0.0`);
  console.log(`📡 SSE endpoint: http://localhost:${port}/sse`);
  console.log(`💚 Health check: http://localhost:${port}/health`);
  console.log(`\n🛠️  Available tools: ${TOOLS.map((t) => t.name).join(", ")}\n`);
});

// ============================================================================
// BLOCKNATIVE API HELPERS
// ============================================================================

interface BlocknativeParams {
  endpoint: "gas_price" | "chains" | "oracles";
  chainId?: number;
  system?: string;
  network?: string;
  confidence?: number;
}

function buildBlocknativeUrl(params: BlocknativeParams): URL {
  const searchParams = new URLSearchParams();
  let path = "/gasprices/blockprices";

  if (params.endpoint === "chains") {
    path = "/chains";
  } else if (params.endpoint === "oracles") {
    path = "/oracles";
  } else {
    const chainId = params.chainId ?? 8453;
    searchParams.set("chainid", String(chainId));
    if (typeof params.confidence === "number") {
      searchParams.set("confidence", String(params.confidence));
    }
  }

  if (params.endpoint === "oracles") {
    if (params.chainId) {
      searchParams.set("chainid", String(params.chainId));
    } else if (params.system && params.network) {
      searchParams.set("system", params.system);
      searchParams.set("network", params.network);
    }
  }

  const url = new URL(path, BLOCKNATIVE_BASE_URL);
  const qs = searchParams.toString();
  if (qs) url.search = qs;
  return url;
}

// Type definitions
interface GasEstimate {
  confidence: number;
  maxFeePerGas: number;
  maxPriorityFeePerGas: number;
  estimatedSeconds: number;
}

interface Chain {
  chainId: number;
  label: string;
  system: string;
  network: string;
}

interface Oracle {
  name: string;
  label: string;
  system: string;
  network: string;
}

interface RawGasPricePayload {
  blockPrices?: Array<{
    estimatedPrices?: Array<{
      confidence?: number;
      maxFeePerGas?: number;
      maxPriorityFeePerGas?: number;
      estimatedSeconds?: number;
    }>;
  }>;
}

interface RawChainPayload {
  chainId: number;
  label: string;
  system: string;
  network: string;
}

interface RawOraclePayload {
  name?: string;
  label: string;
  system: string;
  network: string;
}

function parseGasPricePayload(payload: RawGasPricePayload): { estimates: GasEstimate[] } {
  const rawEstimates =
    Array.isArray(payload?.blockPrices) && payload.blockPrices.length > 0
      ? payload.blockPrices[0].estimatedPrices ?? []
      : [];

  return {
    estimates: rawEstimates.map((e) => ({
      confidence: Number(e.confidence || 0),
      maxFeePerGas: Number(e.maxFeePerGas || 0),
      maxPriorityFeePerGas: Number(e.maxPriorityFeePerGas || 0),
      estimatedSeconds: Number(e.estimatedSeconds || 0),
    })),
  };
}

function parseChainsPayload(payload: RawChainPayload[]): Chain[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((chain) => ({
    chainId: Number(chain.chainId),
    label: chain.label,
    system: chain.system,
    network: chain.network,
  }));
}

function parseOraclesPayload(payload: RawOraclePayload[]): Oracle[] {
  if (!Array.isArray(payload)) return [];
  return payload.map((oracle) => ({
    name: oracle.label ?? oracle.name ?? "Unknown",
    label: oracle.label,
    system: oracle.system,
    network: oracle.network,
  }));
}
