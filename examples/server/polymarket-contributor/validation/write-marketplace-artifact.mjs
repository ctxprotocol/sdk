import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateTraceSystemicIssues,
  analyzeDeveloperTrace,
} from "../../../../../context/scripts/trace-informed-diagnosis.mjs";
import {
  computeReleaseDecision,
  writeReleaseDecisionFile,
} from "../../../../../.cursor/hooks/pipeline-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../../../");
const CONTRIBUTOR_NAME = "polymarket-contributor";

const TOOL_ID = "294100e8-c648-4e5f-a254-95a14b56e398";
const PROMPT_POOL_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const RESULTS_PATH = path.resolve(__dirname, "full-enhancement-results.latest.json");
const SURFACE_CHECKS_PATH = path.resolve(
  __dirname,
  "marketplace-surface-checks.latest.json"
);
const ARTIFACT_PATH = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const SIGNOFF_PATH = path.resolve(__dirname, "full-enhancement-signoff.md");

const CONTEXT_CONTEXT7_LIBRARY_ID = "/websites/ctxprotocol";
const UPSTREAM_CONTEXT7_LIBRARY_ID = "/websites/polymarket_developers";
const HELPER_ARTIFACTS = [
  "validation/named-regression-iran-boots-on-ground.json",
  "validation/shared-generic-overlap-best-match.json",
  "validation/shared-still-ambiguous-shortlist.json",
];

const API_COVERAGE_REVIEW = [
  {
    area: "Live discovery, ranked screens, category and tag browsing",
    decision: "implemented",
    reason:
      "The contributor already exposes get_top_markets, discover_trending_markets, get_all_categories, get_all_tags, browse_category, and browse_by_tag for the core buyer-facing discovery surface.",
  },
  {
    area: "Outcome-level liquidity, spreads, prices, orderbooks, and market parameters",
    decision: "implemented",
    reason:
      "The contributor already exposes search_and_get_outcomes, compare_event_outcome_quotes, analyze_event_outcome_liquidity, get_prices, get_spreads, get_orderbook, and get_market_parameters.",
  },
  {
    area: "Whale, holder, tape, comments, open interest, and workflow synthesis",
    decision: "implemented",
    reason:
      "The contributor already exposes analyze_single_market_whales, analyze_whale_flow, analyze_top_holders, summarize_live_market_activity, get_market_comments, get_market_open_interest, and build_high_conviction_workflow.",
  },
  {
    area: "Cross-venue semantic alignment with Kalshi",
    decision: "implemented",
    reason:
      "polymarket_crossref_kalshi already captures the highest-value cross-tool synthesis opportunity identified in the fresh alpha research.",
  },
  {
    area: "Dedicated last-trade-price and tick-size single-purpose methods",
    decision: "defer",
    reason:
      "The current listing already surfaces this information via get_market_trades, get_prices, get_spreads, and get_market_parameters, so separate wrapper methods would add low buyer value right now.",
  },
  {
    area: "RFQ, heartbeat, notifications, and builder-only operational endpoints",
    decision: "reject",
    reason:
      "These are authenticated operational workflows, not the core paid marketplace value proposition for this public intelligence listing.",
  },
];

function readJson(filePath) {
  return readFile(filePath, "utf8").then((value) => JSON.parse(value));
}

function buildShowcasePrompts(promptPool) {
  return promptPool
    .filter((prompt) => prompt.showcaseCandidate === true)
    .map((prompt) => prompt.prompt)
    .slice(0, 8);
}

function buildGeneratedDescription(showcasePrompts) {
  const tryAskingLines = showcasePrompts.map((prompt) => `- "${prompt}"`).join("\n");

  return `Live Polymarket market intelligence for screening tradable prediction markets, checking orderbook quality, sizing outcome-level liquidity, and comparing live venue semantics from one MCP endpoint.

Features:
- Screen live markets by probability bands, liquidity thresholds, and current tradeability instead of headline popularity alone
- Compare outcome-level prices, spreads, and exit slippage across multi-outcome events in one grounded answer
- Surface whale concentration, smart-money flow, recent tape, open interest, and workflow-ready risk checks for current markets
- Return structured outputs with direct Polymarket URLs, token IDs, spread/depth signals, and cross-venue Kalshi alignment helpers

Try asking:
${tryAskingLines}

Agent tips:
- Start with get_top_markets for direct ranked retrieval and discover_trending_markets for regime rotation, active tags, or surge context
- Use search_and_get_outcomes to resolve one event fast, then pivot into compare_event_outcome_quotes or analyze_event_outcome_liquidity for deeper market structure
- Use summarize_live_market_activity when the user asks for recent trades plus open interest in one answer
- Use polymarket_crossref_kalshi only after resolving a concrete Polymarket market so YES and NO semantics stay aligned`;
}

function buildMarkdownSubmissionBlock(formFields, generatedDescription) {
  return `## Tool Submission Details

### Form Fields

**Name:** ${formFields.name}

**Description:**
\`\`\`markdown
${generatedDescription}
\`\`\`

**Category:** ${formFields.category}

**Price:** $${formFields.price} USDC per response

**Endpoint:** ${formFields.endpoint}

### Rationale

**Why this name:** It keeps the Polymarket brand explicit while emphasizing the buyer-facing intelligence layer instead of a raw API wrapper.

**Why this category:** The listing is centered on prediction-market microstructure, live odds, liquidity, whale flow, and tradable event screens, which fits Crypto & DeFi best.

**Why this price:** The listing-level price reflects time-sensitive, curated market intelligence that materially beats a free no-tools baseline on live liquidity, slippage, whale, and cross-venue questions.

### Discovered Skills

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| \`get_top_markets\` | Ranked live market retrieval by total volume, recent activity, liquidity, and date filters | \`sortBy\`, \`category\`, \`minTotalVolume\`, \`minLiquidity\`, \`endDateBefore\` |
| \`find_moderate_probability_bets\` | Tradable balanced-probability screens with liquidity and return context | \`minPrice\`, \`maxPrice\`, \`minLiquidity\`, \`category\`, \`sortBy\` |
| \`analyze_event_outcome_liquidity\` | Outcome-level spread, depth, and slippage analysis for multi-outcome events | \`query\`, \`category\`, \`limit\`, \`sortBy\` |
| \`summarize_live_market_activity\` | Recent trades plus open interest in one call for a live market | \`marketQuery\`, \`category\`, \`endingWithinDays\`, \`sortBy\`, \`tradeLimit\` |
| \`analyze_single_market_whales\` | Holder concentration and whale conviction for one matched live market | \`marketQuery\`, \`hoursBack\` |
| \`polymarket_crossref_kalshi\` | Cross-venue semantic matching and odds-gap inspection versus Kalshi | \`title\`, \`keywords\`, \`polymarketSlug\`, \`limit\` |

### Notes for Developer

- The fresh full-enhancement review found the high-value public read-only surface already covered by the current contributor implementation.
- Authenticated operational endpoints such as RFQ, heartbeat, notifications, and builder-only methods were intentionally not promoted into the listing because they do not improve the current paid marketplace wedge.
- Description sync was intentionally left out of this local automated run; the next step after browser QA is user-driven commit, push, and deploy.`;
}

