import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerBeforeCompactHook, PI_VCC_COMPACT_INSTRUCTION, getLastCompactionStats, formatCompactionStats, buildOwnCut, applyTailBudget } from "../src/hooks/before-compact";

let tmpDir: string;
let CONFIG_PATH: string;
const DEBUG_PATH = "/tmp/pi-vcc-debug.json";

// Auto-continue is version-gated (issue #22). Pin the pi version explicitly so
// these tests describe behaviour instead of tracking the installed pi package.
const OLD_PI = "0.84.3"; // needs pi-vcc's fallback continue
const SELF_RESUME_PI = "0.84.4"; // pi core resumes the run by itself

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-test-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// Minimal ExtensionAPI stub: capture handler + provide ctx with mocked ui.notify
function createMockPi() {
  let beforeHandler: ((event: any, ctx: any) => any) | undefined;
  let compactHandler: ((event: any, ctx: any) => any) | undefined;
  let beforeAgentStartHandler: ((event: any, ctx: any) => any) | undefined;
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const userMessages: Array<string | unknown[]> = [];
  const customMessages: Array<{ message: any; options: any }> = [];
  const ctx = {
    hasUI: true,
    ui: {
      notify: (msg: string, level: string) => {
        notifyCalls.push({ msg, level });
      },
    },
  };
  return {
    pi: {
      on: (eventName: string, h: (e: any, c: any) => any) => {
        if (eventName === "session_before_compact") beforeHandler = h;
        if (eventName === "session_compact") compactHandler = h;
        if (eventName === "before_agent_start") beforeAgentStartHandler = h;
      },
      sendUserMessage: (content: string | unknown[]) => {
        userMessages.push(content);
      },
      sendMessage: (message: any, options: any) => {
        customMessages.push({ message, options });
      },
    } as any,
    invokeBefore: (event: any) => beforeHandler!(event, ctx),
    invokeCompact: (event: any) => compactHandler!(event, ctx),
    invokeBeforeAgentStart: (event: any = { type: "before_agent_start", prompt: "next", systemPrompt: "", systemPromptOptions: {} }) => beforeAgentStartHandler?.(event, ctx),
    notifyCalls,
    userMessages,
    customMessages,
  };
}
 
function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}
 
function makeEvent(branchEntries: any[], customInstructions?: string, eventContext: Record<string, unknown> = {}) {
  return {
    type: "session_before_compact",
    customInstructions,
    branchEntries,
    preparation: {
      previousSummary: undefined,
      fileOps: { read: [], written: [], edited: [] },
      tokensBefore: 1000,
    },
    signal: new AbortController().signal,
    ...eventContext,
  };
}
 
const msg = (id: string, role: "user" | "assistant" | "toolResult", content = "x") => ({
  id,
  type: "message",
  message: { role, content },
});
const comp = (id: string, firstKeptEntryId?: string) => ({ id, type: "compaction", firstKeptEntryId });
const custom = (id: string, customType: string, content: string | unknown[], extra: Record<string, unknown> = {}) => ({ id, type: "custom_message", customType, content, display: false, timestamp: "2026-01-01T00:00:00.000Z", ...extra });
const branchSummary = (id: string, summary: string, fromId = "f1") => ({ id, type: "branch_summary", summary, fromId, timestamp: "2026-01-01T00:00:00.000Z" });
 
