import { convertToLlm } from "@earendil-works/pi-coding-agent";

/** convertToLlm for one message, as the summarizer input path runs it: a message
 * it rejects or drops yields []. */
export const toLlmSafe = (message: unknown): any[] => {
  try {
    return convertToLlm([message as any]);
  } catch {
    return [];
  }
};

/** A custom_message the user listed in skipCustomTypes; dropped before summarizing. */
export const isSkippedCustom = (m: any, skipCustomTypes: readonly string[]): boolean =>
  m?.role === "custom" && skipCustomTypes.includes(m?.customType);

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
export const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
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

/** Convert a single message so its persisted entry id stays aligned. */
export const toSummaryMessage = (message: any) => {
  const [converted] = toLlmSafe(message);
  if (!converted) return undefined;
  // Keep ! commands in their original form for the brief transcript.
  if (message.role === "bashExecution") return message;
  // Extension messages should not be counted as user requests.
  if (message.role === "custom") return { ...converted, injected: true };
  return converted;
};
