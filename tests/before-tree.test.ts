import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEntriesForBranchSummary, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import * as piCore from "@earendil-works/pi-coding-agent";
import registerExtension from "../index";
import { assistantText, userMsg } from "./fixtures";

const RECALL_NOTE_START = "Use `vcc_recall` to search";

let dir: string;
let config: string;
let previousConfig: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-vcc-tree-"));
  config = join(dir, "pi-vcc-config.json");
  previousConfig = process.env.PI_VCC_CONFIG_PATH;
  process.env.PI_VCC_CONFIG_PATH = config;
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.PI_VCC_CONFIG_PATH;
  else process.env.PI_VCC_CONFIG_PATH = previousConfig;
  rmSync(dir, { recursive: true, force: true });
});

function setupTree() {
  const session = SessionManager.inMemory(dir);
  const root = session.appendMessage(userMsg("Shared starting point."));
  const target = session.appendMessage(assistantText("Destination branch."));
  session.branch(root);
  session.appendMessage(userMsg("Investigate the queue worker."));
  const response = session.appendMessage(assistantText("Found a retry loop in the queue worker."));
  const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, response, target);
  let beforeTree: (event: SessionBeforeTreeEvent, ctx: { sessionManager: SessionManager }) =>
    { cancel?: boolean; summary?: { summary: string } } | undefined;
  registerExtension({
    on(name: string, handler: typeof beforeTree) {
      if (name === "session_before_tree") beforeTree = handler;
    },
    registerCommand() {},
    registerTool() {},
  } as unknown as ExtensionAPI);

  const abortController = new AbortController();
  return {
    session,
    response,
    abortController,
    summarize(overrides: Partial<SessionBeforeTreeEvent["preparation"]> = {}) {
      return beforeTree({
        type: "session_before_tree",
        preparation: {
          targetId: target,
          oldLeafId: response,
          commonAncestorId,
          entriesToSummarize: entries,
          userWantsSummary: true,
          ...overrides,
        },
        signal: abortController.signal,
      }, { sessionManager: session });
    },
  };
}

test("existing configs leave branch summaries to Pi by default", () => {
  writeFileSync(config, JSON.stringify({ overrideDefaultCompaction: true }));
  expect(setupTree().summarize()).toBeUndefined();
});

test("summarizes the abandoned branch with session-wide recall refs", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true, overrideDefaultCompaction: false }));
  const { summarize } = setupTree();
  const result = summarize()?.summary?.summary;
  expect(result).toContain("Investigate the queue worker.");
  expect(result).toContain("Found a retry loop in the queue worker. (#3)");
  expect(result).not.toContain("Destination branch.");
  expect(result).not.toContain("Shared starting point.");
});

test("preserves no-summary navigation and custom prompts even when opted in", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const { summarize } = setupTree();
  expect(summarize({ userWantsSummary: false })).toBeUndefined();
  expect(summarize({ customInstructions: "Focus on outstanding work." })).toBeUndefined();
  expect(summarize({ entriesToSummarize: [] })).toBeUndefined();
});

test("cancels an aborted VCC summary before Pi can fall back to its model", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const { summarize, abortController } = setupTree();
  abortController.abort();
  expect(summarize()).toEqual({ cancel: true });
});

test.skipIf(!("buildSessionProjection" in piCore))("uses edited content with the original recall ref", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const { session, response, summarize } = setupTree();
  if (!("appendContextEdit" in session) || typeof session.appendContextEdit !== "function") {
    throw new Error("Pi exposes session projection without context editing");
  }
  session.appendContextEdit(response, { content: "Verified the queue backoff." });
  const result = summarize({ entriesToSummarize: session.getBranch().slice(1) })?.summary?.summary;
  expect(result).toContain("Verified the queue backoff. (#3)");
  expect(result).not.toContain("Found a retry loop");
});

