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
}

const headers = [
  "Session Goal", "Key Conversation Turns", "Actions Taken",
  "Important Evidence", "Files And Changes", "Outstanding Context",
  "User Preferences",
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
  "Outstanding Context",
]);

const APPENDABLE_SECTIONS = new Set([
  "Key Conversation Turns", "Actions Taken", "Important Evidence",
  "Files And Changes", "User Preferences",
]);

const extractBullets = (section: string): string[] =>
  section.split("\n").filter((l) => /^\s*[-*]/.test(l) || /^\s*(Read|Modified|Created):/.test(l));

const capMergedBullets = (header: string, bullets: string[]): string[] => {
  if (header === "Key Conversation Turns") return bullets.slice(-8);
  if (header === "Important Evidence") return bullets.slice(-8);
  if (header === "User Preferences") return bullets.slice(-6);
  if (header === "Files And Changes") return bullets.slice(0, 12);
  if (header === "Actions Taken") {
    // Filter out old omitted markers before re-capping
    const clean = bullets.filter((b) => !/^\s*-?\s*\+\d+\s+actions omitted/.test(b));
    if (clean.length <= 8) return clean;
    const omitted = clean.length - 5;
    return [
      ...clean.slice(0, 3),
      `- +${omitted} actions omitted`,
      ...clean.slice(-2),
    ];
  }
  return bullets;
};

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
    const combined = capMergedBullets(header, [...new Set([...oldBullets, ...newBullets])]);
    const headerLine = `[${header}]`;
    return combined.length > 0 ? headerLine + "\n" + combined.join("\n") : "";
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

export const compile = (input: CompileInput): string => {
  const blocks = filterNoise(normalize(input.messages));
  const data = buildSections({ blocks, fileOps: input.fileOps });
  const fresh = formatSummary(data);
  const merged = input.previousSummary ? mergePrevious(input.previousSummary, fresh) : fresh;
  return redact(merged);
};
