import { describe, it, expect } from "bun:test";
import { filterNoise } from "../src/core/filter-noise";
import type { NormalizedBlock } from "../src/types";

describe("filterNoise", () => {
  it("removes thinking blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "thinking", text: "hmm", redacted: false },
      { kind: "assistant", text: "hello" },
    ];
    expect(filterNoise(blocks)).toEqual([{ kind: "assistant", text: "hello" }]);
  });

  it("removes noise tool calls and results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "TodoWrite", args: {} },
      { kind: "tool_result", name: "TodoWrite", text: "ok", isError: false },
      { kind: "tool_call", name: "Read", args: { path: "x.ts" } },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "tool_call", name: "Read", args: { path: "x.ts" } });
  });

  it("removes user blocks that are pure XML wrappers", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>some noise</system-reminder>" },
      { kind: "user", text: "Fix the bug" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "user", text: "Fix the bug" });
  });

  it("cleans XML wrappers from user text but keeps real content", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "<system-reminder>noise</system-reminder>\nFix the login" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("Fix the login");
  });

  it("removes known noise strings", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Continue from where you left off." },
      { kind: "user", text: "real task" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("real task");
  });

  it("preserves non-noise tool calls", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { path: "a.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok", isError: false },
    ];
    expect(filterNoise(blocks)).toHaveLength(2);
  });
});
