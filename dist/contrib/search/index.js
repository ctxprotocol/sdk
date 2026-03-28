// src/contrib/search/types.ts
var CONTRIBUTOR_SEARCH_METADATA_VERSION = "ctx-contributor-search/v1";
var CONTRIBUTOR_SEARCH_VALIDATION_VERSION = "ctx-contributor-search-validation/v1";
var ContributorSearchBudgetExceededError = class extends Error {
  constructor(message = "Contributor search budget exceeded") {
    super(message);
    this.name = "ContributorSearchBudgetExceededError";
  }
};

// src/contrib/search/core.ts
var DEFAULT_MAX_SHORTLIST_SIZE = 8;
var DEFAULT_DEGRADED_OUTCOME_POLICY = "return_shortlist";
var MAX_METADATA_PROVENANCE_ENTRIES = 8;
var MAX_METADATA_INTENT_QUERIES = 6;
var MAX_REASON_LENGTH = 240;
var ContributorSearchTimeoutError = class extends Error {
  constructor(message = "Contributor search judge timed out") {
    super(message);
    this.name = "ContributorSearchTimeoutError";
  }
};
function normalizeString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}
function uniqueStrings(values) {
  const deduped = /* @__PURE__ */ new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}
function truncateReason(reason) {
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH)}...`;
}
function candidateProvenanceKey(provenance) {
  return [
    provenance.source,
    provenance.query,
    provenance.rank ?? "",
    provenance.fetchedAt ?? "",
    JSON.stringify(provenance.metadata ?? {})
  ].join("::");
}
function mergeProvenance(first, second) {
  const merged = /* @__PURE__ */ new Map();
  for (const provenance of [...first, ...second]) {
    merged.set(candidateProvenanceKey(provenance), provenance);
  }
  return [...merged.values()];
}
function mergeCandidates(first, second) {
  return {
    ...first,
    description: first.description ?? second.description ?? null,
    rawIds: {
      ...second.rawIds ?? {},
      ...first.rawIds ?? {}
    },
    rankFeatures: {
      ...second.rankFeatures ?? {},
      ...first.rankFeatures ?? {}
    },
    provenance: mergeProvenance(first.provenance, second.provenance),
    metadata: {
      ...second.metadata ?? {},
      ...first.metadata ?? {}
    }
  };
}
function isCandidateSelectable(candidate, validateCandidate) {
  return validateCandidate(candidate);
}
function summarizeProvenance(candidates) {
  const grouped = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    for (const provenance of candidate.provenance) {
      const key = `${provenance.source}::${provenance.query}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.candidateIds.add(candidate.candidateId);
        continue;
      }
      grouped.set(key, {
        source: provenance.source,
        query: provenance.query,
        candidateIds: /* @__PURE__ */ new Set([candidate.candidateId])
      });
    }
  }
  return [...grouped.values()].map((entry) => ({
    source: entry.source,
    query: entry.query,
    candidateCount: entry.candidateIds.size
  })).slice(0, MAX_METADATA_PROVENANCE_ENTRIES);
}
function buildJudgeSnapshot(params) {
  return {
    provider: params.config.provider,
    model: params.config.model,
    timeoutMs: params.config.timeoutMs,
    budgetUsd: params.config.budgetUsd,
    disabled: params.config.disableJudge,
    applied: params.applied,
    usage: params.usage
  };
}
function buildTraceSummary(params) {
  return {
    usedDeterministicFallback: params.usedDeterministicFallback,
    validatorStatus: params.validatorStatus,
    validatorReasonCode: params.validatorReasonCode,
    validatorReason: params.validatorReason
  };
}
function buildSearchMetadata(params) {
  const intentQueries = uniqueStrings(params.intents.map((intent) => intent.query)).slice(0, MAX_METADATA_INTENT_QUERIES);
  return {
    version: CONTRIBUTOR_SEARCH_METADATA_VERSION,
    outcome: params.outcome,
    confidence: params.confidence,
    selectedCandidateId: params.selectedCandidate?.candidateId ?? null,
    shortlistCandidateIds: params.shortlist.map((candidate) => candidate.candidateId),
    relatedCandidateIds: params.relatedCandidates.map(
      (candidate) => candidate.candidateId
    ),
    rejectedCandidateIds: params.rejectedCandidates.map(
      (candidate) => candidate.candidateId
    ),
    candidateCount: params.candidates.length,
    shortlistCount: params.shortlist.length,
    intentQueries,
    degraded: params.degraded,
    judge: params.judgeSnapshot,
    provenance: summarizeProvenance(params.candidates),
    trace: params.trace
  };
}
function buildResolution(params) {
  const searchMetadata = buildSearchMetadata({
    intents: params.intents,
    candidates: params.candidates,
    shortlist: params.shortlist,
    selectedCandidate: params.selectedCandidate,
    relatedCandidates: params.relatedCandidates,
    rejectedCandidates: params.rejectedCandidates,
    outcome: params.outcome,
    confidence: params.confidence,
    degraded: params.degraded,
    judgeSnapshot: params.judgeSnapshot,
    trace: params.trace
  });
  return {
    outcome: params.outcome,
    selectedCandidate: params.selectedCandidate,
    shortlist: [...params.shortlist],
    relatedCandidates: [...params.relatedCandidates],
    rejectedCandidates: [...params.rejectedCandidates],
    confidence: params.confidence,
    reason: truncateReason(params.reason),
    degraded: params.degraded,
    searchMetadata
  };
}
function dedupeCandidateIds(ids) {
  const deduped = [];
  const seen = /* @__PURE__ */ new Set();
  let hadDuplicates = false;
  for (const id of ids) {
    const normalized = normalizeString(id);
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      hadDuplicates = true;
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return {
    ids: deduped,
    hadDuplicates
  };
}
function validateJudgeSelection(params) {
  const shortlistById = /* @__PURE__ */ new Map();
  for (const candidate of params.shortlist) {
    shortlistById.set(candidate.candidateId, candidate);
  }
  const normalizedPrimaryCandidateId = normalizeString(params.primaryCandidateId);
  const relatedCandidateIds = dedupeCandidateIds(params.relatedCandidateIds);
  const rejectedCandidateIds = dedupeCandidateIds(params.rejectedCandidateIds);
  if (relatedCandidateIds.hadDuplicates || rejectedCandidateIds.hadDuplicates) {
    return {
      ok: false,
      reasonCode: "judge_invalid_output",
      reason: "Judge returned duplicate candidate ids within a bucket."
    };
  }
  const referencedIds = /* @__PURE__ */ new Set();
  if (normalizedPrimaryCandidateId) {
    referencedIds.add(normalizedPrimaryCandidateId);
  }
  for (const id of [...relatedCandidateIds.ids, ...rejectedCandidateIds.ids]) {
    if (referencedIds.has(id)) {
      return {
        ok: false,
        reasonCode: "validator_rejected",
        reason: "Judge referenced the same candidate across multiple buckets."
      };
    }
    referencedIds.add(id);
  }
  if (normalizedPrimaryCandidateId && !shortlistById.has(normalizedPrimaryCandidateId)) {
    return {
      ok: false,
      reasonCode: "validator_rejected",
      reason: "Judge selected a candidate outside the bounded shortlist."
    };
  }
  for (const id of [...relatedCandidateIds.ids, ...rejectedCandidateIds.ids]) {
    if (!shortlistById.has(id)) {
      return {
        ok: false,
        reasonCode: "validator_rejected",
        reason: "Judge referenced a candidate outside the bounded shortlist."
      };
    }
  }
  const selectedCandidate = normalizedPrimaryCandidateId ? shortlistById.get(normalizedPrimaryCandidateId) ?? null : null;
  if (selectedCandidate && !isCandidateSelectable(selectedCandidate, params.validateCandidate)) {
    return {
      ok: false,
      reasonCode: "validator_rejected",
      reason: "Judge selected a candidate that failed deterministic contributor validation."
    };
  }
  return {
    ok: true,
    selectedCandidate,
    relatedCandidates: relatedCandidateIds.ids.map((id) => shortlistById.get(id)).filter((candidate) => Boolean(candidate)),
    rejectedCandidates: rejectedCandidateIds.ids.map((id) => shortlistById.get(id)).filter((candidate) => Boolean(candidate))
  };
}
async function evaluateJudge(params) {
  if (!params.timeoutMs || params.timeoutMs <= 0) {
    return params.judge.evaluate(params.input, params.context);
  }
  let timeoutId;
  try {
    return await Promise.race([
      params.judge.evaluate(params.input, params.context),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new ContributorSearchTimeoutError());
        }, params.timeoutMs ?? 0);
      })
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
function buildFallbackResolution(params) {
  if (params.validShortlist.length === 0) {
    return buildResolution({
      intents: params.intents,
      candidates: params.candidates,
      shortlist: [],
      selectedCandidate: null,
      relatedCandidates: [],
      rejectedCandidates: [],
      outcome: "capability_miss",
      confidence: "low",
      reason: params.reason,
      degraded: {
        reasonCode: "no_viable_candidates",
        message: truncateReason(params.reason)
      },
      judgeSnapshot: buildJudgeSnapshot({
        config: params.config,
        applied: params.judgeApplied,
        usage: params.judgeUsage
      }),
      trace: buildTraceSummary({
        usedDeterministicFallback: true,
        validatorStatus: params.validatorStatus,
        validatorReasonCode: params.validatorReasonCode,
        validatorReason: params.validatorReason
      })
    });
  }
  if (params.validShortlist.length === 1 && params.config.degradedOutcomePolicy === "allow_low_confidence_selected") {
    return buildResolution({
      intents: params.intents,
      candidates: params.candidates,
      shortlist: params.validShortlist,
      selectedCandidate: params.validShortlist[0] ?? null,
      relatedCandidates: [],
      rejectedCandidates: [],
      outcome: "selected",
      confidence: "low",
      reason: params.reason,
      degraded: {
        reasonCode: params.reasonCode,
        message: truncateReason(params.reason)
      },
      judgeSnapshot: buildJudgeSnapshot({
        config: params.config,
        applied: params.judgeApplied,
        usage: params.judgeUsage
      }),
      trace: buildTraceSummary({
        usedDeterministicFallback: true,
        validatorStatus: params.validatorStatus,
        validatorReasonCode: params.validatorReasonCode,
        validatorReason: params.validatorReason
      })
    });
  }
  return buildResolution({
    intents: params.intents,
    candidates: params.candidates,
    shortlist: params.validShortlist,
    selectedCandidate: null,
    relatedCandidates: [],
    rejectedCandidates: [],
    outcome: "shortlist_only",
    confidence: "low",
    reason: params.reason,
    degraded: {
      reasonCode: params.reasonCode,
      message: truncateReason(params.reason)
    },
    judgeSnapshot: buildJudgeSnapshot({
      config: params.config,
      applied: params.judgeApplied,
      usage: params.judgeUsage
    }),
    trace: buildTraceSummary({
      usedDeterministicFallback: true,
      validatorStatus: params.validatorStatus,
      validatorReasonCode: params.validatorReasonCode,
      validatorReason: params.validatorReason
    })
  });
}
function createSearchIntent(params) {
  const normalizedQuery = normalizeString(params.query) ?? params.rawRequest.trim();
  const fallbackIntentId = normalizedQuery.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return {
    intentId: (params.intentId ?? fallbackIntentId) || "search-intent",
    rawRequest: params.rawRequest.trim(),
    query: normalizedQuery,
    clause: normalizeString(params.clause),
    ...params.metadata ? { metadata: params.metadata } : {}
  };
}
function dedupeSearchCandidates(candidates) {
  const deduped = /* @__PURE__ */ new Map();
  for (const candidate of candidates) {
    const normalizedCandidateId = normalizeString(candidate.candidateId);
    if (!normalizedCandidateId) {
      continue;
    }
    const normalizedCandidate = {
      ...candidate,
      candidateId: normalizedCandidateId,
      title: candidate.title.trim(),
      description: normalizeString(candidate.description),
      rawIds: candidate.rawIds ?? {},
      rankFeatures: candidate.rankFeatures ?? {},
      provenance: candidate.provenance ?? [],
      metadata: candidate.metadata ?? {}
    };
    const existing = deduped.get(normalizedCandidateId);
    deduped.set(
      normalizedCandidateId,
      existing ? mergeCandidates(existing, normalizedCandidate) : normalizedCandidate
    );
  }
  return [...deduped.values()];
}
function buildSearchShortlist(candidates, maxShortlistSize = DEFAULT_MAX_SHORTLIST_SIZE) {
  const cappedSize = Math.max(1, Math.floor(maxShortlistSize));
  return {
    maxSize: cappedSize,
    candidates: dedupeSearchCandidates(candidates).slice(0, cappedSize)
  };
}
function mergeContributorSearchConfig(...configs) {
  const resolved = {
    provider: null,
    model: null,
    timeoutMs: null,
    budgetUsd: null,
    disableJudge: false,
    degradedOutcomePolicy: DEFAULT_DEGRADED_OUTCOME_POLICY,
    maxShortlistSize: DEFAULT_MAX_SHORTLIST_SIZE
  };
  for (const config of configs) {
    if (!config) {
      continue;
    }
    if ("provider" in config) {
      resolved.provider = normalizeString(config.provider);
    }
    if ("model" in config) {
      resolved.model = normalizeString(config.model);
    }
    if ("timeoutMs" in config) {
      resolved.timeoutMs = typeof config.timeoutMs === "number" && Number.isFinite(config.timeoutMs) ? Math.max(0, Math.floor(config.timeoutMs)) : null;
    }
    if ("budgetUsd" in config) {
      resolved.budgetUsd = normalizeString(config.budgetUsd);
    }
    if ("disableJudge" in config && typeof config.disableJudge === "boolean") {
      resolved.disableJudge = config.disableJudge;
    }
    if (config.degradedOutcomePolicy === "return_shortlist" || config.degradedOutcomePolicy === "allow_low_confidence_selected") {
      resolved.degradedOutcomePolicy = config.degradedOutcomePolicy;
    }
    if (typeof config.maxShortlistSize === "number" && Number.isFinite(config.maxShortlistSize)) {
      resolved.maxShortlistSize = Math.max(1, Math.floor(config.maxShortlistSize));
    }
  }
  return resolved;
}
function attachContributorSearchMetadata(data, resolution) {
  return {
    ...data,
    searchMetadata: resolution.searchMetadata
  };
}
async function resolveContributorSearch(params) {
  const config = mergeContributorSearchConfig(
    params.helperConfig,
    params.contributorConfig,
    params.overrides
  );
  const candidates = dedupeSearchCandidates(params.candidates);
  const shortlist = buildSearchShortlist(candidates, config.maxShortlistSize).candidates;
  const validateCandidate = params.isCandidateValid ?? (() => true);
  const validShortlist = shortlist.filter(
    (candidate) => isCandidateSelectable(candidate, validateCandidate)
  );
  const judge = params.judge;
  if (shortlist.length === 0) {
    return buildFallbackResolution({
      intents: params.intents,
      candidates,
      validShortlist,
      reasonCode: "no_viable_candidates",
      reason: "No viable candidates survived deterministic gathering before judging.",
      config,
      judgeApplied: false,
      judgeUsage: null,
      validatorStatus: "not_run",
      validatorReasonCode: null,
      validatorReason: null
    });
  }
  if (config.disableJudge || !judge) {
    return buildFallbackResolution({
      intents: params.intents,
      candidates,
      validShortlist,
      reasonCode: !judge ? "judge_missing" : "judge_disabled",
      reason: !judge ? "No contributor search judge was configured for this resolution." : "Contributor search judge was disabled for this resolution.",
      config,
      judgeApplied: false,
      judgeUsage: null,
      validatorStatus: "not_run",
      validatorReasonCode: null,
      validatorReason: null
    });
  }
  const judgeInput = {
    rawRequest: params.rawRequest,
    intents: params.intents,
    shortlist: {
      maxSize: config.maxShortlistSize,
      candidates: shortlist
    },
    ...params.instructions ? { instructions: params.instructions } : {},
    policy: config
  };
  const judgeContext = {
    provider: config.provider,
    model: config.model,
    timeoutMs: config.timeoutMs,
    budgetUsd: config.budgetUsd,
    traceLabel: params.traceLabel ?? null
  };
  let judgeUsage = null;
  try {
    const judgeResult = await evaluateJudge({
      judge,
      input: judgeInput,
      context: judgeContext,
      timeoutMs: config.timeoutMs
    });
    judgeUsage = judgeResult.usage ?? null;
    const validation = validateJudgeSelection({
      shortlist,
      primaryCandidateId: judgeResult.primaryCandidateId,
      relatedCandidateIds: judgeResult.relatedCandidateIds,
      rejectedCandidateIds: judgeResult.rejectedCandidateIds,
      validateCandidate
    });
    if (!validation.ok) {
      return buildFallbackResolution({
        intents: params.intents,
        candidates,
        validShortlist,
        reasonCode: validation.reasonCode,
        reason: validation.reason,
        config,
        judgeApplied: true,
        judgeUsage,
        validatorStatus: "rejected",
        validatorReasonCode: validation.reasonCode,
        validatorReason: validation.reason
      });
    }
    if (!validation.selectedCandidate) {
      return buildFallbackResolution({
        intents: params.intents,
        candidates,
        validShortlist,
        reasonCode: "ambiguous_shortlist",
        reason: normalizeString(judgeResult.reason) ?? "Judge declined to select a single grounded candidate.",
        config,
        judgeApplied: true,
        judgeUsage,
        validatorStatus: "accepted",
        validatorReasonCode: null,
        validatorReason: null
      });
    }
    return buildResolution({
      intents: params.intents,
      candidates,
      shortlist,
      selectedCandidate: validation.selectedCandidate,
      relatedCandidates: validation.relatedCandidates,
      rejectedCandidates: validation.rejectedCandidates,
      outcome: "selected",
      confidence: judgeResult.confidence,
      reason: normalizeString(judgeResult.reason) ?? "Judge selected a candidate.",
      degraded: null,
      judgeSnapshot: buildJudgeSnapshot({
        config,
        applied: true,
        usage: judgeUsage
      }),
      trace: buildTraceSummary({
        usedDeterministicFallback: false,
        validatorStatus: "accepted",
        validatorReasonCode: null,
        validatorReason: null
      })
    });
  } catch (error) {
    const reasonCode = error instanceof ContributorSearchBudgetExceededError ? "judge_budget_exceeded" : error instanceof ContributorSearchTimeoutError ? "judge_timeout" : "judge_error";
    const reason = error instanceof Error ? error.message : "Contributor search judge failed with a non-Error value.";
    return buildFallbackResolution({
      intents: params.intents,
      candidates,
      validShortlist,
      reasonCode,
      reason,
      config,
      judgeApplied: true,
      judgeUsage,
      validatorStatus: "not_run",
      validatorReasonCode: null,
      validatorReason: null
    });
  }
}