describe("registerBeforeCompactHook: cancel paths", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
 
  test("/pi-vcc with too few live messages cancels and notifies warning", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
    expect(notifyCalls[0].msg).toContain("Too few messages");
  });
 
  test("/pi-vcc with no user message compacts all instead of cancelling", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
 
    const entries = [msg("m1", "assistant"), msg("m2", "assistant"), msg("m3", "assistant")];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    // No longer cancels — compacts all to recover from context overflow
    expect(result.cancel).toBeUndefined();
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
  });
 
  test("/compact with override=true cancels and notifies (NEW: was silent before)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, undefined))).toEqual({ cancel: true });
    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0].level).toBe("warning");
  });
 
  test("/compact with override=false short-circuits (no notify, returns undefined)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
 
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, undefined))).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
  });
 
  test("overflow retry ownCut failure falls back to Pi core instead of cancelling", () => {
    setConfig({ debug: true, overrideDefaultCompaction: true });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    const result = invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: true }));

    expect(result).toBeUndefined();
    expect(notifyCalls).toHaveLength(0);
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(false);
    expect(snapshot.fallbackToCore).toBe(true);
    expect(snapshot.reason).toBe("too_few_live_messages");
    expect(snapshot.compaction).toEqual({ reason: "overflow", willRetry: true });
  });

  test("debug:true writes metrics-only snapshot on cancel with no content leakage", () => {
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
 
    // Use too_few_live_messages cancel path to test content leakage
    const entries = [
      msg("m1", "user", "SECRET_TOKEN_abc123"),
      msg("m2", "assistant", "sensitive response"),
    ];
    expect(invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
 
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.cancelled).toBe(true);
    expect(snapshot.reason).toBe("too_few_live_messages");
 
    // No content leakage
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET_TOKEN_abc123");
    expect(serialized).not.toContain("sensitive response");
  });
 
  test("debug:false does NOT write snapshot", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant")];
    expect(invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION))).toEqual({ cancel: true });
    expect(existsSync(DEBUG_PATH)).toBe(false);
  });
});
 
