import { describe, it, expect } from "bun:test";
import { formatSummary } from "../src/core/format";
import type { SectionData } from "../src/sections";

const empty: SectionData = {
  sessionGoal: [],
  outstandingContext: [],
  filesAndChanges: [],
  commits: [],
  userPreferences: [],
  trackedCommands: [],
  briefTranscript: "",
};

describe("formatSummary", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single header section", () => {
    const data = {
      ...empty,
      sessionGoal: ["fix auth bug"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("- fix auth bug");
  });

  it("separates header and brief transcript with ---", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      briefTranscript: "[user]\ndo something",
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("---");
    expect(r).toContain("[user]\ndo something");
  });

  it("renders brief transcript alone when no header sections", () => {
    const data = {
      ...empty,
      briefTranscript: "[user]\nhi\n\n[assistant]\nhello",
    };
    const r = formatSummary(data);
    expect(r).toContain("[user]\nhi\n\n[assistant]\nhello");
  });

  it("joins multiple header sections with blank line", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      outstandingContext: ["blocker"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("[Outstanding Context]");
    expect(r).toContain("\n\n");
  });

  it("wraps long lines so compaction TUI rendering stays bounded", () => {
    const data = {
      ...empty,
      briefTranscript: `[assistant]\n${"word ".repeat(80)}`,
    };
    const r = formatSummary(data);
    expect(Math.max(...r.split("\n").map((line) => line.length))).toBeLessThanOrEqual(120);
  });
});
