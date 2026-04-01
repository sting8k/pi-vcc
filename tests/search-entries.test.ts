import { describe, it, expect } from "bun:test";
import { searchEntries } from "../src/core/search-entries";
import type { RenderedEntry } from "../src/core/render-entries";

const entries: RenderedEntry[] = [
  { index: 0, role: "user", summary: "Fix login bug" },
  { index: 1, role: "assistant", summary: "Reading auth.ts" },
  { index: 2, role: "tool_result", summary: "[Read] code here" },
  { index: 3, role: "assistant", summary: "Found the root cause" },
];

describe("searchEntries", () => {
  it("returns all for empty query", () => {
    expect(searchEntries(entries)).toEqual(entries);
    expect(searchEntries(entries, "")).toEqual(entries);
  });

  it("filters by single term", () => {
    const r = searchEntries(entries, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("filters by multiple terms (AND)", () => {
    const r = searchEntries(entries, "root cause");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(3);
  });

  it("returns empty for no match", () => {
    expect(searchEntries(entries, "xyz123")).toEqual([]);
  });
});