/** Run the hook as Pi does for the plain "Summarize" choice, navigating from `from` to `to`. */
function summarizeTree(session: SessionManager, from: string, to: string) {
  let beforeTree: ((event: SessionBeforeTreeEvent, ctx: { sessionManager: SessionManager }) =>
    { summary?: { summary: string } } | undefined) | undefined;
  registerExtension({
    on(name: string, handler: NonNullable<typeof beforeTree>) {
      if (name === "session_before_tree") beforeTree = handler;
    },
    registerCommand() {},
    registerTool() {},
  } as unknown as ExtensionAPI);
  const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, from, to);
  const result = beforeTree!({
    type: "session_before_tree",
    preparation: { targetId: to, oldLeafId: from, commonAncestorId, entriesToSummarize: entries, userWantsSummary: true },
    signal: new AbortController().signal,
  }, { sessionManager: session });
  return result?.summary?.summary ?? "";
}

/** The header sections, above the brief transcript. Long lines wrap there, so
 * assert on single-word markers. */
const headerOf = (summary: string) => summary.split("\n---\n")[0];

/** A branch abandoned after a compaction: two messages before its cut, two kept, two after it. */
function compactedBranch(compactionSummary: string, details: unknown) {
  const session = SessionManager.inMemory(dir);
  const root = session.appendMessage(userMsg("Shared starting point."));
  const target = session.appendMessage(assistantText("Destination branch."));
  session.branch(root);
  session.appendMessage(userMsg("Covered request before the cut."));
  session.appendMessage(assistantText("Covered answer before the cut."));
  const kept = session.appendMessage(userMsg("Kept request after the cut."));
  session.appendMessage(assistantText("Kept answer after the cut."));
  session.appendCompaction(compactionSummary, kept, 1000, details, true);
  session.appendMessage(userMsg("Request after the compaction."));
  const leaf = session.appendMessage(assistantText("Answer after the compaction."));
  return summarizeTree(session, leaf, target);
}

test("merges a pi-vcc compaction like a compaction does, summarizing only what it does not cover", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const previous = [
    "[Files And Changes]",
    "- Modified: src/old.ts",
    "",
    "---",
    "",
    "[user]",
    "Covered request before the cut.",
    "",
    "---",
    "",
    "Use `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already completed.",
  ].join("\n");
  const result = compactedBranch(previous, { compactor: "pi-vcc" });

  expect(headerOf(result)).toContain("src/old.ts");
  expect(result).toContain("Kept request after the cut.");
  expect(result).toContain("Request after the compaction.");
  expect(result).not.toContain("Covered answer before the cut.");
  expect(result).not.toContain("compacted into the following summary");
  expect(result.split(RECALL_NOTE_START).length - 1).toBe(1);
});

test("keeps a compaction pi-vcc did not write as context, not as a user request", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const result = compactedBranch("## Goal\nFOREIGN-SUMMARY-MARKER", undefined);

  expect(result).toContain("compacted into the following summary");
  expect(result).toContain("FOREIGN-SUMMARY-MARKER");
  expect(headerOf(result)).not.toContain("FOREIGN-SUMMARY-MARKER");
});

test("does not read an earlier branch summary as a user request", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true }));
  const session = SessionManager.inMemory(dir);
  const root = session.appendMessage(userMsg("Shared starting point."));
  const target = session.appendMessage(assistantText("Destination branch."));
  session.branchWithSummary(root, "EARLIER-BRANCH-MARKER", undefined, true);
  session.appendMessage(userMsg("Investigate the queue worker."));
  const leaf = session.appendMessage(assistantText("Found a retry loop."));

  const result = summarizeTree(session, leaf, target);
  expect(result).toContain("EARLIER-BRANCH-MARKER");
  expect(headerOf(result)).not.toContain("EARLIER-BRANCH-MARKER");
  expect(headerOf(result)).toContain("Investigate the queue worker.");
});

test("leaves out custom messages listed in skipCustomTypes", () => {
  writeFileSync(config, JSON.stringify({ summarizeBranches: true, skipCustomTypes: ["noise"] }));
  const session = SessionManager.inMemory(dir);
  const root = session.appendMessage(userMsg("Shared starting point."));
  const target = session.appendMessage(assistantText("Destination branch."));
  session.branch(root);
  session.appendMessage(userMsg("Investigate the queue worker."));
  session.appendCustomMessageEntry("noise", "Regenerated noise text.", false);
  session.appendCustomMessageEntry("note", "Teammate note text.", true);
  const leaf = session.appendMessage(assistantText("Found a retry loop."));

  const result = summarizeTree(session, leaf, target);
  expect(result).toContain("Teammate note text.");
  expect(result).not.toContain("Regenerated noise text.");
});