// src/contrib/search/trace.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isContributorSearchMetadata(value) {
  if (!isRecord(value)) {
    return false;
  }
  return value.version === CONTRIBUTOR_SEARCH_METADATA_VERSION && (value.outcome === "selected" || value.outcome === "shortlist_only" || value.outcome === "capability_miss") && (value.confidence === "high" || value.confidence === "medium" || value.confidence === "low") && (value.selectedCandidateId === null || typeof value.selectedCandidateId === "string") && isStringArray(value.shortlistCandidateIds) && isStringArray(value.relatedCandidateIds) && isStringArray(value.rejectedCandidateIds) && typeof value.candidateCount === "number" && typeof value.shortlistCount === "number" && isStringArray(value.intentQueries) && isRecord(value.judge) && Array.isArray(value.provenance) && isRecord(value.trace);
}
function extractMetadataFromUnknown(value) {
  if (isContributorSearchMetadata(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  const nestedSearchMetadata = value.searchMetadata;
  if (isContributorSearchMetadata(nestedSearchMetadata)) {
    return nestedSearchMetadata;
  }
  return null;
}
function isContributorSearchTraceRecord(value) {
  if (!isRecord(value)) {
    return false;
  }
  return (value.toolId === null || typeof value.toolId === "string") && (value.toolName === null || typeof value.toolName === "string") && (value.timestampMs === null || typeof value.timestampMs === "number") && isContributorSearchMetadata(value.searchMetadata);
}
function extractContributorSearchMetadata(result) {
  return extractMetadataFromUnknown(result);
}
function extractContributorSearchesFromDeveloperTrace(trace) {
  const diagnostics = trace?.diagnostics;
  if (diagnostics && "contributorSearches" in diagnostics && Array.isArray(diagnostics.contributorSearches)) {
    return diagnostics.contributorSearches.filter(
      isContributorSearchTraceRecord
    );
  }
  const extracted = [];
  for (const step of trace?.timeline ?? []) {
    const metadata = step.metadata;
    if (!isRecord(metadata)) {
      continue;
    }
    const directMetadata = extractMetadataFromUnknown(metadata.contributorSearch);
    const resultMetadata = extractMetadataFromUnknown(metadata.result);
    const searchMetadata = directMetadata ?? resultMetadata;
    if (!searchMetadata) {
      continue;
    }
    extracted.push({
      toolId: step.tool?.id ?? null,
      toolName: step.tool?.name ?? null,
      timestampMs: typeof step.timestampMs === "number" ? step.timestampMs : null,
      searchMetadata
    });
  }
  return extracted;
}

// src/contrib/search/validation.ts
function buildContributorSearchValidationArtifact(params) {
  return {
    version: CONTRIBUTOR_SEARCH_VALIDATION_VERSION,
    generatedAt: params.generatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
    caseId: params.caseId,
    caseKind: params.caseKind,
    rawRequest: params.rawRequest,
    intents: params.intents,
    candidates: params.candidates,
    resolution: {
      outcome: params.resolution.outcome,
      selectedCandidateId: params.resolution.selectedCandidate?.candidateId ?? null,
      shortlistCandidateIds: params.resolution.shortlist.map(
        (candidate) => candidate.candidateId
      ),
      relatedCandidateIds: params.resolution.relatedCandidates.map(
        (candidate) => candidate.candidateId
      ),
      rejectedCandidateIds: params.resolution.rejectedCandidates.map(
        (candidate) => candidate.candidateId
      ),
      confidence: params.resolution.confidence,
      reason: params.resolution.reason,
      degradedReasonCode: params.resolution.degraded?.reasonCode ?? null
    },
    searchMetadata: params.resolution.searchMetadata,
    ...params.expectation ? { expectation: params.expectation } : {}
  };
}

export { CONTRIBUTOR_SEARCH_METADATA_VERSION, CONTRIBUTOR_SEARCH_VALIDATION_VERSION, ContributorSearchBudgetExceededError, attachContributorSearchMetadata, buildContributorSearchValidationArtifact, buildSearchShortlist, createSearchIntent, dedupeSearchCandidates, extractContributorSearchMetadata, extractContributorSearchesFromDeveloperTrace, mergeContributorSearchConfig, resolveContributorSearch };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map