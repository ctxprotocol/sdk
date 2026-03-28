import type { QueryDeveloperTrace } from "../../client/types.js";
import {
  CONTRIBUTOR_SEARCH_METADATA_VERSION,
  type ContributorSearchMetadata,
  type ContributorSearchTraceRecord,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function isContributorSearchMetadata(
  value: unknown
): value is ContributorSearchMetadata {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === CONTRIBUTOR_SEARCH_METADATA_VERSION &&
    (value.outcome === "selected" ||
      value.outcome === "shortlist_only" ||
      value.outcome === "capability_miss") &&
    (value.confidence === "high" ||
      value.confidence === "medium" ||
      value.confidence === "low") &&
    (value.selectedCandidateId === null ||
      typeof value.selectedCandidateId === "string") &&
    isStringArray(value.shortlistCandidateIds) &&
    isStringArray(value.relatedCandidateIds) &&
    isStringArray(value.rejectedCandidateIds) &&
    typeof value.candidateCount === "number" &&
    typeof value.shortlistCount === "number" &&
    isStringArray(value.intentQueries) &&
    isRecord(value.judge) &&
    Array.isArray(value.provenance) &&
    isRecord(value.trace)
  );
}

function extractMetadataFromUnknown(
  value: unknown
): ContributorSearchMetadata | null {
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

function isContributorSearchTraceRecord(
  value: unknown
): value is ContributorSearchTraceRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.toolId === null || typeof value.toolId === "string") &&
    (value.toolName === null || typeof value.toolName === "string") &&
    (value.timestampMs === null || typeof value.timestampMs === "number") &&
    isContributorSearchMetadata(value.searchMetadata)
  );
}

export function extractContributorSearchMetadata(
  result: unknown
): ContributorSearchMetadata | null {
  return extractMetadataFromUnknown(result);
}

export function extractContributorSearchesFromDeveloperTrace(
  trace: QueryDeveloperTrace | undefined
): ContributorSearchTraceRecord[] {
  const diagnostics = trace?.diagnostics;
  if (
    diagnostics &&
    "contributorSearches" in diagnostics &&
    Array.isArray(diagnostics.contributorSearches)
  ) {
    return diagnostics.contributorSearches.filter(
      isContributorSearchTraceRecord
    );
  }

  const extracted: ContributorSearchTraceRecord[] = [];
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
      timestampMs:
        typeof step.timestampMs === "number" ? step.timestampMs : null,
      searchMetadata,
    });
  }

  return extracted;
}