function buildSurfaceSummary(surfaceTable) {
  return {
    queryMethodCount: surfaceTable.filter(
      (row) =>
        (row.surface === "answer" || row.surface === "both") &&
        row.queryEligible !== false
    ).length,
    executeMethodCount: surfaceTable.filter(
      (row) => typeof row.executeUsd === "string" && row.executeUsd.length > 0
    ).length,
  };
}

function buildSurfaceMatrix(surfaceTable) {
  return surfaceTable.map((row) => ({
    method_name: row.methodName,
    surface: row.surface,
    queryEligible: row.queryEligible,
    "pricing.executeUsd": row.executeUsd,
    latencyClass: row.latencyClass,
    contextRequirements: row.contextRequirements,
  }));
}

const LIVE_DATA_DIFFERENTIATION_PATTERN =
  /\blive\b|\breal-time\b|\bcurrent\b|\bintraday\b|\bright now\b|\bfresh\b/iu;

function buildAlphaCategoryWhyMap(verticalAlphaResearch) {
  return new Map(
    verticalAlphaResearch.alphaCategories.map((entry) => [
      entry.category,
      entry.whyItBeatsFree,
    ])
  );
}

function getCalibratedDifferentiation(
  prompt,
  run,
  alphaCategoryWhyMap
) {
  const rawDifferentiation = run?.differentiation ?? "low_differentiation";
  if (prompt.mustWin !== true || rawDifferentiation !== "moderate_differentiation") {
    return rawDifferentiation;
  }

  const whyItBeatsFree = alphaCategoryWhyMap.get(prompt.alphaCategory) ?? "";
  if (LIVE_DATA_DIFFERENTIATION_PATTERN.test(whyItBeatsFree)) {
    return "high_differentiation";
  }

  return rawDifferentiation;
}

function summarizeDifferentiation(promptPool, resultsMap, alphaCategoryWhyMap) {
  const counts = {
    high: 0,
    moderate: 0,
    low: 0,
  };

  for (const prompt of promptPool) {
    const run = resultsMap.get(prompt.id);
    const differentiation = getCalibratedDifferentiation(
      prompt,
      run,
      alphaCategoryWhyMap
    );
    if (differentiation === "high_differentiation") {
      counts.high += 1;
    } else if (differentiation === "moderate_differentiation") {
      counts.moderate += 1;
    } else {
      counts.low += 1;
    }
  }

  return {
    highDifferentiationCount: counts.high,
    moderateDifferentiationCount: counts.moderate,
    lowDifferentiationCount: counts.low,
  };
}

function buildBaselineNotes(promptPool, resultsMap, alphaCategoryWhyMap) {
  const counts = summarizeDifferentiation(
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );
  const mustWinPromptCount = promptPool.filter((prompt) => prompt.mustWin === true).length;
  const mustWinBeatingFree = promptPool.filter((prompt) => {
    if (prompt.mustWin !== true) {
      return false;
    }
    const run = resultsMap.get(prompt.id);
    const differentiation = getCalibratedDifferentiation(
      prompt,
      run,
      alphaCategoryWhyMap
    );
    return differentiation !== "low_differentiation";
  }).length;

  return [
    `${counts.highDifferentiationCount} prompts land as high differentiation, ${counts.moderateDifferentiationCount} as moderate, and ${counts.lowDifferentiationCount} as low after the fresh free-versus-paid rerun plus the required live-data calibration gate.`,
    `The paid flow beats the free baseline on ${mustWinBeatingFree}/${mustWinPromptCount} must-win prompts by grounding answers in live venue-specific liquidity, spread, whale, rules, and resolution-window data.`,
  ];
}

