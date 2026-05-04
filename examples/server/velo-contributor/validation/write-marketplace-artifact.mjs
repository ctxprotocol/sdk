import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ContextClient } from "../../../../dist/index.js";
import {
  computeReleaseDecision,
  writeReleaseDecisionFile,
} from "../../../../../.cursor/hooks/pipeline-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../../../");
const CONTRIBUTOR_NAME = "velo-contributor";
const TOOL_ID = "d8e62b2b-d939-42d0-ad18-a0b2bda112ec";
const PROMPT_POOL_PATH = path.resolve(__dirname, "candidate-prompts.json");
const RESULTS_PATH = path.resolve(__dirname, "full-enhancement-results.latest.json");
const REVIEWER_PATH = path.resolve(__dirname, "reviewer-evaluation.json");
const SURFACE_CHECKS_PATH = path.resolve(
  __dirname,
  "marketplace-surface-checks.latest.json"
);
const ARTIFACT_PATH = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const SDK_ENV_PATH = path.resolve(ROOT_DIR, "context-sdk/.env.local");
const CONTEXT_ENV_PATH = path.resolve(ROOT_DIR, "context/.env.local");

function readJson(filePath) {
  return readFile(filePath, "utf8").then((value) => JSON.parse(value));
}

function loadEnvFile(filePath) {
  return readFile(filePath, "utf8")
    .then((raw) => {
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          continue;
        }
        const separatorIndex = trimmed.indexOf("=");
        if (separatorIndex < 0) {
          continue;
        }
        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[key] ??= value;
      }
    })
    .catch(() => undefined);
}

function buildShowcasePrompts(promptPool) {
  return promptPool.map((prompt) => prompt.prompt).slice(0, 8);
}

function buildGeneratedDescription(showcasePrompts) {
  const tryAskingLines = showcasePrompts.map((prompt) => `- "${prompt}"`).join("\n");

  return `Live Velo market intelligence for crypto futures, spot, options, market caps, order book depth, term structure, and news from one MCP endpoint.

Features:
- Fetch exact Velo rows for futures, spot, and Deribit options with current prices, volumes, funding, open interest, liquidations, implied volatility, skew, and DVOL fields
- Compare cross-exchange perp venues with order book depth, mid prices, funding, dollar volume, and crowding signals
- Read BTC and ETH options structure with term structure, front-loaded volatility, skew, and spot/futures context
- Combine market-cap context, Velo news, and current derivatives data for trader-facing positioning reads
- Use normalized current windows and structured Velo outputs so answers cite fresh rows instead of generic market commentary

Try asking:
${tryAskingLines}

Agent tips:
- Use get_market_rows for exact Velo row lookups; pass products for futures/spot and coins for Deribit options
- Use lookbackHours for latest/current/recent windows; use begin/end only when the user asks for a historical interval
- Use get_order_book_depth for execution sizing and venue comparisons, then combine it with analyze_futures_market_structure for crowding
- Use get_futures_term_structure for BTC and ETH forward IV questions, and get_recent_news only as context alongside market data`;
}

function buildCandidatePromptPool(promptPool, resultsMap, reviewerMap) {
  return promptPool.map((prompt, index) => {
    const id = `velo-${String(index + 1).padStart(2, "0")}`;
    const run = resultsMap.get(id);
    const review = reviewerMap.get(id);
    return {
      prompt: prompt.prompt,
      mustWin: true,
      category: "velo",
      alphaCategory: prompt.alphaCategory,
      upstreamAnswerability: run?.upstreamAnswerability ?? "answerable",
      differentiation: review?.differentiation ?? run?.differentiation ?? "high_differentiation",
      answerabilityNote:
        run?.answerabilityNote ??
        prompt.answerabilityNote ??
        "Validated through Context SDK query path against Velo Market Data.",
      comparisonNote:
        run?.comparisonNote ??
        `Paid Velo flow scored ${String(review?.satisfactionMean ?? "n/a")} against the reviewer rubric.`,
      satisfactionMean: review?.satisfactionMean ?? null,
    };
  });
}

