import express from "express";
import { z } from "zod";
import { defineHttpTool, executeHttpTool } from "@contextprotocol/sdk";

const BLOCKNATIVE_BASE_URL = "https://api.blocknative.com";

const blocknativeInputSchema = z.object({
  endpoint: z.enum(["gas_price", "chains", "oracles"]).default("gas_price"),
  chainId: z.number().int().optional(),
  system: z.string().optional(),
  network: z.string().optional(),
  confidence: z.number().int().min(1).max(100).optional(),
});

const blocknativeOutputSchema = z.object({
  endpoint: z.enum(["gas_price", "chains", "oracles"]),
  fetchedAt: z.string(),
  data: z.union([
    z.object({
      type: z.literal("gas_price"),
      chainId: z.number().nullable(),
      estimates: z.array(
        z.object({
          confidence: z.number(),
          maxFeePerGasGwei: z.number(),
          maxPriorityFeePerGasGwei: z.number(),
          estimatedSeconds: z.number(),
        })
      ),
    }),
    z.object({
      type: z.literal("chains"),
      chains: z.array(
        z.object({
          chainId: z.number(),
          system: z.string(),
          network: z.string(),
        })
      ),
    }),
    z.object({
      type: z.literal("oracles"),
      oracles: z.array(
        z.object({
          name: z.string(),
          system: z.string(),
          network: z.string(),
        })
      ),
    }),
  ]),
});

const blocknativeTool = defineHttpTool({
  name: "blocknative_gas_tools",
  version: "0.1.0",
  description:
    "Expose Blocknative gas prices, supported chains, and oracles in a Context-friendly format.",
  inputSchema: blocknativeInputSchema,
  outputSchema: blocknativeOutputSchema,
  async handler(input) {
    const apiKey = process.env.BLOCKNATIVE_API_KEY;
    if (!apiKey) {
      throw new Error("BLOCKNATIVE_API_KEY is not configured");
    }

    const url = buildBlocknativeUrl(input);
    const response = await fetch(url.toString(), {
      headers: { Authorization: apiKey },
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `Blocknative request failed (${response.status}): ${details.slice(0, 200)}`
      );
    }

    const payload = await response.json();
    return parseBlocknativePayload(input.endpoint, payload, input.chainId ?? null);
  },
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/context/blocknative", async (req, res) => {
  try {
    const input = req.body?.input ?? req.body;
    const response = await executeHttpTool(blocknativeTool, input, {
      headers: req.headers,
    });
    res.json(response);
  } catch (error) {
    console.error("Blocknative tool error:", error);
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const port = Number(process.env.PORT || 4001);
app.listen(port, () => {
  console.log(`Blocknative contributor server listening on http://localhost:${port}`);
});

function buildBlocknativeUrl(params: z.infer<typeof blocknativeInputSchema>) {
  const searchParams = new URLSearchParams();
  let path = "/gasprices/blockprices";

  if (params.endpoint === "chains") {
    path = "/gasprices/chains";
  } else if (params.endpoint === "oracles") {
    path = "/gasprices/oracles";
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
  if (qs) {
    url.search = qs;
  }
  return url;
}

function parseBlocknativePayload(
  endpoint: z.infer<typeof blocknativeInputSchema>["endpoint"],
  payload: any,
  chainId: number | null
): z.infer<typeof blocknativeOutputSchema> {
  if (endpoint === "chains") {
    return {
      endpoint,
      fetchedAt: new Date().toISOString(),
      data: {
        type: "chains",
        chains: Array.isArray(payload?.chains)
          ? payload.chains.map((chain: any) => ({
              chainId: Number(chain.chainId),
              system: chain.system,
              network: chain.network,
            }))
          : [],
      },
    };
  }

  if (endpoint === "oracles") {
    return {
      endpoint,
      fetchedAt: new Date().toISOString(),
      data: {
        type: "oracles",
        oracles: Array.isArray(payload?.oracles)
          ? payload.oracles.map((oracle: any) => ({
              name: oracle.name,
              system: oracle.system,
              network: oracle.network,
            }))
          : [],
      },
    };
  }

  const estimates =
    Array.isArray(payload?.blockPrices) && payload.blockPrices.length > 0
      ? payload.blockPrices[0].estimatedPrices ?? []
      : [];

  return {
    endpoint,
    fetchedAt: new Date().toISOString(),
    data: {
      type: "gas_price",
      chainId,
      estimates: estimates.map((estimate: any) => ({
        confidence: Number(estimate.confidence || 0),
        maxFeePerGasGwei: Number(estimate.maxFeePerGas || 0),
        maxPriorityFeePerGasGwei: Number(estimate.maxPriorityFeePerGas || 0),
        estimatedSeconds: Number(estimate.estimatedSeconds || 0),
      })),
    },
  };
}

