import type { Message } from "@earendil-works/pi-ai";
import type { FileOps } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { buildSections } from "./build-sections";
import { keepNewestUserMessages } from "../extract/user-messages";
import { formatSummary, capBrief, capItems, stripCapMarker, BRIEF_MAX_LINES, FILES_PER_CATEGORY, RECALL_NOTE, wrapLongLines } from "./format";
import { COMMAND_SEPARATOR, COMMANDS_PER_NAME } from "../extract/tracked-commands";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";

export interface CompileInput {
  messages: Message[];
  previousSummary?: string;
  fileOps?: FileOps;
  /**
   * Session-global `#N` index per message position (see
   * src/core/global-indices.ts). Parallel to `messages`; a missing entry
   * renders as no ref (fail-closed). Omitted entirely → legacy positional.
   */
  sourceIndices?: Array<number | undefined>;
  /** See BuildSectionsInput.trackCommands (core/build-sections.ts) --
   * empty/omitted by default, threaded through from
   * PiVccSettings.trackCommands by the caller (hooks/before-compact.ts). */
  trackCommands?: readonly string[];
}

export interface RankedCompileInput extends CompileInput {
  ranking?: BriefRankingOptions;
}

// A section missing here is dropped on merge, e.g. [Session Goal] or
// [Early Session Requests] from an older version.
const HEADER_NAMES = ["Files And Changes", "Commits", "Tracked Commands", "User Messages"];

const SEPARATOR = "\n\n---\n\n";

// A header section is a "[Title Case]" line standing alone in the header area
// (the text before the first separator) plus the lines up to the next blank
// line; sections are joined by blank lines and have none inside. The brief
// transcript's blocks are "[user]" / "[assistant]", and a transcript line can
// start with "[Some Title]" followed by more text, so a header is never found
// by searching the text for "[Title]". Matching the shape, not a list of names,
// also bounds sections written by older versions (e.g. [Outstanding Context]).
const HEADER_LINE_RE = /^\[[A-Z][^\]\n]*\]$/;

/** Header area and brief transcript. Without a leading header line the whole
 * text is the brief; header sections only (no separator) have no brief. */
const splitSummary = (text: string): { head: string; brief: string } => {
  if (!HEADER_LINE_RE.test(text.split("\n", 1)[0])) return { head: "", brief: text.trim() };
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return { head: text, brief: "" };
  return { head: text.slice(0, idx), brief: text.slice(idx + SEPARATOR.length).trim() };
};

/** Extract a named section from summary text */
export const sectionOf = (text: string, header: string): string => {
  const lines = splitSummary(text).head.split("\n");
  const start = lines.indexOf(`[${header}]`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== "") end++;
  return lines.slice(start, end).join("\n").trim();
};

export const briefOf = (text: string): string => splitSummary(text).brief;

const isClean = (l: string) => l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");
// Both summaries went through wrapLongLines (the fresh one in formatSummary);
// rejoin each item's indented continuation lines so the merges, which read
// only "- " lines, see whole items.
const unwrapSection = (text: string, header: string) => sectionOf(text, header).replace(/\n[ \t]+(?=\S)/g, " ");

const COMMITS_CAP = 8;
const COMMIT_HASH_RE = /^- [0-9a-f]{7,12}: /;
const bareCommit = (line: string): string => line.replace(COMMIT_HASH_RE, "- ");

/** One line per commit, first-seen order. A hashless line is the same commit
 * as a hashed line with its message (one side did not capture the hash): keep
 * the hashed one, in the earlier line's place. */
const dedupCommitLines = (lines: string[]): string[] => {
  const out: string[] = [];
  for (const line of lines) {
    if (out.includes(line)) continue;
    const bare = bareCommit(line);
    if (COMMIT_HASH_RE.test(line)) {
      const hashless = out.findIndex((o) => o === bare);
      if (hashless >= 0) out[hashless] = line;
      else out.push(line);
    } else if (!out.some((o) => bareCommit(o) === bare)) {
      out.push(line);
    }
  }
  return out;
};

/** Merge a header section */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;

  // Files And Changes: merge by category (Modified/Created/Read), dedup paths
  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Tracked Commands: same categorized-merge shape as Files And Changes, but
  // categories are whatever command names the user configured in
  // trackCommands -- discover them from the actual text rather than a
  // fixed list, so a config change between compactions doesn't orphan a
  // category that was already recorded.
  if (header === "Tracked Commands") {
    return mergeTrackedCommandLines(prev, fresh);
  }

  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);

  if (header === "User Messages") {
    return `[${header}]\n${keepNewestUserMessages([...prevLines, ...freshLines]).join("\n")}`;
  }

  // Commits: one line per commit, cap
  const capped = dedupCommitLines([...prevLines, ...freshLines]).slice(-COMMITS_CAP);
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/**
 * Generic categorized-section merge: parses "- Category: a, b, c (+N more)"
 * lines from both prev and fresh text, unions each category's items across
 * compactions (deduped via Set), and re-renders. Extracted from what used
 * to be Files And Changes' only inline implementation, in preparation for
 * a second categorized section reusing the identical shape (see the
 * follow-up `feat/track-commands-section` branch/PR).
 */
