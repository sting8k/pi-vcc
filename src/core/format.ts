import type { SectionData } from "../sections";

const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

/**
 * Join a categorized line's items (oldest first), keeping the newest `limit`
 * behind a leading "(+N earlier)". Keeping the oldest instead froze a merged
 * list on its first entries. stripCapMarker is its inverse, used when a merge
 * re-reads the line.
 */
export const capItems = (items: readonly string[], limit: number, joinWith: string): string => {
  if (items.length <= limit) return items.join(joinWith);
  return `(+${items.length - limit} earlier) ` + items.slice(-limit).join(joinWith);
};

/** Files listed per Files And Changes category; the newest are kept. */
export const FILES_PER_CATEGORY = 10;

/** Also strips the trailing "(+N more)" that older versions wrote. */
export const stripCapMarker = (text: string): string =>
  text.replace(/^\s*\(\+\d+ earlier\)\s*/, "").replace(/\s*\(\+\d+ (?:more|earlier)\)\s*$/, "");

export const BRIEF_MAX_LINES = 120;
const TUI_SAFE_LINE_CHARS = 120;

const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = "";

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

export const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text.split("\n").flatMap((line) => wrapLine(line, maxChars)).join("\n");

export const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Find first section header to avoid cutting mid-section
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

export const RECALL_NOTE =
  "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. " +
  "Do not redo work already completed.";

export interface FormatSummaryOptions {
  capBriefTranscript?: boolean;
}

export const formatSummary = (data: SectionData, options: FormatSummaryOptions = {}): string => {
  const capBriefTranscript = options.capBriefTranscript ?? true;
  const headerParts = [
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Tracked Commands", data.trackedCommands),
    section("User Messages", data.userMessages),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBriefTranscript ? capBrief(data.briefTranscript) : data.briefTranscript);
  }

  if (parts.length === 0) return "";

  // NOTE: RECALL_NOTE is intentionally NOT appended here.
  // It is appended once by `compile()` at the very end, after merge-with-previous,
  // to avoid the note compounding inside the brief transcript across compactions.
  return wrapLongLines(parts.join("\n\n---\n\n"));
};