describe("registerBeforeCompactHook: compact-all path", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
 
  test("single-user + autonomous tail → returns compaction with empty firstKeptEntryId", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
 
    const entries = [
      msg("m1", "user", "go"),
      msg("m2", "assistant", "calling tool"),
      msg("m3", "toolResult", "result"),
      msg("m4", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(notifyCalls).toHaveLength(0); // no cancel notify on success
  });
 
  test("manual /pi-vcc marker still compacts and records reason metadata", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION, { reason: "manual", willRetry: false }));

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(result.compaction.details).toMatchObject({ reason: "manual", willRetry: false });
    expect(getLastCompactionStats()).toMatchObject({ reason: "manual", willRetry: false });
  });

  test("threshold override still compacts and records reason metadata", () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    const result = invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));

    expect(result.compaction).toBeDefined();
    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(result.compaction.details).toMatchObject({ reason: "threshold", willRetry: false });
    expect(getLastCompactionStats()).toMatchObject({ reason: "threshold", willRetry: false });
  });

  test("threshold compact auto-continues by default on pi < 0.84.4 with hidden custom message", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, customMessages, userMessages } = createMockPi();
    registerBeforeCompactHook(pi, OLD_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(userMessages).toEqual([]);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(customMessages[0].message).toMatchObject({
      customType: "pi-vcc-auto-continue",
      display: false,
    });
    expect(customMessages[0].message.content).toEqual([]);
  });

  test("successful overflow compact auto-continues by default on pi < 0.84.4 with hidden custom message", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, customMessages, userMessages } = createMockPi();
    registerBeforeCompactHook(pi, OLD_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "overflow", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(userMessages).toEqual([]);
    expect(customMessages).toHaveLength(1);
    expect(customMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(customMessages[0].message).toMatchObject({
      customType: "pi-vcc-auto-continue",
      display: false,
    });
    expect(customMessages[0].message.content).toEqual([]);
  });

  test("threshold compact continuation is canceled when a real user prompt starts", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, invokeBeforeAgentStart, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, OLD_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false });
    invokeBeforeAgentStart();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(customMessages).toEqual([]);
  });

  test("threshold compact continuation can be disabled", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: false });
    const { pi, invokeBefore, invokeCompact, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, OLD_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(customMessages).toEqual([]);
  });

  test("successful overflow compact continuation can be disabled", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: false });
    const { pi, invokeBefore, invokeCompact, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, OLD_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "overflow", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(customMessages).toEqual([]);
  });

  test("pi >= 0.84.4 gets no pi-vcc continue even with the setting explicitly true", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: true });
    const { pi, invokeBefore, invokeCompact, customMessages, userMessages, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi, SELF_RESUME_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(customMessages).toEqual([]);
    expect(userMessages).toEqual([]);
    // Compaction itself is untouched: the stats toast still fires.
    expect(notifyCalls.some((call) => call.msg.startsWith("pi-vcc: kept"))).toBe(true);
  });

  test("overflow compact on pi >= 0.84.4 also skips the pi-vcc continue", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: true });
    const { pi, invokeBefore, invokeCompact, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, SELF_RESUME_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "overflow", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "overflow", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(customMessages).toEqual([]);
  });

  test("unreadable pi version fails safe: no continue", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true, continueAfterThresholdCompact: true });
    const { pi, invokeBefore, invokeCompact, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, "not-a-version");

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, undefined, { reason: "threshold", willRetry: false }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(customMessages).toEqual([]);
  });

  test("explicit /compact follow-up prompt still runs on pi >= 0.84.4", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, customMessages } = createMockPi();
    registerBeforeCompactHook(pi, SELF_RESUME_PI);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue"));
    await invokeCompact({ type: "session_compact", fromExtension: true });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(userMessages).toEqual(["continue"]); // version gate only touches pi-vcc's own continue
    expect(customMessages).toEqual([]);
  });

  test("override=true + customInstructions sends follow-up user message after compact", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue"));
    await invokeCompact({ type: "session_compact", fromExtension: true });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(userMessages).toEqual(["continue"]);
    expect(notifyCalls.some((call) => call.msg.startsWith("pi-vcc: kept 1/2 turns,"))).toBe(true);
  });

  test("follow-up prompt does not block compact metrics notify", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, notifyCalls } = createMockPi();
    pi.sendUserMessage = (content: string | unknown[]) => {
      userMessages.push(content);
      return new Promise(() => {});
    };
    registerBeforeCompactHook(pi);
    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue"));

    invokeCompact({ type: "session_compact", fromExtension: true });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(userMessages).toEqual(["continue"]);
    expect(notifyCalls.some((call) => call.msg.startsWith("pi-vcc: kept 1/2 turns,"))).toBe(true);
  });

  test("override=true + /compact keep prefix keeps requested turns and strips follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", "user"), msg("m2", "assistant"),
      msg("m3", "user"), msg("m4", "assistant"),
      msg("m5", "user"), msg("m6", "assistant"),
      msg("m7", "user"), msg("m8", "assistant"),
    ];
    const result = invokeBefore(makeEvent(entries, "keep:3 continue"));
    await invokeCompact({ type: "session_compact", fromExtension: true });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 3,
      totalUserTurns: 4,
      requestedKeepUserTurns: 3,
      keepUserTurnsExplicit: true,
    });
    expect(userMessages).toEqual(["continue"]);
  });

  test("override=true + /compact keep suffix keeps requested turns and strips follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [
      msg("m1", "user"), msg("m2", "assistant"),
      msg("m3", "user"), msg("m4", "assistant"),
      msg("m5", "user"), msg("m6", "assistant"),
    ];
    const result = invokeBefore(makeEvent(entries, "continue keep:2"));
    await invokeCompact({ type: "session_compact", fromExtension: true });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(result.compaction.firstKeptEntryId).toBe("m3");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 2,
      totalUserTurns: 3,
      requestedKeepUserTurns: 2,
      keepUserTurnsExplicit: true,
    });
    expect(userMessages).toEqual(["continue"]);
  });

  test("session_compact overflow retry does not send follow-up prompt", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages, customMessages, notifyCalls } = createMockPi();
    registerBeforeCompactHook(pi);

    const entries = [msg("m1", "user"), msg("m2", "assistant"), msg("m3", "user"), msg("m4", "assistant")];
    invokeBefore(makeEvent(entries, "continue", { reason: "overflow", willRetry: true }));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "overflow", willRetry: true });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(userMessages).toEqual([]);
    expect(customMessages).toEqual([]);
    expect(notifyCalls).toEqual([]);
  });

  test("formatCompactionStats shows kept 0/N result for compact-all fallback without extra wording", () => {
    const msg = formatCompactionStats({
      summarized: 2,
      kept: 4,
      keptUserTurns: 0,
      totalUserTurns: 2,
      requestedKeepUserTurns: 2,
      keepUserTurnsExplicit: true,
      keepFallbackToCompactAll: true,
      keptTokensEst: 10,
    });
    expect(msg).toBe("pi-vcc: kept 0/2 turns, ~10 tok (summarized 2).");
    expect(msg).not.toMatch(/fallback/i);
  });

  test("formatCompactionStats shows kept 0/N result for default compact-all fallback without extra wording", () => {
    const msg = formatCompactionStats({
      summarized: 2,
      kept: 4,
      keptUserTurns: 0,
      totalUserTurns: 1,
      requestedKeepUserTurns: 1,
      keepUserTurnsExplicit: false,
      keepFallbackToCompactAll: true,
      keptTokensEst: 10,
    });
    expect(msg).toBe("pi-vcc: kept 0/1 turns, ~10 tok (summarized 2).");
    expect(msg).not.toMatch(/fallback/i);
  });

  test("formatCompactionStats appends smart-keep tag when adjusted", () => {
    const msg = formatCompactionStats({
      summarized: 5,
      kept: 6,
      keptUserTurns: 3,
      totalUserTurns: 5,
      requestedKeepUserTurns: 1,
      keepUserTurnsExplicit: false,
      keepFallbackToCompactAll: false,
      keptTokensEst: 3200,
      smartKeepAdjusted: true,
      smartFromKeep: 1,
    });
    expect(msg).toBe("pi-vcc: kept 3/5 turns, ~3.2k tok (summarized 5, smart-keep).");
  });

  test("/pi-vcc keep instruction changes firstKeptEntryId and stats", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];

    const result = invokeBefore(makeEvent(entries, `${PI_VCC_COMPACT_INSTRUCTION} keep:2`));

    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(result.compaction.details.sourceMessageCount).toBe(2);
    expect(getLastCompactionStats()).toMatchObject({
      summarized: 2,
      kept: 4,
      keptUserTurns: 2,
      totalUserTurns: 3,
    });
  });

  test("/pi-vcc marker with trailing prompt does not leak marker as follow-up", async () => {
    setConfig({ debug: false, overrideDefaultCompaction: true });
    const { pi, invokeBefore, invokeCompact, userMessages } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];

    const result = invokeBefore(makeEvent(entries, `${PI_VCC_COMPACT_INSTRUCTION} keep:2 continue`));
    await invokeCompact({ type: "session_compact", fromExtension: true, reason: "manual", willRetry: false });
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 2,
      keepUserTurnsExplicit: true,
    });
    expect(userMessages).toEqual([]);
  });

  test("huge keep instruction compacts all safely", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [msg("u1", "user", "one"), msg("a1", "assistant", "reply one"), msg("u2", "user", "two"), msg("a2", "assistant", "reply two")];

    const result = invokeBefore(makeEvent(entries, `${PI_VCC_COMPACT_INSTRUCTION} keep:999999999999999999999`));

    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(getLastCompactionStats()).toMatchObject({
      keptUserTurns: 0,
      totalUserTurns: 2,
    });
  });
});

