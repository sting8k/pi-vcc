import { describe, it, expect } from "bun:test";
import { extractFiles } from "../src/extract/files";
import type { NormalizedBlock } from "../src/types";

describe("extractFiles", () => {
  it("returns empty sets for no blocks", () => {
    const r = extractFiles([]);
    expect(r.read.size).toBe(0);
    expect(r.modified.size).toBe(0);
    expect(r.created.size).toBe(0);
  });

  it("seeds from fileOps", () => {
    const r = extractFiles([], {
      readFiles: ["a.ts"],
      modifiedFiles: ["b.ts"],
    });
    expect(r.read.has("a.ts")).toBe(true);
    expect(r.modified.has("b.ts")).toBe(true);
  });

  it("detects Read tool", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "x.ts" } },
    ];
    expect(extractFiles(blocks).read.has("x.ts")).toBe(true);
  });

  it("detects Edit tool as modified", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Edit", args: { path: "y.ts" } },
    ];
    expect(extractFiles(blocks).modified.has("y.ts")).toBe(true);
  });

  it("detects Write tool as both modified and created", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Write", args: { path: "new.ts" } },
    ];
    const r = extractFiles(blocks);
    expect(r.modified.has("new.ts")).toBe(true);
    expect(r.created.has("new.ts")).toBe(true);
  });

  it("skips tool_call without path arg", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { query: "foo" } },
    ];
    expect(extractFiles(blocks).read.size).toBe(0);
  });

  it("supports file_path arg key", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "read_file", args: { file_path: "z.ts" } },
    ];
    expect(extractFiles(blocks).read.has("z.ts")).toBe(true);
  });
});


