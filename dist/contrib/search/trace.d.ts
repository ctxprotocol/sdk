import type { QueryDeveloperTrace } from "../../client/types.js";
import { type ContributorSearchMetadata, type ContributorSearchTraceRecord } from "./types.js";
export declare function extractContributorSearchMetadata(result: unknown): ContributorSearchMetadata | null;
export declare function extractContributorSearchesFromDeveloperTrace(trace: QueryDeveloperTrace | undefined): ContributorSearchTraceRecord[];
//# sourceMappingURL=trace.d.ts.map