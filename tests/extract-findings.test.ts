import { describe, it, expect } from "bun:test";
import { extractFindings } from "../src/extract/findings";
import type { NormalizedBlock } from "../src/types";

describe("extractFindings", () => {
  it("returns empty for no blocks", () => {
    expect(extractFindings([])).toEqual([]);
  });

  it("captures error tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Edit", text: "File not found", isError: true },
    ];
    const r = extractFindings(blocks);
    expect(r.length).toBe(1);
    expect(r[0]).toContain("[Edit] Error:");
  });

  it("captures assistant lines matching error patterns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "The root cause is a null pointer" },
    ];
    expect(extractFindings(blocks).length).toBe(1);
  });

  it("ignores short lines", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "error" },
    ];
    expect(extractFindings(blocks)).toEqual([]);
  });

  it("deduplicates findings", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "found that X is broken" },
      { kind: "assistant", text: "found that X is broken" },
    ];
    expect(extractFindings(blocks).length).toBe(1);
  });
});

