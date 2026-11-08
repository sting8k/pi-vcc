import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VERSION, estimateTokens } from "@earendil-works/pi-coding-agent";
import { buildVccSummary, parseVersionCore } from "../hooks/before-compact";
import { loadSettings } from "../core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars } from "../core/token-estimate";

/**
 * First Pi version whose `turn_end` is an actionable boundary: a handler may
 * return `{ entries: [...], continue: true }` to persist a compaction entry
 * and get one more model request without steering. Before it, pi-vcc's own
 * auto-compaction hook already handles everything; this tool is not registered.
 */
export const ACTIONABLE_TURN_END_VERSION: readonly [number, number, number] = [0, 87, 0];

/** True when the running Pi accepts a compaction entry from turn_end. */
export const supportsActionableTurnEnd = (piVersion: unknown): boolean => {
  const running = parseVersionCore(piVersion);
  if (!running) return false;
  for (let i = 0; i < 3; i++) {
    if (running[i] !== ACTIONABLE_TURN_END_VERSION[i]) return running[i] > ACTIONABLE_TURN_END_VERSION[i];
  }
  return true;
};

/** A projected session entry, reduced to the fields this module reads. */
export interface CompactEntry {
  sourceEntry: { id?: string; type: string; message?: { role?: string; content?: unknown } };
  messages: any[];
}

/** Valid first-kept entries: never orphan a tool result from its call. */
export const isSafeBoundary = (sourceEntry: { type: string; message?: { role?: string } }): boolean => {
  if (sourceEntry.type !== "message") {
    return ["compaction", "branch_summary", "custom_message"].includes(sourceEntry.type);
  }
  const role = sourceEntry.message?.role;
  return role === "user" || role === "assistant";
};

/**
 * Index of the first entry to summarize: the oldest cut that leaves at least
 * `keepRecentTokens` in the tail, advanced to the first safe boundary at/after
 * it (keeps more, never less). -1 when the whole window fits the budget;
 * entries.length when no safe boundary exists — callers no-op on both.
 */
export const findCompactCut = (entries: CompactEntry[], keepRecentTokens: number): number => {
  let kept = 0;
  let cut = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    kept += entries[i].messages.reduce((sum, m) => sum + estimateTokens(m), 0);
    if (kept >= keepRecentTokens) {
      cut = i;
      break;
    }
  }
  while (cut >= 0 && cut < entries.length && !isSafeBoundary(entries[cut].sourceEntry)) cut++;
  return cut;
};

const FILE_OP_BUCKETS: ReadonlyMap<string, "read" | "written" | "edited"> = new Map([
  ["read", "read"],
  ["write", "written"],
  ["edit", "edited"],
]);

/** The read/written/edited paths pi's own compaction would report for these messages. */
export const collectFileOps = (messages: any[]) => {
  const ops = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
  const add = (name: string, args: { path?: unknown } | undefined) => {
    const bucket = FILE_OP_BUCKETS.get(name);
    if (bucket && typeof args?.path === "string") ops[bucket].add(args.path);
  };
  for (const m of messages) {
    // Calls made from codemode scripts are recorded on the script's result.
    if (m.role === "toolResult") for (const call of m.nestedCalls?.calls ?? []) add(call.name, call.arguments);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) if (block?.type === "toolCall") add(block.name, block.arguments);
  }
  return ops;
};

/**
 * The compaction entry fields for a summary built by pi-vcc's own builder, or
 * null when it cannot be built (previous summary not written by pi-vcc, empty
 * span, builder threw). Never throws. When null the caller keeps the context
 * and notifies — same failure shape as the auto-compaction hook.
 */
export const buildVccCompaction = (
  oldEntries: CompactEntry[],
  liveEntries: CompactEntry[],
  sessionManager: unknown,
): { summary: string; details: Record<string, unknown> } | null => {
  try {
    const previous = oldEntries.find((e) => e.sourceEntry.type === "compaction")?.sourceEntry as
      | { summary?: string; details?: { compactor?: string } }
      | undefined;
    // pi-vcc's merge keeps only the sections it wrote itself; any other
    // previous summary would vanish.
    if (previous && previous.details?.compactor !== "pi-vcc") return null;

    const settings = loadSettings();
    const span = oldEntries
      .filter((e) => e.sourceEntry.type !== "compaction")
      .flatMap((e) => e.messages.map((message: any) => ({ message, id: e.sourceEntry.id as string })))
      .filter(({ message }) => !(message.role === "custom" && settings.skipCustomTypes.includes(message.customType)));
    if (span.length === 0) return null;

    // Same calibration as the hook: characters of the whole live window per context token.
    const liveMessages = liveEntries.flatMap((e) => e.messages);
    const sourceChars = liveMessages.reduce(
      (sum, m) => sum + estimateMessageContentChars((m as { content?: unknown }).content),
      previous?.summary?.length ?? 0,
    );
    const tokensBefore = liveMessages.reduce((sum, m) => sum + estimateTokens(m), 0);

    const { summary } = buildVccSummary({
      messages: span.map((w) => w.message),
      entryIds: span.map((w) => w.id),
      sessionManager: sessionManager as { getEntries?: () => any[]; getSessionFile?: () => string | undefined },
      previousSummary: previous?.summary,
      fileOps: collectFileOps(span.map((w) => w.message)),
      charsPerToken: calibrateCharsPerToken(sourceChars, tokensBefore).charsPerToken,
      settings,
    });
    if (!summary.trim()) return null;

    return {
      summary,
      details: {
        compactor: "pi-vcc",
        version: 2,
        sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
        sourceMessageCount: span.length,
        previousSummaryUsed: Boolean(previous?.summary),
      },
    };
  } catch {
    return null;
  }
};

