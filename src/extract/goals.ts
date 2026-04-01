import type { NormalizedBlock } from "../types";
import { nonEmptyLines, clip } from "../core/content";

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

const isSubstantiveGoal = (text: string): boolean =>
  text.length > 5 && !NOISE_SHORT_RE.test(text.trim());

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const lines = nonEmptyLines(b.text).filter(isSubstantiveGoal);
    if (lines.length === 0) continue;

    if (goals.length === 0) {
      goals.push(...lines.slice(0, 3));
      continue;
    }

    if (SCOPE_CHANGE_RE.test(b.text)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, 200));
    } else if (TASK_RE.test(b.text) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, 200));
    }
  }

  if (latestScopeChange) {
    goals.push("[Scope change]", ...latestScopeChange);
  }

  return goals.slice(0, 8);
};
