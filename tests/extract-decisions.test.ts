import { describe, it, expect } from "bun:test";
import { extractDecisions } from "../src/extract/decisions";
import type { NormalizedBlock } from "../src/types";

describe("extractDecisions", () => {
  it("returns empty for no blocks", () => {
    expect(extractDecisions([])).toEqual([]);
  });

  it("captures decision patterns from assistant", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "I decided to use React for the frontend" },
    ];
    expect(extractDecisions(blocks).length).toBe(1);
  });

  it("captures from user blocks too", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "We must use PostgreSQL for the database" },
    ];
    expect(extractDecisions(blocks).length).toBe(1);
  });

  it("ignores tool_call blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { path: "a.ts" } },
    ];
    expect(extractDecisions(blocks)).toEqual([]);
  });
});
