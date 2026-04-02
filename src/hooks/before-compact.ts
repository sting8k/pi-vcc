import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";
import { compile } from "../core/summarize";
import type { PiVccCompactionDetails } from "../details";

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("session_before_compact", (event) => {
    const { preparation, customInstructions } = event;

    const messages = convertToLlm(preparation.messagesToSummarize);

    const summary = compile({
      messages,
      previousSummary: preparation.previousSummary,
      fileOps: {
        readFiles: [...preparation.fileOps.read],
        modifiedFiles: [...preparation.fileOps.written, ...preparation.fileOps.edited],
      },
      customInstructions,
    });

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: preparation.messagesToSummarize.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
    };

    return {
      compaction: { summary, details },
    };
  });
};
