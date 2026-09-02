import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { convertToLlm, VERSION } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { compileRanked } from "../core/summarize";
import { parseKeepAndPrompt, PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateMessageContentTokens, estimateTokensFromChars } from "../core/token-estimate";
import type { PiVccCompactionDetails } from "../details";
import type { CompactionReason } from "../types";

export { PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  requestedKeepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  keepFallbackToCompactAll: boolean;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
  /** Base keep before smart adjustment (for toast like "1→3"). */
  smartFromKeep?: number;
  reason?: CompactionReason;
  willRetry?: boolean;
}

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let pendingFollowUpPrompt: string | null = null;
let pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;

// Invisible auto-continue: resume the agent after compaction without polluting
// the LLM context with a user-visible continue prompt. triggerInvisibleContinue
// sends a custom message marked with a dedicated customType (content:[],
// display:false, triggerTurn:true, deliverAs:'followUp') so Pi's queue/busy-state
// stays coherent; the on('context') filter registered in registerBeforeCompactHook
// removes that message (by customType ONLY) from the LLM payload — the model
// simply continues from the compaction summary.
//
// Ported from monotykamary/pi-vcc branch 'tom'
// (https://github.com/monotykamary/pi-vcc, MIT) — a pi-vcc derivative.
export const AUTO_CONTINUE_CUSTOM_TYPE = "pi-vcc-auto-continue";

/**
 * First Pi version that resumes the run by itself after an automatic compaction.
 * From this version on pi-vcc's fallback continue is redundant, and because it is
 * scheduled blind (setTimeout(0), no idle check) it lands as a ghost turn once the
 * self-resumed run ends - see issue #22, which reports both behaviours on 0.84.4.
 * Kept as a [major, minor, patch] tuple so there is one source of truth.
 */
export const PI_SELF_RESUME_VERSION: readonly [number, number, number] = [0, 84, 4];

/**
 * Minimal semver core parse: [major, minor, patch], or null when unusable.
 * Prerelease/build suffixes are dropped, so 0.84.4-rc.1 counts as 0.84.4 - the
 * safe direction, since such a build already carries the self-resume behaviour.
 */
const parseVersionCore = (version: unknown): [number, number, number] | null => {
  if (typeof version !== "string") return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/**
 * Two keys must both turn for pi-vcc to send its own continue:
 *  - `settingEnabled` is the user's permission (`continueAfterThresholdCompact`);
 *    false always wins.
 *  - the running Pi must be old enough to still need the fallback.
 * An unreadable/malformed version fails safe to "no continue": a missing continue
 * costs one idle turn, a ghost turn corrupts the transcript.
 */
export const shouldScheduleAutoContinue = (settingEnabled: boolean, piVersion: unknown): boolean => {
  if (!settingEnabled) return false;
  const running = parseVersionCore(piVersion);
  if (!running) return false;
  for (let i = 0; i < 3; i++) {
    if (running[i] !== PI_SELF_RESUME_VERSION[i]) return running[i] < PI_SELF_RESUME_VERSION[i];
  }
  return false;
};

export const triggerInvisibleContinue = (pi: ExtensionAPI): void => {
  pi.sendMessage(
    {
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
      details: undefined,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
};

const clearPendingAutoContinue = () => {

  if (pendingAutoContinueTimer) {
    clearTimeout(pendingAutoContinueTimer);
    pendingAutoContinueTimer = null;
  }
};

const scheduleAutoContinue = (pi: any) => {
  clearPendingAutoContinue();
  pendingAutoContinueTimer = setTimeout(() => {
    pendingAutoContinueTimer = null;
    try {
      triggerInvisibleContinue(pi);
    } catch {}
  }, 0);
};

export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const formatCompactionStats = (stats: CompactionStats): string => {
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `pi-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.`;
  }
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  return `pi-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).`;
};

const readCompactionEventContext = (event: unknown): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason = raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
    ? raw.reason
    : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats) => {
  setTimeout(() => {
    try {
      ctx?.ui?.notify?.(
        formatCompactionStats(stats),
        "info",
      );
    } catch {}
  }, 500);
};

const parseCompactionInstructions = (customInstructions?: string): {
  isPiVcc: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
} => {
  const trimmed = customInstructions?.trim();
  if (trimmed === PI_VCC_COMPACT_INSTRUCTION) {
    return { isPiVcc: true, keepUserTurns: 1, keepUserTurnsExplicit: false, followUpPrompt: null };
  }

  const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed?.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isPiVcc: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: null,
    };
  }

  const parsed = parseKeepAndPrompt(customInstructions);
  return {
    isPiVcc: false,
    keepUserTurns: parsed.keepUserTurns ?? 1,
    keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
    followUpPrompt: parsed.followUpPrompt || null,
  };
};

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync("/tmp/pi-vcc-debug.json", JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  }
  return liveMessages;
};