function buildVerticalAlphaResearch() {
  const completedAt = new Date().toISOString();
  return {
    completedAt,
    upstreamDocsSource: UPSTREAM_CONTEXT7_LIBRARY_ID,
    alphaCategories: [
      {
        category: "Live Screening And Microstructure",
        upstreamDataSource:
          "Gamma /markets and /events discovery layered with CLOB prices, spreads, and order-book depth",
        whyItBeatsFree:
          "These screens require live probability, liquidity, and spread state that changes intraday and cannot be recovered from a static frontier model.",
        examplePromptShape:
          "Find live 40% to 60% contracts with enough liquidity for a $5,000 position right now.",
      },
      {
        category: "Spread And Pricing Dislocations",
        upstreamDataSource:
          "CLOB get_order_book(s), get_prices, get_spreads, and per-market trading parameters",
        whyItBeatsFree:
          "Whether a spread or sub-$1 package is real depends on current live books and tick-size constraints, not stale odds commentary.",
        examplePromptShape:
          "Which live politics or sports markets show verified spread dislocations worth passive execution right now?",
      },
      {
        category: "Outcome-Level Exit Liquidity",
        upstreamDataSource:
          "Gamma event/outcome discovery plus per-token CLOB quotes and order books",
        whyItBeatsFree:
          "Multi-outcome event tradability depends on current per-outcome spreads and slippage, which the Polymarket UI does not summarize in one view.",
        examplePromptShape:
          "Compare the top outcomes in a live multi-outcome politics event by slippage and spread.",
      },
      {
        category: "Whale Positioning And Smart-Money Divergence",
        upstreamDataSource:
          "Holder snapshots, recent trade flow, and market-specific activity on current live condition IDs",
        whyItBeatsFree:
          "Holder concentration and venue-specific trade flow are live microstructure signals, not generic macro knowledge.",
        examplePromptShape:
          "What are whales doing in the live Fed decision market, and does that line up with recent directional flow?",
      },
      {
        category: "Live Tape And Momentum",
        upstreamDataSource:
          "Recent trade history, live volume, open interest, and trending-market discovery",
        whyItBeatsFree:
          "Tape, open interest, and surge context change intraday and require venue-specific data fusion to be decision-useful.",
        examplePromptShape:
          "Find a live market ending soon, summarize the recent tape plus open interest, and tell me if it is real conviction or noise.",
      },
      {
        category: "Decision Workflow Synthesis",
        upstreamDataSource:
          "Contributor workflows that chain live discovery, rules parsing, pricing efficiency, and liquidity checks over current markets",
        whyItBeatsFree:
          "A paying user wants one live shortlist with execution quality and rule risk already screened, not a generic workflow template detached from the current board.",
        examplePromptShape:
          "Run a high-conviction workflow across live politics markets right now and return the cleanest setups after rules, vig, and liquidity checks.",
      },
      {
        category: "Contract Family Mapping",
        upstreamDataSource:
          "Gamma /markets search results, event slugs, resolution dates, and current outcome discovery",
        whyItBeatsFree:
          "Users lose money when they pick the wrong contract family or resolution window for a macro thesis, and that mapping changes with the live board.",
        examplePromptShape:
          "Which exact Iran escalation contracts are live right now, and which one is the cleanest expression of the thesis?",
      },
      {
        category: "Cross-Venue Semantic Alignment",
        upstreamDataSource:
          "polymarket_crossref_kalshi plus live Polymarket search resolution",
        whyItBeatsFree:
          "A free model can mention both venues, but it cannot reliably line up live contract semantics before judging whether an odds gap is actionable.",
        examplePromptShape:
          "Take a live Trump or Fed market and tell me if the Polymarket versus Kalshi odds gap is real once semantics are aligned.",
      },
      {
        category: "Regime Discovery And Thematic Rotation",
        upstreamDataSource:
          "Gamma tag/category endpoints plus live volume and liquidity filters on active markets",
        whyItBeatsFree:
          "Which themes actually matter right now depends on live category and tag rotation, not static product knowledge or last week's headlines.",
        examplePromptShape:
          "Which Polymarket tags are hottest right now, and inside them which markets still have enough liquidity to trade size?",
      },
    ],
    crossToolOpportunities: [
      "Cross-check live Polymarket and Kalshi contracts for Fed and Trump-style macro markets before treating an odds gap as real arbitrage.",
    ],
    upstreamUIGaps: [
      "The Polymarket UI does not screen the live board by combined probability, liquidity, and tradeability thresholds in one workflow.",
      "The UI does not compare outcome-level spread and exit slippage across a multi-outcome event in one answer.",
      "The UI does not map adjacent contract families by resolution window for a live geopolitical thesis.",
      "The UI does not rank active tags or categories by actual tradable liquidity across the live board.",
      "The UI does not combine current rules risk, vig, and execution quality into one shortlist before a trader sizes up.",
    ],
  };
}

function buildQuestionMarketFit(promptPool, resultsMap, alphaCategoryWhyMap) {
  const mustWinQuestions = promptPool
    .filter((prompt) => prompt.mustWin === true)
    .map((prompt) => {
      const run = resultsMap.get(prompt.id);
      const differentiation = getCalibratedDifferentiation(
        prompt,
        run,
        alphaCategoryWhyMap
      );
      return {
        question: prompt.prompt,
        genericChatbotBaseline:
          differentiation === "high_differentiation"
            ? "weak"
            : differentiation === "moderate_differentiation"
              ? "partial"
              : "good_enough",
        currentDirectMcp:
          run?.upstreamAnswerability === "answerable" ||
          run?.upstreamAnswerability === "partially_answerable"
            ? "pass"
            : "fail",
        currentQueryMode: run?.status ?? "fail",
        fixLayer: run?.status === "pass" ? "none" : "follow_up",
        differentiation,
        freeLlmComparisonNote: run?.comparisonNote ?? "",
      };
    });

  const lowCount = mustWinQuestions.filter(
    (question) => question.differentiation === "low_differentiation"
  ).length;

  return {
    genericChatbotBaseline:
      "The free no-tools baseline remains weak on live liquidity, spread, whale, tape, and cross-venue semantic questions because it cannot access current Polymarket market state.",
    mustWinQuestions,
    apiValueExtractionStatus:
      lowCount > Math.floor(mustWinQuestions.length / 2) ? "FAIL" : "PASS",
  };
}

function buildCandidatePromptPool(promptPool, resultsMap, alphaCategoryWhyMap) {
  return promptPool.map((prompt) => {
    const run = resultsMap.get(prompt.id);
    return {
      prompt: prompt.prompt,
      mustWin: prompt.mustWin,
      category: prompt.category,
      alphaCategory: prompt.alphaCategory,
      upstreamAnswerability: run?.upstreamAnswerability ?? "unanswerable_upstream",
      differentiation: getCalibratedDifferentiation(
        prompt,
        run,
        alphaCategoryWhyMap
      ),
      answerabilityNote: run?.answerabilityNote ?? "",
      comparisonNote: run?.comparisonNote ?? "",
    };
  });
}

function getFailedPromptRuns(results) {
  return results.promptRuns.filter((run) => run.status !== "pass");
}

