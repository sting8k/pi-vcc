import { describe, it, expect } from "bun:test";
import type { RenderedEntry } from "../src/core/render-entries";
import { renderMessage } from "../src/core/render-entries";
import {
  validateRangeParams,
  selectRangeEntries,
  rangeCap,
  harmonicSum,
  RANGE_BUDGET_CHARS,
  RANGE_MIN_CHARS,
} from "../src/tools/recall";

const entry = (index: number, summary = `summary ${index}`): RenderedEntry => ({
  index,
  role: "user",
  summary,
});

describe("validateRangeParams", () => {
  it("accepts a valid pinned range", () => {
    expect(validateRangeParams(170, 217, undefined)).toBeNull();
    expect(validateRangeParams(170, 217, 80)).toBeNull();
  });

  it("requires both from and to", () => {
    expect(validateRangeParams(170, undefined, undefined)).toContain("both 'from' and 'to'");
    expect(validateRangeParams(undefined, 217, undefined)).toContain("both 'from' and 'to'");
    expect(validateRangeParams(undefined, undefined, undefined)).toBeNull();
  });

  it("rejects limit without the range form", () => {
    expect(validateRangeParams(undefined, undefined, 80)).toContain("'limit'");
  });

  it("rejects non-integer or inverted ranges", () => {
    expect(validateRangeParams(1.5, 10, undefined)).toContain("integer");
    expect(validateRangeParams(10, 1, undefined)).toContain("greater than to");
  });

  it("rejects non-positive limits", () => {
    expect(validateRangeParams(1, 10, 0)).toContain("positive");
    expect(validateRangeParams(1, 10, 2.5)).toContain("positive");
  });
});

describe("harmonicSum / rangeCap", () => {
  it("computes harmonic numbers", () => {
    expect(harmonicSum(1)).toBe(1);
    expect(harmonicSum(2)).toBe(1.5);
    expect(harmonicSum(3)).toBeCloseTo(1.8333, 3);
  });

  it("clamps small ranges to full detail (head and tail)", () => {
    const H = harmonicSum(3);
    expect(rangeCap(0, 3, H)).toBe(300);
    expect(rangeCap(2, 3, H)).toBe(300);
  });

  it("decays head-to-tail for large ranges", () => {
    const H = harmonicSum(48);
    expect(rangeCap(0, 48, H)).toBe(300); // clamped max
    expect(rangeCap(10, 48, H)).toBe(Math.floor(RANGE_BUDGET_CHARS / 11 / H));
    expect(rangeCap(47, 48, H)).toBe(RANGE_MIN_CHARS); // floored
    expect(rangeCap(0, 48, H)).toBeGreaterThan(rangeCap(20, 48, H));
  });

  it("is monotonically non-increasing", () => {
    const H = harmonicSum(100);
    let prev = rangeCap(0, 100, H);
    for (let i = 1; i < 100; i++) {
      const c = rangeCap(i, 100, H);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }
  });

  it("returns 0 for empty ranges", () => {
    expect(rangeCap(0, 0, harmonicSum(0))).toBe(0);
  });
});

describe("renderMessage with maxChars", () => {
  const longUser = { role: "user", content: "word ".repeat(500) } as const;
  const longTool = {
    role: "toolResult",
    toolName: "bash",
    content: "out ".repeat(500),
  } as const;

  it("clips prose to the allocation when it binds", () => {
    const r = renderMessage(longUser, 7, false, 120);
    expect(r.index).toBe(7);
    expect(r.summary.length).toBeLessThanOrEqual(120);
    expect(r.summary.length).toBeGreaterThan(60); // clipped but not a stub
  });

  it("keeps the default role ceiling when the allocation is generous", () => {
    const r = renderMessage(longUser, 7, false, 600);
    expect(r.summary.length).toBeLessThanOrEqual(300); // prose ceiling
    expect(r.summary.length).toBeGreaterThan(200);
  });

  it("caps tool output at its tighter role ceiling", () => {
    const r = renderMessage(longTool, 8, false, 600);
    const body = r.summary.slice("[bash] ".length);
    expect(body.length).toBeLessThanOrEqual(200); // tool ceiling
    expect(r.summary.startsWith("[bash]")).toBe(true);
  });

  it("ignores maxChars when full content is requested", () => {
    const r = renderMessage(longUser, 7, true, 50);
    expect(r.summary.length).toBeGreaterThan(1000);
  });

  it("clips tool-call args when maxChars is set", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc", name: "bash", arguments: { command: "echo " + "x".repeat(500) } },
        { type: "text", text: "done" },
      ],
    } as any;
    const r = renderMessage(msg, 9, false, 80);
    expect(r.summary.length).toBeLessThanOrEqual(80);
    expect(r.summary).toContain("bash(command=echo");
  });

  it("renders short content unchanged", () => {
    const r = renderMessage({ role: "user", content: "hi" }, 7, false, 50);
    expect(r.summary).toBe("hi");
  });
});

describe("selectRangeEntries", () => {
  const msgs = Array.from({ length: 10 }, (_, i) => entry(i));

  it("selects an inclusive range by global index", () => {
    const r = selectRangeEntries(msgs, 3, 6);
    expect(r.indices).toEqual([3, 4, 5, 6]);
    expect(r.total).toBe(4);
    expect(r.truncated).toBe(false);
    expect(r.nextFrom).toBeUndefined();
    expect(r.invalidExpand).toEqual([]);
  });

  it("returns empty for a range with no messages", () => {
    const r = selectRangeEntries(msgs, 100, 200);
    expect(r.indices).toEqual([]);
    expect(r.total).toBe(0);
  });

  it("caps results and reports a continue-from index", () => {
    const r = selectRangeEntries(msgs, 0, 9, 3);
    expect(r.indices).toEqual([0, 1, 2]);
    expect(r.truncated).toBe(true);
    expect(r.nextFrom).toBe(3);
    expect(r.total).toBe(10);
  });

  it("does not cap when limit covers the whole range", () => {
    const r = selectRangeEntries(msgs, 2, 5, 10);
    expect(r.truncated).toBe(false);
    expect(r.nextFrom).toBeUndefined();
    expect(r.indices.length).toBe(4);
  });

  it("reports expand indices outside the range as invalid", () => {
    const r = selectRangeEntries(msgs, 2, 4, undefined, [7]);
    expect(r.invalidExpand).toEqual([7]);
  });
});