const mergeCategorizedLines = (
  categories: readonly string[],
  prev: string,
  fresh: string,
  splitOn: string,
  touchOnDup = false,
): Record<string, Set<string>> => {
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        // Strip the overflow marker so it never merges back in as an entry.
        const rest = stripCapMarker(line.slice(prefix.length));
        for (const p of rest.split(splitOn)) {
          const trimmed = p.trim();
          if (!trimmed) continue;
          // touchOnDup: re-inserting an existing entry moves it to the
          // tail — with tail-capping this makes the section "N most-
          // recently-USED" rather than "N most-recently-first-seen".
          if (touchOnDup && merged[cat].has(trimmed)) merged[cat].delete(trimmed);
          merged[cat].add(trimmed);
        }
      }
    }
  }
  return merged;
};

const formatCategorizedLines = (
  header: string,
  merged: Record<string, Set<string>>,
  categories: readonly string[],
  joinWith: string,
  itemLimit: number,
): string => {
  const lines: string[] = [];
  for (const cat of categories) {
    if (merged[cat].size > 0) lines.push(`- ${cat}: ${capItems([...merged[cat]], itemLimit, joinWith)}`);
  }
  if (lines.length === 0) return "";
  return `[${header}]\n${lines.join("\n")}`;
};

const FILE_CATEGORIES = ["Modified", "Created", "Read"] as const;

/** Merge Files And Changes by category, dedup paths across compactions */
const mergeFileLines = (prev: string, fresh: string): string => {
  // Newest-last with re-touched files moved to the end, so the capped list
  // follows the files being worked on instead of freezing on the first ones.
  const merged = mergeCategorizedLines(FILE_CATEGORIES, prev, fresh, ",", true);
  // Dedup: if already in Modified, drop from Created (file existed before)
  for (const p of merged.Modified) merged.Created.delete(p);
  return formatCategorizedLines("Files And Changes", merged, FILE_CATEGORIES, ", ", FILES_PER_CATEGORY);
};

/** Category names actually present in "- <name>: ..." lines in `text`. */
const discoverCategoryNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([^:]+): /);
    if (m) names.add(m[1]);
  }
  return [...names];
};

/**
 * Merge Tracked Commands by whatever command names actually appear in prev/
 * fresh (not a fixed category list, since trackCommands is user-config).
 * Line format (separator, cap) is owned by extract/tracked-commands.ts.
 */
const mergeTrackedCommandLines = (prev: string, fresh: string): string => {
  const categories = [...new Set([...discoverCategoryNames(prev), ...discoverCategoryNames(fresh)])];
  const merged = mergeCategorizedLines(categories, prev, fresh, COMMAND_SEPARATOR, true);
  return formatCategorizedLines("Tracked Commands", merged, categories, COMMAND_SEPARATOR, COMMANDS_PER_NAME);
};

const mergeBriefTranscript = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return prev + "\n\n" + fresh;
};

const briefLineCount = (text: string): number =>
  text ? text.split("\n").length : 0;

const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBrief(prev);
  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

const mergePrevious = (prev: string, fresh: string, options: { preserveFreshBrief?: boolean } = {}): string => {
  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      return mergeHeaderSection(header, unwrapSection(prev, header), unwrapSection(fresh, header));
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(prev);
  const freshBrief = briefOf(fresh);
  const mergedBrief = options.preserveFreshBrief
    ? mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief)
    : mergeBriefTranscript(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(options.preserveFreshBrief ? mergedBrief : capBrief(mergedBrief));
  }

  return parts.join(SEPARATOR);
};

interface CompileWithBriefBlocksOptions {
  briefBlocksFor?: (blocks: ReturnType<typeof normalize>) => ReturnType<typeof normalize>;
  capFreshBrief?: boolean;
  preserveFreshBriefOnMerge?: boolean;
}

const compileWithBriefBlocks = (input: CompileInput, options: CompileWithBriefBlocksOptions = {}): string => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices));
  const briefBlocks = options.briefBlocksFor?.(blocks);
  // Strip any legacy RECALL_NOTE baked into prev summary (pre-fix format)
  // so merge doesn't re-stack it inside the brief.
  const prev = input.previousSummary
    ? stripRecallNote(input.previousSummary)
    : undefined;
  const data = buildSections({ blocks, briefBlocks, fileOps: input.fileOps, trackCommands: input.trackCommands });
  const fresh = formatSummary(data, { capBriefTranscript: options.capFreshBrief ?? true });
  const merged = prev ? mergePrevious(prev, fresh, { preserveFreshBrief: options.preserveFreshBriefOnMerge }) : fresh;
  if (!merged) return "";
  return wrapLongLines(merged + SEPARATOR + RECALL_NOTE);
};

export const compile = (input: CompileInput): string =>
  compileWithBriefBlocks(input);

export const compileRanked = (input: RankedCompileInput): string =>
  compileWithBriefBlocks(input, {
    briefBlocksFor: (blocks) => selectRankedBriefBlocks(blocks, {
      ...input.ranking,
      fileOps: input.ranking?.fileOps ?? input.fileOps,
    }),
    capFreshBrief: false,
    preserveFreshBriefOnMerge: true,
  });

/**
 * RECALL_NOTE as stored: wrapLongLines breaks it across lines (it is longer
 * than the wrap width), so match its words separated by any whitespace,
 * together with the separator in front of it.
 */
const RECALL_NOTE_RE = new RegExp(
  "\\n*(?:---\\n+)?" +
    RECALL_NOTE.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+") +
    "\\n*",
  "g",
);

/**
 * Remove every RECALL_NOTE from a previous summary before merging. The exact
 * match this replaced never found the wrapped note, so each compaction kept
 * the old note inside the brief and stacked one more; this also cleans those.
 */
const stripRecallNote = (text: string): string =>
  text.replace(RECALL_NOTE_RE, "\n\n").trimEnd();
