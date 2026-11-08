import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, isContentBearing, extractToolCallText, extractToolCallArgsText, clip } from "./content";
import { extractPaths } from "./tool-args";

export interface SearchHit extends RenderedEntry {
  /** Context snippet around the first matched term (only when query provided) */
  snippet?: string;
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
}

/**
 * Result of a search, with enough metadata for a caller to report truncation
 * honestly (see `searchEntriesDetailed`). `searchEntries` stays `SearchHit[]`
 * for existing call sites that only need the hits themselves.
 */
export interface SearchResult {
  hits: SearchHit[];
  /** Genuine matches found before the hard cap was applied (after any
   *  relative-floor noise filtering). May exceed `hits.length`. */
  totalBeforeCap: number;
  /** True when the hard cap discarded matches (`totalBeforeCap > hits.length`). */
  truncated: boolean;
}
/** A file touched in one entry — used by mode:touched aggregation. */
export interface FileTouch {
  index: number;
  toolName: string;
  /** False when the call names the file but carries no file content to drill into (a multi-path script edit). */
  drillable?: false;
}

/** Aggregated view of a file touched across multiple entries. */
export interface TouchedFile {
  path: string;
  entries: FileTouch[];
}
const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quantifier starting at `i`, if any. Only unbounded forms (+, *, {n,}) can
 *  drive catastrophic backtracking. */
const quantifierAt = (p: string, i: number): { len: number; unbounded: boolean } => {
  const c = p[i];
  if (c === "+" || c === "*") return { len: 1, unbounded: true };
  if (c === "{") {
    const end = p.indexOf("}", i);
    const body = end === -1 ? "" : p.slice(i + 1, end);
    if (/^\d+(,\d*)?$/.test(body)) return { len: end - i + 1, unbounded: body.endsWith(",") };
  }
  return { len: 0, unbounded: false };
};

/**
 * Detect an unbounded quantifier applied to a group that already contains one,
 * e.g. `(a+)+` or `(\w*)*`. That shape makes the engine explore exponentially
 * many splits on a non-matching input. Alternation overlap like `(a|a)+` is not
 * covered here; the search budget in `searchEntries` is the backstop.
 */
const hasNestedQuantifier = (pattern: string): boolean => {
  const groups: boolean[] = []; // per open group: contains an unbounded quantifier
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") { i++; continue; }
    if (inClass) { if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; continue; }
    if (c === "(") { groups.push(false); continue; }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const q = quantifierAt(pattern, i + 1);
      if (inner && q.unbounded) return true;
      if (groups.length) groups[groups.length - 1] ||= inner || q.unbounded;
      i += q.len;
      continue;
    }
    const q = quantifierAt(pattern, i);
    if (q.unbounded && groups.length) {
      groups[groups.length - 1] = true;
      i += q.len - 1;
    }
  }
  return false;
};

/** Try to compile as regex; fall back to escaped literal. Patterns with nested
 *  unbounded quantifiers are treated as literals rather than compiled. */
const safeRegex = (pattern: string): RegExp => {
  if (hasNestedQuantifier(pattern)) return new RegExp(escapeRegex(pattern), "i");
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(escapeRegex(pattern), "i");
  }
};

