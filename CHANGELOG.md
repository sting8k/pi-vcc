# Changelog

All notable changes to `@sting8k/pi-vcc` are documented in this file.

## [0.7.2]

### Fixes

- **Recall: stream session JSONL files larger than V8's string limit** - Recall now parses session transcripts incrementally instead of decoding the entire file as one UTF-8 string, preventing `ERR_STRING_TOO_LONG` on long-running sessions. Message indices, lineage filtering, malformed-line handling, missing-file behavior, and final records without a trailing newline are preserved. Verified against a 536,885,410-byte synthetic transcript: the previous loader failed at V8's 536,870,888-character limit, while the streamed loader returned the expected messages and global indices.

## [0.7.1]

### Fixes

- **Compaction: prevent duplicate ghost turns on Pi 0.84.4+** - Pi core now resumes runs after automatic compaction, making pi-vcc's queued invisible follow-up redundant and allowing it to land as an unsolicited turn after the resumed run finishes. `continueAfterThresholdCompact` is now a compatibility permission: when enabled, pi-vcc sends its fallback only on Pi versions older than 0.84.4. Existing configs with `true` are protected automatically; malformed runtime versions fail safe by sending nothing. Explicit follow-up prompts and Pi-owned overflow retries are unchanged.
- **Recall: handle brand-new sessions before their JSONL exists** - `/pi-vcc-recall` and shared recall paths now treat a missing current-session file as empty history instead of throwing `ENOENT`, returning the existing friendly no-history/no-match response. Other filesystem errors still surface, and recall remains scoped to the current session.

## [0.7.0]

### Features

- **Recall searches bounded tool-call arguments** — commands, write content, edit text, queries, and other string arguments that previously existed in the session but were invisible to search are now indexed under one shared 2,000-character budget per message. Search snippets come from the same bounded text, while `vcc_recall` excludes its own invocation and output to prevent repeat-query feedback loops. File paths, global `#N` indices, lineage scope, `expand`, `mode:"touched"`, and `#N:path` keep their existing semantics.

### Changes

- **Recall trims noisy result tails and bounds pagination** — multi-term natural-language searches drop hits below 20% of the top BM25 score; single-term and regex searches skip that floor. Every search path is capped at 50 results (10 pages), with explicit `showing 50 of N matches` and out-of-range page messages instead of silently understating or misreporting results. On two real-session benchmark runs, the combined policy produced zero new empty searches and zero top-result changes, reduced median result counts from 32→18 and 29.5→20, and bounded p90 at 50.

## [0.6.1]

### Fixes

- **Recall: `expand` now works when the original `query` is retained** — callers naturally pass the search query together with selected entry indices, but that combination silently re-ran the clipped search path instead of returning full entries. A non-empty `expand` now takes precedence over search while preserving lineage and `scope` validation.

## [0.6.0]

### Features

