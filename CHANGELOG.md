# Changelog

All notable changes to `@sting8k/pi-vcc` are documented in this file.

## [Unreleased]

### Changes

- **`buildVccSummary` is exported** — an extension that appends its own compaction entry (e.g. a tool-triggered compaction at a turn boundary) can now build the exact summary the hook writes: same sections, same session-global `(#N)` refs that `vcc_recall` resolves, same ranked brief. No behavior change to auto-compaction.

## [0.11.1]

### Fixes

- **Transcript text no longer becomes a summary section** — the merge with the previous summary looked for `[Tracked Commands]`, `[Commits]` and the other headers anywhere in the text, transcript included. A transcript line that started with or mentioned one of those names became a section of junk text (even with `trackCommands` empty), and every later compaction copied it again. A header now counts only as a line of its own before the transcript. Summaries already carrying such junk drop it at the next compaction. (#60)
- **`[Commits]` lists each commit once, and misses fewer** — a commit seen once without its hash (`git commit -q` prints none) and once with it was listed twice. Commits made with combined flags (`-am`, `-qam`) or with the message on stdin (`-F -` and a heredoc) were not read at all, and only the first of several commits in one command was kept. (#60)
- **Files edited by a multi-file edit tool are listed** — an edit tool that takes a `paths` list instead of one `path` left those files out of `[Files And Changes]` and showed a bare `* edit` in the transcript. They now appear in `Modified`, as `* edit "a.ts" +2` in the transcript, and in `vcc_recall` (`mode:touched` and file search). (#60)

## [0.11.0]

### Changes

- **Summary sections no longer depend on English wording** — `[Session Goal]` and `[User Preferences]` picked lines by English keywords (`fix`, `instead`, `always`, `prefer`…), so in another language they stayed empty or kept the wrong lines, and `[Outstanding Context]` kept any line containing words like `failed`. `[Session Goal]` is replaced by `[Early Session Requests]`: the session's first 3 user messages, as written, kept across compactions. A new `[User Messages]` section lists the 15 newest later messages as written, replacing `[Scope change]` and `[User Preferences]`. A command the user runs with `!` is not counted as one of their messages: the transcript shows it as one `$ cmd (#N)` line, and `vcc_recall` opens its output. `[Outstanding Context]` is removed; recent errors are still in the transcript. A summary written by an older version is still read: its first `[Session Goal]` line becomes the early request and the removed sections are dropped. (#56, #58, #59)

### Fixes

- **`[Files And Changes]` follows recent work** — each category kept the first 10 files and then never changed: the merge with the previous summary re-read the capped list and capped it again oldest-first, so every later file was hidden for the rest of the session. The list now keeps the 10 newest files per category (`(+N earlier)`, as in `[Tracked Commands]`), and a file touched again moves back to the newest end. By @zbrdc (#54).
- **Extension messages no longer become the session goal or preferences** — a `custom_message` is turned into a plain user message before summarizing, so a relayed notice or a job-finished line was read as the user's goal, scope change or preference. The hook now marks these messages as injected: they still appear in the brief transcript, but `[Early Session Requests]` and `[User Messages]` read only what the user wrote. By @zbrdc (#55).
- **Long items from the latest turn survive the merge** — from the second compaction on, a header item longer than one line (a long goal, a long file list) lost everything after its first line, so most modified files and the end of long goals went missing. Both the previous and the new summary are now rejoined before merging.

## [0.10.2]

### Fixes

- **Config follows Pi's agent directory** — the default config is `pi-vcc-config.json` in Pi's agent directory: `~/.pi/agent`, unless `PI_CODING_AGENT_DIR` is set or a Pi-based host such as Feynman uses its own. If you set `PI_CODING_AGENT_DIR`, move an existing `~/.pi/agent/pi-vcc-config.json` there. `PI_VCC_CONFIG_PATH` still overrides both. By @Markusli (#53).
- **Tool name no longer doubled in the system prompt** — Pi puts the tool name before each tool's prompt line, so `vcc_recall`'s line read `vcc_recall: vcc_recall: …`. By @g-marconet (#52).

## [0.10.1]

### Fixes

- **Messages Pi hid from the model stay out of the summary** — since Pi 0.87.0 a failed attempt that Pi retries, or a cut-off reply before overflow recovery, is kept in the session but marked hidden from the model (`context_edit`). pi-vcc read the raw history and put those turns back into the summary; it now uses Pi's own view of the context when a session has such edits. Sessions without them are unchanged. By @mvdbos (#49).

## [0.10.0]

### Features

- **`vcc_recall` reads a range** — `range: [from, to]` returns entries `#from..#to` in order, 20 per page, so the agent can read what happened around a summary ref like `(#1253)` without guessing search terms or expanding each entry in full. Idea and first version by @Renno231 (#20).
- **`expand` of a tool call includes its result** — the result is matched by tool call id and clipped at 4,000 chars, with the `expand` that reads all of it.
- **Off-path fallback** — when the current conversation path has nothing for a query, range, expand or `#N:path`, recall answers from edited or retried branches and says so on the first line. Before, it answered "No matches" or "Cannot expand" unless the agent knew to retry with `scope: "all"`.
- **Next-step lines** — search results end with a ready `range`/`expand` around the first hit, and `mode: "touched"` with a ready `#N:path` call. A range past the end is read up to the last entry.
- **Forgiving arguments** — mistakes with only one possible meaning are repaired before pi validates the call: `"459"` or `"#459"` for a number, a single index for `expand` or `range`, `"10-20"` or a reversed range, `"ALL"`, and `mode: "all"` meant as `scope: "all"` (which pi used to reject). Anything else unusable is named on an `Ignored:` line.
- **Search skips the turn in progress** — the agent's own question no longer comes back as the first result, and no longer hides an answer that only exists on an edited or retried branch from the fallback.
- **No more silently dropped params** — when a call sets a param its action cannot use (e.g. `query` next to `expand`), the output names it on the first line. Default values such as `page: 1` are not reported.

### Changed

- **Clearer `vcc_recall` description** — lists the actions that each take a whole call (query, range, expand, touched, `#N:path`) apart from the params that work with all of them (page, scope), and says where `#N` comes from.

### Performance

- **Keyword search about 2x faster on large sessions** — each query term is compiled once instead of once per message, with identical results. A long query on a 17k-message session had hit the 3 s search limit under load.

### Internal

- `vcc_recall` and `/pi-vcc-recall` share one pipeline (`src/core/recall-request.ts`, `src/core/recall-run.ts`): one place picks the action, scope is applied once, and the command no longer copies the tool's search and paging code. Replaying 1,086 real recall calls gives byte-identical output apart from the new note.

### Fixes

- **The recall note no longer stacks up** — since 0.3.14 the closing "Use `vcc_recall` …" note was wrapped across two lines, so the next compaction did not recognise it, kept it inside the transcript and added another: one more note per compaction (a third of the summaries in the maintainer's own sessions carried 2 to 4). Every copy is now removed before merging, which also cleans summaries written by older versions, and the freed lines go back to the transcript.
- **`/pi-vcc` on a short session explains itself** — Pi refuses to compact while the whole session fits in the recent part it always keeps (`compaction.keepRecentTokens`), before any extension runs. pi-vcc now says that, as a warning, instead of "Compaction failed: Nothing to compact (session too small)".

## [0.9.0]

### Features

- **`trackCommands` setting and `[Tracked Commands]` section** — list the commands you want remembered across compactions (e.g. `["ssh", "kubectl", "docker"]`, `["psql", "terraform"]`, or a prefix like `"gh pr"`) and the summary keeps their invocations from `bash` tool calls: the 10 most recently used per command, each as written up to the next unquoted shell separator. Sees through `sudo`/`env`/`VAR=` prefixes and into an `ssh host '<command>'` remote command. Fills the gap for sessions where the commands are the record, such as ops work that never edits a file or touches git. Off by default (`[]`), no change for existing configs.

### Docs

- **Shorter README** — repetition removed, the example summary now matches real output, and the size/latency figures were remeasured over 1,884 real sessions (97.6% median size reduction, 1 ms median compaction).

### Internal

- Extracted `mergeFileLines`'s category-parse-merge-render logic into generic, reusable `mergeCategorizedLines`/`formatCategorizedLines` helpers (no behavior change to `[Files And Changes]`), now shared with `[Tracked Commands]`'s merge logic.

## [0.8.3]

### Fixes

- **Summary items cut off on the next compaction** — the stored summary wraps long lines at 120 characters, and merging it into the next summary only read each item's first line. The rest was dropped: the tail of a long `[Session Goal]` item, and whole files from `[Files And Changes]` (e.g. 7 of 8 long paths) once a later compaction also changed files. Wrapped lines are now rejoined before merging.

## [0.8.2]

### Fixes

- **Commit subjects from heredoc messages** — the summary's commits section showed the heredoc opener (`$(cat <<'EOF'`) instead of the real subject for `git commit -m "$(cat <<'EOF' ... EOF)"`, the form coding agents use for multi-line messages. The subject is now read from the heredoc body; an empty or unparsable heredoc is skipped rather than recorded as garbage. (#38, thanks @renyddd)
- **Compaction that did nothing** — Pi 1.0 stores the system prompt as a `role: "system"` session entry. When it was the only thing before the kept tail, pi-vcc summarized nothing: it stored an empty summary, kept every message, and the next turn compacted again. Such a cut now falls back to summarizing everything. Emptiness is judged the way the summarizer sees the prefix, so `custom_message` entries still count as content unless listed in `skipCustomTypes`. The token-budget re-cut gets the same guard. (#40, thanks @mvdbos; #43)

### Chores

- **Smaller npm package** — `package.json` now has a `files` whitelist (`index.ts`, `src/`, `CHANGELOG.md`; npm adds `README.md`, `LICENSE`, `package.json`). The tarball no longer ships `demo.gif` (16.4 MB), `tests/`, `benchmarks/`, `scripts/`, `.github/` or `bun.lock`. The README demo image now uses an absolute GitHub URL so it still renders on npmjs.com.

## [0.8.1]

### Fixes

- **Pi 1.0 compatibility** — peer range widened to `>=0.74.0 <2.0.0`. Pi 1.0 persists the prompt/tool loadout as `role: "system"` session messages; `vcc_recall` / `/vcc-recall` no longer list them as empty `assistant` entries. They keep their `#N` slot so existing refs stay stable, and `#N:file` drill-down now resolves by index instead of array position. Compaction itself was already unaffected.

## [0.8.0]

### Features

- **`skipForProviders` setting** — list of provider ids for which pi-vcc defers compaction entirely, so a provider-specific or remote compaction extension can take over. Matched case-insensitively against `ctx.model.provider` on every compaction (a `/model` switch mid-session is respected); explicit `/pi-vcc` always runs; an undefined model never skips. Needed because `session_before_compact` is last-result-wins by extension load order, so there was no way for users to pick the compactor deterministically. (fixes #27)
- **`skipCustomTypes` setting** — list of `customType` values whose `custom_message` entries are dropped from the summarizer input. Aimed at per-turn boilerplate injected by other extensions (skill cards, guidance blocks) that is regenerated every turn. Exact, case-sensitive match. Only the summary input is filtered: cut selection, token calibration, `firstKeptEntryId` and kept-turn counts are unchanged. Deliberately keyed on `customType` rather than `display: false`, which is a TUI-visibility flag that extensions also use for durable content. (refs #23)

### Fixes

- **Stale stats toast and spurious auto-continue on another extension's compaction.** `session_compact` only checked `event.fromExtension`, so when a different extension produced the compaction pi-vcc still showed its own stats toast with numbers from its last run and could queue its auto-continue. The handler now checks the persisted `compactionEntry.details.compactor === "pi-vcc"` stamp, which is also correct when another extension's `session_before_compact` result wins via load order.

## [0.7.3]

### Fixes

- **Compaction summaries now emit session-global `#N` refs (the recall index space).** Summaries previously numbered the selected compaction window from zero, while `vcc_recall` resolves `#N` against every `type == "message"` entry in the session file. From the second compaction on — and on any session containing abandoned branches — emitted `(#N)` refs retrieved unrelated operations or failed lineage checks. The hook now maps each selected entry id to its global index via a shared counting rule (`src/core/global-indices.ts`, used by both recall and the summary path) and threads per-message indices through `compile`/`compileRanked`; unresolvable positions (custom messages, branch summaries, ambiguous ids, or no index map at all) render no ref instead of a wrong one. Summary details version bumped to `2` to mark the new ref scheme. Ported from k0valik/pi-blackhole commit `f82e07a` — thanks @k0valik for the report and reference fix. Known limitations: summaries minted before this fix keep their window-relative refs until they roll off the brief budget, and branched sessions (`/tree`) write a new file where copied refs point at the old file's index space (unchanged from before).

### Other

- **Added MIT license** — `LICENSE` file plus `"license": "MIT"` in `package.json` (fixes #31).
- **Added CI** — a minimal GitHub Actions test workflow (`bun test` on pull requests and master pushes) with supply-chain hygiene: `pull_request` trigger (never `pull_request_target`), `contents: read` token scope, commit-SHA-pinned actions, `persist-credentials: false`, pinned `bun-version`, and `bun install --frozen-lockfile --ignore-scripts`.
- **Committed `bun.lock`** — it was gitignored and stale since April, so installs drifted (the `pi-coding-agent` peer range resolved to latest instead of the version under development). The refreshed lockfile pins pi `0.85.1` and makes CI reproducible.
- **`tests/real-sessions.test.ts` skips cleanly when no `~/.pi` sessions exist** (CI runners) instead of failing on `ENOENT`.

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
