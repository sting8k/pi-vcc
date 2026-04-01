import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/core/build-sections";
import type { NormalizedBlock } from "../src/types";

describe("buildSections", () => {
  it("returns all-empty for no blocks", () => {
    const r = buildSections({ blocks: [] });
    expect(r.sessionGoal).toEqual([]);
    expect(r.whatWasDone).toEqual([]);
    expect(r.filesRead).toEqual([]);
  });

  it("populates sections from realistic blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the auth bug" },
      { kind: "tool_call", name: "Read", args: { path: "auth.ts" } },
      { kind: "tool_result", name: "Read", text: "code...", isError: false },
      { kind: "assistant", text: "The root cause is a null check" },
      { kind: "tool_call", name: "Edit", args: { path: "auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok", isError: false },
      { kind: "assistant", text: "- run tests next" },
    ];
    const r = buildSections({ blocks });
    expect(r.sessionGoal).toContain("Fix the auth bug");
    expect(r.filesRead).toContain("auth.ts");
    expect(r.filesModified).toContain("auth.ts");
    expect(r.whatWasDone.length).toBeGreaterThan(0);
    expect(r.importantFindings.length).toBeGreaterThan(0);
    expect(r.nextSteps).toContain("- run tests next");
  });

  it("uses fileOps to seed file lists", () => {
    const r = buildSections({
      blocks: [],
      fileOps: { readFiles: ["x.ts"], modifiedFiles: ["y.ts"] },
    });
    expect(r.filesRead).toContain("x.ts");
    expect(r.filesModified).toContain("y.ts");
  });

  it("collapses repeated tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "a.ts" } },
    ];
    const r = buildSections({ blocks });
    expect(r.whatWasDone.length).toBe(1);
    expect(r.whatWasDone[0]).toContain("x3");
  });
});