describe("applyTailBudget: token-budget tail cut (default path)", () => {
  const big = (n: number) => "x".repeat(n);

  test("Case A: no user anchor + oversized live window → non-compact-all budget cut (no_anchor)", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", big(200_000)), // 50k tok at 4 chars/tok
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true);

    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compactAll).toBe(false);
    expect(result.firstKeptEntryId).toBe("a2");
    expect(result.firstKeptEntryId).not.toBe("");
    expect(result.budgetCut).toBe("no_anchor");
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).not.toBe("toolResult");
  });

  test("Case A small window: everything < budget → unchanged compact-all fallback", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    if (!cut.ok) return;
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result).toBe(cut); // returned unchanged
    if (!result.ok) return;
    expect(result.compactAll).toBe(true);
    expect(result.firstKeptEntryId).toBe("");
    expect(result.budgetCut).toBeUndefined();
  });

  test("Case B: oversized tail (>62.5k tok) re-cuts inside the last turn, not at toolResult", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", big(300_000)), // 75k tok at 4 chars/tok
      msg("t1", "toolResult", "res"),
      msg("a3", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(false);
    expect(cut.firstKeptEntryId).toBe("u2");

    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    if (!result.ok) return;
    expect(result.budgetCut).toBe("oversized_tail");
    expect(result.compactAll).toBe(false);
    expect(result.firstKeptEntryId).toBe("a2"); // cut landed inside the last turn
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).toBe("assistant");
  });

  test("Case B tolerance: last turn ~37.5k tok → no budget cut", () => {
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", big(150_000)), // 37.5k tok at 4 chars/tok < 62.5k
      msg("t1", "toolResult", "res"),
      msg("a3", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    if (!cut.ok) return;
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result).toBe(cut); // tolerance zone: unchanged
    if (!result.ok) return;
    expect(result.budgetCut).toBeUndefined();
    expect(result.firstKeptEntryId).toBe("u2");
  });

  test("toolResult snap: crossing lands on a toolResult → snapped forward to next non-toolResult", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", big(200_000)), // crossing lands here
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true);
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    if (!result.ok) return;
    expect(result.budgetCut).toBe("no_anchor");
    expect(result.firstKeptEntryId).toBe("a2"); // snapped past the toolResult
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.message.role).toBe("assistant");
  });

  test("formatCompactionStats leads with tail tokens for budget cuts", () => {
    const base = {
      summarized: 4,
      kept: 2,
      keptUserTurns: 0,
      totalUserTurns: 1,
      requestedKeepUserTurns: 1,
      keepUserTurnsExplicit: false,
      keepFallbackToCompactAll: false,
      keptTokensEst: 5000,
    };
    expect(formatCompactionStats({ ...base, budgetCut: "no_anchor" })).toBe("pi-vcc: kept ~5.0k tok tail (mid-turn cut, no user anchor), summarized 4.");
    expect(formatCompactionStats({ ...base, budgetCut: "oversized_tail" })).toBe("pi-vcc: kept ~5.0k tok tail (mid-turn cut, oversized tail), summarized 4.");
  });
});

