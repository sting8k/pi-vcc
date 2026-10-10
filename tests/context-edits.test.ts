import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as piCore from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyTailBudget, buildOwnCut, registerBeforeCompactHook } from "../src/hooks/before-compact";

// Context edits/projection are host features; older supported Pi versions still
// exercise the unchanged legacy collector in the rest of the suite.
describe.skipIf(typeof (piCore as any).buildSessionProjection !== "function")("context-edited compaction", () => {
  let dir: string;
  let previousConfig: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-vcc-edits-"));
    previousConfig = process.env.PI_VCC_CONFIG_PATH;
    process.env.PI_VCC_CONFIG_PATH = join(dir, "config.json");
    writeFileSync(process.env.PI_VCC_CONFIG_PATH, JSON.stringify({ overrideDefaultCompaction: true }));
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.PI_VCC_CONFIG_PATH;
    else process.env.PI_VCC_CONFIG_PATH = previousConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  const assistant = (text: string) => ({
    role: "assistant", content: [{ type: "text", text }], timestamp: 0,
    api: "openai-completions", provider: "test", model: "test", stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as any);

  function compact(session: any, keep = 0, reason = "manual") {
    let handler: any;
    registerBeforeCompactHook({ on(name: string, fn: any) {
      if (name === "session_before_compact") handler = fn;
    } } as any, "1.1.0");
    const entries = session.getBranch();
    return handler({
      type: "session_before_compact", branchEntries: entries,
      customInstructions: `__pi_vcc__ keep:${keep}`, reason, willRetry: reason === "overflow",
      preparation: { tokensBefore: 1000, fileOps: { read: [], written: [], edited: [] },
        previousSummary: entries.filter((e: any) => e.type === "compaction").at(-1)?.summary },
      signal: new AbortController().signal,
    }, { sessionManager: session, ui: { notify() {} } })?.compaction;
  }

  test("an omitted recovery response never re-enters the compaction summary", () => {
    const session = piCore.SessionManager.inMemory(dir) as any;
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Investigate authentication" }], timestamp: 0 });
    const failed = session.appendMessage(assistant("OMITTED_RECOVERY_RESPONSE"));
    session.appendContextEdit(failed, null);
    session.appendMessage(assistant("Verified the current configuration."));
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Continue the real task" }], timestamp: 0 });
    const result = compact(session, 0, "overflow");
    expect(result).toBeDefined();
    expect(result.summary).not.toContain("OMITTED_RECOVERY_RESPONSE");
    expect(result.summary).toContain("Verified the current configuration.");
  });

  test("the latest replacement is summarized with the original recall index", () => {
    const session = piCore.SessionManager.inMemory(dir) as any;
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect authentication" }], timestamp: 0 });
    const response = session.appendMessage(assistant("ORIGINAL_RESPONSE"));
    session.appendContextEdit(response, { content: "SUPERSEDED_REPLACEMENT" });
    session.appendContextEdit(response, { content: "Current replacement response." });
    session.appendMessage(assistant("Verified the configuration."));
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Continue the real task" }], timestamp: 0 });
    const result = compact(session);
    expect(result.summary).not.toContain("ORIGINAL_RESPONSE");
    expect(result.summary).not.toContain("SUPERSEDED_REPLACEMENT");
    expect(result.summary).toContain("Current replacement response. (#1)");
  });

  test("omitted user anchors and custom content do not affect the kept cut", () => {
    const session = piCore.SessionManager.inMemory(dir) as any;
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Original task" }], timestamp: 0 });
    session.appendMessage(assistant("Initial work."));
    const custom = session.appendCustomMessageEntry("guidance", "OMITTED_GUIDANCE", false);
    session.appendContextEdit(custom, null);
    const kept = session.appendMessage({ role: "user", content: [{ type: "text", text: "Actual latest task" }], timestamp: 0 });
    session.appendMessage(assistant("Kept work."));
    const omitted = session.appendMessage({ role: "user", content: [{ type: "text", text: "OMITTED_USER" }], timestamp: 0 });
    session.appendContextEdit(omitted, null);
    const result = compact(session, 1);
    expect(result.firstKeptEntryId).toBe(kept);
    expect(result.summary).not.toContain("OMITTED_GUIDANCE");
    expect(result.summary).not.toContain("OMITTED_USER");
  });

  test("repeated compact-all excludes edits already outside the projected window", () => {
    const session = piCore.SessionManager.inMemory(dir) as any;
    session.appendMessage({ role: "user", content: [{ type: "text", text: "First task" }], timestamp: 0 });
    const omitted = session.appendMessage(assistant("OLD_OMITTED_RESPONSE"));
    session.appendContextEdit(omitted, null);
    session.appendMessage(assistant("First retained fact."));
    session.appendMessage(assistant("Second retained fact."));
    const first = compact(session);
    session.appendCompaction(first.summary, first.firstKeptEntryId, first.tokensBefore, first.details, true);
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Next task" }], timestamp: 0 });
    session.appendMessage(assistant("New retained fact."));
    session.appendMessage(assistant("Final retained fact."));
    const second = compact(session);
    expect(second.summary).not.toContain("OLD_OMITTED_RESPONSE");
    expect(second.summary).toContain("First retained fact.");
    expect(second.summary).toContain("New retained fact.");
  });

  test("budget cuts use replacement sizes and never start at a tool result", () => {
    const session = piCore.SessionManager.inMemory(dir) as any;
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Original task" }], timestamp: 0 });
    session.appendMessage(assistant("Original work."));
    session.appendMessage({ role: "user", content: [{ type: "text", text: "Recent task" }], timestamp: 0 });
    const replaced = session.appendMessage(assistant("x".repeat(1000)));
    session.appendContextEdit(replaced, { content: "small replacement" });
    session.appendMessage({ role: "toolResult", content: [{ type: "text", text: "r".repeat(500) }], toolCallId: "tool", toolName: "read", isError: false, timestamp: 0 });
    const safeBoundary = session.appendMessage(assistant("Latest safe boundary."));
    const entries = session.getBranch();
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    const result = applyTailBudget(entries, cut, { maxTokens: 50, oversizedFactor: 1, charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.firstKeptEntryId).toBe(safeBoundary);
    expect(JSON.stringify(result.messages)).toContain("small replacement");
    expect(JSON.stringify(result.messages)).not.toContain("x".repeat(1000));
  });
});