export function buildOwnCut(branchEntries: any[], keepUserTurns = 1): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean) => ({
    ok: true as const,
    messages: liveMessages.map((e) => e.message),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageContentTokens(live[i].message.content, charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off any toolResult to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    totalUserTurns: live.filter((m) => m.message.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail: boost default keep when tail is small ──

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

export interface ResolveSmartKeepOptions {
  branchEntries: any[];
  /** Requested keep:N; null when user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when user typed keep:N explicitly — always respected. */
  explicit: boolean;
  /** Setting toggle. */
  smartKeepTail: boolean;
  /** Injectable thresholds for tests. */
  minTokens?: number;
  maxTokens?: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  /** Original base keep, for toast like "1→3". */
  fromKeep: number;
}

/**
 * Estimate tail tokens for a given keep:N.
 * Returns null when keep would trigger compact-all (tail lost) or cancel,
 * so the resolver can stop growing instead of selecting a value that
 * discards the tail entirely.
 */
const tailTokensForKeep = (branchEntries: any[], keepUserTurns: number, charsPerToken?: number): number | null => {
  const cut = buildOwnCut(branchEntries, keepUserTurns);
  if (!cut.ok || cut.compactAll) return null;
  const idx = branchEntries.findIndex((e: any) => e.id === cut.firstKeptEntryId);
  if (idx < 0) return null;
  const kept = branchEntries.slice(idx).filter((e: any) => e.type === "message");
  const chars = kept.reduce(
    (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
    0,
  );
  return estimateTokensFromChars(chars, charsPerToken);
};

/**
 * Resolve the effective keep:N.
 * - Explicit keep:N from the user is always respected.
 * - smartKeepTail=false → old behavior (default keep:1).
 * - smartKeepTail=true → if keep:1 tail <= minTokens, grow keep to the
 *   largest N whose tail stays <= maxTokens. Stops at compact-all boundary.
 */
export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseTokens = tailTokensForKeep(opts.branchEntries, baseKeep, opts.charsPerToken);
  // base tail already above min (or unmeasurable / compact-all) → don't grow.
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const baseCut = buildOwnCut(opts.branchEntries, baseKeep);
  const totalUserTurns = baseCut.ok ? baseCut.totalUserTurns : 0;

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tailTokensForKeep(opts.branchEntries, k, opts.charsPerToken);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  };
};

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

/**
 * `piVersion` is the running Pi version (defaults to the runtime's own VERSION).
 * It is a parameter, not a setting: it decides whether pi-vcc's auto-continue
 * fallback is still needed, and lets tests pin the behaviour to a version.
 */
export const registerBeforeCompactHook = (pi: ExtensionAPI, piVersion: string = VERSION) => {
  // Filter our invisible-continue marker out of the LLM context payload so the
  // model just continues from the compaction summary (matched by customType ONLY).
  pi.on("context", (event) => {
    const messages = event.messages.filter((message) => {
      if (message.role !== "custom") return true;
      return message.customType !== AUTO_CONTINUE_CUSTOM_TYPE;
    });
    if (messages.length !== event.messages.length) return { messages };
  });

  pi.on("before_agent_start", () => {
    clearPendingAutoContinue();
  });

  pi.on("session_before_compact", (event, ctx) => {
    const { preparation, branchEntries, customInstructions } = event;
    const { reason, willRetry } = readCompactionEventContext(event);
    const settings = loadSettings();

    // Always handle explicit /pi-vcc marker.
    // Otherwise, only handle when user opted in via settings.
    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt } = parseCompactionInstructions(customInstructions);
    pendingFollowUpPrompt = null;
    if (!isPiVcc && !settings.overrideDefaultCompaction) return;

    const calibrationCut = buildOwnCut(branchEntries as any[], 0);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(branchEntries as any[], ownCut, { charsPerToken: tokenEstimate.charsPerToken });
    }
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = lastComp?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      pendingFollowUpPrompt = null;
      const fallbackToCore = !isPiVcc && (reason === "overflow" || willRetry);
      dbg(settings, {
        cancelled: !fallbackToCore,
        fallbackToCore,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!lastComp.firstKeptEntryId,
          foundInBranch: lastComp.firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === lastComp.firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      if (fallbackToCore) return;

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    pendingFollowUpPrompt = followUpPrompt;
    const agentMessages = ownCut.messages;
    const firstKeptEntryId = ownCut.firstKeptEntryId;
    const messages = convertToLlm(agentMessages);

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
      0,
    );
    lastStats = {
      summarized: agentMessages.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      budgetCut: ownCut.ok ? ownCut.budgetCut : undefined,
      reason,
      willRetry,
    };

    const config = settings;

    // Ranked compaction: keep the highest-signal blocks under a token budget
    // instead of the old unranked compile() (fixed 120-line cap). The token
    // budget is converted to a char budget via the session's calibrated
    // charsPerToken so the summary targets ~RANKED_BRIEF_BUDGET_TOKENS tokens
    // regardless of content density.
    //
    // The budget is SIZE-RELATIVE: it scales with transcript length between a
    // floor (RANKED_BRIEF_BUDGET_TOKENS) and a ceiling (RANKED_BRIEF_CEILING_TOKENS)
    // at RANKED_BRIEF_CHARS_PER_BLOCK per normalized block. Small/medium sessions
    // stay at the floor (size parity with the old cap); very large transcripts --
    // which carry far more high-value long-tail (edits, commands, tests) than the
    // old 120-line brief could hold -- earn more budget up to the ceiling, while
    // the ceiling keeps growth bounded (no return of the ~60% bloat).
    // Audit (research/audit, 794 sessions, vs shipped master 0.3.18): SMALL/MED
    // unchanged; LARGE bucket paired recall -5.0pp -> -2.3pp (median to parity),
    // long-tail losers 100/369 -> 67/369; fact density stays ~1.4x master.
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    const summary = compileRanked({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
      ranking: {
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutIdx >= 0
      ? branchEntries.slice(Math.max(0, cutIdx - 3), Math.min(branchEntries.length, cutIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      budgetCut: ownCut.budgetCut,
      compaction: { reason, willRetry },
      messagesToSummarize: agentMessages.length,
      messagesPreviewHead: agentMessages.slice(0, 3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      messagesPreviewTail: agentMessages.slice(-3).map((m: any) => ({ role: m.role, preview: previewContent(m.content) })),
      convertedMessages: messages.length,
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: agentMessages.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      reason,
      willRetry,
    };

    lastCompactWasPiVcc = isPiVcc;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact path only (delayed to let UI settle).
  // /pi-vcc path uses its own onComplete callback in the command handler.
  pi.on("session_compact", async (event, ctx) => {
    const { reason, willRetry } = readCompactionEventContext(event);
    if (!event.fromExtension) return;
    const followUpPrompt = pendingFollowUpPrompt;
    pendingFollowUpPrompt = null;
    if (lastCompactWasPiVcc) return; // /pi-vcc handles its own toast via onComplete
    if (willRetry) return;
    const stats = lastStats;
    if (!stats) return;
    const shouldContinueAfterAutoCompact = (reason === "threshold" || reason === "overflow")
      && shouldScheduleAutoContinue(loadSettings().continueAfterThresholdCompact, piVersion);
    scheduleCompactionStatsNotify(ctx, stats);
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinue(pi);
    }
  });
};
