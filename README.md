# pi-vcc

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls — produces a brief transcript via extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) **(View-oriented Conversation Compiler)**.

## Demo

![pi-vcc demo](./demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | 35-99% on real sessions (higher on longer sessions) |
| **Compaction latency** | Waits for LLM call | 30-470ms, no API calls |
| **History after compaction** | Gone — agent only sees summary | Active lineage searchable via `vcc_recall` (`scope:"all"` available) |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero — no API calls |
| **Structure** | Free-form prose | Brief transcript + 4 semantic sections |

## Features

- **No LLM** — purely algorithmic, zero extra API cost
- **Brief transcript** — chronological conversation flow, each tool call collapsed to a one-liner with `(#N)` refs, text truncated to keep it compact
- **5 semantic sections** — session goal, files & changes, commits, outstanding context, user preferences
- **Bounded merge** — rolling sections re-capped after merge instead of growing unbounded
- **Lossless recall** — `vcc_recall` reads raw session JSONL, so active-lineage history stays searchable across compactions
- **Scoped recall** — default search is active lineage; use `scope:"all"` / `scope:all` to intentionally search across all lineages
- **Regex search** — `vcc_recall` supports regex patterns (`hook|inject`, `fail.*build`) and OR-ranked multi-word queries
- **Result ranking** — search results ranked by term relevance, rare terms weighted higher than common ones
- **`/pi-vcc-recall`** — slash command to search history directly, results shown as collapsible message and auto-fed to agent as context
- **Fallback cut** — still works when Pi core returns nothing to summarize
- **`/pi-vcc`** — manual compaction on demand

## Install

```bash
pi install npm:@sting8k/pi-vcc
```

Or from GitHub:

```bash
pi install https://github.com/sting8k/pi-vcc
```

Or try without installing:

```bash
pi -e https://github.com/sting8k/pi-vcc
```

## Usage

pi-vcc runs automatically when your context window fills up, or on-demand via commands.

### Compaction

- **`/pi-vcc`** — manual compaction, keeps the last 1 user turn by default.
- **`/pi-vcc keep:N [prompt]`** — keep the last `N` user turns; optional prompt is sent to the agent after compaction.
  - `keep:1` = default, `keep:0` = compact everything, no tail.
- By default pi-vcc also handles `/compact` and auto-threshold compactions. Set `overrideDefaultCompaction: false` to send those paths back to Pi core.
- **Smart keep**: when enabled, pi-vcc auto-boosts `keep:1` to a larger N if the tail is small enough (< 5k tokens, capped at 20k).

### Compacted message structure

```
[Session Goal]
- Fix the authentication bug in login flow
- [Scope change]
- Also update the session token refresh logic

[Files And Changes]
- Modified: src/auth/session.ts
- Created: tests/auth-refresh.test.ts

[Commits]
- a1b2c3d: fix(auth): refresh token after password reset

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset...
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
* bash "bun test tests/auth.test.ts" (#16)
...(28 earlier lines omitted)
```

Sections appear only when relevant — a session with no git commits won't have `[Commits]`.

**Sections:**

| Section | Description |
|---|---|
| `[Session Goal]` | Initial goal + scope changes (regex-based extraction) |
| `[Files And Changes]` | Modified/created files from tool calls (capped, paths trimmed to common root) |
| `[Commits]` | Git commits made during the session (last 8, hash + first line) |
| `[Outstanding Context]` | Unresolved items — errors, pending questions |
| `[User Preferences]` | Regex-extracted from user messages (`always`, `never`, `prefer`...) |
| Brief transcript | Chronological conversation flow — rolling window of ~120 recent lines, tool calls collapsed to one-liners with `(#N)` refs |

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly, so anything dropped by compaction stays reachable. By default it covers the active conversation lineage, regardless of how many compactions have happened. Use `scope:"all"` to also reach messages from other branches, such as turns that were edited or retried. Scope is limited to the current session — earlier sessions are not searchable.

**Plain keywords work best.** Multi-word queries are OR-matched and ranked by relevance; a regex pattern is also accepted, and if it matches nothing the query falls back to keyword search:

```
vcc_recall({ query: "auth token" })                  // active-lineage OR search, ranked
vcc_recall({ query: "auth token", page: 2 })           // paginated (5 results/page)
vcc_recall({ query: "hook|inject" })                  // regex pattern
vcc_recall({ query: "auth token", scope: "all" })    // search all lineages
```

Manual slash command:

```
/pi-vcc-recall auth token scope:all
```

## Pipeline

1. **Calibrate** — estimate `charsPerToken` from `preparation.tokensBefore` vs actual message chars (falls back to heuristic `4 chars/token`)
2. **Smart keep** — if `keep:1` tail is small (< 5k tokens), boost keep to the largest N whose tail stays ≤ 20k tokens; explicit `keep:N` is always respected
3. **Build cut** — split at the keep boundary; everything before is summarized, the tail stays intact
4. **Normalize** — raw Pi messages → uniform blocks (user, assistant, tool_call, tool_result, thinking)
5. **Filter noise** — strip system messages, empty blocks
6. **Build sections** — extract goal, file paths, commits, outstanding context, preferences
7. **Brief transcript** — chronological conversation flow, tool calls collapsed to one-liners, text truncated
8. **Format** — render into bracketed sections + transcript
9. **Merge** — if previous summary exists: sticky sections dedup, volatile sections replace, transcript rolls

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` (auto-scaffolded on first load with safe defaults):

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: when `true`, pi-vcc handles all compaction paths — `/pi-vcc`, `/compact`, and auto-threshold/overflow. Set `false` to restrict pi-vcc to `/pi-vcc` and let the rest fall through to pi core. Existing config files keep whatever value they already have.
- **`smartKeepTail`** *(default `true`)*: when `true`, pi-vcc boosts the default `keep:1` to the largest `N` whose tail stays ≤ 20k tokens, but only when the `keep:1` tail is already small (≤ 5k tokens). Explicit `keep:N` from the user is always respected.
- **`continueAfterThresholdCompact`** *(default `true`)*: permission for pi-vcc to ask the agent to continue after a successful automatic compaction (threshold or overflow), avoiding a UX cliff where the agent stops after compaction instead of continuing the task. It only applies to pi < 0.84.4 - from 0.84.4 on, pi core resumes the run itself, so pi-vcc never sends its own continue (a second one would land as a ghost turn). `false` disables it on every version.
- **`debug`** *(default `false`)*: when `true`, each compaction writes detailed info to `/tmp/pi-vcc-debug.json` — message counts, cut boundary, summary preview, sections, token estimate calibration.

## Benchmarks

Local benchmarks / research comparing the ranked brief against the shipped pi-vcc 0.3.18 baseline (recall, fact-density, precision, size) live in [`benchmarks/README.md`](./benchmarks/README.md).

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) — the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) — the AI coding agent this extension is built for

## Acknowledgments

- Recall `mode:"touched"` + `#N:path` drill-down ported from
  [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik),
  who also suggested the feature.
- Invisible auto-continue pattern ported from
  [monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc) (`tom` branch) by [@monotykamary](https://github.com/monotykamary).

## License

MIT
