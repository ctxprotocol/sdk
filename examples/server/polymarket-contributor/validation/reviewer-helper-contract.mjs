import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function parseJsonMaybeFenced(rawText, sourceLabel) {
  const trimmed = rawText.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonText = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`Could not parse JSON payload from ${sourceLabel}: ${error.message}`);
  }
}

export function assertLegacyReviewerHelperEnabled({ importMetaUrl, why }) {
  if (process.env.ALLOW_LEGACY_REVIEWER_HELPERS === "1") {
    return;
  }
  const scriptName = path.basename(fileURLToPath(importMetaUrl));
  throw new Error(
    `${scriptName} is a legacy reviewer helper and is disabled by default because it writes synthesized or hand-curated reviewer output. ${why} Run it only for an intentional backfill with ALLOW_LEGACY_REVIEWER_HELPERS=1.`
  );
}

export function getRequiredPathInput({ flagName, envName, description }) {
  const cliArgs = process.argv.slice(2);
  for (let index = 0; index < cliArgs.length; index += 1) {
    const arg = cliArgs[index];
    if (arg === flagName) {
      const nextValue = cliArgs.at(index + 1);
      if (!nextValue) {
        throw new Error(`Missing value after ${flagName} for ${description}.`);
      }
      return path.resolve(nextValue);
    }
    if (arg.startsWith(`${flagName}=`)) {
      return path.resolve(arg.slice(flagName.length + 1));
    }
  }

  const envValue = process.env[envName];
  if (envValue) {
    return path.resolve(envValue);
  }

  throw new Error(
    `Missing ${description}. Provide ${flagName} <path> or set ${envName}.`
  );
}

export function parseReviewerPayloadSource(sourcePath) {
  const raw = readFileSync(sourcePath, "utf8");

  try {
    return parseJsonMaybeFenced(raw, sourcePath);
  } catch (topLevelError) {
    const assistantPayloads = [];
    for (const line of raw.split("\n")) {
      if (!line.includes('"role":"assistant"') || !line.includes("perQueryEvaluations")) {
        continue;
      }
      try {
        const row = JSON.parse(line);
        const contentBlocks = Array.isArray(row.message?.content) ? row.message.content : [];
        const textBlock = contentBlocks.find((block) => typeof block?.text === "string");
        if (!textBlock?.text) {
          continue;
        }
        assistantPayloads.push(parseJsonMaybeFenced(textBlock.text, sourcePath));
      } catch {
        continue;
      }
    }

    const payload = assistantPayloads.at(-1);
    if (!payload) {
      throw topLevelError;
    }
    return payload;
  }
}
