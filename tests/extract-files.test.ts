import { describe, it, expect } from "bun:test";
import { extractFiles } from "../src/extract/files";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import type { NormalizedBlock } from "../src/types";

describe("extractFiles", () => {
  it("matches tool names case-insensitively", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read", args: { path: "a.ts" } },
      { kind: "tool_call", name: "Read", args: { path: "b.ts" } },
      { kind: "tool_call", name: "Write", args: { path: "c.ts" } },
      { kind: "tool_call", name: "MultiEdit", args: { path: "d.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.read].sort()).toEqual(["a.ts", "b.ts"]);
    expect([...r.modified].sort()).toEqual(["c.ts", "d.ts"]);
    expect([...r.created]).toEqual(["c.ts"]);
  });

  it("records modern edit tools as modifications", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "quick_edit", args: { path: "a.ts" } },
      { kind: "tool_call", name: "target_edit", args: { path: "b.ts" } },
    ];
    const r = extractFiles(blocks);
    expect([...r.modified].sort()).toEqual(["a.ts", "b.ts"]);
  });

  it("seeds activity from hook-provided fileOps", () => {
    const r = extractFiles([], { readFiles: ["x.ts"], modifiedFiles: ["y.ts"], createdFiles: [] });
    expect([...r.read]).toEqual(["x.ts"]);
    expect([...r.modified]).toEqual(["y.ts"]);
  });
});

describe("settings defaults", () => {
  it("overrides pi core compaction by default", () => {
    expect(DEFAULT_SETTINGS.overrideDefaultCompaction).toBe(true);
  });

  it("trackCommands is empty (feature off) by default", () => {
    expect(DEFAULT_SETTINGS.trackCommands).toEqual([]);
  });
});
