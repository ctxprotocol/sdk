import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeReleaseDecision,
  writeReleaseDecisionFile,
} from "../../../../../.cursor/hooks/pipeline-release-decision.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../../../../");
const CONTRIBUTOR_NAME = "polymarket-contributor";

export function refreshReleaseDecision() {
  const decision = computeReleaseDecision({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
  });

  const decisionPath = writeReleaseDecisionFile({
    rootDir: ROOT_DIR,
    contributor: CONTRIBUTOR_NAME,
    decision,
  });

  return { decision, decisionPath };
}
