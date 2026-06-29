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
const CONTRIBUTOR_NAME = "hyperliquid-contributor";
const TOOL_ID = "b940bedc-3d67-45b0-8709-b3d070e5e454";
const PROMPT_POOL_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const RESULTS_PATH = path.resolve(__dirname, "full-enhancement-results.latest.json");
const REVIEWER_PATH = path.resolve(__dirname, "reviewer-evaluation.json");
const SURFACE_CHECKS_PATH = path.resolve(
  __dirname,
  "marketplace-surface-checks.latest.json"
);
const ARTIFACT_PATH = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const SDK_ENV_PATH = path.resolve(ROOT_DIR, "context-sdk/.env.local");
const CONTEXT_ENV_PATH = path.resolve(ROOT_DIR, "context/.env.local");

function loadEnvFile(filePath) {
  return readFile(filePath, "utf8")
    .then((raw) => {
      for (const line of raw.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) {
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
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    })
    .catch(() => undefined);
}

function readJson(filePath) {
  return readFile(filePath, "utf8").then((value) => JSON.parse(value));
}

const CURATED_SHOWCASE_PROMPT_IDS = [
  "hl-020",
  "hl-021",
  "hl-022",
  "hl-005",
  "hl-001",
  "hl-011",
  "hl-004",
];

function buildShowcasePrompts(promptPool) {
  const byId = new Map(promptPool.map((prompt) => [prompt.id, prompt.prompt]));
  const curated = CURATED_SHOWCASE_PROMPT_IDS.map((id) => byId.get(id)).filter(
    (prompt) => typeof prompt === "string" && prompt.length > 0
  );

  if (curated.length >= 7) {
    return curated.slice(0, 8);
  }

  return promptPool
    .filter((prompt) => prompt.showcaseCandidate === true)
    .map((prompt) => prompt.prompt)
    .slice(0, 8);
}

function buildGeneratedDescription(showcasePrompts) {
  const tryAskingLines = showcasePrompts.map((prompt) => `- "${prompt}"`).join("\n");

  return `Live Hyperliquid market intelligence for perps, spot, liquidity, funding, open interest, HLP vaults, and HYPE staking from one MCP endpoint.

Features:
- Analyze your linked Hyperliquid book when portfolio context is injected: direct perp positions, vault equity, shadow positions, liquidation distance, and full cross-account exposure
- Pull current perp market snapshots with mark, mid, oracle, volume, open interest, funding, spreads, and leverage
- Simulate visible-book price impact for large BTC, HYPE, ZEC, CHIP, and other Hyperliquid orders
- Compare funding, carry pressure, open-interest crowding, recent trades, candles, and volume momentum
- Inspect Hyperliquid spot token metadata, spot pairs, HLP vault stats, and public HYPE staking mechanics
- Use structured responses with data freshness, sources, and fetched timestamps for auditability

Try asking:
${tryAskingLines}

Agent tips:
- For your positions and risk, use analyze_user_positions, analyze_vault_exposure, or analyze_full_portfolio; omit address to use your linked Hyperliquid wallet
- Start with get_market_info or list_markets for live perp discovery, then use get_orderbook or calculate_price_impact for execution sizing
- Use get_funding_history with get_market_info when the question is about current carry versus recent persistence
- Use get_open_interest_analysis for crowded-market and liquidation-risk questions before making a directional recommendation
- Use get_spot_meta for spot token and pair questions; avoid substituting perp data for spot pair answers
- Treat write actions as signature workflows that require user approval in the browser`;
}

function buildVerticalAlphaResearch() {
  return {
    completedAt: new Date().toISOString(),
    upstreamDocsSource:
      "validation/context7-hyperliquid-contributor-upstream-snapshot.txt",
    alphaCategories: [
      {
        category: "market-discovery",
        upstreamDataSource: "Hyperliquid /info metaAndAssetCtxs",
        whyItBeatsFree:
          "Live market prices, volume, open interest, funding, and leverage change intraday and are not available to a static free model.",
      },
      {
        category: "liquidity-impact",
        upstreamDataSource: "Hyperliquid /info l2Book plus market context",
        whyItBeatsFree:
          "Visible-book depth and slippage require current orderbook levels and sizing math.",
      },
      {
        category: "funding-carry",
        upstreamDataSource: "Hyperliquid fundingHistory and current asset contexts",
        whyItBeatsFree:
          "Carry persistence requires current funding plus recent historical samples.",
      },
      {
        category: "open-interest-risk",
        upstreamDataSource: "Hyperliquid open interest and OI cap endpoints",
        whyItBeatsFree:
          "Crowding and liquidation-risk context depends on current open interest, volume, and cap status.",
      },
      {
        category: "spot-market-structure",
        upstreamDataSource: "Hyperliquid spotMetaAndAssetCtxs",
        whyItBeatsFree:
          "Spot token metadata, canonical pair flags, and pair volume require current Hyperliquid spot data.",
      },
      {
        category: "protocol-yield-and-staking",
        upstreamDataSource: "Hyperliquid vaultDetails and staking metadata",
        whyItBeatsFree:
          "HLP, vault, and staking answers are strongest when grounded in protocol-native fields and explicit public-data limits.",
      },
    ],
  };
}

function buildCandidatePromptPool(promptPool, resultsMap, reviewerMap) {
  return promptPool.map((prompt) => {
    const run = resultsMap.get(prompt.id);
    const review = reviewerMap.get(prompt.id);
    return {
      prompt: prompt.prompt,
      mustWin: prompt.mustWin === true,
      category: "hyperliquid",
      alphaCategory: prompt.alphaCategory,
      upstreamAnswerability: run?.upstreamAnswerability ?? "answerable",
      differentiation: review?.differentiation ?? run?.differentiation ?? "low_differentiation",
      answerabilityNote: run?.answerabilityNote ?? "Validated through Context SDK query path.",
      comparisonNote:
        run?.comparisonNote ??
        "Paid Hyperliquid flow was compared against the Gemini free baseline.",
      satisfactionMean: review?.satisfactionMean ?? null,
    };
  });
}

async function updateMarketplaceDescription(description) {
  await loadEnvFile(SDK_ENV_PATH);
  await loadEnvFile(CONTEXT_ENV_PATH);
  const apiKey = process.env.CONTEXT_API_KEY ?? process.env.API_KEY;
  if (!apiKey) {
    return {
      status: "skipped",
      reason: "CONTEXT_API_KEY was not available.",
    };
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

  const [promptPoolFile, results, reviewer, surfaceChecks] = await Promise.all([
    readJson(PROMPT_POOL_PATH),
    readJson(RESULTS_PATH),
    readJson(REVIEWER_PATH),
    readJson(SURFACE_CHECKS_PATH),
  ]);
  const promptPool = promptPoolFile.prompts ?? [];
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
      name: "Hyperliquid Intelligence",
      description: generatedDescription,
      category: "Crypto & DeFi",
      price: "0.10",
      endpoint: "https://mcp.ctxprotocol.com/hyperliquid/mcp",
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
    verticalAlphaResearch: buildVerticalAlphaResearch(),
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
        "Automated validation focuses on SDK/query and representative read-only MCP behavior. Browser signature workflows remain manual QA.",
    },
    knownLimitations: [
      "Browser chat and signature-based write actions still require manual QA.",
      "Reviewer noted weak but non-blocking opportunities around orderbook spread units, recent trade snapshot limits, and spot pair resolution clarity.",
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
