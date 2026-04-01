import type { NormalizedBlock } from "../types";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { extractFindings } from "../extract/findings";
import { extractDecisions } from "../extract/decisions";
import { extractPreferences } from "../extract/preferences";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  fileOps?: { readFiles?: string[]; modifiedFiles?: string[] };
}

const extractWhatWasDone = (blocks: NormalizedBlock[]): string[] => {
  const done: string[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call") {
      done.push(`${b.name}(${Object.keys(b.args).join(", ")})`);
    }
  }
  // Deduplicate and collapse repeated tool calls
  const counts = new Map<string, number>();
  for (const d of done) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()]
    .map(([k, v]) => (v > 1 ? `${k} x${v}` : k))
    .slice(0, 20);
};

const extractCurrentState = (blocks: NormalizedBlock[]): string[] => {
  // Last few assistant messages typically describe current state
  const state: string[] = [];
  const assistants = blocks.filter((b) => b.kind === "assistant");
  const last = assistants.slice(-3);
  for (const b of last) {
    const lines = b.text.split("\n").filter((l) => l.trim());
    state.push(...lines.slice(0, 2).map((l) => l.slice(0, 200)));
  }
  return state.slice(0, 5);
};

const extractOpenProblems = (blocks: NormalizedBlock[]): string[] => {
  const problems: string[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_result" && b.isError) {
      problems.push(`[${b.name}] ${b.text.split("\n")[0]?.slice(0, 200)}`);
    }
  }
  return [...new Set(problems)].slice(0, 10);
};

const extractNextSteps = (blocks: NormalizedBlock[]): string[] => {
  const steps: string[] = [];
  const assistants = blocks.filter((b) => b.kind === "assistant");
  const last = assistants.at(-1);
  if (!last) return steps;
  for (const line of last.text.split("\n")) {
    const t = line.trim();
    if (/^\d+[\.\)]\s/.test(t) || /^-\s/.test(t)) {
      steps.push(t.slice(0, 200));
    }
  }
  return steps.slice(0, 5);
};

export const buildSections = (input: BuildSectionsInput): SectionData => {
  const { blocks, fileOps } = input;
  const fa = extractFiles(blocks, fileOps);
  return {
    sessionGoal: extractGoals(blocks),
    currentState: extractCurrentState(blocks),
    whatWasDone: extractWhatWasDone(blocks),
    importantFindings: extractFindings(blocks),
    filesRead: [...fa.read],
    filesModified: [...fa.modified],
    filesCreated: [...fa.created],
    openProblems: extractOpenProblems(blocks),
    decisions: extractDecisions(blocks),
    userPreferences: extractPreferences(blocks),
    nextSteps: extractNextSteps(blocks),
  };
};