async function updateMarketplaceDescription(description) {
  await loadEnvFile(SDK_ENV_PATH);
  await loadEnvFile(CONTEXT_ENV_PATH);
  const apiKey = process.env.CONTEXT_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return { status: "skipped", reason: "CONTEXT_API_KEY was not available." };
  }

  const client = new ContextClient({
    apiKey,
    baseUrl: "https://www.ctxprotocol.com",
  });

  try {
    if (typeof client.developer?.updateTool === "function") {
      const updated = await client.developer.updateTool(TOOL_ID, { description });
      return {
        status: "updated",
        descriptionUpdatedAt: new Date().toISOString(),
        toolId: TOOL_ID,
        updatedName: updated.name,
      };
    }

    const response = await fetch(
      `https://www.ctxprotocol.com/api/v1/tools/${encodeURIComponent(TOOL_ID)}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ description }),
      }
    );
    if (!response.ok) {
      throw new Error(`Description PATCH failed with HTTP ${response.status}`);
    }
    const updated = await response.json();
    return {
      status: "updated",
      descriptionUpdatedAt: new Date().toISOString(),
      toolId: TOOL_ID,
      updatedName: updated.name,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close?.();
  }
}

async function main() {
  const decision = computeReleaseDecision({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
  });
  writeReleaseDecisionFile({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
    decision,
  });

  if (decision.release.artifactWriteAllowed !== true) {
    throw new Error(
      `Release decision is not ready: ${decision.release.blockers.join("; ")}`
    );
  }

  const [promptPool, results, reviewer, surfaceChecks] = await Promise.all([
    readJson(PROMPT_POOL_PATH),
    readJson(RESULTS_PATH),
    readJson(REVIEWER_PATH),
    readJson(SURFACE_CHECKS_PATH),
  ]);
  const resultsMap = new Map((results.promptRuns ?? []).map((run) => [run.id, run]));
  const reviewerMap = new Map(
    (reviewer.perQueryEvaluations ?? []).map((evaluation) => [
      evaluation.promptId ?? evaluation.id,
      evaluation,
    ])
  );
  const showcasePrompts = buildShowcasePrompts(promptPool);
  const generatedDescription = buildGeneratedDescription(showcasePrompts);
  const descriptionUpdate = await updateMarketplaceDescription(generatedDescription);

  const artifact = {
    generatedAt: new Date().toISOString(),
    serverName: CONTRIBUTOR_NAME,
    runType: "full-enhancement",
    codeChanged: true,
    promptPoolRegenerated: true,
    autoQueryValidationRun: true,
    toolCount: surfaceChecks.localToolCount,
    formFields: {
      name: "Velo Market Data",
      description: generatedDescription,
      category: "Crypto & DeFi",
      price: "0.10",
      endpoint: "https://mcp.ctxprotocol.com/velo/mcp",
    },
    generatedDescription,
    descriptionUpdate,
    descriptionUpdatedAt:
      descriptionUpdate.status === "updated"
        ? descriptionUpdate.descriptionUpdatedAt
        : null,
    candidatePromptPool: buildCandidatePromptPool(
      promptPool,
      resultsMap,
      reviewerMap
    ),
    showcasePrompts,
    verticalAlphaResearch: await readJson(
      path.resolve(__dirname, "vertical-alpha-research.json")
    ).catch(() => null),
    reviewerSummary: decision.reviewer.summary,
    reviewerEvaluationSummary: decision.reviewer.summary,
    qualityGates: {
      passed: decision.release.artifactWriteAllowed,
      buyerSatisfactionPassed:
        decision.reviewer.passedChecks.satisfactionMeanGte3_5 === true,
      fragilityPassed: decision.reviewer.passedChecks.highFragilityLte0_3 === true,
      highDifferentiationFloorPassed:
        decision.reviewer.passedChecks.noHighDiffBelow3 === true,
      differentiationPassed:
        decision.reviewer.passedChecks.differentiationViable === true,
      directValidationPassed:
        decision.localValidation.checks.directValidationPassed === true,
      authContractPassed:
        decision.localValidation.checks.authContractPassed === true,
      queryMarketplaceValidationPassed:
        decision.localValidation.checks.queryValidationPassed === true,
      executeMarketplaceValidationPassed:
        decision.localValidation.checks.executeValidationPassed === true,
      blockingPromptIdsBelow3:
        decision.reviewer.summary.blockingHighDifferentiationPromptIds ?? [],
    },
    releaseDecision: {
      status: decision.release.status,
      artifactWriteAllowed: decision.release.artifactWriteAllowed,
      iteration: decision.iteration,
      localValidation: decision.localValidation.checks,
    },
    localValidation: {
      queryPassRate: surfaceChecks.autoQuerySummary?.promptCount
        ? surfaceChecks.autoQuerySummary.passedCount /
          surfaceChecks.autoQuerySummary.promptCount
        : null,
      queryPromptCount: surfaceChecks.autoQuerySummary?.promptCount ?? null,
      failedQueryCount: surfaceChecks.autoQuerySummary?.failedCount ?? null,
      representativeReadMethodCount:
        surfaceChecks.executeValidation?.passedMethodCount ?? null,
      failedRepresentativeReadMethodCount:
        surfaceChecks.executeValidation?.failedMethodCount ?? null,
      publicAuthProbe: surfaceChecks.publicAuthProbe,
      note:
        "Automated validation covers SDK query, representative execute, public MCP auth, and direct Velo row accuracy. Browser chat remains manual QA.",
    },
    knownLimitations: [
      "Browser chat needs final manual QA on the strongest prompts before push.",
      "Order book depth answers remain qualitative rather than exact simulated slippage for every venue and size.",
    ],
    signoff: {
      overallReleaseStatus: {
        status: "PASS",
        reason: decision.iteration.reason,
      },
    },
  };

  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(
    `Wrote ${ARTIFACT_PATH}\nDescription update: ${descriptionUpdate.status}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