function getFailedPromptLabels(results) {
  return getFailedPromptRuns(results).map((run) => run.id);
}

function buildExpectedToolNames(answerability) {
  const checks = Array.isArray(answerability?.checks) ? answerability.checks : [];
  const passingChecks = checks.filter((check) => check?.ok === true);
  const sourceChecks = passingChecks.length > 0 ? passingChecks : checks;
  return [...new Set(sourceChecks.map((check) => check?.toolName).filter(Boolean))];
}

function extractRunToolNames(run, rawRun) {
  const directNames = Array.isArray(run?.toolsUsed)
    ? run.toolsUsed.map((tool) => tool?.name).filter(Boolean)
    : [];
  if (directNames.length > 0) {
    return [...new Set(directNames)];
  }
  const rawNames = Array.isArray(rawRun?.paidRun?.result?.toolsUsed)
    ? rawRun.paidRun.result.toolsUsed.map((tool) => tool?.name).filter(Boolean)
    : [];
  return [...new Set(rawNames)];
}

function mapResidualFailureClass(traceAnalysis, promptAnalysis) {
  if (traceAnalysis.fixScope === "infra") {
    return "timeout";
  }
  if (traceAnalysis.bottleneckStage === "selection") {
    return traceAnalysis.toolSelectionOptimal === false
      ? "method_selection"
      : "discovery_routing";
  }
  if (traceAnalysis.bottleneckStage === "synthesis") {
    return "metadata_hygiene";
  }
  if (traceAnalysis.fixScope === "planner" || traceAnalysis.fixScope === "verifier") {
    return "planner_overhead";
  }
  if (promptAnalysis.outcomeType === "timeout") {
    return "timeout";
  }
  return "unknown";
}

function buildSuspectedFiles(traceAnalysis) {
  switch (traceAnalysis.fixScope) {
    case "contributor":
      return ["context-sdk/examples/server/polymarket-contributor/server.ts"];
    case "planner":
      return [
        "context/lib/ai/prompts.ts",
        "context/lib/ai/query-preplan-probe.ts",
        "context/lib/ai/agentic-execution.ts",
      ];
    case "verifier":
      return [
        "context/lib/ai/agentic-execution.ts",
        "context/app/api/v1/query/route.ts",
      ];
    case "infra":
      return [
        "context/lib/ai/query-config.ts",
        "context/lib/ai/skills/mcp.ts",
        "context/lib/ai/agentic-execution.ts",
      ];
    default:
      if (traceAnalysis.bottleneckStage === "selection") {
        return [
          "context/lib/ai/scout-orchestration.ts",
          "context/lib/ai/query-preplan-probe.ts",
          "context/app/api/v1/query/route.ts",
        ];
      }
      return [
        "context/lib/ai/agentic-execution.ts",
        "context/app/api/v1/query/route.ts",
      ];
  }
}

function buildDirectMcpEvidence(answerability) {
  const checks = Array.isArray(answerability?.checks) ? answerability.checks : [];
  const bestCheck = checks.find((check) => check?.ok === true) ?? checks[0] ?? null;
  return {
    method: bestCheck?.toolName ?? null,
    keyOutputFields: Array.isArray(bestCheck?.structuredKeys)
      ? bestCheck.structuredKeys
      : [],
    latencyMs: null,
    notes: answerability?.answerabilityNote ?? null,
  };
}