/**
 * Wall-clock budget for one search. A normal query over 400 entries takes ~10ms,
 * so this only trips on pathological patterns that survive `hasNestedQuantifier`.
 * Aborting loudly beats returning a silently truncated match count.
 *
 * This is a per-entry checkpoint, not a hard per-call ceiling: JavaScript cannot
 * interrupt a running `RegExp.test`, so a single pathological entry still runs to
 * completion and the overshoot is caught on the next iteration. That bounds the
 * damage to one entry instead of the whole corpus, which is the point — the
 * unbounded case was N entries multiplied by the per-entry cost.
 */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Use fewer or more specific words; ` +
        "for a regex, avoid nested quantifiers such as (a+)+.",
      );
    }
  };
};

/** Detect if the query looks like a single regex pattern (contains regex metacharacters). */
const looksLikeRegex = (query: string): boolean =>
  /[|*+?{}()[\]\\^$.]/.test(query);

/** Build a regex for snippet highlighting — matches first available term. */
const snippetRegex = (terms: string[]): RegExp => {
  const alts = terms.map((t) => safeRegex(t).source);
  return new RegExp(alts.join("|"), "i");
};

// ── Stopwords for natural language queries ──
const STOPWORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

/** Remove stopwords, keep meaningful terms. */
const filterStopwords = (terms: string[]): string[] => {
  const meaningful = terms.filter((t) => !STOPWORDS.has(t.toLowerCase()) && t.length > 1);
  // If all terms were stopwords, return original (don't lose everything)
  return meaningful.length > 0 ? meaningful : terms;
};

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/**
 * One query term, compiled once per search. Building the RegExp per term per
 * doc cost ~1M compilations on a 17k-message session and was most of the
 * search time.
 */
interface Term {
  term: string;
  re: RegExp;      // safeRegex(term): case-insensitive, first match
  global: RegExp;  // same source with "gi", for counting occurrences
}

const compileTerms = (terms: string[]): Term[] =>
  terms.map((term) => {
    const re = safeRegex(term);
    return { term, re, global: new RegExp(re.source, "gi") };
  });

/** Count occurrences of a term in text. */
const termFreq = (text: string, t: Term): number => {
  const matches = text.match(t.global);
  return matches ? matches.length : 0;
};

const wordCount = (doc: string): number => doc.split(/\s+/).length;

/** A run of base64 characters this long can be encoded data (an image, a file). Shorter
 *  ones (keys, tokens) rarely hold a chance match: a 3-letter term hits about once per
 *  32k random chars. JSON, code and paths break a run with punctuation. */
const BASE64_RUN = /[A-Za-z0-9+/=]{1000,}/g;

/** Encoded data mixes digits and both cases (random base64: ~16% / 40% / 40%). Joined
 *  identifiers, hex and `=====` rules do not, and stay searchable. */
const looksEncoded = (run: string): boolean => {
  let digits = 0, upper = 0, lower = 0;
  for (let i = 0; i < run.length; i++) {
    const c = run.charCodeAt(i);
    if (c >= 48 && c <= 57) digits++;
    else if (c >= 65 && c <= 90) upper++;
    else if (c >= 97 && c <= 122) lower++;
  }
  return digits >= run.length * 0.05 && upper >= run.length * 0.15 && lower >= run.length * 0.15;
};

/** An entry's text as search sees it: encoded data is dropped, as search engines drop
 *  overlong tokens. Terms match as substrings, so a short term would hit inside it
 *  hundreds of times, and it would count as one word of length. */
const searchableText = (msg: Message | undefined, e: RenderedEntry): string =>
  (msg ? fullText(msg) : e.summary).replace(BASE64_RUN, (run) => (looksEncoded(run) ? "…" : run));

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // term -> number of docs containing it
  /** Per doc, the terms it contains: found once here, reused for matchCount and scoring. */
  matched: Term[][];
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], docLens: number[], terms: Term[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  const matched: Term[][] = [];
  let totalLen = 0;

  for (let i = 0; i < n; i++) {
    checkBudget();
    totalLen += docLens[i];
    const here: Term[] = [];
    for (const t of terms) {
      if (t.re.test(docs[i])) {
        df.set(t.term, (df.get(t.term) ?? 0) + 1);
        here.push(t);
      }
    }
    matched.push(here);
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df, matched };
};

/** BM25 score for a single doc against query terms. */
const bm25Score = (doc: string, dl: number, terms: Term[], ctx: BM25Context): number => {
  let score = 0;

  for (const t of terms) {
    const tf = termFreq(doc, t);
    if (tf === 0) continue;

    const docFreq = ctx.df.get(t.term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Longest snippet line: a longer one is cut to a window around the match, or to its start. */
const SNIPPET_LINE_CHARS = 300;

const clipLine = (line: string, at: number): string => {
  if (line.length <= SNIPPET_LINE_CHARS) return line;
  const start = Math.max(0, Math.min(at - SNIPPET_LINE_CHARS / 2, line.length - SNIPPET_LINE_CHARS));
  const end = start + SNIPPET_LINE_CHARS;
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
};

/** Line-based snippet: ±contextLines around first regex match. */
const lineSnippet = (text: string, regex: RegExp, contextLines = 2): string | undefined => {
  const lines = text.split("\n");
  let matchIdx = -1;
  let matchAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const at = lines[i].search(regex);
    if (at >= 0) {
      matchIdx = i;
      matchAt = at;
      break;
    }
  }
  if (matchIdx === -1) return undefined;

  const start = Math.max(0, matchIdx - contextLines);
  const end = Math.min(lines.length, matchIdx + contextLines + 1);
  const slice = lines.slice(start, end).map((line, i) => clipLine(line, start + i === matchIdx ? matchAt : 0));

  const parts: string[] = [];
  if (start > 0) parts.push(`...(${start} lines above)`);
  parts.push(...slice);
  if (end < lines.length) parts.push(`...(${lines.length - end} lines below)`);
  return parts.join("\n");
};

/**
 * Aggregate character budget for ALL toolCall arguments appended to one
 * message's searchable text — a single shared budget across every toolCall
 * in the message, not per call, so N toolCalls can't multiply the bound and
 * make one message's contribution to the BM25 doc corpus unbounded.
 *
 * Head-only cap: content past this budget is not indexed via toolCall
 * arguments at all. This is an honest tradeoff, not a proxy for full
 * coverage — a Write/Edit tool result commonly only acknowledges success
 * (e.g. "wrote 400 lines"), so a fact buried past the cap in a giant
 * argument is not guaranteed to be searchable elsewhere either.
 */
const TOOL_ARGS_BUDGET = 2000;

/**
 * Tool name of the recall tool itself (src/tools/recall.ts). A search
 * operation must not match its own query or its own prior output: the
 * vcc_recall invocation is persisted as an ordinary assistant toolCall (its
 * `{ query }` argument, excluded below in `toolCallArgsText`) followed by an
 * ordinary toolResult message (its `N matches for "<query>"` text, excluded
 * in `fullText`) — without both exclusions a repeated query keeps matching
 * its own prior invocation/output and the hit count grows on every search.
 * This is a targeted introspection invariant for one named tool, not a
 * general allowlist/blocklist over tool names or tool results.
 */
const RECALL_TOOL_NAME = "vcc_recall";

/** Text of every toolCall's arguments in a message's content, for search —
 *  bounded once, in aggregate, by TOOL_ARGS_BUDGET. Excludes the recall
 *  tool's own arguments (see RECALL_TOOL_NAME). */
const toolCallArgsText = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  const raw = (content as { type: string }[])
    .filter((part): part is ToolCall => part.type === "toolCall")
    .filter((part) => part.name?.toLowerCase() !== RECALL_TOOL_NAME)
    .map((part) => extractToolCallArgsText(part.arguments))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

/**
 * Build full searchable text for a message: text parts plus toolCall
 * arguments (bash command, Write/Edit content, etc.) so a match that only
 * exists in a tool call's arguments is still findable and its snippet is
 * derived from the same text.
 *
 * The recall tool's own toolResult is excluded (searchable text ""): it
 * echoes back `N matches for "<query>"` from the *previous* recall call, so
 * indexing it would make a repeated query self-match and grow with every
 * search. This only affects search indexing — browse/no-query returns
 * entries before fullText runs (see `searchEntries`), and #N expand reads
 * the message/entry directly, not through this function, so the toolResult
 * is still fully visible there.
 */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  if (msg.role === "toolResult" && msg.toolName?.toLowerCase() === RECALL_TOOL_NAME) {
    return "";
  }
  const text = textOf(msg.content);
  const argsText = toolCallArgsText(msg.content);
  return argsText ? `${text}\n${argsText}` : text;
};

/**
 * Compute file indicators from a message, counting non-empty content lines
 * per content-bearing file call. Shape-based — no tool-name allowlist.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getFileIndicators(msg: Message): { toolName: string; path: string; lineCount: number; drillable: boolean }[] {
  if (!msg?.content || typeof msg.content === "string") return [];
  const indicators: { toolName: string; path: string; lineCount: number; drillable: boolean }[] = [];
  for (const part of msg.content) {
    if (!part || typeof part !== "object" || part.type !== "toolCall") continue;
    const args = part.arguments as Record<string, unknown>;
    const drillable = isContentBearing(args);
    // A multi-path edit tool: a script (`code`) edits the listed `paths`, so there is no per-file content.
    if (!drillable && !(typeof args.code === "string" && Array.isArray(args.paths))) continue;
    const totalText = extractToolCallText(args);
    const nonEmpty = totalText.split("\n").filter((l) => l.trim().length > 0);
    for (const path of extractPaths(args)) {
      indicators.push({
        toolName: part.name || "",
        path,
        lineCount: nonEmpty.length,
        drillable,
      });
    }
  }
  return indicators;
}

/**
 * Aggregate file operations across all entries for mode:touched.
 *
 * Ported from pi-blackhole (https://github.com/k0valik/pi-blackhole, MIT) by
 * k0valik — a pi-vcc derivative.
 */
export function getTouchedFiles(
  messages: Message[],
  rendered: RenderedEntry[],
): TouchedFile[] {
  const map = new Map<string, TouchedFile>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const indicators = getFileIndicators(msg);
    for (const fm of indicators) {
      const index = rendered[i]?.index ?? i;
      if (!map.has(fm.path)) {
        map.set(fm.path, { path: fm.path, entries: [] });
      }
      (map.get(fm.path) as TouchedFile).entries.push({
        index,
        toolName: fm.toolName,
        ...(!fm.drillable && { drillable: false as const }),
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Relative BM25 noise floor for MULTI-TERM natural-language queries only:
 * after sorting by score, drop hits scoring below this fraction of the top
 * score. Relative (not absolute) because BM25 magnitudes vary with corpus
 * size and document length, so a fixed score threshold would behave
 * inconsistently across short vs. long sessions.
 *
 * Applied only when the query has >=2 DISTINCT effective terms after
 * stopword filtering and case/duplicate normalization (see the
 * `effectiveTermCount >= 2` gate below `searchEntriesDetailed` uses before
 * calling `applyRelativeFloor`). Distinct, not raw count: "auth auth" or
 * "Auth AUTH" is semantically a single-term query and must bypass the floor
 * like any other single term — repeating or casing a word doesn't turn it
 * into the multi-term OR-tail noise this floor targets. The normalization is
 * gate-only; it doesn't change `terms` or the BM25 scoring itself, which
 * already matches case-insensitively. For a genuine single term, every hit's
 * occurrence already satisfies the whole query — its BM25 score differences
 * reflect term frequency and document length, not multi-term OR-tail noise,
 * so filtering by it there risks real matches for no corresponding noise
 * reduction. Evidence below confirmed this rather than assuming it.
 *
 * Evidence (scripts/benchmark-recall-quality.ts, run through this exact
 * production function via its `tuning` override — not a duplicate scoring
 * implementation). Two independent runs against real session corpora (23
 * sessions/161 queries and 31 sessions/222 queries; exact counts vary with
 * whatever real sessions are available locally, so both are reported rather
 * than treating one as a fixed target):
 *   - floor=0.20 on multi-term queries: median result count 49→23 (run 1,
 *     n=69) and 60.5→23.5 (run 2, n=98); p90 142.8→81 and 126.2→75.3.
 *     Zero-hit count stayed 0 in both runs, top-1 never changed (0/69,
 *     0/98). Top-5 membership shifted in 5/69 (7%) and 5/98 (5%).
 *   - floor=0.10 was too weak to "meaningfully" remove the tail (multi-term
 *     median only 49→39 / 60.5→42); floor=0.25 removed more but roughly
 *     doubled the multi-term top-5 disruption (8/69, run 1) for little extra
 *     median gain over 0.20. 0.20 is the least aggressive setting that
 *     meaningfully thinned the tail.
 *   - Single-term queries with the floor gated off: every floor candidate
 *     (0, 0.10, 0.20, 0.25) produced byte-identical results — 0/92 and
 *     0/124 top-5 changes in both runs, confirming the gate is a true no-op
 *     rather than an untested assumption. Before this gate existed, applying
 *     0.20 unconditionally still changed single-term top-5 in a small but
 *     non-zero fraction of queries (1/140 in this repo's own rerun, 1/124 in
 *     an independent reviewer rerun) for negligible median movement — real
 *     false-negative risk for no real noise benefit, which is why the gate
 *     exists.
 *
 * The top-scoring hit always survives by construction, independent of the
 * evidence above: its own score always satisfies `score >= topScore * floor`
 * for any floor <= 1, so a non-empty scored[] can never be filtered to zero.
 */
const BM25_RELATIVE_FLOOR = 0.2;

/**
 * Hard cap on total SEARCH results, applied to both the natural-language
 * (post-floor) and regex result paths so pagination stays bounded regardless
 * of how noisy or broad a query is.
 *
 * Evidence (same bench/corpora as BM25_RELATIVE_FLOOR, floor disabled to
 * isolate the cap's effect; run 1 = 161 queries, run 2 = 222 queries):
 * uncapped result counts ranged up to 380 (median 32 / 29.5, p90 119 /
 * 115.9). cap=50 sits ABOVE the corpus's own median in both runs but BELOW
 * its p90 — it leaves the typical (median) query unclipped while still
 * bounding the long tail: only 46/161 (29%) and 66/222 (30%) of queries were
 * truncated by it, versus 90/161 (56%) and 124/222 (56%) for cap=25, which
 * would also clip plenty of unremarkable ~30-match queries well under what
 * "noisy" implies. cap=50 also bounds the worst case (380) down by 87%.
 * Combined with the floor (production policy: floor=0.20 multi-term-only,
 * cap=50, vs. no filtering at all): 0 zero-hit regressions and 0 top-1
 * changes in both runs; top-5 changed in 5/161 (3%) and 5/222 (2%); median
 * result count 32→18 and 29.5→20; p90 119→50 and 115.9→50.
 */
const SEARCH_RESULT_CAP = 50;

/**
 * Tuning overrides for `searchEntriesDetailed`. Exists only so the offline
 * bench (scripts/benchmark-recall-quality.ts) and targeted tests can
 * exercise the real scoring/capping pipeline against candidate constants —
 * production call sites (`searchEntries`, the recall tool) never pass this
 * and always get `BM25_RELATIVE_FLOOR`/`SEARCH_RESULT_CAP`.
 */
export interface SearchTuning {
  relativeFloor?: number;
  cap?: number;
}

/** Drop scored hits below `floor` of the top score. The top hit's own score
 *  always passes (score >= score * floor for floor <= 1), so this can never
 *  turn a non-empty `scored` into an empty result. */
const applyRelativeFloor = (
  scored: Array<{ hit: SearchHit; score: number }>,
  floor: number,
): Array<{ hit: SearchHit; score: number }> => {
  if (scored.length === 0) return scored;
  const topScore = scored[0].score;
  if (topScore <= 0) return scored;
  return scored.filter((s) => s.score >= topScore * floor);
};

/**
 * Bound `hits` to `cap` entries, reporting the pre-cap count so callers can
 * signal truncation honestly instead of understating "total matches".
 *
 * Order preserved, never re-sorted: for the BM25 path that's already
 * highest-score-first, so `slice(0, cap)` keeps the top `cap` hits. For the
 * regex path there is no score — hits are collected in entry/chronological
 * iteration order, so `slice(0, cap)` keeps the OLDEST `cap` matches, not
 * the most recent or most relevant ones. That is an explicit, documented
 * preservation choice for this change, not a new selection/ranking policy —
 * changing which matches a truncated regex search keeps (e.g. newest-first)
 * is a separate decision, out of scope here.
 */
const capHits = (hits: SearchHit[], cap: number): SearchResult => {
  const totalBeforeCap = hits.length;
  const capped = totalBeforeCap > cap ? hits.slice(0, cap) : hits;
  return { hits: capped, totalBeforeCap, truncated: capped.length < totalBeforeCap };
};

/**
 * Full search with truncation metadata. `searchEntries` below is a thin
 * `.hits`-only wrapper kept for existing call sites; use this directly when
 * a caller (the recall tool) needs to report a capped result set honestly.
 */
export const searchEntriesDetailed = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  tuning?: SearchTuning,
): SearchResult => {
  if (!query?.trim()) return { hits: entries, totalBeforeCap: entries.length, truncated: false };

  const relativeFloor = tuning?.relativeFloor ?? BM25_RELATIVE_FLOOR;
  const cap = tuning?.cap ?? SEARCH_RESULT_CAP;
  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // If the query looks like a single regex pattern (contains metacharacters),
  // treat the whole thing as one pattern — don't split into terms.
  //
  // The detection is deliberately loose, so ordinary prose trips it: a trailing
  // "?" or "." turns the whole sentence into one pattern that must match
  // verbatim. On real sessions that path returned nothing 47.5% of the time
  // versus 1.1% for term search. Mode detection must never silently lose
  // results, so an empty regex result falls through to term search below.
  //
  // No relative-floor filtering here: regex matches are boolean (matched or
  // not), there's no score to be relative to. Only the hard cap applies.
  if (looksLikeRegex(rawQuery)) {
    const regex = safeRegex(rawQuery);
    const hits: SearchHit[] = [];
    for (let i = 0; i < entries.length; i++) {
      checkBudget();
      const e = entries[i];
      const msg = messages[i];
      const text = searchableText(msg, e);
      const filePart = e.files?.join(" ") ?? "";
      const hay = `${e.role} ${text} ${filePart}`;
      if (regex.test(hay)) {
        const snip = lineSnippet(text, regex);
        hits.push({ ...e, snippet: snip, matchCount: 1 });
      }
    }
    if (hits.length > 0) return capHits(hits, cap);
  }

  // Natural language / multi-word query: BM25 scoring
  const rawTerms = rawQuery.split(/\s+/);
  const terms = filterStopwords(rawTerms);
  const snipRe = snippetRegex(terms);

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = searchableText(msg, e);
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const compiled = compileTerms(terms);
  const docLens = docs.map(wordCount);
  const ctx = buildBM25Context(docs, docLens, compiled, checkBudget);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    checkBudget();
    const e = entries[i];
    const hay = docs[i];
    const here = ctx.matched[i];
    const mc = here.length;
    if (mc === 0) continue;
    // Terms absent from the doc add 0, so scoring only the matched ones gives the same sum in the same order.
    const score = bm25Score(hay, docLens[i], here, ctx);
    const text = searchableText(messages[i], e);
    const snip = lineSnippet(text, snipRe);
    scored.push({
      hit: { ...e, snippet: snip, matchCount: mc },
      score,
    });
  }

  // Sort by BM25 score desc, then drop the noisy long tail relative to the
  // top score (multi-term queries only — see BM25_RELATIVE_FLOOR), then
  // apply the hard cap.
  scored.sort((a, b) => b.score - a.score);
  // Gate on DISTINCT normalized terms, not raw term count: "auth auth" or
  // "Auth AUTH" is semantically a single-term query and must bypass the
  // floor like any other single term — repeating/casing a word doesn't turn
  // it into the multi-term OR-tail noise this floor targets. This is a
  // gate-only normalization; it does not change `terms` itself or the BM25
  // scoring above, which already matches case-insensitively.
  const effectiveTermCount = new Set(terms.map((t) => t.toLowerCase())).size;
  const floored = effectiveTermCount >= 2 ? applyRelativeFloor(scored, relativeFloor) : scored;
  return capHits(floored.map((s) => s.hit), cap);
};

export const searchEntries = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
): SearchHit[] => searchEntriesDetailed(entries, messages, query).hits;
