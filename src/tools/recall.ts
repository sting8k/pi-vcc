import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeToolParams, parseToolRequest } from "../core/recall-request";
import { invalidExpandIndices, openRecallView, runRecall, type RecallPagingHints } from "../core/recall-run";

export { invalidExpandIndices };

const TOOL_PAGING_HINTS: RecallPagingHints = {
  outOfRange: (_query, _scope, totalPages, truncated) => truncated
    ? `Use a page between 1 and ${totalPages}.`
    : `Use a page between 1 and ${totalPages}, or refine your query.`,
  nextPage: (_query, scope, page) => `\n--- Use page:${page}${scope === "all" ? " with scope:'all'" : ""} for more results ---`,
  skipCurrentTurn: true,
  aroundHit: (n, scope) =>
    `\n--- Read around a hit: range:[${Math.max(0, n - 3)}, ${n + 3}]; full text: expand:[${n}]${scope === "all" ? " (with scope:'all')" : ""} ---`,
};

export const registerRecallTool = (pi: ExtensionAPI) => {
  pi.registerTool({
    name: "vcc_recall",
    label: "VCC Recall",
    description: [
      "Recall earlier parts of this session, including anything dropped by compaction.",
      "Use it before saying the context is gone.",
      "",
      "Pick one per call:",
      "- query: keyword search (regex works), 5 results per page.",
      "- range: [from, to]: entries #from..#to in order, 20 per page.",
      "- expand: [N, ...]: full text of those entries.",
      "- mode: 'touched': files worked on, with entry indices.",
      "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
      "",
      "Add to any of them:",
      "- page: next page of query, range or touched results.",
      "- scope: 'lineage' (default) reads the current conversation path; 'all' also",
      "  reads edited or retried branches.",
      "",
      "#N is the number shown in summary refs like (#12) and in recall results.",
      "Only the current session is searchable. One result is capped at 50 KB.",
    ].join("\n"),
    promptSnippet:
      "Recall earlier parts of this session before saying the context is gone. " +
      "One per call: query (search), range:[from, to] (entries in order), expand:[N] (full text), " +
      "mode:'touched' (files). #N is the number in summary refs like (#12).",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N." }),
      ),
      range: Type.Optional(
        Type.Array(Type.Number(), {
          minItems: 2,
          maxItems: 2,
          description: "[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.",
        }),
      ),
      expand: Type.Optional(
        Type.Array(Type.Number(), { description: "#N indices to return full content for (from summary refs like (#12) or recall results)." }),
      ),
      page: Type.Optional(
        Type.Number({ description: "Page number (1-based) for query, range or touched results. Default: 1." }),
      ),
      scope: Type.Optional(
        Type.Union([
          Type.Literal("lineage"),
          Type.Literal("all"),
        ], { description: "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches, such as turns that were edited or retried." }),
      ),
      mode: Type.Optional(
        Type.Union([
          Type.Literal("hybrid"),
          Type.Literal("touched"),
        ], { description: "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices. The touched list misses files written via apply_patch (paths inside the diff) or bash redirects." }),
      ),
    }),
    // Runs before pi validates the schema, so repairable mistakes never reach the agent as errors.
    prepareArguments: (args: unknown) => normalizeToolParams(args) as any,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "No session file available." }],
          details: undefined,
        };
      }
      const request = parseToolRequest(params);
      const view = openRecallView(sessionFile, request.scope, ctx.sessionManager);
      const text = runRecall(request, view, TOOL_PAGING_HINTS);
      return { content: [{ type: "text", text }], details: undefined };
    },
  });
};
