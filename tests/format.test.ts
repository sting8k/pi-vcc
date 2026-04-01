import { describe, it, expect } from "bun:test";
import { formatSummary } from "../src/core/format";
import type { SectionData } from "../src/sections";

const empty: SectionData = {
  sessionGoal: [], currentState: [], whatWasDone: [],
  importantFindings: [], filesRead: [], filesModified: [],
  filesCreated: [], openProblems: [], decisions: [],
  userPreferences: [], nextSteps: [],
};

describe("formatSummary", () => {
  it("returns empty string for all-empty sections", () => {
    expect(formatSummary(empty)).toBe("");
  });

  it("formats a single section", () => {
    const data = { ...empty, sessionGoal: ["Fix login"] };
    expect(formatSummary(data)).toBe("[Session Goal]\n- Fix login");
  });

  it("formats files section with subcategories", () => {
    const data = {
      ...empty,
      filesRead: ["a.ts"],
      filesModified: ["b.ts"],
    };
    const r = formatSummary(data);
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("Read:");
    expect(r).toContain("  - a.ts");
    expect(r).toContain("Modified:");
  });

  it("joins multiple sections with blank line", () => {
    const data = {
      ...empty,
      sessionGoal: ["goal"],
      nextSteps: ["step 1"],
    };
    const r = formatSummary(data);
    expect(r).toContain("\n\n");
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("[Next Best Steps]");
  });
});

