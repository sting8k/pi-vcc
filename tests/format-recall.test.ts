import { describe, it, expect } from "bun:test";
import { formatRecallOutput } from "../src/core/format-recall";
import type { RenderedEntry } from "../src/core/render-entries";

describe("formatRecallOutput", () => {
  it("shows no-match message with query", () => {
    const r = formatRecallOutput([], "xyz");
    expect(r).toContain('No matches for "xyz"');
  });

  it("shows no-entries message without query", () => {
    expect(formatRecallOutput([])).toContain("No entries");
  });

  it("formats entries with index and role", () => {
    const entries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "hello" },
    ];
    const r = formatRecallOutput(entries);
    expect(r).toContain("#0 [user] hello");
  });

  it("shows match count with query", () => {
    const entries: RenderedEntry[] = [
      { index: 2, role: "assistant", summary: "done" },
    ];
    const r = formatRecallOutput(entries, "done");
    expect(r).toContain('Found 1 matches for "done"');
  });
});
