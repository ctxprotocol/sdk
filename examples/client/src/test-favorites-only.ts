import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextClient, ContextError, type Tool } from "@ctxprotocol/sdk";

function readEnvValue(filePath: string, key: string): string | undefined {
  if (!existsSync(filePath)) {
    return;
  }

  const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const currentKey = trimmed.slice(0, separatorIndex).trim();
    if (currentKey !== key) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    return rawValue.replace(/^['"]|['"]$/gu, "");
  }
}

function getContextApiKey(): string {
  const envKey = process.env.CONTEXT_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const filePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.env.local"
  );
  const fileKey = readEnvValue(filePath, "CONTEXT_API_KEY");
  if (fileKey) {
    return fileKey;
  }

  throw new Error("Set CONTEXT_API_KEY or provide it in context-sdk/.env.local.");
}

function getContextBaseUrl(): string | undefined {
  const baseUrl = process.env.CONTEXT_BASE_URL?.trim();
  return baseUrl ? baseUrl : undefined;
}

function summarizeTools(tools: Tool[]): string[] {
  return tools.slice(0, 5).map((tool) => `${tool.name} (${tool.id})`);
}

async function main() {
  const baseUrl = getContextBaseUrl();
  const client = new ContextClient({
    apiKey: getContextApiKey(),
    ...(baseUrl ? { baseUrl } : {}),
  });
  const query = "crypto";

  console.log("Base URL:", baseUrl ?? "https://www.ctxprotocol.com");

  try {
    const [defaultResults, unrestrictedResults, favoritesResults] =
      await Promise.all([
        client.discovery.search({
          query,
          limit: 10,
          mode: "query",
          surface: "answer",
        }),
        client.discovery.search({
          query,
          limit: 10,
          mode: "query",
          surface: "answer",
          favoritesOnly: false,
        }),
        client.discovery.search({
          query,
          limit: 10,
          mode: "query",
          surface: "answer",
          favoritesOnly: true,
        }),
      ]);

    console.log("Default discovery count:", defaultResults.length);
    console.log("Explicit unrestricted count:", unrestrictedResults.length);
    console.log("Favorites-only count:", favoritesResults.length);
    console.log("Default discovery sample:", summarizeTools(defaultResults));
    console.log(
      "Explicit unrestricted sample:",
      summarizeTools(unrestrictedResults)
    );
    console.log("Favorites-only sample:", summarizeTools(favoritesResults));

    if (favoritesResults.length > unrestrictedResults.length) {
      throw new Error(
        "favoritesOnly=true returned more tools than explicit unrestricted discovery."
      );
    }

    const unrestrictedIds = new Set(unrestrictedResults.map((tool) => tool.id));
    const favoritesOutsideUnrestricted = favoritesResults.filter(
      (tool) => !unrestrictedIds.has(tool.id)
    );
    if (favoritesOutsideUnrestricted.length > 0) {
      console.log(
        "Favorites-only returned tools outside the unrestricted top 10 window:",
        summarizeTools(favoritesOutsideUnrestricted)
      );
    }

    const queryResult = await client.query.run({
      query: "What are the top whale movements on Base?",
      favoritesOnly: true,
      includeDeveloperTrace: true,
    });

    if (!queryResult.response.trim()) {
      throw new Error("Query response was empty.");
    }

    console.log("Query response length:", queryResult.response.length);
    console.log(
      "Query tools used:",
      queryResult.toolsUsed.map((tool) => `${tool.name} (${tool.id})`)
    );
    console.log("Query total cost (USD):", queryResult.cost.totalCostUsd);
    console.log(
      "Developer trace present:",
      Boolean(queryResult.developerTrace?.timeline?.length)
    );
    console.log("TS SDK favorites-only validation passed.");
  } catch (error) {
    if (error instanceof ContextError) {
      console.error("Context Protocol error:", error.message);
      console.error("Error code:", error.code);
      process.exitCode = 1;
      return;
    }

    throw error;
  }
}

void main();
