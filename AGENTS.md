# AGENTS.md

pi-vcc is a Pi extension: algorithmic compaction (no LLM call) plus `vcc_recall` over the raw session history. User-facing docs are in `README.md`; keep it short and put contributor notes here.

## Checks

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun test
```

`bun.lock` pins an older Pi host (0.85.1). CI also runs the suite on a recent Pi (the `matrix.pi` version in `.github/workflows/ci.yml`); to do the same locally, install that version of both packages:

```sh
V=1.4.0
npm install --no-save --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@$V @earendil-works/pi-codemode@$V
bun test
```

Without the matching `pi-codemode`, older Pi releases pick up a newer one they cannot load and several suites fail. Tests for host features missing from the locked Pi (e.g. context edits) skip there and run on the recent one.

## Layout

- `index.ts`: registers everything below.
- `src/hooks/before-compact.ts`: the compaction hook: which messages are live, where to cut, smart keep-tail.
- `src/core/`: summary pipeline (`normalize` → `filter-noise` → `build-sections` → `brief`/`rank` → `format`, driven by `summarize.ts`), recall (`recall-request.ts` parses the call, `recall-run.ts` runs it, `search-entries.ts` ranks), settings.
- `src/extract/`: one module per summary section (user messages, files, commits, tracked commands).
- `src/commands/`, `src/tools/recall.ts`: `/pi-vcc`, `/pi-vcc-recall` and the `vcc_recall` tool.

## Rules

- Support the whole peer range (`>=0.74.0 <2.0.0`). Use a newer host API only behind a check that keeps older hosts on the old path.
- `#N` refs in summaries are session-wide entry indices that `vcc_recall` resolves. Any change to which entries are indexed must keep them stable.
- Agents act on recall and summary text (headers, hint lines, `Ignored:` notes). Treat it as an interface: change it on purpose, and update the tests that pin it.
- The smart keep-tail limit (25k) is pi-vcc's own and does not follow Pi's `compaction.keepRecentTokens`.
- Tests that read settings set `PI_VCC_CONFIG_PATH` to a temp file, never the user's config. `tests/real-sessions.test.ts` runs only when `~/.pi/agent/sessions` exists.
- `research/` is git-ignored local data (real sessions, replays). Never commit it or quote session content in commits or PRs.
- Note user-facing changes in `CHANGELOG.md` under `[Unreleased]`.
