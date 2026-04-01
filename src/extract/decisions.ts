import type { NormalizedBlock } from "../types";

const DECISION_PATTERNS = [
  /\bdecid(ed|ing)\b/i,
  /\bchose\b/i,
  /\bwill use\b/i,
  /\bgoing with\b/i,
  /\bapproach[:\s]/i,
  /\bconstraint[:\s]/i,
  /\brequirement[:\s]/i,
  /\bmust\b/i,
  /\bshould not\b/i,
  /\barchitecture/i,
];

export const extractDecisions = (blocks: NormalizedBlock[]): string[] => {
  const decisions: string[] = [];

  for (const b of blocks) {
    if (b.kind !== "assistant" && b.kind !== "user") continue;
    for (const line of b.text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 10) continue;
      if (DECISION_PATTERNS.some((p) => p.test(trimmed))) {
        decisions.push(trimmed.slice(0, 200));
      }
    }
  }

  return [...new Set(decisions)].slice(0, 10);
};
