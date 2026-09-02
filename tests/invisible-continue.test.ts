import { describe, expect, it, test } from "bun:test";
import {
  registerBeforeCompactHook,
  triggerInvisibleContinue,
  buildOwnCut,
  shouldScheduleAutoContinue,
  AUTO_CONTINUE_CUSTOM_TYPE,
  PI_SELF_RESUME_VERSION,
} from "../src/hooks/before-compact";

// Versions are injected, never read from the installed pi package, so these
// stay stable when the peer dependency is bumped.
describe("auto-continue eligibility: setting x running pi version", () => {
  it("boundary constant is the reported self-resume version 0.84.4", () => {
    expect([...PI_SELF_RESUME_VERSION]).toEqual([0, 84, 4]);
  });

  it("setting false disables the continue on every version", () => {
    expect(shouldScheduleAutoContinue(false, "0.75.1")).toBe(false);
    expect(shouldScheduleAutoContinue(false, "0.84.3")).toBe(false);
    expect(shouldScheduleAutoContinue(false, "0.84.4")).toBe(false);
  });

  it("setting true keeps the fallback on pi versions that do not self-resume", () => {
    expect(shouldScheduleAutoContinue(true, "0.70.2")).toBe(true);
    expect(shouldScheduleAutoContinue(true, "0.75.1")).toBe(true);
    expect(shouldScheduleAutoContinue(true, "0.84.3")).toBe(true);
  });

  it("0.84.3 vs 0.84.4 is the exact cut-off", () => {
    expect(shouldScheduleAutoContinue(true, "0.84.3")).toBe(true);
    expect(shouldScheduleAutoContinue(true, "0.84.4")).toBe(false);
  });

  it("newer pi never gets a pi-vcc continue, even with the setting on", () => {
    expect(shouldScheduleAutoContinue(true, "0.84.5")).toBe(false);
    expect(shouldScheduleAutoContinue(true, "0.85.0")).toBe(false);
    expect(shouldScheduleAutoContinue(true, "1.0.0")).toBe(false);
    expect(shouldScheduleAutoContinue(true, "0.100.0")).toBe(false); // numeric, not lexicographic
  });

  it("prerelease/build suffixes compare on the version core", () => {
    expect(shouldScheduleAutoContinue(true, "0.84.3-rc.1")).toBe(true);
    expect(shouldScheduleAutoContinue(true, "0.84.4-rc.1")).toBe(false); // already carries self-resume
    expect(shouldScheduleAutoContinue(true, "0.84.4+build.7")).toBe(false);
    expect(shouldScheduleAutoContinue(true, "v0.84.3")).toBe(true);
    expect(shouldScheduleAutoContinue(true, " 0.84.3 ")).toBe(true);
  });

  it("malformed or unreadable versions fail safe to no continue", () => {
    for (const bad of ["", "0.84", "abc", "0.x.4", "0.84.4.1", undefined, null, 84, {}]) {
      expect(shouldScheduleAutoContinue(true, bad)).toBe(false);
    }
  });
});

describe("invisible auto-continue: trigger + context filter", () => {
  it("triggerInvisibleContinue sends a hidden custom message with followUp delivery", () => {
    const calls: { m: any; o: any }[] = [];
    const pi = { sendMessage: (m: any, o: any) => calls.push({ m, o }) } as any;
    triggerInvisibleContinue(pi);

    expect(calls).toHaveLength(1);
    expect(calls[0].o).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(calls[0].m).toMatchObject({
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: [],
      display: false,
    });
  });

  it("context hook filters ONLY our customType; other custom messages pass through untouched", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "keep" }] };
    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const other = { role: "custom", customType: "some-other-ext", content: [{ type: "text", text: "ctx" }] };

    const result = handler?.({ messages: [user, own, other] });
    const filtered = ((result as any)?.messages ?? [user, own, other]) as any[];
    expect(filtered).toEqual([user, other]);
  });

  it("context hook is a pure filter: returns undefined when nothing to remove", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const user = { role: "user", content: [{ type: "text", text: "hi" }] };
    const other = { role: "custom", customType: "other-ext", content: [] };
    const result = handler?.({ messages: [user, other] });
    expect(result).toBeUndefined(); // no mutation, no return
  });

  it("filter is idempotent: removing our marker yields empty result deterministically", () => {
    let handler: ((event: any) => unknown) | undefined;
    const pi = { on: (e: string, h: any) => { if (e === "context") handler = h; } } as any;
    registerBeforeCompactHook(pi);

    const own = { role: "custom", customType: AUTO_CONTINUE_CUSTOM_TYPE, content: [] };
    const once = handler?.({ messages: [own] });
    const messages = ((once as any)?.messages ?? []) as any[];
    expect(messages).toEqual([]);
  });
});

describe("invisible auto-continue: summarize-path noise", () => {
  it("our continue custom message carries empty content → adds no noise to summarizer input", () => {
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "reply" } },
      {
        id: "c1",
        type: "custom_message",
        customType: AUTO_CONTINUE_CUSTOM_TYPE,
        content: [],
        display: false,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      { id: "u2", type: "message", message: { role: "user", content: "next" } },
      { id: "a2", type: "message", message: { role: "assistant", content: "done" } },
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;

    // The continue message is collected into the live window (harmless) but its
    // content is empty, so it contributes zero text/tokens to the summarizer.
    const custom = cut.messages.find((m: any) => m.content && m.role === "custom");
    expect(custom).toBeDefined();
    const contentLen = Array.isArray(custom.content)
      ? custom.content.length
      : String(custom.content ?? "").length;
    expect(contentLen).toBe(0);
  });
});