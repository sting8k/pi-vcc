import type { NormalizedBlock } from "../types";

export const extractGoals = (blocks: NormalizedBlock[]): string[] => {
  const goals: string[] = [];
  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const lines = b.text.split("\n").filter((l) => l.trim());
    // First user messages are typically goals
    if (goals.length === 0 && lines.length > 0) {
      goals.push(...lines.slice(0, 3));
    }
  }
  return goals;
};
