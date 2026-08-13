import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { loadAllMessages } from "../core/load-messages";
import { searchEntries, getTouchedFiles } from "../core/search-entries";
import { formatRecallOutput, formatTouchedOutput } from "../core/format-recall";
import { renderMessage } from "../core/render-entries";
import type { RenderedEntry } from "../core/render-entries";
import { getActiveLineageEntryIds } from "../core/lineage";
import { normalizeRecallScope, normalizeRecallMode } from "../core/recall-scope";
import { parseDrillDown, expandEntryFile } from "../core/drill-down";

const DEFAULT_RECENT = 25;
const PAGE_SIZE = 5;

/** Default total character budget for a pinned-range digest (~1.5k tokens). */
export const RANGE_BUDGET_CHARS = 6000;
/** Per-entry readability floor; below this entries degrade to unreadable stubs. */
export const RANGE_MIN_CHARS = 50;

/**
 * Nth harmonic number H_n = Σ 1/i, the normalization constant for gradient
 * allocation. Precompute once per call and pass to rangeCap.
 */
export const harmonicSum = (n: number): number => {
  let s = 0;
  for (let i = 1; i <= n; i++) s += 1 / i;
  return s;
};

/**
 * Gradient per-entry character cap for the pinned-range digest. The head of the
 * range (oldest entries — the ones compaction erases first) gets full detail,
 * decaying as 1/(position+1) toward a readability floor at the tail. renderMessage
 * applies role ceilings (prose 300 / tool output 200) on top, so small ranges
 * render exactly as today while large ranges self-bound in a single call.
 */
export const rangeCap = (
  position: number,
  total: number,
  hSum: number,
  budget = RANGE_BUDGET_CHARS,
  minChars = RANGE_MIN_CHARS,
): number => {
  if (total <= 0) return 0;
  const raw = (budget / (position + 1)) / hSum;
  return Math.max(minChars, Math.min(300, Math.floor(raw)));
};

export const invalidExpandIndices = (requested: number[], available: Set<number>): number[] =>
  requested.filter((i) => !Number.isInteger(i) || !available.has(i));

/**
 * Validate the pinned-range form (from/to/limit). Returns an error string, or
 * null when the params are usable. from/to are inclusive message indices, not
 * turn numbers; both must be present together. 'limit' caps results and only
 * applies to the pinned-range form.
 */
export const validateRangeParams = (
  from: number | undefined,
  to: number | undefined,
  limit: number | undefined,
): string | null => {
  const hasFrom = from !== undefined;
  const hasTo = to !== undefined;
  if (hasFrom !== hasTo) {
    return "Pinned-range recall requires both 'from' and 'to' (inclusive message indices). Example: vcc_recall({ from: 170, to: 217 })";
  }
  if (!hasFrom) {
    if (limit !== undefined) {
      return "'limit' only applies to the pinned-range form and must be paired with 'from' and 'to'.";
    }
    return null;
  }
  if (!Number.isInteger(from) || !Number.isInteger(to)) {
    return "'from' and 'to' must be integer message indices.";
  }
  const f = from as number;
  const t = to as number;
  if (f > t) {
    return `Invalid range: from (${f}) is greater than to (${t}). Indices are inclusive.`;
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    return "'limit' must be a positive integer.";
  }
  return null;
};

export interface RangeRecallResult {
  /** Global message indices within [from..to], capped by 'limit' when provided. */
  indices: number[];
  /** Entries in the full range before any cap. */
  total: number;
  /** Expand indices that fall outside the range (or are non-integers). */
  invalidExpand: number[];
  /** True when 'limit' cut the range short. */
  truncated: boolean;
  /** Next 'from' index to continue from when truncated (last shown + 1). */
  nextFrom: number | undefined;
}

/**
 * Select the inclusive message-index range [from..to] from rendered entries.
 * Returns global indices in ascending order. 'expand' indices are validated
 * against the range. When 'limit' caps the result, nextFrom reports the index
 * to continue from on the next call.
 */
