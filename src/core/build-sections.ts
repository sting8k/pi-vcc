import type { FileOps, NormalizedBlock } from "../types";
import { clip, firstLine, nonEmptyLines } from "./content";
import { redact } from "./redact";
import type { SectionData } from "../sections";
import { extractGoals } from "../extract/goals";
import { extractFiles } from "../extract/files";
import { extractFindings } from "../extract/findings";
import { extractDecisions } from "../extract/decisions";
import { extractPreferences } from "../extract/preferences";
import { extractPath } from "./tool-args";

export interface BuildSectionsInput {
  blocks: NormalizedBlock[];
  fileOps?: FileOps;
}

// --- What Was Done: VCC-style collapsed tool calls ---

const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  read: "file_path", edit: "file_path", write: "file_path",
  Glob: "pattern", Grep: "pattern",
};

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") {
    return `* ${name} "${clip(args[field] as string, 60)}"`;
  }
  const path = extractPath(args);
  if (path) return `* ${name} "${clip(path, 60)}"`;
  if (name === "bash" || name === "Bash") {
    const cmd = (args.command ?? args.description ?? "") as string;
    return `* ${name} "${redact(clip(cmd, 80))}"`;
  }
  if (typeof args.query === "string") {
    return `* ${name} "${clip(args.query as string, 60)}"`;
  }
  return `* ${name}`;
};

const extractWhatWasDone = (blocks: NormalizedBlock[]): string[] => {
  const raw: string[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call") raw.push(toolOneLiner(b.name, b.args));
  }
  const counts = new Map<string, number>();
  for (const d of raw) counts.set(d, (counts.get(d) ?? 0) + 1);
  return [...counts.entries()]
    .map(([k, v]) => (v > 1 ? `${k} x${v}` : k))
    .slice(0, 30);
};

// --- Current State: assistant prose + capped tool results ---

const FILLER_RE = /^(ok|sure|done|got it|alright|let me|i('ll| will)|here'?s|understood)/i;
const CODE_NOISE_RE = /^[\s{}()\[\];,=<>|&!*]+$|^var\s|^\w+=\{|function\s*\w*\(|=>\s*\{/;

const extractCurrentState = (blocks: NormalizedBlock[]): string[] => {
  const state: string[] = [];
  const tail = blocks.slice(-12);

  for (const b of tail) {
    if (b.kind === "assistant") {
      for (const line of nonEmptyLines(b.text)) {
        if (FILLER_RE.test(line)) continue;
        if (CODE_NOISE_RE.test(line)) continue;
        if (line.length < 8) continue;
        state.push(clip(line, 200));
      }
    }
  }

  return state.slice(-5);
};

// --- Open Problems: only clear blockers, from tail of conversation ---

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const extractOpenProblems = (blocks: NormalizedBlock[]): string[] => {
  const problems: string[] = [];
  const tail = blocks.slice(-40);

  for (const b of tail) {
    if (b.kind === "tool_result" && b.isError) {
      problems.push(`[${b.name}] ${firstLine(b.text, 150)}`);
    }

    if (b.kind === "assistant" && BLOCKER_RE.test(b.text)) {
      for (const line of nonEmptyLines(b.text)) {
        if (BLOCKER_RE.test(line) && line.length > 15) {
          problems.push(clip(line, 150));
          break;
        }
      }
    }

    if (b.kind === "user" && BLOCKER_RE.test(b.text)) {
      for (const line of nonEmptyLines(b.text)) {
        if (BLOCKER_RE.test(line) && line.length > 15) {
          problems.push(`[user] ${clip(line, 150)}`);
          break;
        }
      }
    }
  }

  return [...new Set(problems)].slice(0, 5);
};

// --- Next Steps: list-form + prose fallback ---

const extractNextSteps = (blocks: NormalizedBlock[]): string[] => {
  const steps: string[] = [];
  const assistants = blocks.filter((b) => b.kind === "assistant");
  const recent = assistants.slice(-5);

  for (let i = recent.length - 1; i >= 0 && steps.length < 5; i--) {
    for (const t of nonEmptyLines(recent[i].text)) {
      if (/^\d+[\.)\]]\s/.test(t) || /^-\s/.test(t)) {
        const clipped = clip(t, 200);
        if (!steps.includes(clipped)) steps.push(clipped);
      }
    }
    if (steps.length > 0) break;
  }

  if (steps.length === 0 && recent.length > 0) {
    const last = recent[recent.length - 1];
    const lines = nonEmptyLines(last.text);
    for (const line of lines.slice(-3)) {
      if (line.length > 15 && !FILLER_RE.test(line) && !CODE_NOISE_RE.test(line)) {
        steps.push(clip(line, 200));
      }
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




