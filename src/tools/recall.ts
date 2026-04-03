import { Type } from "@sinclair/typebox";
import { readFileSync } from "fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { renderMessage } from "../core/render-entries";
import { searchEntries } from "../core/search-entries";
import { formatRecallOutput } from "../core/format-recall";

const DEFAULT_RECENT = 25;
const MAX_RESULTS = 50;

const loadAllMessages = (sessionFile: string, full: boolean) => {
  const content = readFileSync(sessionFile, "utf-8");
  const entries: any[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  const messageEntries = entries.filter((e) => e.type === "message" && e.message);
  const rendered = messageEntries.map((e, i) => renderMessage(e.message, i, full));
  const rawMessages = messageEntries.map((e) => e.message);
  return { rendered, rawMessages };
};

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description:
      "Search full conversation history in this session, including before compaction." +
      " Use without query to see recent brief history." +
      " Use with query to search all history." +
      " Use expand with entry indices to get full content (note: some tool results may already be truncated by Pi core before saving).",
    promptSnippet:
      "vcc_recall: Search full conversation history including compacted parts. Use expand:[indices] for full content.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Search terms to filter history" }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "Entry indices to return full untruncated content for" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }

      const expandSet = new Set(params.expand ?? []);
      const hasExpand = expandSet.size > 0;

      if (hasExpand && !params.query) {
        const { rendered: fullMsgs } = loadAllMessages(sessionFile, true);
        const expanded = fullMsgs.filter((m) => expandSet.has(m.index));
        if (expanded.length === 0) {
          return {
            content: [{ type: "text", text: `No entries found for indices: ${[...expandSet].join(", ")}` }],
            details: undefined,
          };
        }
        const output = formatRecallOutput(expanded);
        return {
          content: [{ type: "text", text: output }],
          details: undefined,
        };
      }

      const { rendered: msgs, rawMessages } = loadAllMessages(sessionFile, false);
      const results = params.query?.trim()
        ? searchEntries(msgs, rawMessages, params.query).slice(0, MAX_RESULTS)
        : msgs.slice(-DEFAULT_RECENT);
      const output = formatRecallOutput(results, params.query);

      return {
        content: [{ type: "text", text: output }],
        details: undefined,
      };
    },
  });
};