export const selectRangeEntries = (
  msgs: RenderedEntry[],
  from: number,
  to: number,
  limit?: number,
  expand?: number[],
): RangeRecallResult => {
  const ranged = msgs.filter((m) => m.index >= from && m.index <= to);
  const rangedIndices = new Set(ranged.map((m) => m.index));
  const invalidExpand = invalidExpandIndices(expand ?? [], rangedIndices);

  const total = ranged.length;
  const capped = limit !== undefined ? ranged.slice(0, limit) : ranged;
  const truncated = limit !== undefined && capped.length < total;
  const last = capped[capped.length - 1];
  return {
    indices: capped.map((m) => m.index),
    total,
    invalidExpand,
    truncated,
    nextFrom: truncated && last ? last.index + 1 : undefined,
  };
};

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Recall earlier parts of the current session — decisions made, files touched, commands run, " +
      "including anything dropped by compaction. Reach for this before telling the user you no longer " +
      "have the context. Plain keywords work best; a regex pattern is also accepted. Results are paged " +
      "(page); pass expand with entry indices to read full untruncated content. Use mode:'touched' to " +
      "list files worked on in this session with their entry indices, and #N:path to drill into a file's " +
      "content from an entry (#N:path:full for all lines). Note: apply_patch paths (inside the diff " +
      "payload) and bash redirects do not appear in the touched index. Only the current session is " +
      "searchable — earlier sessions are not. Pinned-range form: vcc_recall({ from, to, limit?, expand?, " +
      "scope? }) returns the inclusive message-index range [from..to] (indices, not turn numbers). If " +
      "capped by 'limit', continue from the returned 'continue from' index. Range output is lean by " +
      "default: one call returns the whole range as a digest, with detail decaying from the head of " +
      "the range to the tail (older entries get more characters; expand returns verbatim content for " +
      "specific indices).",
    promptSnippet:
      "vcc_recall: recall earlier parts of this session before saying the context is gone. " +
      "Plain keywords work best; scope:'all' widens to other conversation branches. " +
      "mode:'touched' lists files worked on; #N:path drills into a file's content from an entry. " +
      "Pinned range: vcc_recall({ from, to, limit? }) — inclusive message indices; one-call digest with " +
      "detail decaying head-to-tail; if capped, continue from the returned index.",
    parameters: Type.Object({
      from: Type.Optional(
        Type.Number({ description: "Inclusive start message index for pinned-range recall. Must be paired with 'to'. Indices are message indices, not turn numbers." }),
      ),
      to: Type.Optional(
        Type.Number({ description: "Inclusive end message index for pinned-range recall. Must be paired with 'from'. Indices are message indices, not turn numbers." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Optional cap on entries returned for pinned-range recall. When capped, output includes a 'continue from' index to pass as 'from' on the next call." }),
      ),
      query: Type.Optional(
        Type.String({ description: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. Ignored when the pinned-range form ('from'/'to') is used." }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for. In the pinned-range form, must fall within the requested range." }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number (1-based) for paginated search results. Default: 1. Not used in the pinned-range form (use 'limit' instead)." }),
      ),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("lineage"),
          Type.Literal("all"),
        ], { description: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried." }),
      ),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("hybrid"),
          Type.Literal("touched"),
        ], { description: "What to show. hybrid (default) = normal search; touched = aggregated files-by-path with entry indices." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }

      const scope = normalizeRecallScope(params.scope);
      const lineageEntryIds = scope === "lineage"
        ? getActiveLineageEntryIds(ctx.sessionManager)
        : undefined;

      // Pinned-range form: vcc_recall({ from, to, limit?, expand?, scope? }).
      // from/to are inclusive message indices, not turn numbers. When capped by
      // 'limit', the output reports a 'continue from' index for the next call.
      const from = params.from ?? undefined;
      const to = params.to ?? undefined;
      const limit = params.limit ?? undefined;
      const rangeError = validateRangeParams(from, to, limit);
      if (rangeError) {
        return { content: [{ type: "text", text: rangeError }], details: undefined };
      }

      if (from !== undefined && to !== undefined) {
        const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const expandArr = params.expand ?? [];
        const expandSet = new Set(expandArr);
        const { indices, total, invalidExpand, truncated, nextFrom } = selectRangeEntries(
          msgs, from, to, limit, expandArr,
        );

        if (invalidExpand.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside range ${from}..${to}: ${invalidExpand.join(", ")}` }],
            details: undefined,
          };
        }

        if (indices.length === 0) {
          if (scope === "lineage") {
            const { rendered: allMsgs } = loadAllMessages(sessionFile, false);
            if (allMsgs.some((m) => m.index >= from && m.index <= to)) {
              return {
                content: [{ type: "text", text: `Indices ${from}..${to} exist but lie outside the active lineage. Use scope:'all' to reach them.` }],
                details: undefined,
              };
            }
          }
          return {
            content: [{ type: "text", text: `No messages found with indices ${from}..${to} in session history.` }],
            details: undefined,
          };
        }

        // Lean by default: gradient allocation gives the head of the range full
        // detail and decays toward a readability floor at the tail, so a single
        // call returns the whole range without pagination (role ceilings applied
        // in renderMessage).
        const hSum = harmonicSum(indices.length);
        const rawByIndex = new Map<number, Message>();
        msgs.forEach((m, i) => { rawByIndex.set(m.index, rawMessages[i]); });
        const entries = indices.map((idx, position) => {
          const raw = rawByIndex.get(idx);
          if (!raw) return { index: idx, role: "unknown", summary: "[message unavailable]" } as RenderedEntry;
          return expandSet.has(idx)
            ? renderMessage(raw, idx, true)
            : renderMessage(raw, idx, false, rangeCap(position, indices.length, hSum));
        });

        const scopeNote = scope === "all" ? ", scope: all" : "";
        const header = `Pinned range #${from}..#${to} (${total} messages${scopeNote}${truncated ? `, showing ${entries.length}` : ""})`;
        let output = formatRecallOutput(entries, undefined, header);
        if (truncated && nextFrom !== undefined) {
          const limitArg = limit !== undefined ? `, limit: ${limit}` : "";
          const scopeArg = scope === "all" ? ', scope: "all"' : "";
          output += `\n\n--- Capped at limit:${limit} (${entries.length} of ${total} shown). Continue from: ${nextFrom} — call vcc_recall({ from: ${nextFrom}, to: ${to}${limitArg}${scopeArg} }) for the rest ---`;
        }
        return { content: [{ type: "text", text: output }], details: undefined };
      }

      // Drill-down: #N:path resolves to file-scoped tool content. Anchored so
      // inline mentions like "see #42:auth.ts" are never treated as drill-down.
      // Honors scope like every other recall path: the target entry must be on
      // the active lineage unless scope:'all'. Membership is checked against
      // global indices; expandEntryFile keeps loading unfiltered so #N stays
      // aligned with the global message index.
      const q = params.query?.trim();
      if (q && parseDrillDown(q)) {
        const parsed = parseDrillDown(q)!;
        if (lineageEntryIds) {
          const { rendered } = loadAllMessages(sessionFile, false, lineageEntryIds);
          if (!rendered.some((m) => m.index === parsed.index)) {
            return {
              content: [{ type: "text", text: `Cannot expand indices outside active lineage: ${parsed.index}. Use scope:'all' to reach other branches.` }],
              details: undefined,
            };
          }
        }
        const text = expandEntryFile(
          sessionFile,
          parsed.index,
          parsed.pathPattern,
          parsed.full,
          parsed.offset,
          parsed.limit,
        );
        return {
          content: [{ type: "text", text }],
          details: undefined,
        };
      }

      // touched mode: aggregate file operations across the live window.
      if (normalizeRecallMode(params.mode) === "touched") {
        const { rendered, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
        const touched = getTouchedFiles(rawMessages, rendered);
        const text = formatTouchedOutput(touched, params.page);
        return {
          content: [{ type: "text", text }],
          details: undefined,
        };
      }

      const expandSet = new Set(params.expand ?? []);
      const hasExpand = expandSet.size > 0;

      if (hasExpand && !params.query) {
        const { rendered: fullMsgs } = loadAllMessages(sessionFile, true, lineageEntryIds);
        const requested = [...expandSet];
        const byIndex = new Map(fullMsgs.map((m) => [m.index, m]));
        const invalid = invalidExpandIndices(requested, new Set(byIndex.keys()));
        if (invalid.length > 0) {
          return {
            content: [{ type: "text", text: `Cannot expand indices outside ${scope === "all" ? "session history" : "active lineage"}: ${invalid.join(", ")}` }],
            details: undefined,
          };
        }

        const expanded = requested.map((i) => byIndex.get(i)).filter((m): m is NonNullable<typeof m> => Boolean(m));
        const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(expanded);
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false, lineageEntryIds);
      const allResults = params.query?.trim()
        ? searchEntries(msgs, rawMessages, params.query)
        : msgs.slice(-DEFAULT_RECENT);

      if (params.query?.trim()) {
        const page = Math.max(1, params.page ?? 1);
        const start = (page - 1) * PAGE_SIZE;
        const pageResults = allResults.slice(start, start + PAGE_SIZE);
        const totalPages = Math.ceil(allResults.length / PAGE_SIZE);
        const scopeSuffix = scope === "all" ? " (scope: all)" : "";
        const header = totalPages > 1
          ? `Page ${page}/${totalPages} (${allResults.length} total matches${scopeSuffix})`
          : `${allResults.length} matches${scopeSuffix}`;
        const footer = page < totalPages
          ? `\n--- Use page:${page + 1}${scope === "all" ? " with scope:'all'" : ""} for more results ---`
          : "";
        const output = formatRecallOutput(pageResults, params.query, header) + footer;
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const output = (scope === "all" ? "Scope: all\n\n" : "") + formatRecallOutput(allResults, params.query);
      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};

