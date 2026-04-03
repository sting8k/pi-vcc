import { describe, it, expect } from "bun:test";
import { searchEntries } from "../src/core/search-entries";
import type { RenderedEntry } from "../src/core/render-entries";
import type { Message } from "@mariozechner/pi-ai";

const entries: RenderedEntry[] = [
  { index: 0, role: "user", summary: "Fix login bug" },
  { index: 1, role: "assistant", summary: "Reading auth.ts" },
  { index: 2, role: "tool_result", summary: "[Read] code here" },
  { index: 3, role: "assistant", summary: "Found the root cause" },
];

// Matching raw messages for full-text search
const messages: Message[] = [
  { role: "user", content: "Fix login bug" } as any,
  { role: "assistant", content: [{ type: "text", text: "Reading auth.ts" }] } as any,
  { role: "toolResult", content: [{ type: "text", text: "[Read] code here" }] } as any,
  { role: "assistant", content: [{ type: "text", text: "Found the root cause" }] } as any,
];

describe("searchEntries", () => {
  it("returns all for empty query", () => {
    expect(searchEntries(entries, messages)).toEqual(entries);
    expect(searchEntries(entries, messages, "")).toEqual(entries);
  });

  it("filters by single term", () => {
    const r = searchEntries(entries, messages, "login");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(0);
  });

  it("filters by multiple terms (AND)", () => {
    const r = searchEntries(entries, messages, "root cause");
    expect(r).toHaveLength(1);
    expect(r[0].index).toBe(3);
  });

  it("returns empty for no match", () => {
    expect(searchEntries(entries, messages, "xyz123")).toEqual([]);
  });

  it("finds keyword beyond clip boundary in full content", () => {
    const longText = "A".repeat(400) + " hidden_keyword here";
    const longEntries: RenderedEntry[] = [
      { index: 0, role: "user", summary: "A".repeat(300) },
    ];
    const longMsgs: Message[] = [
      { role: "user", content: longText } as any,
    ];
    const r = searchEntries(longEntries, longMsgs, "hidden_keyword");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toContain("hidden_keyword");
  });

  it("returns snippet around matched term", () => {
    const r = searchEntries(entries, messages, "root");
    expect(r).toHaveLength(1);
    expect(r[0].snippet).toBeDefined();
    expect(r[0].snippet).toContain("root");
  });
});
