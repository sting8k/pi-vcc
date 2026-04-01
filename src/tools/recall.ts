import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderMessage } from "../core/render-entries";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Search past conversation history in this session." +
      " Returns matching entries from before compaction." +
      " Use without query to see full brief history.",
    promptSnippet:
      "vcc_recall: Search past conversation history in this session",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms to filter history" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entries = ctx.sessionManager.getEntries();
      const msgs = entries
        .filter((e): e is { type: "message"; message: any } =>
          e.type === "message",
        )
        .map((e, i) => renderMessage(e.message, i));

      const results = searchEntries(msgs, params.query);
      const output = formatRecallOutput(results, params.query);

      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};

