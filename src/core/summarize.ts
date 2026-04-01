import type { Message } from "@mariozechner/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { formatSummary } from "./format";
import { redact } from "./redact";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
  customInstructions?: string;
}

const headers = [
  "Session Goal", "Current State", "What Was Done",
  "Important Findings", "Files And Changes", "Open Problems",
  "Decisions And Constraints", "User Preferences", "Next Best Steps",
];

const sectionOf = (text: string, header: string): string => {
  const start = text.indexOf(`[${header}]`);
  if (start < 0) return "";
  const after = text.slice(start);
  const next = headers.map((h) => h === header ? -1 : after.indexOf(`[${h}]`))
    .filter((n) => n > 0).sort((a, b) => a - b)[0];
  return (next ? after.slice(0, next) : after).trim();
};

const VOLATILE_SECTIONS = new Set([
  "Current State", "Open Problems", "Next Best Steps",
]);

const APPENDABLE_SECTIONS = new Set([
  "What Was Done", "Important Findings", "Files And Changes",
  "Decisions And Constraints", "User Preferences",
]);

const extractBullets = (section: string): string[] =>
  section.split("\n").filter((l) => /^\s*[-*]/.test(l) || /^\s*(Read|Modified|Created):/.test(l));

const mergeSectionContent = (header: string, prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) {
    if (VOLATILE_SECTIONS.has(header)) return "";
    return prev;
  }
  if (VOLATILE_SECTIONS.has(header)) return fresh;
  if (APPENDABLE_SECTIONS.has(header)) {
    const oldBullets = extractBullets(prev);
    const newBullets = extractBullets(fresh);
    const combined = [...new Set([...oldBullets, ...newBullets])];
    const headerLine = `[${header}]`;
    return headerLine + "\n" + combined.join("\n");
  }
  return fresh;
};

const mergePrevious = (prev: string, fresh: string): string => {
  const merged = headers
    .map((header) => {
      const freshSec = sectionOf(fresh, header);
      const prevSec = sectionOf(prev, header);
      return mergeSectionContent(header, prevSec, freshSec);
    })
    .filter(Boolean);
  return merged.join("\n\n");
};

const SUMMARY_MAX_CHARS = 12_000;

export const compile = (input: CompileInput): string => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks, fileOps: input.fileOps });
  if (input.customInstructions?.trim()) {
    data.decisions = [
      `Compaction instruction: ${input.customInstructions.trim()}`,
      ...data.decisions,
    ].slice(0, 10);
  }
  const fresh = formatSummary(data);
  const merged = input.previousSummary ? mergePrevious(input.previousSummary, fresh) : fresh;
  const redacted = redact(merged);
  return redacted.length > SUMMARY_MAX_CHARS
    ? redacted.slice(0, SUMMARY_MAX_CHARS) + "\n...(summary truncated)"
    : redacted;
};