- **Recall `mode:"touched"` — file activity index** — answers the question agents actually ask after a compaction ("did I already edit this file, and what did I do?"). One call returns every file touched in the session mapped to the entries that touched it (`./src/core/config-manager.ts    #155 (quick_edit), #157 (edit)`), sorted by recency and paged. Classification is shape-based (a call counts when its arguments carry a path plus `content`/`edits`/`oldText`/`newText`), so custom edit tools are recognised without a tool-name allowlist and reads never pollute the index. Indices are the same global message indices `expand` uses. Ported from [pi-blackhole](https://github.com/k0valik/pi-blackhole).
- **Recall `#N:path` drill-down** — expands the file-scoped content of a single operation inside an entry (`#155:config-manager`, `:full`, or `:offset:limit` for long files), instead of the summarised `quick_edit(path=…)` line `expand` used to return. `#N` alone lists the file operations in that entry. The pattern is anchored, so an inline mention such as "see #42:auth.ts" is still an ordinary search. Ported from [pi-blackhole](https://github.com/k0valik/pi-blackhole).

### Changes

- **Invisible auto-continue** — the prompt sent after a compaction is now a custom message with empty content delivered as a follow-up (`triggerTurn`, `deliverAs:"followUp"`) and filtered out of the LLM payload by a `context` hook, instead of a user-role prompt that stayed in context for the rest of the session. Same gating, same timing, no per-compaction context cost. Pattern ported from [monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc) (`tom` branch).
- **Compaction toast reports tail tokens on budget cuts** — a budget cut keeps no whole user turn, so the old line read `kept 0/1 turns` and looked like everything was lost. It now leads with what is actually kept: `kept ~18.2k tok tail (mid-turn cut, no user anchor), summarized 42`. Turn-anchored cuts are unchanged.

### Fixes

- **Compaction: token-budget tail cut for autonomous sessions** — the tail was anchored exclusively to user-message boundaries, which breaks when a session has one user prompt and then runs on its own. With no boundary to keep, the hook fell back to compacting everything (`firstKeptEntryId` empty), orphan recovery rebuilt a window whose only user message was again at index 0, and every subsequent compaction repeated it: the working tail was lost every time, for the rest of the run. Measured on 755 real sessions, 21.7% hit this path. The default path now falls back to a token budget, cutting at the nearest non-`toolResult` boundary (never inside a `toolCall`/`toolResult` pair), mirroring pi core's `findCutPoint` semantics. The mirror case is handled too: a tail larger than 62.5k tokens (2.5x the 25k budget) is re-cut to roughly the budget, so a compaction that used to free almost nothing now does. Explicit `keep:N` is respected absolutely and is never re-cut. Audit on the same corpus: 43 of 43 rescuable sessions keep a tail (median 21.7k tokens) instead of none, 16 of 17 oversized tails drop from a median 73k to 20k tokens, and weighted fact recall for the rescued group rises 0.558 → 0.909. The 682 unaffected sessions are bit-identical.
- **Compaction: `custom_message` and `branch_summary` reached the summariser** — the live window only collected `type: "message"` entries, so anything an extension injected through `sendMessage` (including pi-vcc's own auto-continue) was invisible: not counted, and never passed to the summariser, so its content disappeared silently at every compaction. Both entry types are now converted to their message form in the live window, matching pi core, which treats them as user-role messages. Turn counting still counts only real user messages, so `keep:N` anchoring is unchanged.
- **Recall: `#N:path` drill-down honours `scope`** — the drill-down branch dispatched before scope resolution and read the session unfiltered, making it the one recall path that could return entries from abandoned branches without `scope:"all"`. The target entry is now checked against the active lineage by global index; `expandEntryFile` still loads unfiltered so `#N` stays aligned with the global message index. The same issue exists upstream in pi-blackhole and has been reported there.

Known trade-off: when an oversized tail is re-cut, facts that live in `toolResult` blocks cannot be expressed in the brief (ranking skips those blocks), so that group loses a median 0.049 weighted recall in exchange for freeing ~50k tokens per session. Raising the brief ceiling and block budget was tested and made no difference; a dedicated failures section is the actual fix and is planned. Known limit: a single message at or above the budget cannot be cut around (1 of 755 sessions).

## [0.5.0]

### Changes

- **`overrideDefaultCompaction` now defaults to `true`** — fresh installs let pi-vcc handle `/compact` and auto-threshold/overflow compaction, not just `/pi-vcc`. Existing config files keep their stored value; set `false` to restore pi core's LLM-based compaction for those paths.

### Fixes

- **File activity: case-insensitive tool matching** — `FILE_READ_TOOLS`/`FILE_WRITE_TOOLS`/`FILE_CREATE_TOOLS` were exact-match sets, so Pi's lowercase `read` tool never registered and `[Files And Changes]` emitted no `Read:` line at all (0 of 179 audited sessions produced one). Matching is now case-insensitive, mirroring the `/i` tool regexes in `core/rank.ts`.
- **File activity: recognise modern edit tools** — `quick_edit`, `target_edit` and `apply_patch` are ranked as edits in `src/core/rank.ts` but were missing from `FILE_WRITE_TOOLS`, so files changed through them never appeared under `Modified:`.
- **File activity: use hook-provided file ops** — `buildSections` never received `CompileInput.fileOps`, so the hook's authoritative read/modified sets were dropped before the summary was built. `extractFiles` already accepted the argument; it is now wired through.
- **Recall search: guard against regex backtracking** — a query such as `(a+)+$` made `searchEntries` spend ~0.5s per entry, freezing a 400-entry session for ~3.5 minutes. Patterns with an unbounded quantifier applied to a group that already contains one are now matched literally, and a 3s budget checked between entries stops a runaway search after one entry rather than the whole corpus (normal searches take ~10ms). Same corpus and query: 3.5 min → 0.7ms.
- **Recall search: don't lose results to mode detection** — `looksLikeRegex` treats any query containing `?`, `.`, `(`, `|` etc. as a single regex, so ordinary prose ("why did we drop the cache?") was matched verbatim and returned nothing. Measured across 584 real recall calls: the regex path returned zero results 47.5% of the time (median 1 hit) versus 1.1% for term search (median 98 hits), and 25.9% of queries were routed there. An empty regex result now falls through to term search instead of being returned as-is.
- **Recall tool: describe it as recall, not search** — the tool description led with "Search session history" and advertised regex, so the model filed it under keyword search and wrote regex-style queries (8.8% of 510 real queries contained `|`) instead of reaching for it when context was missing. Description, prompt snippet and parameter docs now say what it is for, prefer plain keywords, explain `scope` without internal jargon, and state plainly that only the current session is searchable. No behaviour change.

Audit on 790 real sessions: weighted recall 63.6% → 74.5% (median 68.2% → 79.3%), weighted fact density 6.00 → 7.08, summary size +6% (4183 → 4433 chars).

## [0.4.0]

### Features

- **Ranked compaction brief** — replace the fixed 120-line summary cap with signal-density-based block selection under a size-relative token budget (floor/ceiling/per-block clamp). On 794 real sessions: size parity with the old cap, recall +2.4pp, gh-recall +7pp, higher fact density.
- **Size-relative brief budget** — `maxBriefChars` now scales with transcript length between a floor (~1100 tok) and ceiling (~2000 tok) at ~15 tok/block, so large sessions are no longer starved of high-value long-tail blocks while small sessions stay tight.
- **Heredoc previews in brief** — multi-line bash (set -euo pipefail + real work) and interpreter heredocs (python3/node/ssh/sqlite3/...) now render a one-line body preview instead of a content-free opener. File-writer heredocs (cat/tee/dd) stay opener-only.
- **Hardened heredoc parsing** — tighten opener regex to reject shift ops (`8<<20`) and numeric heredocs; only treat as heredoc when a closing terminator exists downstream. Misparse rate ≤0.17% across ~105k bash blocks, fail-safe.
- **Trivial-bash penalty** — scaffolding-only bash blocks (set -e, cd, ls, echo) no longer compete with real edits for the brief budget. Failed commands (nonzero exit) are exempt since the failure is itself a state fact.
- **Segment-closing assistant boost** — assistant turns that close a segment (next renderable block is user or EOF) get a +14 score boost and 120+120 head/tail truncation instead of the old head-only budget.
- **Smart keep-tail** — when `smartKeepTail` is enabled (default true), pi-vcc estimates the keep:1 tail token count and, if ≤5k, grows keep to the largest N whose tail stays ≤25k. Explicit `keep:N` from the user is always respected.
- **Auto-continue after compaction** — continue the agent after a successful threshold compaction or overflow compaction, deferred until idle so it doesn't interrupt in-flight tool calls.
- **Token calibration from context usage** — calibrate chars/token from the real `tokensBefore` reported by the harness instead of a hardcoded heuristic, so estimates adapt to each session's content mix.

### Fixes

- **Token estimate: count all token-bearing parts** — `estimateMessageContentChars` now counts `thinking`, `toolCall.arguments` (not just `.input`), and `image` (4800 chars). Previously these were missed, deflating calibrated chars/token (mean 2.35→2.50) and over-estimating tail tokens. Fixes smart-keep engagement and brief budget sizing.
- **Brief budget: charge preserve-recent blocks** — the newest `preserveRecentBlocks` are now charged against `maxBriefChars` instead of being added unconditionally. On the largest real session (~27.9k blocks) the ranked brief was 31% larger than baseline with zero recall gain; `maxBriefChars` is now a true ceiling.
- **Notify format tightened** — compaction notify now shows `kept N/M turns, ~Xk tok (summarized Y)` instead of verbose source-entry counts and mechanism wording. Anomalies (compact-all fallback) collapse to `kept 0/N` with no extra clause.
- **Notify retained with follow-up** — compact metrics notify is no longer swallowed when a pi-vcc follow-up prompt is queued.
- **Brief: preserve message line breaks** — assistant text line breaks are no longer collapsed in the brief render.
- **Exclude tool_result from selection** — `tool_result` blocks no longer consume brief selection budget since they render to nothing.
- **gh pr poll penalty/dedup** — `gh pr view/checks <num>` polling commands get -10 penalty and are deduplicated by PR number; `gh pr merge/create/comment` are not penalized.
- **Continuation timing** — threshold continuation deferred until idle; overflow compaction continuation fixed.
- **Misc** — greptile review nits addressed; smart-keep tests aligned with compact-all boundary.

### Documentation

- Add runnable benchmark template (`benchmarks/benchmark.ts`) with fact model, category weights, and paired recall scoring vs 0.3.18 baseline.
- Add benchmarks writeup (`benchmarks/README.md`) documenting the scoring model, size-relative budget params, and results on a public HF session dataset plus held-out local sessions.
- Restructure usage and recall sections in README; add config field documentation.