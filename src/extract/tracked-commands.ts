import type { NormalizedBlock } from "../types";

/** Maximum characters kept per captured entry (a truncated one-liner, not a
 * parsed structure -- deliberately shallow, see module docstring below). */
const MAX_ENTRY_CHARS = 80;

const stripQuotes = (s: string): string => s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");

/** Cut `text` at the next real shell separator (`;`, `&`, `|`, or newline),
 * strip surrounding quotes, and truncate. This is the ENTIRE "parsing" this
 * module does -- no flag tables, no per-command argument grammar. */
const captureEntry = (text: string): string => {
  const cut = text.split(/[;&|\n]/)[0];
  let entry = stripQuotes(cut.trim());
  if (entry.length > MAX_ENTRY_CHARS) entry = `${entry.slice(0, MAX_ENTRY_CHARS)}…`;
  return entry;
};

/** Find every top-level invocation of `name` in `cmd`: at the start of the
 * string, or immediately after a real shell separator (`;`, `&`, `|`, or a
 * newline). Requires whitespace (or end of string) right after `name` so
 * `ssh-keygen`/`docker-compose` don't match `ssh`/`docker`. Does NOT treat
 * quote characters as a boundary -- quoted prose (`echo "docker restart is
 * flaky"`) would otherwise misread as a real invocation. */
const findTopLevelInvocations = (cmd: string, name: string): number[] => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[;&|\\n]\\s*)${escaped}(?=\\s|$)`, "g");
  const starts: number[] = [];
  for (const m of cmd.matchAll(re)) {
    if (m.index !== undefined) starts.push(m.index + m[0].length);
  }
  return starts;
};

/**
 * Locate the SSH target by TOKEN POSITION (via matchAll's own `.index`,
 * never a substring re-search, which would misfire on e.g.
 * `ssh -i key-prod prod ...` finding "prod" inside "key-prod") and return
 * everything genuinely after it, trimmed. Flag-skipping is deliberately
 * approximate: a `-flag` token is boolean if the next token is also a flag
 * (or there is no next token), otherwise it's assumed to consume a value --
 * good enough to skip past `-i key -p 2222` to the real host without a
 * per-flag value table.
 */
const sshRemoteCommand = (afterSsh: string): string | undefined => {
  const tokens = [...afterSsh.matchAll(/\S+/g)];
  let i = 0;
  while (i < tokens.length && tokens[i][0].startsWith("-")) {
    const next = tokens[i + 1];
    i += next && !next[0].startsWith("-") ? 2 : 1;
  }
  const target = tokens[i];
  if (!target) return undefined;
  const rest = afterSsh.slice(target.index! + target[0].length).trim();
  return rest || undefined;
};

export interface TrackedCommandActivity {
  /** Command name (as configured in settings.trackCommands) -> entries seen. */
  byCommand: Map<string, Set<string>>;
}

/**
 * Scans bash tool-call commands for invocations of any command name in
 * `trackCommands`, capturing a truncated one-line snapshot per match --
 * deliberately shallow (no per-command argument parsing) so this never
 * needs updating as any given CLI's flags evolve, unlike a design that
 * tries to extract structured fields (e.g. "the kubectl namespace" or "the
 * docker container name") for each tool separately.
 *
 * When "ssh" is one of the tracked names, also scans inside its own
 * remote-command argument (quoted or not) for other tracked names --
 * running an infra command over SSH is at least as common as running one
 * locally, and a top-level-only scan would otherwise miss it.
 *
 * Only matches literal command text, never tool_result output.
 */
export const extractTrackedCommands = (
  blocks: NormalizedBlock[],
  trackCommands: readonly string[],
): TrackedCommandActivity => {
  const byCommand = new Map<string, Set<string>>();
  if (trackCommands.length === 0) return { byCommand };
  for (const name of trackCommands) byCommand.set(name, new Set());

  const trackSsh = trackCommands.includes("ssh");

  for (const b of blocks) {
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args.command === "string" ? b.args.command : "";
    if (!cmd) continue;

    for (const name of trackCommands) {
      for (const startAt of findTopLevelInvocations(cmd, name)) {
        const entry = captureEntry(cmd.slice(startAt).trim());
        if (entry) byCommand.get(name)!.add(`${name} ${entry}`.trim());
      }
    }

    if (trackSsh) {
      for (const startAt of findTopLevelInvocations(cmd, "ssh")) {
        const remote = sshRemoteCommand(cmd.slice(startAt));
        if (!remote) continue;
        const unquoted = stripQuotes(remote);
        for (const name of trackCommands) {
          if (name === "ssh") continue;
          for (const startAt2 of findTopLevelInvocations(unquoted, name)) {
            const entry = captureEntry(unquoted.slice(startAt2).trim());
            if (entry) byCommand.get(name)!.add(`${name} ${entry}`.trim());
          }
        }
      }
    }
  }

  return { byCommand };
};

const cap = (set: Set<string>, limit: number, joinWith: string): string => {
  const arr = [...set];
  if (arr.length <= limit) return arr.join(joinWith);
  return arr.slice(0, limit).join(joinWith) + ` (+${arr.length - limit} more)`;
};

/** Formats TrackedCommandActivity into `[Commands Run]` body lines, one per
 * tracked command name that had at least one match. Entries are joined with
 * " | " rather than "," since a captured one-liner (e.g. `kubectl get
 * pods,svc`) can legitimately contain a comma. */
export const formatTrackedCommands = (act: TrackedCommandActivity): string[] => {
  const lines: string[] = [];
  for (const [name, entries] of act.byCommand) {
    if (entries.size > 0) lines.push(`${name}: ${cap(entries, 10, " | ")}`);
  }
  return lines;
};
