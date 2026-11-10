import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEntriesForBranchSummary, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, SessionBeforeTreeEvent } from "@earendil-works/pi-coding-agent";
import * as piCore from "@earendil-works/pi-coding-agent";
import registerExtension from "../index";
import { assistantText, userMsg } from "./fixtures";

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