describe("registerBeforeCompactHook: budget-cut hook integration", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("Case A default path: no_anchor budget cut keeps a tail and sets stats", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "x".repeat(200_000)),
    ];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.cancel).toBeUndefined();
    expect(result.compaction.firstKeptEntryId).not.toBe("");
    expect(getLastCompactionStats()!.budgetCut).toBe("no_anchor");
  });

  test("Case A small window: unchanged compact-all fallback and no budgetCut", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "tool"),
      msg("t1", "toolResult", "res"),
      msg("a2", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.compaction.firstKeptEntryId).toBe("");
    expect(getLastCompactionStats()!.budgetCut).toBeUndefined();
  });

  test("Explicit keep:N with giant last turn is untouched (no budgetCut)", () => {
    setConfig({ debug: false, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "x".repeat(300_000)),
      msg("u3", "user", "three"),
      msg("a3", "assistant", "reply three"),
    ];
    const result = invokeBefore(makeEvent(entries, `${PI_VCC_COMPACT_INSTRUCTION} keep:2`));
    expect(result.compaction.firstKeptEntryId).toBe("u2");
    expect(getLastCompactionStats()!.budgetCut).toBeUndefined();
    expect(getLastCompactionStats()!.keepUserTurnsExplicit).toBe(true);
  });
});

