import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { compile } from "../core/summarize";

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", (event) => {
    const { preparation, customInstructions } = event;

    const summary = compile({
      messages: preparation.messagesToSummarize,
      previousSummary: preparation.previousSummary,
      fileOps: preparation.fileOperations,
      customInstructions,
    });

    return {
      compaction: { summary },
    };
  });
};
