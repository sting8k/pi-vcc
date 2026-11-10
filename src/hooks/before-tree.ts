import type { ExtensionAPI, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import * as piCore from "@earendil-works/pi-coding-agent";
import { getSessionGlobalIndexById } from "../core/global-indices";
import { loadSettings } from "../core/settings";
import { isSkippedCustom, toLiveMessage, toSummaryMessage } from "../core/summary-messages";
import { compileRanked } from "../core/summarize";
import { DEFAULT_CHARS_PER_TOKEN } from "../core/token-estimate";

interface ProjectedEntry {
  sourceEntry: SessionEntry;
  messages: SessionMessageEntry["message"][];
}

export const registerBeforeTreeHook = (pi: ExtensionAPI) => {
  pi.on("session_before_tree", ({ preparation, signal }, ctx) => {
    const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = preparation;
    if (!userWantsSummary || customInstructions !== undefined || replaceInstructions || entriesToSummarize.length === 0) return;
    const settings = loadSettings();
    if (settings.summarizeBranches !== true) return;
    if (signal.aborted) return { cancel: true };

    let entries: ProjectedEntry[];
    if (entriesToSummarize.some(({ type }: { type: string }) => type === "context_edit")) {
      // Newer Pi hosts can omit or replace entries. Use their projection to
      // keep those edits and retain the source IDs for recall.
      const project = (piCore as typeof piCore & {
        buildSessionProjection?: (entries: SessionEntry[]) => { entries: ProjectedEntry[] };
      }).buildSessionProjection;
      if (!project) return { cancel: true };
      entries = project(entriesToSummarize).entries;
    } else {
      entries = entriesToSummarize.flatMap((entry) => {
        const message = entry.type === "compaction"
          ? { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: Date.parse(entry.timestamp) }
          : toLiveMessage(entry);
        return message ? [{ sourceEntry: entry, messages: [message as SessionMessageEntry["message"]] }] : [];
      });
    }

    const indexById = getSessionGlobalIndexById(ctx.sessionManager);
    const messages = [];
    const sourceIndices: Array<number | undefined> = [];
    for (const { sourceEntry, messages: entryMessages } of entries) {
      for (const message of entryMessages) {
        if (isSkippedCustom(message, settings.skipCustomTypes)) continue;
        const converted = toSummaryMessage(message);
        if (!converted) continue;
        // Prior summaries provide context without becoming new user requests.
        messages.push(message.role === "branchSummary" || message.role === "compactionSummary"
          ? { ...converted, injected: true }
          : converted);
        sourceIndices.push(indexById?.get(sourceEntry.id));
      }
    }

    const summary = compileRanked({
      messages,
      sourceIndices,
      trackCommands: settings.trackCommands,
      ranking: { maxBriefChars: 1100 * DEFAULT_CHARS_PER_TOKEN },
    });
    return { summary: { summary: summary || "No content to summarize." } };
  });
};
