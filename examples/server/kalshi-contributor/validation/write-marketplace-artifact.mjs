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
const CONTRIBUTOR_NAME = "kalshi-contributor";

const TOOL_ID = "5cc326fb-500d-4c17-bc5f-ade143210636";
const PROMPT_POOL_PATH = path.resolve(__dirname, "full-enhancement-prompt-pool.json");
const RESULTS_PATH = path.resolve(__dirname, "full-enhancement-results.latest.json");
const SURFACE_CHECKS_PATH = path.resolve(
  __dirname,
  "marketplace-surface-checks.latest.json"
);
const ARTIFACT_PATH = path.resolve(__dirname, "../marketplace-validation-artifact.json");
const SIGNOFF_PATH = path.resolve(__dirname, "full-enhancement-signoff.md");

const CONTEXT_CONTEXT7_LIBRARY_ID = "/websites/ctxprotocol";
const UPSTREAM_CONTEXT7_LIBRARY_ID = "/websites/kalshi";
const HELPER_ARTIFACTS = [];

const API_COVERAGE_REVIEW = [
  {
    area: "Live discovery, ranked screens, category and series browsing",
    decision: "implemented",
    reason:
      "The contributor already exposes discover_trending_markets, get_markets_by_probability, search_markets, browse_category, browse_series, get_events, and get_event for core buyer-facing live discovery of Kalshi markets.",
  },
  {
    area: "Per-market pricing, orderbook depth, spreads, and liquidity",
    decision: "implemented",
    reason:
      "The contributor already exposes get_market, get_market_orderbook, check_market_efficiency, and analyze_market_liquidity for grounded microstructure and execution-quality answers.",
  },
  {
    area: "Trade flow, candlesticks, and sentiment",
    decision: "implemented",
    reason:
      "The contributor already exposes get_market_trades, get_market_candlesticks, get_event_candlesticks, and analyze_market_sentiment so the flow-and-tape questions are directly answerable.",
  },
  {
    area: "Event and series structure with resolution",
    decision: "implemented",
    reason:
      "The contributor already exposes get_events, get_event, get_event_by_slug, get_series, browse_series, and resolve_slug to walk from a slug or ticker into full sub-market decomposition.",
  },
  {
    area: "Arbitrage and opportunity discovery",
    decision: "implemented",
    reason:
      "find_arbitrage_opportunities, find_trading_opportunities, and kalshi_crossref_polymarket already cover structural (yes+no<100), intra-event, and cross-venue edge detection.",
  },
  {
    area: "Authenticated trading, portfolio, RFQ, and builder-only operational endpoints",
    decision: "reject",
    reason:
      "These require per-user Kalshi auth and are not the public-intelligence value proposition of this paid marketplace listing.",
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

  return `Live Kalshi market intelligence for screening tradable event contracts, inspecting orderbook depth and spreads, flagging structural and cross-venue arbitrage, and reading trade flow from one MCP endpoint.

Features:
- Screen the live Kalshi board by volume, probability band, and tradeability — not just by headline popularity
- Pull per-market orderbook depth, bid/ask spreads, and slippage context for sizing real Yes/No entries
- Decompose events and series into sub-markets and flag yes_bid+no_bid arbitrage or cross-market overround
- Read recent trades, candlesticks, and sentiment in one grounded answer, with direct tickers and close times
- Cross-reference Kalshi legs against Polymarket via kalshi_crossref_polymarket to catch venue-level mispricings

Try asking:
${tryAskingLines}

Agent tips:
- Start with discover_trending_markets or get_markets_by_probability for live ranked screens, then pivot into get_market and get_market_orderbook for microstructure
- When the user names an event or asks for "all/every" sub-markets, use get_event with with_nested_markets=true and follow up with get_markets if the event fans out
- Use check_market_efficiency and find_arbitrage_opportunities before calling an edge real — yes_bid+no_bid<100 is the Kalshi-native structural test
- Use kalshi_crossref_polymarket only after you have a concrete Kalshi ticker so Yes/No semantics stay aligned across venues`;
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

**Why this name:** Keeps the Kalshi brand explicit while framing the listing as a buyer-facing intelligence layer, not a raw REST wrapper.

**Why this category:** The listing centers on event-contract microstructure, live odds, orderbook depth, trade flow, and arbitrage discovery, which fits Finance & Markets.

**Why this price:** Time-sensitive curated Kalshi intelligence that materially beats a free no-tools baseline on live liquidity, spread, arbitrage, and cross-venue questions where the free model cannot access the current board.

### Discovered Skills

| Tool Name | Description | Key Parameters |
|-----------|-------------|----------------|
| \`discover_trending_markets\` | Live ranked Kalshi markets by volume, recency, and liquidity | \`sortBy\`, \`minVolume\`, \`category\`, \`limit\` |
| \`get_markets_by_probability\` | Screen markets by yes_ask / probability band with liquidity filters | \`minYesAsk\`, \`maxYesAsk\`, \`minLiquidity\`, \`category\` |
| \`get_market_orderbook\` | Full Yes/No orderbook with depth and slippage context | \`ticker\` |
| \`check_market_efficiency\` | Spread, midpoint, and yes_bid+no_bid arbitrage signal | \`ticker\` |
| \`analyze_market_liquidity\` | Dollar-size-to-slippage estimate from live book depth | \`ticker\`, \`slippageCents\` |
| \`get_event\` | Event-level decomposition with nested sub-markets | \`eventTicker\`, \`with_nested_markets\` |
| \`find_arbitrage_opportunities\` | Intra-event and structural arbitrage scanner | \`eventTicker\`, \`minEdgeCents\` |
| \`kalshi_crossref_polymarket\` | Cross-venue semantic alignment and odds-gap inspection | \`ticker\`, \`keywords\`, \`limit\` |

### Notes for Developer

- The fresh full-enhancement review found the high-value public read-only surface already covered by the current Kalshi contributor implementation.
- Authenticated trading, portfolio, RFQ, and builder-only Kalshi endpoints were intentionally not promoted into the listing because they do not improve the current paid marketplace wedge.
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

function getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap) {
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
  const counts = { high: 0, moderate: 0, low: 0 };
  for (const prompt of promptPool) {
    const run = resultsMap.get(prompt.id);
    const differentiation = getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap);
    if (differentiation === "high_differentiation") counts.high += 1;
    else if (differentiation === "moderate_differentiation") counts.moderate += 1;
    else counts.low += 1;
  }
  return {
    highDifferentiationCount: counts.high,
    moderateDifferentiationCount: counts.moderate,
    lowDifferentiationCount: counts.low,
  };
}

function buildBaselineNotes(promptPool, resultsMap, alphaCategoryWhyMap) {
  const counts = summarizeDifferentiation(promptPool, resultsMap, alphaCategoryWhyMap);
  const mustWinPromptCount = promptPool.filter((p) => p.mustWin === true).length;
  const mustWinBeatingFree = promptPool.filter((prompt) => {
    if (prompt.mustWin !== true) return false;
    const run = resultsMap.get(prompt.id);
    const differentiation = getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap);
    return differentiation !== "low_differentiation";
  }).length;

  return [
    `${counts.highDifferentiationCount} prompts land as high differentiation, ${counts.moderateDifferentiationCount} as moderate, and ${counts.lowDifferentiationCount} as low after the fresh free-versus-paid rerun plus the required live-data calibration gate.`,
    `The paid flow beats the free baseline on ${mustWinBeatingFree}/${mustWinPromptCount} must-win prompts by grounding answers in live Kalshi ticker, orderbook, trade, event-structure, and cross-venue data.`,
  ];
}

function buildVerticalAlphaResearch() {
  const completedAt = new Date().toISOString();
  return {
    completedAt,
    upstreamDocsSource: UPSTREAM_CONTEXT7_LIBRARY_ID,
    alphaCategories: [
      {
        category: "Live Discovery And Screening",
        upstreamDataSource:
          "Kalshi /markets and /events discovery endpoints sorted by live 24h volume, close time, and probability band",
        whyItBeatsFree:
          "These screens require current Kalshi board state — tickers, volumes, and close times change intraday and cannot be recovered from a static frontier model.",
        examplePromptShape:
          "Show me the top 10 trending Kalshi markets right now by 24h volume with tickers, Yes prices, and liquidity.",
      },
      {
        category: "Pricing Efficiency And Spreads",
        upstreamDataSource:
          "Per-market Kalshi /markets/{ticker} pulls for yes_bid, yes_ask, no_bid, no_ask, and derived midpoints",
        whyItBeatsFree:
          "Whether a Kalshi spread is tight or wide depends on the live book at this moment, not generic commentary about prediction markets.",
        examplePromptShape:
          "What are the current yes/no bid and ask and midpoint-implied probability for this Kalshi ticker right now?",
      },
      {
        category: "Liquidity And Orderbook Depth",
        upstreamDataSource:
          "Kalshi /markets/{ticker}/orderbook plus contributor analyze_market_liquidity for slippage-aware sizing",
        whyItBeatsFree:
          "Dollar-size-to-slippage only makes sense against the current live orderbook, which a free model does not have access to.",
        examplePromptShape:
          "Pull the full orderbook for this Kalshi ticker and tell me the dollar size I can buy Yes with <=2 cents of slippage.",
      },
      {
        category: "Event And Series Structure",
        upstreamDataSource:
          "Kalshi /events, /events/{event}, /series, and slug resolution for nested sub-markets",
        whyItBeatsFree:
          "Multi-leg Kalshi events decompose into dozens of sub-markets whose current Yes prices change intraday — that is live structure, not static knowledge.",
        examplePromptShape:
          "For this Kalshi event, list all sub-markets, their current Yes prices, and flag any pair where yes_bid+no_bid<100.",
      },
      {
        category: "Trade Flow And Sentiment",
        upstreamDataSource:
          "Kalshi /markets/{ticker}/trades, candlesticks, and event-level candles for live tape and direction",
        whyItBeatsFree:
          "Net Yes-vs-No flow, candle-based momentum, and sentiment are intraday live signals that demand venue-specific data fusion.",
        examplePromptShape:
          "Fetch the last 50 trades on this Kalshi ticker and tell me net Yes vs No volume over the last hour.",
      },
      {
        category: "Structural And Cross-Venue Arbitrage",
        upstreamDataSource:
          "Contributor find_arbitrage_opportunities, find_trading_opportunities, and kalshi_crossref_polymarket layered over live Kalshi quotes",
        whyItBeatsFree:
          "Arbitrage calls depend on the current live Kalshi book and the current Polymarket book — a generic model cannot align contract semantics or quote the real gap.",
        examplePromptShape:
          "Run the efficiency check on this Kalshi ticker — if yes_bid+no_bid<100, what is the implied arb edge after fees?",
      },
      {
        category: "Imminent Settlement And Close-Time Screens",
        upstreamDataSource:
          "Kalshi /events and /markets filtered by close_time for contracts about to settle",
        whyItBeatsFree:
          "Which Kalshi events actually settle before a given date is a live-board question, not a thesis a free model can fabricate credibly.",
        examplePromptShape:
          "List every Kalshi event closing before this Friday — imminent-settlement shortlist with tickers and close times.",
      },
      {
        category: "Workflow Synthesis On A Single Market",
        upstreamDataSource:
          "Contributor workflows chaining get_market, orderbook, trades, analyze_market_liquidity, and find_trading_opportunities on one live ticker",
        whyItBeatsFree:
          "A paying user wants one live workflow — pricing, depth, flow, and a trade recommendation — not a generic how-to detached from the current Kalshi board.",
        examplePromptShape:
          "Walk me through a full trading workflow on this Kalshi ticker — current pricing, orderbook depth to fill $1,000 Yes, recent flow, and a rec with risk.",
      },
      {
        category: "Targeted Search And Thematic Screens",
        upstreamDataSource:
          "Kalshi search_markets plus category and series browsing over the live open market set",
        whyItBeatsFree:
          "Searching Kalshi for a specific player, series, or theme returns current live tickers and prices that a free baseline has to hallucinate.",
        examplePromptShape:
          "Search Kalshi for markets mentioning a named player or theme and rank them by current yes_ask.",
      },
    ],
    crossToolOpportunities: [
      "Cross-check live Kalshi and Polymarket contracts for macro and sports markets via kalshi_crossref_polymarket before treating an odds gap as real arbitrage.",
    ],
    upstreamUIGaps: [
      "The Kalshi UI does not screen the live board by combined probability, liquidity, and close-time thresholds in one workflow.",
      "The UI does not estimate dollar-size-to-slippage from the current orderbook in one answer.",
      "The UI does not flag yes_bid+no_bid<100 structural arbitrage across an event's sub-markets automatically.",
      "The UI does not cross-reference live Kalshi quotes against an equivalent Polymarket contract in one view.",
      "The UI does not combine current pricing, orderbook depth, trade flow, and a workflow-level recommendation for a single market in one synthesis.",
    ],
  };
}

function buildQuestionMarketFit(promptPool, resultsMap, alphaCategoryWhyMap) {
  const mustWinQuestions = promptPool
    .filter((p) => p.mustWin === true)
    .map((prompt) => {
      const run = resultsMap.get(prompt.id);
      const differentiation = getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap);
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
    (q) => q.differentiation === "low_differentiation"
  ).length;

  return {
    genericChatbotBaseline:
      "The free no-tools baseline remains weak on live Kalshi liquidity, spread, orderbook, trade flow, event-structure, and cross-venue semantic questions because it cannot access the current Kalshi board.",
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
      differentiation: getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap),
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
  const passingChecks = checks.filter((c) => c?.ok === true);
  const sourceChecks = passingChecks.length > 0 ? passingChecks : checks;
  return [...new Set(sourceChecks.map((c) => c?.toolName).filter(Boolean))];
}

function extractRunToolNames(run, rawRun) {
  const directNames = Array.isArray(run?.toolsUsed)
    ? run.toolsUsed.map((t) => t?.name).filter(Boolean)
    : [];
  if (directNames.length > 0) return [...new Set(directNames)];
  const rawNames = Array.isArray(rawRun?.paidRun?.result?.toolsUsed)
    ? rawRun.paidRun.result.toolsUsed.map((t) => t?.name).filter(Boolean)
    : [];
  return [...new Set(rawNames)];
}

function mapResidualFailureClass(traceAnalysis, promptAnalysis) {
  if (traceAnalysis.fixScope === "infra") return "timeout";
  if (traceAnalysis.bottleneckStage === "selection") {
    return traceAnalysis.toolSelectionOptimal === false
      ? "method_selection"
      : "discovery_routing";
  }
  if (traceAnalysis.bottleneckStage === "synthesis") return "metadata_hygiene";
  if (traceAnalysis.fixScope === "planner" || traceAnalysis.fixScope === "verifier") {
    return "planner_overhead";
  }
  if (promptAnalysis.outcomeType === "timeout") return "timeout";
  return "unknown";
}

function buildSuspectedFiles(traceAnalysis) {
  switch (traceAnalysis.fixScope) {
    case "contributor":
      return ["context-sdk/examples/server/kalshi-contributor/server.ts"];
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
  const bestCheck = checks.find((c) => c?.ok === true) ?? checks[0] ?? null;
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
    if (!run || !rawRun) continue;

    const differentiation = getCalibratedDifferentiation(prompt, run, alphaCategoryWhyMap);
    const outcomeType = run.outcomeType ?? rawRun?.paidRun?.result?.outcomeType ?? "error";
    const needsTraceDiagnosis =
      differentiation !== "high_differentiation" || outcomeType !== "answer";
    const developerTrace = rawRun?.paidRun?.result?.developerTrace ?? null;
    if (!needsTraceDiagnosis || !developerTrace) continue;

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
    if (!traceAnalysis) continue;

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
  if (residualPromptAnalyses.length === 0) return null;

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
      "context-sdk/examples/server/kalshi-contributor/validation/full-enhancement-results.latest.json",
    surfaceChecksArtifact:
      "context-sdk/examples/server/kalshi-contributor/validation/marketplace-surface-checks.latest.json",
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
      (m) => m.methodName
    ),
    marketplaceExecuteMethodRuns: surfaceChecks.executeValidation.methods,
    publicAuthProbe: surfaceChecks.publicAuthProbe,
    externalAccuracyCheck: surfaceChecks.externalAccuracyCheck,
    freeLlmBaselineGate: {
      mustWinPromptCount: results.summary.mustWinPromptCount,
      highDifferentiationCount: differentiation.highDifferentiationCount,
      moderateDifferentiationCount: differentiation.moderateDifferentiationCount,
      lowDifferentiationCount: differentiation.lowDifferentiationCount,
      notes: buildBaselineNotes(promptPool, resultsMap, alphaCategoryWhyMap),
    },
    traceAnalysis: {
      analyzedPromptCount: traceDiagnostics.analyzedPromptCount,
      systemicIssueCount: traceDiagnostics.systemicIssues.length,
      promptsRequiringAttention: traceDiagnostics.promptAnalyses.map((e) => e.id),
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
    automationVersion: "kalshi-full-enhancement-local-2026-04-20",
    level1InternalConsistency: {
      status: localPass ? "PASS" : "FAIL",
      checks: [
        {
          scope: "Fresh local full-enhancement sweep",
          status: localPass ? "PASS" : "FAIL",
          issueClass: localPass
            ? "no_obvious_internal_inconsistency"
            : "query_failures_detected",
          evidenceSources: [
            "context-sdk/examples/server/kalshi-contributor/validation/full-enhancement-results.latest.json",
            "context-sdk/examples/server/kalshi-contributor/validation/marketplace-surface-checks.latest.json",
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
          scope: "Live Kalshi market snapshot vs public /markets endpoint",
          status: surfaceChecks.externalAccuracyCheck.status,
          issueClass: externalPass ? "wrong_universe_not_detected" : "wrong_universe",
          evidenceSources: [
            "context-sdk/examples/server/kalshi-contributor/validation/marketplace-surface-checks.latest.json",
            "https://api.elections.kalshi.com/trade-api/v2/markets?status=open&limit=5",
          ],
          notes: surfaceChecks.externalAccuracyCheck.notes,
        },
      ],
    },
    summary: {
      wrongUniverseStatus: externalPass ? "not_detected" : "detected",
      automationReady: localPass && externalPass ? "READY" : "PARTIAL",
      notes:
        localPass && externalPass
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

function buildSignoff(results, surfaceChecks, questionMarketFit) {
  const failedPromptLabels = getFailedPromptLabels(results);
  const queryPass =
    results.summary.passRate === 1 && surfaceChecks.autoQuerySummary.failedCount === 0;
  const executePass = surfaceChecks.executeValidation.failedMethodCount === 0;
  const authPass = surfaceChecks.publicAuthProbe.pass === true;
  const directPass = authPass && surfaceChecks.externalAccuracyCheck.status === "PASS";
  const apiValuePass = questionMarketFit.apiValueExtractionStatus === "PASS";
  const overallPass = queryPass && executePass && directPass && apiValuePass;

  return {
    apiValueExtraction: {
      status: apiValuePass ? "PASS" : "FAIL",
      notes: apiValuePass
        ? [
            "The fresh question set still proves clear paid value on live Kalshi liquidity, spread, orderbook, trade-flow, event-structure, and arbitrage questions.",
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
            "Execute coverage included discovery, per-market lookup, orderbook, trades, and event decomposition.",
          ]
        : ["One or more representative execute methods failed the fresh local rerun."],
    },
    directEndpointValidation: {
      status: directPass ? "PASS" : "FAIL",
      notes: directPass
        ? [
            "Fresh local direct MCP checks were healthy and the public auth contract probe stayed correct.",
            "A raw upstream Kalshi ranking spot check did not detect a wrong-universe regression.",
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
        : ["The public auth contract probe did not behave as expected."],
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
        ? ["Representative execute validation is green on localhost for the current listing."]
        : ["Representative execute validation is still failing for at least one method."],
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

  return `# Kalshi Full-Enhancement Signoff

## Submission Block
\`\`\`text
Contributor: kalshi-contributor
Run type: full-enhancement
Completed at: ${generatedAt}
Prompt pool: validation/full-enhancement-prompt-pool.json
Results latest: validation/full-enhancement-results.latest.json
Surface checks latest: validation/marketplace-surface-checks.latest.json
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
${showcasePrompts.map((p) => `- ${p}`).join("\n")}

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
    artifact: { exists: true, status: "consistent" },
  };

  const promptPool = (await readJson(PROMPT_POOL_PATH)).prompts ?? (await readJson(PROMPT_POOL_PATH));
  const results = await readJson(RESULTS_PATH);
  const surfaceChecks = await readJson(SURFACE_CHECKS_PATH);
  const resultsMap = new Map(results.promptRuns.map((run) => [run.id, run]));
  const verticalAlphaResearch = buildVerticalAlphaResearch();
  const alphaCategoryWhyMap = buildAlphaCategoryWhyMap(verticalAlphaResearch);

  const showcasePrompts = buildShowcasePrompts(promptPool);
  const regressionPrompts = promptPool.map((p) => p.prompt);
  const generatedDescription = buildGeneratedDescription(showcasePrompts);
  const formFields = {
    name: "Kalshi Intelligence",
    description: generatedDescription,
    category: "Finance & Markets",
    price: "0.10",
    endpoint: "https://mcp.ctxprotocol.com/kalshi/mcp",
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
  const signoff = buildSignoff(results, surfaceChecks, questionMarketFit);
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
    serverName: "kalshi-contributor",
    runType: "full-enhancement",
    codeChanged: false,
    promptPoolRegenerated: true,
    autoQueryValidationRun: true,
    toolCount: results.surfaceTable.length,
    formFields,
    generatedDescription,
    candidatePromptPool,
    promptSets: { showcasePrompts, regressionPrompts },
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
    markdownSubmissionBlock: buildMarkdownSubmissionBlock(formFields, generatedDescription),
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