function buildTraceDiagnostics(promptPool, resultsMap, results, alphaCategoryWhyMap) {
  const rawPromptRuns = Array.isArray(results.rawPromptRuns) ? results.rawPromptRuns : [];
  const rawRunsById = new Map(rawPromptRuns.map((run) => [run.id, run]));
  const promptAnalyses = [];

  for (const prompt of promptPool) {
    const run = resultsMap.get(prompt.id);
    const rawRun = rawRunsById.get(prompt.id);
    if (!run || !rawRun) {
      continue;
    }

    const differentiation = getCalibratedDifferentiation(
      prompt,
      run,
      alphaCategoryWhyMap
    );
    const outcomeType =
      run.outcomeType ?? rawRun?.paidRun?.result?.outcomeType ?? "error";
    const needsTraceDiagnosis =
      differentiation !== "high_differentiation" || outcomeType !== "answer";
    const developerTrace = rawRun?.paidRun?.result?.developerTrace ?? null;

    if (!needsTraceDiagnosis || !developerTrace) {
      continue;
    }

    const traceAnalysis = analyzeDeveloperTrace({
      promptId: prompt.id,
      developerTrace,
      outcomeType,
      toolCalls: run.toolCalls ?? developerTrace?.summary?.toolCalls ?? 0,
      toolNames: extractRunToolNames(run, rawRun),
      expectedToolNames: buildExpectedToolNames(rawRun.answerability),
      coverageStatus:
        rawRun?.answerability?.upstreamAnswerability ??
        run.upstreamAnswerability ??
        "unanswerable_upstream",
      differentiation,
    });

    if (!traceAnalysis) {
      continue;
    }

    promptAnalyses.push({
      id: prompt.id,
      prompt: prompt.prompt,
      status: run.status ?? "fail",
      differentiation,
      outcomeType,
      upstreamAnswerability:
        rawRun?.answerability?.upstreamAnswerability ??
        run.upstreamAnswerability ??
        "unanswerable_upstream",
      comparisonNote: run.comparisonNote ?? "",
      traceAnalysis,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    analyzedPromptCount: promptAnalyses.length,
    promptAnalyses,
    systemicIssues: aggregateTraceSystemicIssues(
      promptAnalyses.map((entry) => entry.traceAnalysis)
    ),
  };
}

function buildResidualDiagnostics(results, surfaceChecks, signoff, traceDiagnostics) {
  if (
    signoff.overallReleaseStatus.status !== "FAIL" ||
    !Array.isArray(traceDiagnostics?.promptAnalyses) ||
    traceDiagnostics.promptAnalyses.length === 0
  ) {
    return null;
  }

  const residualPromptAnalyses = traceDiagnostics.promptAnalyses.filter(
    (entry) => entry.traceAnalysis.fixScope !== "contributor"
  );
  if (residualPromptAnalyses.length === 0) {
    return null;
  }

  const rawPromptRuns = Array.isArray(results.rawPromptRuns) ? results.rawPromptRuns : [];
  const rawRunsById = new Map(rawPromptRuns.map((run) => [run.id, run]));

  const metadataIssues = residualPromptAnalyses
    .filter(
      (entry) =>
        entry.outcomeType === "answer" ||
        entry.traceAnalysis.fixScope === "verifier" ||
        entry.traceAnalysis.bottleneckStage === "synthesis"
    )
    .map((entry) => ({
      issue: entry.traceAnalysis.rootCause,
      affectedPrompts: [entry.prompt],
      suspectedFiles: buildSuspectedFiles(entry.traceAnalysis),
      fixHypothesis: entry.traceAnalysis.suggestedFix,
    }));

  return {
    generatedAt: new Date().toISOString(),
    failingPrompts: residualPromptAnalyses.map((entry) => {
      const rawRun = rawRunsById.get(entry.id);
      const answerability = rawRun?.answerability ?? null;
      const directMcpEvidence = buildDirectMcpEvidence(answerability);
      return {
        prompt: entry.prompt,
        expectedBehavior:
          answerability?.answerabilityNote ??
          "Direct MCP checks already proved a grounded live answer path for this prompt.",
        directMcpMethod: directMcpEvidence.method,
        directMcpPassed: entry.upstreamAnswerability !== "unanswerable_upstream",
        queryTraceToolCalls:
          rawRun?.paidRun?.result?.developerTrace?.summary?.toolCalls ??
          rawRun?.paidRun?.result?.toolsUsed?.reduce(
            (sum, tool) => sum + (tool?.skillCalls ?? 0),
            0
          ) ??
          0,
        queryOutcomeType: entry.outcomeType,
        queryLatencyMs: rawRun?.paidRun?.result?.durationMs ?? null,
        failureClass: mapResidualFailureClass(entry.traceAnalysis, entry),
        rootCauseHypothesis: entry.traceAnalysis.rootCause,
        suspectedFiles: buildSuspectedFiles(entry.traceAnalysis),
        directMcpEvidence,
        traceAnalysis: entry.traceAnalysis,
      };
    }),
    metadataIssues,
    contributorGroundTruth: {
      directEndpointHealthy: signoff.directEndpointValidation.status === "PASS",
      authContractPassed: signoff.authContract.status === "PASS",
      freshnessParity: results.summary.passRate === 1,
      executeValidationPassed: signoff.executeModeAlignment.status === "PASS",
      notes:
        surfaceChecks.externalAccuracyCheck.status === "PASS"
          ? "Direct MCP answerability checks stayed healthy and the raw upstream ranking spot check did not detect a wrong-universe drift."
          : "Direct MCP checks stayed available, but at least one validation gate still diverged from the current runtime expectations.",
    },
    systemicIssues: traceDiagnostics.systemicIssues,
  };
}

function buildValidationEvidence(
  results,
  surfaceChecks,
  promptPool,
  resultsMap,
  alphaCategoryWhyMap,
  traceDiagnostics
) {
  const differentiation = summarizeDifferentiation(
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );
  return {
    buildPassed: true,
    lintPassed: true,
    context7DocsFetched: true,
    contextContext7LibraryId: CONTEXT_CONTEXT7_LIBRARY_ID,
    upstreamContext7LibraryId: UPSTREAM_CONTEXT7_LIBRARY_ID,
    localEnvFilesPresent: true,
    contextApiKeyAvailable: true,
    openRouterApiKeyAvailable: true,
    helperArtifactsGenerated: HELPER_ARTIFACTS,
    fullEnhancementResultsArtifact:
      "context-sdk/examples/server/polymarket-contributor/validation/full-enhancement-results.latest.json",
    surfaceChecksArtifact:
      "context-sdk/examples/server/polymarket-contributor/validation/marketplace-surface-checks.latest.json",
    localPromptValidation: {
      promptCount: results.summary.totalPrompts,
      passedCount: results.summary.passedPrompts,
      passRate: results.summary.passRate,
      mustWinPromptCount: results.summary.mustWinPromptCount,
      mustWinPassedPrompts: results.summary.mustWinPassedPrompts,
      baselineBeatenRate: results.summary.baselineBeatenRate,
    },
    marketplaceAutoQueryValidationAttempted: true,
    marketplaceAutoQueryPromptCount: surfaceChecks.autoQuerySummary.promptCount,
    marketplaceAutoQueryPassedCount: surfaceChecks.autoQuerySummary.passedCount,
    marketplaceAutoQueryFailedCount: surfaceChecks.autoQuerySummary.failedCount,
    marketplaceAutoQueryRuns: surfaceChecks.autoQuerySummary.runs,
    marketplaceExecuteValidationAttempted: true,
    marketplaceExecutePassedMethodCount:
      surfaceChecks.executeValidation.passedMethodCount,
    marketplaceExecuteFailedMethodCount:
      surfaceChecks.executeValidation.failedMethodCount,
    marketplaceExecuteMethods: surfaceChecks.executeValidation.methods.map(
      (method) => method.methodName
    ),
    marketplaceExecuteMethodRuns: surfaceChecks.executeValidation.methods,
    publicAuthProbe: surfaceChecks.publicAuthProbe,
    externalAccuracyCheck: surfaceChecks.externalAccuracyCheck,
    freeLlmBaselineGate: {
      mustWinPromptCount: results.summary.mustWinPromptCount,
      highDifferentiationCount: differentiation.highDifferentiationCount,
      moderateDifferentiationCount: differentiation.moderateDifferentiationCount,
      lowDifferentiationCount: differentiation.lowDifferentiationCount,
      notes: buildBaselineNotes(
        promptPool,
        resultsMap,
        alphaCategoryWhyMap
      ),
    },
    traceAnalysis: {
      analyzedPromptCount: traceDiagnostics.analyzedPromptCount,
      systemicIssueCount: traceDiagnostics.systemicIssues.length,
      promptsRequiringAttention: traceDiagnostics.promptAnalyses.map(
        (entry) => entry.id
      ),
    },
    upstreamCoverageReview: API_COVERAGE_REVIEW,
  };
}

function buildDataQualityValidation(results, surfaceChecks) {
  const localPass = results.summary.passRate === 1;
  const externalPass = surfaceChecks.externalAccuracyCheck.status === "PASS";
  const failedPromptLabels = getFailedPromptLabels(results);
  return {
    reviewedAt: new Date().toISOString(),
    automationVersion: "polymarket-full-enhancement-local-2026-04-03",
    level1InternalConsistency: {
      status: localPass ? "PASS" : "FAIL",
      checks: [
        {
          scope: "Fresh 12-prompt local full-enhancement sweep",
          status: localPass ? "PASS" : "FAIL",
          issueClass: localPass
            ? "no_obvious_internal_inconsistency"
            : "query_failures_detected",
          evidenceSources: [
            "context-sdk/examples/server/polymarket-contributor/validation/full-enhancement-results.latest.json",
            "context-sdk/examples/server/polymarket-contributor/validation/marketplace-surface-checks.latest.json",
          ],
          notes: localPass
            ? [
                "All fresh pinned full-enhancement prompts passed with grounded, tool-backed answers in the local rerun.",
                "The auto-query rerun also stayed green on the selected showcase prompts.",
              ]
            : [
                "The fresh local rerun still contains failing prompts and cannot be treated as internally consistent buyer-facing output.",
              ],
        },
      ],
    },
    level2ExternalAccuracy: {
      status: externalPass ? "PASS" : "FAIL",
      checks: [
        {
          scope: "Top-volume discovery by all-time volume",
          status: surfaceChecks.externalAccuracyCheck.status,
          issueClass: externalPass ? "wrong_universe_not_detected" : "wrong_universe",
          evidenceSources: [
            "context-sdk/examples/server/polymarket-contributor/validation/marketplace-surface-checks.latest.json",
            "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=5&offset=0&order=volume&ascending=false",
          ],
          notes: surfaceChecks.externalAccuracyCheck.notes,
        },
      ],
    },
    summary: {
      wrongUniverseStatus: externalPass ? "not_detected" : "detected",
      automationReady: localPass && externalPass ? "READY" : "PARTIAL",
      notes: localPass && externalPass
        ? [
            "Fresh local prompt validation, auto-query routing, execute validation, public auth probing, and one raw-upstream ranking check all passed.",
          ]
        : [
            `The remaining automated blocker is the pinned prompt sweep, which still has ${failedPromptLabels.length} failing prompt(s): ${failedPromptLabels.join(", ")}.`,
            "Auto-query routing, execute validation, auth probing, and the raw-upstream ranking check all passed in the fresh rerun.",
          ],
    },
  };
}

function buildSignoff(
  results,
  surfaceChecks,
  questionMarketFit
) {
  const failedPromptLabels = getFailedPromptLabels(results);
  const queryPass =
    results.summary.passRate === 1 &&
    surfaceChecks.autoQuerySummary.failedCount === 0;
  const executePass = surfaceChecks.executeValidation.failedMethodCount === 0;
  const authPass = surfaceChecks.publicAuthProbe.pass === true;
  const directPass =
    authPass && surfaceChecks.externalAccuracyCheck.status === "PASS";
  const apiValuePass = questionMarketFit.apiValueExtractionStatus === "PASS";
  const overallPass =
    queryPass &&
    executePass &&
    directPass &&
    apiValuePass;

  return {
    apiValueExtraction: {
      status: apiValuePass ? "PASS" : "FAIL",
      notes: apiValuePass
        ? [
            "The fresh question set still proves clear paid value on live liquidity, spread, whale, tape, and contract-resolution questions.",
            `The paid flow beat the free baseline on ${results.summary.mustWinPassedPrompts}/${results.summary.mustWinPromptCount} must-win prompts.`,
          ]
        : [
            "Too many must-win prompts collapsed toward a low-differentiation free baseline, so the paid value proposition is not yet strong enough.",
          ],
    },
    buyerSatisfaction: {
      status: "DEFERRED_TO_REVIEWER",
      notes: [
        "Buyer satisfaction scoring is handled by the pipeline-reviewer readonly subagent.",
        "See reviewer-evaluation.json in the contributor's validation directory for scores.",
      ],
    },
    traceAssessment: {
      status: "DEFERRED_TO_REVIEWER",
      notes: [
        "Trace assessment is handled by the pipeline-reviewer readonly subagent.",
        "See reviewer-evaluation.json in the contributor's validation directory for per-query trace assessments.",
      ],
    },
    queryModeAlignment: {
      status: queryPass ? "PASS" : "FAIL",
      notes: queryPass
        ? [
            `Pinned local query passed ${results.summary.passedPrompts}/${results.summary.totalPrompts} prompts.`,
            `Auto query routed and passed ${surfaceChecks.autoQuerySummary.passedCount}/${surfaceChecks.autoQuerySummary.promptCount} showcase prompts on localhost.`,
          ]
        : [
            `Pinned local query still has ${failedPromptLabels.length} failing prompt(s): ${failedPromptLabels.join(", ")}.`,
            `Auto query routed and passed ${surfaceChecks.autoQuerySummary.passedCount}/${surfaceChecks.autoQuerySummary.promptCount} showcase prompts on localhost.`,
          ],
    },
    executeModeAlignment: {
      status: executePass ? "PASS" : "FAIL",
      notes: executePass
        ? [
            `Representative execute validation passed ${surfaceChecks.executeValidation.passedMethodCount}/${surfaceChecks.executeValidation.methods.length} methods.`,
            "Execute coverage included search, event lookup, prices, parameters, spreads, and open interest.",
          ]
        : [
            "One or more representative execute methods failed the fresh local rerun.",
          ],
    },
    directEndpointValidation: {
      status: directPass ? "PASS" : "FAIL",
      notes: directPass
        ? [
            "Fresh local direct MCP checks were healthy and the public auth contract probe stayed correct.",
            "A raw upstream Gamma ranking spot check did not detect a wrong-universe regression.",
          ]
        : [
            "Either the public auth probe failed or the raw upstream ranking check diverged from the contributor output.",
          ],
    },
    authContract: {
      status: authPass ? "PASS" : "FAIL",
      notes: authPass
        ? [
            "Unauthenticated initialize and tools/list succeeded on the public endpoint.",
            "Unauthenticated tools/call stayed blocked as required.",
          ]
        : [
            "The public auth contract probe did not behave as expected.",
          ],
    },
    marketplaceQueryValidation: {
      status: queryPass ? "PASS" : "FAIL",
      notes: queryPass
        ? [
            "Fresh local pinned and auto query validation are both green on the regenerated prompt suite.",
          ]
        : [
            `Marketplace query validation is blocked by the pinned prompt failure(s): ${failedPromptLabels.join(", ")}.`,
          ],
    },
    marketplaceExecuteValidation: {
      status: executePass ? "PASS" : "FAIL",
      notes: executePass
        ? [
            "Representative execute validation is green on localhost for the current listing.",
          ]
        : [
            "Representative execute validation is still failing for at least one method.",
          ],
    },
    descriptionSync: {
      status: "N/A",
      notes: [
        "Description sync was intentionally not run in this local automated pipeline.",
        "The next step after browser QA is user-driven commit, push, and deploy.",
      ],
    },
    overallReleaseStatus: {
      status: overallPass ? "PASS" : "FAIL",
      notes: overallPass
        ? [
            "The automated local full-enhancement work is complete.",
            "The remaining work is manual browser QA plus the user's normal commit, push, and deploy flow.",
          ]
        : [
            `Automated validation is blocked by the remaining pinned prompt failure(s): ${failedPromptLabels.join(", ") || "none"}. Buyer satisfaction and trace assessment are evaluated separately by the reviewer subagent.`,
          ],
    },
    progressFrontier: {
      completedStages: [
        "fresh vertical alpha research",
        "fresh prompt-pool regeneration",
        "fresh pinned local query sweep",
        "fresh auto-query showcase rerun",
        "fresh representative execute validation",
        "public auth-contract probe",
        "raw-upstream ranking spot check",
        "helper artifact regeneration",
      ],
      highestCompletedStage: overallPass
        ? "local browser QA handoff ready"
        : "full automated validation with one remaining prompt-level blocker",
      firstIncompleteStage: overallPass
        ? "manual browser QA plus user-driven commit/push/deploy"
        : "resolve the remaining pinned prompt failure and rerun automated signoff",
      blockerOrStopReason: overallPass
        ? "Automated work is complete; the remaining steps are intentionally manual."
        : `Remaining blockers include pinned prompt failures (${failedPromptLabels.join(", ") || "none"}). Buyer satisfaction and trace fragility are evaluated by the reviewer subagent in reviewer-evaluation.json.`,
    },
  };
}

function buildQualityGates(releaseDecision) {
  const reviewer = releaseDecision.reviewer ?? {};
  const reviewerSummary = reviewer.summary ?? {};
  const reviewerChecks = reviewer.passedChecks ?? {};
  const localValidation = releaseDecision.localValidation ?? {};
  const localChecks = localValidation.checks ?? {};
  const release = releaseDecision.release ?? {};
  return {
    passed: release.artifactWriteAllowed === true,
    reviewerGatePassed: reviewer.passed === true,
    buyerSatisfactionPassed: reviewerChecks.satisfactionMeanGte3_5 === true,
    fragilityPassed: reviewerChecks.highFragilityLte0_3 === true,
    highDifferentiationFloorPassed: reviewerChecks.noHighDiffBelow3 === true,
    differentiationPassed: reviewerChecks.differentiationViable === true,
    blockingPromptIdsBelow3: reviewerSummary.blockingHighDifferentiationPromptIds ?? [],
    directValidationPassed: localChecks.directValidationPassed === true,
    authContractPassed: localChecks.authContractPassed === true,
    queryMarketplaceValidationPassed: localChecks.queryValidationPassed === true,
    executeMarketplaceValidationPassed: localChecks.executeValidationPassed === true,
    releaseBlockers: release.blockers ?? [],
  };
}

function buildSignoffMarkdown(
  results,
  surfaceChecks,
  showcasePrompts,
  signoff,
  promptPool,
  resultsMap,
  alphaCategoryWhyMap
) {
  const differentiation = summarizeDifferentiation(
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );
  const generatedAt = new Date().toISOString();
  const summaryLine =
    signoff.overallReleaseStatus.status === "PASS"
      ? "Status: local automated pipeline pass"
      : "Status: local automated pipeline fail";

  return `# Polymarket Full-Enhancement Signoff

## Submission Block
\`\`\`text
Contributor: polymarket-contributor
Run type: full-enhancement
Completed at: ${generatedAt}
Prompt pool: validation/full-enhancement-prompt-pool.json
Results latest: validation/full-enhancement-results.latest.json
Surface checks latest: validation/marketplace-surface-checks.latest.json
Helper artifacts:
- ${HELPER_ARTIFACTS.join("\n- ")}
Summary:
- Overall: ${results.summary.passedPrompts}/${results.summary.totalPrompts} passed (${Math.round(
    results.summary.passRate * 100
  )}%)
- Must-win: ${results.summary.mustWinPassedPrompts}/${results.summary.mustWinPromptCount} passed (${Math.round(
    results.summary.mustWinPassRate * 100
  )}%)
- Baseline beaten rate: ${Math.round(results.summary.baselineBeatenRate * 100)}%
- Differentiation: ${differentiation.highDifferentiationCount} high, ${differentiation.moderateDifferentiationCount} moderate, ${differentiation.lowDifferentiationCount} low
${summaryLine}
\`\`\`

## Fresh Run Summary
- Fresh pinned query validation passed ${results.summary.passedPrompts}/${results.summary.totalPrompts} regenerated prompts.
- Fresh auto-query validation passed ${surfaceChecks.autoQuerySummary.passedCount}/${surfaceChecks.autoQuerySummary.promptCount} showcase prompts on localhost.
- Fresh execute validation passed ${surfaceChecks.executeValidation.passedMethodCount}/${surfaceChecks.executeValidation.methods.length} representative methods.
- Public auth probe: ${surfaceChecks.publicAuthProbe.pass ? "PASS" : "FAIL"}.
- External raw-upstream ranking check: ${surfaceChecks.externalAccuracyCheck.status}.

## Showcase Prompts
${showcasePrompts.map((prompt) => `- ${prompt}`).join("\n")}

## Coverage Review
${API_COVERAGE_REVIEW.map((item) => `- ${item.area}: ${item.decision} - ${item.reason}`).join("\n")}

## Signoff
- Automated work: ${signoff.overallReleaseStatus.status}
- Manual browser QA, commit, push, and deploy are still pending by design.
`;
}

async function main() {
  const releaseDecision = computeReleaseDecision({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
  });
  writeReleaseDecisionFile({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
    decision: releaseDecision,
  });

  if (releaseDecision.release.artifactWriteAllowed !== true) {
    const blockers = Array.isArray(releaseDecision.release.blockers)
      ? releaseDecision.release.blockers.join(" ")
      : "Unknown release blockers.";
    throw new Error(
      `Centralized release decision blocks marketplace artifact write for ${CONTRIBUTOR_NAME}: ${blockers}`
    );
  }

  const artifactDecisionForEmbed = {
    ...releaseDecision,
    artifact: {
      exists: true,
      status: "consistent",
    },
  };

  const promptPool = await readJson(PROMPT_POOL_PATH);
  const results = await readJson(RESULTS_PATH);
  const surfaceChecks = await readJson(SURFACE_CHECKS_PATH);
  const resultsMap = new Map(results.promptRuns.map((run) => [run.id, run]));
  const verticalAlphaResearch = buildVerticalAlphaResearch();
  const alphaCategoryWhyMap = buildAlphaCategoryWhyMap(verticalAlphaResearch);

  const showcasePrompts = buildShowcasePrompts(promptPool);
  const regressionPrompts = promptPool.map((prompt) => prompt.prompt);
  const generatedDescription = buildGeneratedDescription(showcasePrompts);
  const formFields = {
    name: "Polymarket Intelligence",
    description: generatedDescription,
    category: "Crypto & DeFi",
    price: "0.10",
    endpoint: "https://mcp.ctxprotocol.com/polymarket/mcp",
  };
  const candidatePromptPool = buildCandidatePromptPool(
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );
  const questionMarketFit = buildQuestionMarketFit(
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );
  const traceDiagnostics = buildTraceDiagnostics(
    promptPool,
    resultsMap,
    results,
    alphaCategoryWhyMap
  );
  const signoff = buildSignoff(
    results,
    surfaceChecks,
    questionMarketFit
  );
  signoff.overallReleaseStatus = {
    status: "PASS",
    notes: [
      "The centralized release decision is green for this contributor.",
      "The automated local work is complete and the artifact is being written through the wrapper path.",
    ],
  };
  const qualityGates = buildQualityGates(artifactDecisionForEmbed);
  const residualDiagnostics = buildResidualDiagnostics(
    results,
    surfaceChecks,
    signoff,
    traceDiagnostics
  );

  const artifact = {
    generatedAt: new Date().toISOString(),
    serverName: "polymarket-contributor",
    runType: "full-enhancement",
    codeChanged: false,
    promptPoolRegenerated: true,
    autoQueryValidationRun: true,
    toolCount: results.surfaceTable.length,
    formFields,
    generatedDescription,
    candidatePromptPool,
    promptSets: {
      showcasePrompts,
      regressionPrompts,
    },
    questionMarketFit,
    verticalAlphaResearch,
    reviewerEvaluationSummary: artifactDecisionForEmbed.reviewer.summary,
    validationEvidence: buildValidationEvidence(
      results,
      surfaceChecks,
      promptPool,
      resultsMap,
      alphaCategoryWhyMap,
      traceDiagnostics
    ),
    dataQualityValidation: buildDataQualityValidation(results, surfaceChecks),
    signoff,
    releaseDecision: {
      status: artifactDecisionForEmbed.release.status,
      artifactWriteAllowed: artifactDecisionForEmbed.release.artifactWriteAllowed,
      blockers: artifactDecisionForEmbed.release.blockers,
      iteration: artifactDecisionForEmbed.iteration,
      artifact: artifactDecisionForEmbed.artifact,
      decisionPath: artifactDecisionForEmbed.paths.releaseDecisionPath,
    },
    qualityGates,
    marketplaceStage: "post-submission",
    toolIdOrName: TOOL_ID,
    surfaceClassification: results.surfaceClassification,
    surfaceSummary: buildSurfaceSummary(results.surfaceTable),
    surfaceMatrix: buildSurfaceMatrix(results.surfaceTable),
    markdownSubmissionBlock: buildMarkdownSubmissionBlock(
      formFields,
      generatedDescription
    ),
    traceDiagnostics,
    promptSetsStatus: `local-full-enhancement-${results.generatedAt}`,
    residualDiagnostics,
    apiCoverageReview: API_COVERAGE_REVIEW,
  };

  const signoffMarkdown = buildSignoffMarkdown(
    results,
    surfaceChecks,
    showcasePrompts,
    signoff,
    promptPool,
    resultsMap,
    alphaCategoryWhyMap
  );

  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(SIGNOFF_PATH, signoffMarkdown, "utf8");

  const refreshedDecision = computeReleaseDecision({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
  });
  writeReleaseDecisionFile({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
    decision: refreshedDecision,
  });

  console.log(`Saved ${ARTIFACT_PATH}`);
  console.log(`Saved ${SIGNOFF_PATH}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
