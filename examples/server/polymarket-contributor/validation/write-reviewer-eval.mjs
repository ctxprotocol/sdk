import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { refreshReleaseDecision } from "./refresh-release-decision.mjs";
import { assertLegacyReviewerHelperEnabled } from "./reviewer-helper-contract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
assertLegacyReviewerHelperEnabled({
  importMetaUrl: import.meta.url,
  why: "This script writes a fully hard-coded reviewer fixture from an old run.",
});

const reviewerEval = {
  "reviewedAt": "2026-04-05T09:45:00.000Z",
  "perQueryEvaluations": [
    {
      "query": "What's the current liquidity depth on Polymarket's top political market? If I wanted to exit a $10,000 YES position, how much slippage would I face?",
      "quotedExcerpts": ["To help you calculate your exit slippage, should I analyze the liquidity for all outcomes across the entire presidential market, or focus specifically on the l…", "Reply with one of the options above or send your own wording if none fit exactly."],
      "satisfactionScores": {"actionability":1,"dataFreshness":1,"specificity":1,"uniqueness":1,"completeness":1,"dataAccuracy":2},
      "satisfactionMean": 1.17,
      "scoreExplanations": {"actionability":"Zero data. System asked a question instead of answering.","dataFreshness":"No data returned.","specificity":"No numbers, no market names, no slippage.","uniqueness":"A free chatbot would at least attempt to answer.","completeness":"Neither part addressed.","dataAccuracy":"No data to evaluate."},
      "traceAssessment": {"toolSelectionClean":false,"retryCount":0,"selfHealCount":0,"budgetConsumedPct":0,"fragilityRisk":"low","selectionIssue":"Two possible tools identified but system punted to user with clarification menu.","planningIssue":"Planner decided clarification needed when query is clear enough to proceed.","executionIssue":"No execution - zero tool calls.","completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":null,"rootCauseCategory":"stage_reflection_error","rootCauseEvidence":"outcomeType is clarification_required, toolCalls is 0. Query mentions 'top political market' + '$10,000 YES position' which is discoverable.","responseQualityNote":"Complete failure - buyer gets nothing.","improvementLever":"Eliminate clarification prompts for queries with sufficient specificity."},
      "overallVerdict": "Would demand a refund."
    },
    {
      "query": "Are there any verified arbitrage opportunities on Polymarket right now where buying both YES and NO on the same market costs less than $1?",
      "quotedExcerpts": ["Based on real-time orderbook data for Polymarket as of April 5, 2026, there are currently no verified arbitrage opportunities.","A scan of 40 active markets shows the platform is currently efficiently priced. The average spread is approximately 0.1¢.","Check Low-Liquidity Markets: Arbitrage is more common in newer or niche markets."],
      "satisfactionScores": {"actionability":4,"dataFreshness":4,"specificity":4,"uniqueness":4,"completeness":4,"dataAccuracy":3},
      "satisfactionMean": 3.83,
      "scoreExplanations": {"actionability":"Clear negative result with recommendations.","dataFreshness":"Explicit date April 5 2026 with real-time data.","specificity":"40 markets scanned, top 5 listed with exact prices and volumes.","uniqueness":"CLOB orderbook scanning across 40 markets requires tool access.","completeness":"Both parts answered. Could show near-miss markets.","dataAccuracy":"Average spread of 0.1¢ is suspiciously tight for all markets."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":0,"selfHealCount":0,"budgetConsumedPct":26,"fragilityRisk":"low","selectionIssue":null,"planningIssue":null,"executionIssue":null,"completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":null,"rootCauseCategory":"completeness_check_failure","rootCauseEvidence":"Could have shown near-miss markets.","responseQualityNote":"Solid negative result with supporting data.","improvementLever":"Show top 3 closest-to-arb markets with YES+NO sum."},
      "overallVerdict": "Decent value, would want near-miss data."
    },
    {
      "query": "On the most active prediction market about Fed rate decisions, what's the whale vs retail trading flow?",
      "quotedExcerpts": ["there is currently no trading flow data available for the most active Fed rate decision markets.","The source indicated 'Insufficient data - trades endpoint may require authentication.'","all net flows are zero."],
      "satisfactionScores": {"actionability":1,"dataFreshness":2,"specificity":2,"uniqueness":1,"completeness":1,"dataAccuracy":2},
      "satisfactionMean": 1.5,
      "scoreExplanations": {"actionability":"Zero usable data.","dataFreshness":"April 5 2026 mentioned but all data is zero.","specificity":"Has condition IDs but all values zero. Wrong market selected (Netanyahu not Fed).","uniqueness":"Free LLM could tell which Fed markets exist.","completeness":"Failed: wrong market, zero data.","dataAccuracy":"Netanyahu selected for Fed rate query. All flow data zero."},
      "traceAssessment": {"toolSelectionClean":false,"retryCount":2,"selfHealCount":2,"budgetConsumedPct":8,"fragilityRisk":"medium","selectionIssue":"Searched category=politics, got Netanyahu. Should have used search_markets with 'Fed rate'.","planningIssue":"Category instead of keyword search.","executionIssue":"6 analyze_whale_flow calls all returned zero.","completenessIssue":"Accepted wrong market response.","codeIssueDetail":"Code filtered by category=politics, picked top result without semantic validation.","dataAccuracyRedFlags":"Netanyahu selected for Fed rate query. All flow uniformly zero.","rootCauseCategory":"code_generation_error","rootCauseEvidence":"get_top_markets with category=politics used instead of search_markets with query=Fed rate.","responseQualityNote":"Honestly admits empty data, but wrong market entirely.","improvementLever":"Use text search when queries mention specific topics."},
      "overallVerdict": "Feel ripped off - asked about Fed rates, got Netanyahu."
    },
    {
      "query": "Find me Polymarket lottery ticket bets under 15 cents with unusual volume spikes.",
      "quotedExcerpts": ["several lottery ticket markets priced under 15 cents are seeing significant 24-hour volume spikes.","Will the Iranian regime fall by April 30? | 3.95¢ | $1,479,683 | 25.3x","The Trump out as President bet at 1.5 cents represents the highest potential payoff (66.7x)."],
      "satisfactionScores": {"actionability":5,"dataFreshness":4,"specificity":5,"uniqueness":5,"completeness":5,"dataAccuracy":4},
      "satisfactionMean": 4.67,
      "scoreExplanations": {"actionability":"10 specific markets with prices, volumes, returns.","dataFreshness":"April 5 2026 data.","specificity":"Exact prices, volumes, multipliers.","uniqueness":"Cross-market lottery scan from 639 markets.","completeness":"All parts answered: under 15¢, unusual volume, ranked.","dataAccuracy":"Prices consistent, return calcs check out."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":0,"selfHealCount":0,"budgetConsumedPct":18,"fragilityRisk":"low","selectionIssue":null,"planningIssue":null,"executionIssue":null,"completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":null,"rootCauseCategory":null,"rootCauseEvidence":null,"responseQualityNote":"Excellent response. Clean execution.","improvementLever":"Add volumeVsAverage spike multiplier per market."},
      "overallVerdict": "Would absolutely pay again."
    },
    {
      "query": "For the biggest multi-outcome sports event, which outcomes are whales betting on?",
      "quotedExcerpts": ["The biggest multi-outcome sports event is the Augusta National Invitational - Winner, with 102 outcome markets.","whale consensus is focused on extreme value plays rather than favorites.","This analysis is based on a snapshot of 10 out of 102 total markets."],
      "satisfactionScores": {"actionability":3,"dataFreshness":3,"specificity":4,"uniqueness":4,"completeness":3,"dataAccuracy":2},
      "satisfactionMean": 3.17,
      "scoreExplanations": {"actionability":"Shows whale vs market divergence but $2,275 top whale is tiny.","dataFreshness":"April 5 2026 snapshot. 10/102 coverage.","specificity":"Named golfers, exact prices, whale values.","uniqueness":"Cross-outcome whale analysis tool-dependent.","completeness":"Only 10/102 outcomes.","dataAccuracy":"$2,275 labeled as whale in $66M market is misleading."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":2,"selfHealCount":2,"budgetConsumedPct":33,"fragilityRisk":"medium","selectionIssue":null,"planningIssue":"Tool only returned 10 outcomes.","executionIssue":"9 calls, 2 retries, duplicate calls.","completenessIssue":"Accepted 10/102 sample.","codeIssueDetail":"analyze_event_whale_breakdown called with maxOutcomes=10.","dataAccuracyRedFlags":"Whale label on $430-$2275 positions in $66M market.","rootCauseCategory":"synthesis_issue","rootCauseEvidence":"Micro-positions presented as whale positioning.","responseQualityNote":"Found right event but 10% sample and misleading whale labels.","improvementLever":"Increase maxOutcomes to 20-30 and contextualize whale positions."},
      "overallVerdict": "Mixed value."
    },
    {
      "query": "What's the true implied probability on Polymarket's most popular crypto market after stripping out the vig?",
      "quotedExcerpts": ["most popular crypto market is MegaETH market cap (FDV) one day after launch.","highly efficient with 0% vig (0 bps).","the $0.02 spread eats into your potential edge."],
      "satisfactionScores": {"actionability":4,"dataFreshness":3,"specificity":4,"uniqueness":4,"completeness":4,"dataAccuracy":4},
      "satisfactionMean": 3.83,
      "scoreExplanations": {"actionability":"Clear vig and spread analysis.","dataFreshness":"Recent query mentioned but no explicit timestamp.","specificity":"Exact vig, spread, YES/NO prices, bid/ask levels.","uniqueness":"Vig calculation from CLOB requires tools.","completeness":"Both parts answered.","dataAccuracy":"Math checks: 0.10+0.90=1.00, vig=0%."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":0,"selfHealCount":0,"budgetConsumedPct":12,"fragilityRisk":"low","selectionIssue":null,"planningIssue":null,"executionIssue":null,"completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":null,"rootCauseCategory":"completeness_check_failure","rootCauseEvidence":"Could show vig for top 3-5 crypto markets.","responseQualityNote":"Clean, correct, clear.","improvementLever":"Show multiple markets for context."},
      "overallVerdict": "Good value for single-market analysis."
    },
    {
      "query": "Deep-fetch the top holders on Polymarket's biggest political market.",
      "quotedExcerpts": ["largest political market by volume is Netanyahu out by...? with $114.15M.","top 10 holders controlling roughly 80% of supply on both sides.","No Side: 10/10 profitable (up to $44,303)."],
      "satisfactionScores": {"actionability":4,"dataFreshness":3,"specificity":5,"uniqueness":5,"completeness":5,"dataAccuracy":4},
      "satisfactionMean": 4.33,
      "scoreExplanations": {"actionability":"Clear concentration, side preference, profitability data.","dataFreshness":"April 5 2026 mentioned. Deep-fetched data.","specificity":"Named holders, exact shares, percentages, PnL.","uniqueness":"Deep-fetch beyond API 20-holder cap.","completeness":"All 3 parts answered thoroughly.","dataAccuracy":"Internally consistent at price 0.055."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":2,"selfHealCount":2,"budgetConsumedPct":5,"fragilityRisk":"medium","selectionIssue":null,"planningIssue":null,"executionIssue":"5 calls with 2 retries. Duplicate calls but self-heal succeeded.","completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":null,"rootCauseCategory":null,"rootCauseEvidence":null,"responseQualityNote":"Excellent despite retry overhead.","improvementLever":"Reduce duplicate calls to save latency."},
      "overallVerdict": "Would pay again - genuinely useful intelligence."
    },
    {
      "query": "Which Polymarket markets have seen the biggest volume spike in the last 6 hours?",
      "quotedExcerpts": ["Counter-Strike: 3DMAX vs Voca (BO3) | $684,339 | 30.0x | Whale Driven.","2026 NCAA Tournament Winner | $1,103,437 | 1.3x | Retail/Balanced.","Esports: clearest surge, driven almost entirely by high-conviction whale buying."],
      "satisfactionScores": {"actionability":3,"dataFreshness":3,"specificity":4,"uniqueness":3,"completeness":3,"dataAccuracy":2},
      "satisfactionMean": 3.0,
      "scoreExplanations": {"actionability":"Shows spikes with driver classification but driver analysis unreliable.","dataFreshness":"24h data instead of requested 6h.","specificity":"Specific volumes, multipliers, position values.","uniqueness":"Volume spike detection is tool-dependent but whale labels from positions not flow.","completeness":"Only 3 markets, whale/retail based on positions not flow.","dataAccuracy":"analyze_whale_flow returned 0 trades for all markets. Driver labels constructed from holder positions, not flow."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":2,"selfHealCount":2,"budgetConsumedPct":8,"fragilityRisk":"medium","selectionIssue":null,"planningIssue":"analyze_whale_flow planned but returned zeros.","executionIssue":"11 calls. 6 analyze_whale_flow all returned zero. Fell back to analyze_top_holders.","completenessIssue":"Accepted position-based labels as flow analysis.","codeIssueDetail":"classifyDriver() uses holderFallback path conflating holdings with flow.","dataAccuracyRedFlags":"All analyze_whale_flow calls returned 0 trades. Whale Driven labels from positions not flow.","rootCauseCategory":"contributor_tool_bug","rootCauseEvidence":"analyze_whale_flow returns zero trades for all markets including Counter-Strike with $684K volume.","responseQualityNote":"Good structure but core driver analysis unreliable.","improvementLever":"Fix analyze_whale_flow to return actual trade data."},
      "overallVerdict": "On the fence - volume data useful, whale analysis misleading."
    },
    {
      "query": "Run a full high-conviction analysis on Polymarket recession prediction markets.",
      "quotedExcerpts": ["specific recession tagged markets were not returned in the top results.","Only the 2026 NCAA Tournament Winner market is currently classed as fully tradable.","recommended to increase candidateCount or switch to Economics category."],
      "satisfactionScores": {"actionability":2,"dataFreshness":3,"specificity":3,"uniqueness":3,"completeness":2,"dataAccuracy":3},
      "satisfactionMean": 2.67,
      "scoreExplanations": {"actionability":"Wrong markets entirely. NCAA/CS have nothing to do with recession.","dataFreshness":"April 5 2026 data. Fresh but wrong topic.","specificity":"Specific scores and values for wrong markets.","uniqueness":"Workflow is tool-dependent. Content off-target.","completeness":"No recession markets found or analyzed.","dataAccuracy":"Data for substitute markets appears consistent. Just wrong topic."},
      "traceAssessment": {"toolSelectionClean":false,"retryCount":2,"selfHealCount":2,"budgetConsumedPct":5,"fragilityRisk":"medium","selectionIssue":"build_high_conviction_workflow with category=business returned 0. Self-heal removed category instead of using search_markets.","planningIssue":"Category search instead of text search for recession.","executionIssue":"Only 2 tool calls. Should have tried search_markets.","completenessIssue":"Accepted unrelated markets for recession query.","codeIssueDetail":"Code used build_high_conviction_workflow only. When category=business failed, removed category instead of using search_markets.","dataAccuracyRedFlags":null,"rootCauseCategory":"code_generation_error","rootCauseEvidence":"Planner used category=business instead of search_markets with query=recession. search_markets was available.","responseQualityNote":"Well-structured, honest about limitation, but irrelevant content.","improvementLever":"Fall back to text search when category discovery fails."},
      "overallVerdict": "Feel ripped off - asked about recession, got NCAA basketball."
    },
    {
      "query": "Compare liquidity depth and whale positioning across all outcomes in Polymarket's biggest multi-outcome political event.",
      "quotedExcerpts": ["Smart money is heavily concentrated in the earliest possible exit date.","Netanyahu out by March 31? | 20 | $13,422,498 | Extreme.","All outcomes currently carry a poor liquidity score due to wide spreads (0.98-0.99)."],
      "satisfactionScores": {"actionability":5,"dataFreshness":3,"specificity":5,"uniqueness":5,"completeness":5,"dataAccuracy":4},
      "satisfactionMean": 4.5,
      "scoreExplanations": {"actionability":"Clear divergence: whales in March 31 ($13.4M), deepest liquidity in April 30.","dataFreshness":"Current data but no explicit timestamp.","specificity":"Exact dollar values, whale counts, depth per outcome.","uniqueness":"Cross-outcome whale vs liquidity comparison.","completeness":"Both questions answered fully.","dataAccuracy":"365x concentration ratio dramatic but plausible. 0.98-0.99 spreads are raw CLOB."},
      "traceAssessment": {"toolSelectionClean":true,"retryCount":0,"selfHealCount":0,"budgetConsumedPct":31,"fragilityRisk":"low","selectionIssue":null,"planningIssue":null,"executionIssue":null,"completenessIssue":null,"codeIssueDetail":null,"dataAccuracyRedFlags":"0.98-0.99 spreads may be misleading - raw CLOB not merged books.","rootCauseCategory":null,"rootCauseEvidence":null,"responseQualityNote":"Excellent cross-outcome analysis.","improvementLever":"Use merged orderbooks for spread reporting."},
      "overallVerdict": "Would pay again - genuinely actionable cross-outcome intelligence."
    }
  ],
  "aggregate": {
    "satisfactionMean": 3.27,
    "satisfactionMin": 1.17,
    "queryCount": 10,
    "queriesAbove4": 3,
    "queriesBelow3": 3,
    "fragilityReport": {
      "highCount": 0,
      "mediumCount": 5,
      "lowCount": 5,
      "highFragilityRate": 0.0,
      "highFragilityQueryIds": []
    },
    "topImprovementLevers": [
      "Use text-based search (search_markets) for topic-specific queries instead of category browsing - caused failures on Q3 and Q9",
      "Fix analyze_whale_flow returning zero trades for all markets despite significant volume - contributor tool bug affecting Q3 and Q8",
      "Eliminate clarification prompts when queries have sufficient specificity (Q1)"
    ]
  }
};

await writeFile(
  path.resolve(__dirname, "reviewer-evaluation.json"),
  JSON.stringify(reviewerEval, null, 2) + "\n"
);
refreshReleaseDecision();
console.log("reviewer-evaluation.json written successfully.");