const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

/**
 * Registers `compact_context` — a tool the model can call to compact the
 * conversation itself at the end of the current turn. Why the indirection:
 * `ctx.compact()` is manual compaction — it aborts the current run and never
 * continues the interrupted turn, so a tool calling it directly would kill the
 * agent's in-flight work. The tool only records the request, and the turn_end
 * boundary proposes the compaction entry with `continue: true`, so pi applies
 * it and makes one more model request. Auto-compaction is untouched.
 */
export const registerAgentCompactTool = (pi: ExtensionAPI, piVersion: string = VERSION) => {
  if (!loadSettings().agentCompact || !supportsActionableTurnEnd(piVersion)) return;

  let pending: string | null = null;
  let ensuredActive = false;

  // Resumed sessions restore the active tool loadout from their transcript,
  // which drops tools registered after the session last ran — this tool and
  // pi-vcc's vcc_recall. Re-join the loadout once per process (pi.*, not the
  // event ctx — event contexts do not expose the tool actions). setActiveTools
  // ignores names that are not registered.
  pi.on("before_agent_start", () => {
    if (ensuredActive) return;
    ensuredActive = true;
    const active = pi.getActiveTools();
    const missing = ["compact_context", "vcc_recall"].filter((name) => !active.includes(name));
    if (missing.length > 0) pi.setActiveTools([...active, ...missing]);
  });

  pi.registerTool({
    name: "compact_context",
    label: "Compact context",
    description:
      "Compact the conversation context now instead of waiting for auto-compaction. " +
      "Compaction runs at the end of the current turn; you then continue with everything " +
      "older than the recent tail replaced by a summary. Call it when a large phase of " +
      "work is finished and its verbose tool output is no longer needed verbatim.",
    promptSnippet:
      "compact_context: replace old conversation with a summary to free context; you keep working afterwards",
    parameters: Type.Object({
      instructions: Type.Optional(
        Type.String({ description: "What the summary must preserve" }),
      ),
    }),
    async execute(_toolCallId, params) {
      pending = typeof params?.instructions === "string" ? params.instructions : "";
      return {
        content: [
          {
            type: "text",
            text: "Compaction scheduled for the end of this turn; continue your work.",
          },
        ],
        details: undefined,
      };
    },
  });

  // Actionable turn_end (Pi >= 0.87.0): returning entries + continue persists
  // a compaction entry and resumes the run. The locked dev Pi's types do not
  // know these fields yet, hence the any-cast (same pattern as the hook's
  // buildSessionProjection access).
  pi.on("turn_end", (async (event: any, ctx: any) => {
    if (pending === null || !event?.context?.canContinue) return;
    const instructions = pending;
    pending = null; // one compaction per tool call; also guards continuation loops

    const keepRecentTokens: number = (pi as any).getSettings?.()?.compaction?.keepRecentTokens
      ?? DEFAULT_KEEP_RECENT_TOKENS;
    const entries: CompactEntry[] = event.context.contextEntries ?? [];
    const cut = findCompactCut(entries, keepRecentTokens);
    if (cut <= 0 || cut >= entries.length) return; // nothing older, or no safe boundary

    const oldEntries = entries.slice(0, cut);
    if (oldEntries.flatMap((e) => e.messages).length === 0) return;

    const firstKeptEntryId = entries[cut].sourceEntry.id as string;
    const vcc = buildVccCompaction(oldEntries, entries, ctx?.sessionManager);
    if (!vcc) {
      try {
        ctx?.ui?.notify?.("pi-vcc: could not build the compaction summary; context kept as is.", "warning");
      } catch {
        // best-effort notify: the compaction no-op below is the real outcome
      }
      return;
    }

    // A leading line is outside every section, so pi-vcc's next merge drops it.
    return {
      entries: [
        {
          type: "compaction" as const,
          summary: instructions ? `Focus requested for this compaction: ${instructions}\n\n${vcc.summary}` : vcc.summary,
          firstKeptEntryId,
          details: vcc.details,
        },
      ],
      continue: true,
    };
  }) as any);
};
