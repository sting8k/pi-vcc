import { describe, it, expect } from "bun:test";
import { extractGoals } from "../src/extract/goals";
import type { NormalizedBlock } from "../src/types";

describe("extractGoals", () => {
  it("returns empty for no blocks", () => {
    expect(extractGoals([])).toEqual([]);
  });

  it("returns empty when no user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "hello" },
    ];
    expect(extractGoals(blocks)).toEqual([]);
  });

  it("extracts first user message lines as goals", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix login bug\nCheck auth flow" },
    ];
    const goals = extractGoals(blocks);
    expect(goals).toEqual(["Fix login bug", "Check auth flow"]);
  });

  it("takes max 3 lines from first user block", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "a\nb\nc\nd\ne" },
    ];
    expect(extractGoals(blocks)).toHaveLength(3);
  });

  it("ignores subsequent user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "first goal" },
      { kind: "assistant", text: "ok" },
      { kind: "user", text: "second request" },
    ];
    expect(extractGoals(blocks)).toEqual(["first goal"]);
  });
});
