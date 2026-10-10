# pi-vcc

[![npm](https://img.shields.io/npm/v/@sting8k/pi-vcc)](https://www.npmjs.com/package/@sting8k/pi-vcc)

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls: it builds the summary by extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) (View-oriented Conversation Compiler).

## Demo

![pi-vcc demo](https://raw.githubusercontent.com/sting8k/pi-vcc/master/demo.gif)

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input, same output |
| **Size reduction** | Varies | 97.6% median, 89% at p10 |
| **Compaction latency** | Waits for an LLM call | 1 ms median, 11 ms p90, 348 ms worst |
| **Cost** | Burns tokens on the summarization call | None |
| **History after compaction** | Gone, the agent only sees the summary | Searchable with `vcc_recall` |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and stay capped |
| **Structure** | Free-form prose | Up to 6 sections + a brief transcript |

Size and latency measured over 1,884 real sessions (summary chars vs the summarized conversation). How much of a session's facts survive is measured in [`benchmarks/README.md`](./benchmarks/README.md).

pi-vcc also takes over `/compact` and automatic compactions, makes its own cut when Pi's cut leaves nothing to summarize, and adds `/pi-vcc` for compacting on demand.

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

pi-vcc runs automatically when your context window fills up, or on demand:

- `/pi-vcc` compacts now, keeping the last user turn.
- `/pi-vcc keep:N [prompt]` keeps the last `N` user turns (`keep:0` compacts everything) and sends the optional prompt to the agent afterwards.

With the default `keep:1`, a small tail is grown automatically (see `smartKeepTail`). To leave `/compact` and automatic compactions to Pi core, set `overrideDefaultCompaction: false`.

On a short session `/pi-vcc` can answer "Nothing to compact yet" whatever `keep:N` says: Pi stops before any extension runs while the whole session still fits in the recent part it always keeps (`compaction.keepRecentTokens` in Pi's settings).

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

[Tracked Commands]
- docker: docker compose restart api 2>&1

[Outstanding Context]
- lint check still failing on line 42

[User Preferences]
- Prefer Vietnamese responses
- Always run tests before committing

---

...(28 earlier lines omitted)

[user]
Fix the auth bug, users can't log in after password reset

[assistant]
Root cause is a missing token refresh after password reset... (#11)
* bash "bun test tests/auth.test.ts" (#12)
* edit "src/auth/session.ts" (#14)
* bash "docker compose restart api 2>&1" (#15)
* bash "bun test tests/auth.test.ts" (#16)

---

Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.
```

A section only appears when it has something to say; a session with no git commits has no `[Commits]`.

| Section | Contents |
|---|---|
| `[Session Goal]` | Initial goal and scope changes |
| `[Files And Changes]` | Files modified, created or read (capped, paths trimmed to a common root) |
| `[Commits]` | Last 8 commits made in the session (hash + subject) |
| `[Tracked Commands]` | Recent runs of only the commands listed in `trackCommands` (off by default) |
| `[Outstanding Context]` | Unresolved errors and pending questions |
| `[User Preferences]` | Lines like "always...", "never...", "prefer..." from user messages |
| Brief transcript | The conversation in order, about 120 recent lines, each tool call shortened to one line with a `(#N)` ref |

On the next compaction, the sections are merged with the previous summary and re-capped, and the transcript rolls forward.

## Recall

Pi's default compaction drops old messages for good. `vcc_recall` reads the raw session file instead, so anything compacted away stays reachable. It searches the active conversation lineage by default; `scope:"all"` also covers edited or retried branches. Only the current session is searchable.

Plain keywords work best. Multi-word queries are OR-matched and ranked, rare terms weigh more, and a regex is accepted (falling back to keywords if it matches nothing):

```
vcc_recall({ query: "auth token" })                  // ranked OR search
vcc_recall({ query: "auth token", page: 2 })         // 5 results per page
vcc_recall({ query: "hook|inject" })                 // regex
vcc_recall({ query: "auth token", scope: "all" })    // all lineages
```

The `#N` refs in a summary, such as `(#1253)`, are the same numbers recall uses, so the agent can go straight to them:

```
vcc_recall({ range: [1250, 1290] })                  // entries in order, 20 per page
vcc_recall({ expand: [1253] })                       // full untruncated text
vcc_recall({ mode: "touched" })                      // files worked on, with #N
vcc_recall({ query: "#1253:auth.ts" })               // a file's content from #1253
```

Each call does one of these. `page` and `scope` work with all of them, and a param the call cannot use is named in the output instead of dropped silently.

The same search as a slash command, with results shown in the chat and passed to the agent:

```
/pi-vcc-recall auth token scope:all
```

## How it works

1. Pick the cut: everything before the kept tail is summarized, the tail stays as is.
2. Normalize Pi messages into uniform blocks and drop noise (system messages, empty blocks).
3. Extract the sections and the brief transcript, and format them.
4. If there is a previous summary, merge into it.

No step calls a model, and token counts are estimated from the session's own numbers.

## Config

Config lives at `~/.pi/agent/pi-vcc-config.json` and is created with these defaults on first load:

```json
{
  "overrideDefaultCompaction": true,
  "smartKeepTail": true,
  "continueAfterThresholdCompact": true,
  "debug": false,
  "skipForProviders": [],
  "skipCustomTypes": [],
  "trackCommands": []
}
```

- **`overrideDefaultCompaction`** *(default `true`)*: pi-vcc handles `/pi-vcc`, `/compact` and automatic compactions. With `false` it only handles `/pi-vcc`. Existing config files keep their value.
- **`smartKeepTail`** *(default `true`)*: if the `keep:1` tail is under 5k tokens, keep as many turns as fit in 20k. An explicit `keep:N` is always respected.
- **`continueAfterThresholdCompact`** *(default `true`)*: after an automatic compaction, tell the agent to carry on instead of stopping. Only used on pi < 0.84.4; newer pi resumes on its own. `false` turns it off everywhere.
- **`debug`** *(default `false`)*: write details of each compaction (message counts, cut, sections, token calibration) to `/tmp/pi-vcc-debug.json`.
- **`skipForProviders`** *(default `[]`)*: providers for which pi-vcc steps aside, so another compaction extension can handle them. Compared case-insensitively with Pi's provider id (see `/model`; Grok is `xai`). Checked on every compaction; `/pi-vcc` always runs.
- **`skipCustomTypes`** *(default `[]`)*: `customType` values of `custom_message` entries to leave out of the summary, for per-turn boilerplate other extensions inject (skill cards, guidance blocks). Exact, case-sensitive match; look for `"type":"custom_message"` in your session file to find the value. Only the summary input changes, not the cut.
- **`trackCommands`** *(default `[]`)*: commands to remember across compactions, listed in a `[Tracked Commands]` section. Any command or prefix works: `["ssh", "kubectl", "docker"]`, `["psql", "./deploy.sh"]`, or `"gh pr"` (matches `gh pr merge`, not `gh run`). Each entry is the command as written, up to the next shell separator outside quotes, with any `sudo`/`env`/`VAR=` prefix kept; the 10 most recent per command are kept. Only `bash` calls are read, and only `ssh` remote commands are looked into, not `sh -c` or `docker exec`. Empty = off.

## Development checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
```

The source typecheck uses the pinned TypeScript compiler and Node definitions;
`skipLibCheck` excludes dependency declarations, not VCC source. CI runs both
checks against the locked legacy Pi host and Pi 1.1.0.

## Benchmarks

Benchmarks comparing the ranked brief with the 0.3.18 baseline (recall, fact density, precision, size) are in [`benchmarks/README.md`](./benchmarks/README.md).

## Acknowledgments

- [VCC](https://github.com/lllyasviel/VCC), the original transcript-preserving conversation compiler.
- Recall `mode:"touched"` and `#N:path` drill-down ported from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by [@k0valik](https://github.com/k0valik), who also suggested the feature.
- Invisible auto-continue pattern ported from [monotykamary/pi-vcc](https://github.com/monotykamary/pi-vcc) (`tom` branch) by [@monotykamary](https://github.com/monotykamary).

## License

MIT