describe("collectLiveMessages: custom_message / branch_summary entries", () => {
  test("custom_message in the summarized prefix is carried into the summarizer input", () => {
    const entries = [
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      custom("c1", "memory-inject", "CUSTOM_CTX_MARKER_123"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // keep:1 → cut at u2, so the summarized prefix is [u1, a1, c1]
    expect(cut.firstKeptEntryId).toBe("u2");
    const summarized = cut.messages.map((m: any) => m.content);
    expect(summarized).toContain("CUSTOM_CTX_MARKER_123");
    const customMsg = cut.messages.find((m: any) => m.role === "custom");
    expect(customMsg).toBeDefined();
    expect(customMsg.customType).toBe("memory-inject");
  });

  test("custom_message is NOT counted as a user turn", () => {
    const entries = [
      msg("u1", "user", "one"),
      custom("c1", "ctx", "injected"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.totalUserTurns).toBe(2); // custom not counted
    expect(cut.keptUserTurns).toBe(1);
  });

  test("branch_summary entry is included and not counted as a user turn", () => {
    const entries = [
      branchSummary("bs1", "BRANCH_SUMMARY_MARKER"),
      msg("u1", "user", "one"),
      msg("a1", "assistant", "reply one"),
      msg("u2", "user", "two"),
      msg("a2", "assistant", "reply two"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.totalUserTurns).toBe(2); // branch_summary not counted
    const prefix = cut.messages.map((m: any) => m.content ?? m.summary);
    expect(prefix).toContain("BRANCH_SUMMARY_MARKER");
    const bsMsg = cut.messages.find((m: any) => m.role === "branchSummary");
    expect(bsMsg).toBeDefined();
    expect(bsMsg.summary).toBe("BRANCH_SUMMARY_MARKER");
  });

  test("budget cut may land on a custom message (valid non-toolResult boundary)", () => {
    const entries = [
      msg("u1", "user", "go"),
      custom("c1", "ctx", "x".repeat(200_000)), // huge custom message
      msg("a1", "assistant", "wrap"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    expect(cut.compactAll).toBe(true); // no user anchor → case A
    const result = applyTailBudget(entries, cut, { charsPerToken: 4 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budgetCut).toBe("no_anchor");
    expect(result.firstKeptEntryId).toBe("c1"); // cut landed on the custom message
    const keptFirst = entries.find((e: any) => e.id === result.firstKeptEntryId)!;
    expect(keptFirst.type).toBe("custom_message");
  });

  test("orphan-recovery window containing custom_message keeps it in the live window", () => {
    const entries = [
      comp("pc", "ghost-id"), // prior compaction with a no-longer-valid kept id
      custom("c1", "ctx", "ORPHAN_CUSTOM_MARKER"),
      msg("a1", "assistant", "reply"),
      msg("u1", "user", "go"),
      msg("a2", "assistant", "done"),
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    // orphan recovery collects from after the last compaction → custom is included
    const summarized = cut.messages.map((m: any) => m.content).join("");
    expect(summarized).toContain("ORPHAN_CUSTOM_MARKER");
    expect(cut.totalUserTurns).toBe(1);
  });
});

describe("registerBeforeCompactHook: custom_message reaches the summarizer", () => {
  beforeEach(() => {
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });
  afterEach(() => {
    if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
    if (existsSync(DEBUG_PATH)) unlinkSync(DEBUG_PATH);
  });

  test("custom message content appears in the debug summarize-input preview", () => {
    setConfig({ debug: true, overrideDefaultCompaction: false });
    const { pi, invokeBefore } = createMockPi();
    registerBeforeCompactHook(pi);
    const entries = [
      custom("c1", "memory-inject", "INJECTED_CTX_9999"),
      msg("u1", "user", "go"),
      msg("a1", "assistant", "reply"),
      msg("u2", "user", "next"),
      msg("a2", "assistant", "done"),
    ];
    const result = invokeBefore(makeEvent(entries, PI_VCC_COMPACT_INSTRUCTION));
    expect(result.cancel).toBeUndefined();
    expect(existsSync(DEBUG_PATH)).toBe(true);
    const snapshot = JSON.parse(readFileSync(DEBUG_PATH, "utf-8"));
    expect(snapshot.usedOwnCut).toBe(true);
    expect(JSON.stringify(snapshot)).toContain("INJECTED_CTX_9999");
  });
});
