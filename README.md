# pi-vcc

Algorithmic conversation compactor for [Pi](https://github.com/badlogic/pi-mono). No LLM calls -- produces structured, transcript-preserving summaries using pure extraction and formatting.

Inspired by [VCC](https://github.com/lllyasviel/VCC) (View-oriented Conversation Compiler).

## Why pi-vcc

|  | Pi default | pi-vcc |
|---|---|---|
| **Method** | LLM-generated summary | Algorithmic extraction, no LLM |
| **Determinism** | Non-deterministic, can hallucinate | Same input = same output, always |
| **Token reduction** | Varies | ~58% measured (30k -> 12.5k) |
| **History after compaction** | Gone -- agent only sees summary | Fully searchable via `vcc_recall` |
| **Repeated compactions** | Each rewrite risks losing more | Sections merge and accumulate |
| **Cost** | Burns tokens on summarization call | Zero -- no API calls |
| **Structure** | Free-form prose | 7 typed sections (goal, turns, actions, evidence, files, context, prefs) |

### Real session metrics

| Compaction | Before | After | Reduction |
|---|---|---|---|
| 1st | 25,832 | 18,974 | 26.5% |
| 2nd (full cut) | 30,020 | 12,507 | 58.3% |
| 3rd (merge) | 15,915 | ~8,800 | ~45% |

## Features

- **No LLM** -- purely algorithmic, zero extra API cost
- **~58% token reduction** with transcript-preserving structured output
- **Lossless recall** -- `vcc_recall` reads raw session JSONL, history stays searchable across compactions
- **Incremental merge** -- turns, actions, evidence, files accumulate; only volatile context refreshes
- **VCC-style tool collapsing** -- tool calls become deduplicated one-liners
- **Fallback cut** -- works even when Pi core returns nothing to summarize
- **Redaction** -- strips passwords, API keys, secrets
- **`/pi-vcc`** -- manual compaction on demand

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

Once linked, pi-vcc hooks `session_before_compact` and handles compaction automatically. Output looks like:

```
[Session Goal]
- Fix the authentication bug in login flow

[Key Conversation Turns]
- [user] Fix the auth bug, users can't log in after password reset
- [assistant] Root cause is a missing token refresh. The session cookie...(truncated)

[Actions Taken]
- * Read "src/auth/session.ts"
- * Edit "src/auth/session.ts"
- * bash "bun test tests/auth.test.ts"

[Important Evidence]
- [Read] export function refreshSession(token) { if (!token) return null;...(truncated)
- [bash] Tests: 12 passed, 0 failed

[Files And Changes]
Modified:
  - src/auth/session.ts
Read:
  - src/auth/session.ts

[Outstanding Context]
- [bash] ERROR: lint check failed on line 42

[User Preferences]
- Prefer Vietnamese responses
```

Use `/pi-vcc` to trigger compaction manually.

## Recall (Lossless History)

Pi's default compaction discards old messages permanently. After compaction, the agent only sees the summary.

`vcc_recall` bypasses this by reading the raw session JSONL file directly. It parses every message entry in the file, renders each one into a searchable `RenderedEntry` with a stable index (matching the message's position in the JSONL), role, truncated summary, and associated file paths. This means entry `#41` always refers to the same message regardless of how many compactions have happened.

**Search** uses multi-term matching -- the query is split into terms and all must appear in the entry's role + summary + file paths. This searches across the entire session including compacted regions:

```
vcc_recall({ query: "auth token refresh" })   // all terms must match
```

**Browse** without a query returns the last 25 entries:

```
vcc_recall()
```

**Expand** switches to full mode -- entries are rendered without truncation, so you get the complete content for specific indices found via search:

```
vcc_recall({ expand: [41, 42] })               // full content, no clipping
```

Typical workflow: search brief -> find relevant entry indices -> expand those indices for full content.

> Some tool results are truncated by Pi core at save time. `expand` returns everything in the JSONL but can't recover what Pi already cut.

## Pipeline

1. **Normalize** -- raw Pi messages -> uniform blocks (user, assistant, tool_call, tool_result, thinking)
2. **Filter noise** -- strip system messages, empty blocks
3. **Build sections** -- extract goal, conversation turns (~128 tokens each), deduplicated tool one-liners, tool results as evidence, file paths, blockers, preferences
4. **Format** -- render into bracketed sections
5. **Redact** -- strip passwords, API keys, secrets
6. **Merge** -- if previous summary exists:
   - Appendable (turns, actions, evidence, files, prefs): deduplicate and combine
   - Volatile (outstanding context): replace with fresh
   - Default (session goal): fresh wins

## Debug

Debug logging is off by default. Enable it in `~/.pi/agent/pi-vcc-config.json`:

```json
{ "debug": true }
```

When enabled, each compaction writes detailed info to `/tmp/pi-vcc-debug.json` -- message counts, cut boundary, summary preview, sections.

## Related Work

- [VCC](https://github.com/lllyasviel/VCC) -- the original transcript-preserving conversation compiler
- [Pi](https://github.com/badlogic/pi-mono) -- the AI coding agent this extension is built for

## License

MIT
