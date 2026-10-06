import { describe, expect, test } from "bun:test";
import {
  calibrateCharsPerToken,
  estimateMessageChars,
  estimateMessageContentChars,
  estimateMessageContentTokens,
  estimatePostCompactionTokens,
  estimateTokensFromChars,
} from "../src/core/token-estimate";

describe("token estimate", () => {
  test("estimates tokens from chars with ceil to avoid undercounting", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
  });

  test("supports calibrated chars/token ratios", () => {
    expect(estimateTokensFromChars(5, 2)).toBe(3);
    expect(estimateMessageContentTokens("abcde", 2)).toBe(3);
  });

  test("calibrates chars/token from source chars and tokens", () => {
    expect(calibrateCharsPerToken(120, 40)).toMatchObject({
      mode: "calibrated",
      charsPerToken: 3,
      sourceChars: 120,
      sourceTokens: 40,
      rawCharsPerToken: 3,
    });
  });

  test("clamps calibrated ratios and falls back without usable source tokens", () => {
    expect(calibrateCharsPerToken(10, 100).charsPerToken).toBe(2);
    expect(calibrateCharsPerToken(1000, 10).charsPerToken).toBe(6);
    expect(calibrateCharsPerToken(1000, 0)).toMatchObject({
      mode: "heuristic",
      charsPerToken: 4,
    });
  });

  test("estimates message content chars from strings and content parts", () => {
    expect(estimateMessageContentChars("hello")).toBe(5);
    expect(estimateMessageContentChars([
      { type: "text", text: "hello" },
      { type: "toolCall", name: "read", input: { path: "a.ts" } },
      { type: "toolResult", content: "done" },
      { type: "image", mimeType: "image/png" },
    ])).toBe(5 + 4 + JSON.stringify({ path: "a.ts" }).length + 4 + 4800);
  });

  test("counts real Pi part shapes: thinking text and toolCall arguments", () => {
    // Pi assistant content: thinking.thinking + toolCall.arguments (not .input).
    expect(estimateMessageContentChars([
      { type: "thinking", thinking: "reasoning", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
    ])).toBe(9 + 6 + 4 + JSON.stringify({ command: "ls" }).length);
  });

  test("ignores non-token parts and unknown shapes without throwing", () => {
    expect(estimateMessageContentChars([
      { type: "thinking" },              // missing thinking field → 0
      { type: "toolCall", name: "noop" }, // name(4) + stringify("")=('""'=2) → 6
      { type: "mystery", text: "x" },     // unknown → falls back to text → 1
      null,                               // 0
      "not-an-object",                    // 0
    ] as any)).toBe(0 + 6 + 1 + 0 + 0);
  });

  test("estimates message content tokens through the shared char estimator", () => {
    expect(estimateMessageContentTokens("abcde")).toBe(2);
  });
});

describe("estimateMessageChars", () => {
  test("counts prompt sections and added tool schemas on a system message", () => {
    expect(estimateMessageChars({
      role: "system",
      content: "x".repeat(100),
      sections: { tools: "y".repeat(50), persona: "z".repeat(25) },
      toolsAdded: ["bash"],
    })).toBe(100 + 50 + 25 + JSON.stringify(["bash"]).length);
  });

  test("counts summary text for compaction and branch summaries", () => {
    expect(estimateMessageChars({ role: "compactionSummary", summary: "s".repeat(40) })).toBe(40);
    expect(estimateMessageChars({ role: "branchSummary", summary: "b".repeat(7) })).toBe(7);
  });

  test("counts command and output for a bash execution", () => {
    expect(estimateMessageChars({ role: "bashExecution", command: "ls", output: "o".repeat(9) })).toBe(11);
  });

  test("delegates content roles to the content estimator", () => {
    const content = [{ type: "text", text: "hello" }];
    expect(estimateMessageChars({ role: "assistant", content }))
      .toBe(estimateMessageContentChars(content));
  });

  test("returns 0 for shapes it cannot read instead of throwing", () => {
    expect(estimateMessageChars(null)).toBe(0);
    expect(estimateMessageChars(undefined)).toBe(0);
    expect(estimateMessageChars("not a message")).toBe(0);
    expect(estimateMessageChars({ role: "compactionSummary" })).toBe(0);
    expect(estimateMessageChars({ role: "system" })).toBe(0);
  });
});

describe("estimatePostCompactionTokens", () => {
  const msg = (chars: number) => ({ role: "user", content: "x".repeat(chars) });

  test("omits the estimate when there is nothing to calibrate against", () => {
    const projection = [msg(400), msg(400)];
    expect(estimatePostCompactionTokens({ projection, removed: [], summaryChars: 0, tokensBefore: 0 })).toBeUndefined();
    expect(estimatePostCompactionTokens({ projection, removed: [], summaryChars: 0, tokensBefore: undefined })).toBeUndefined();
    expect(estimatePostCompactionTokens({ projection: [], removed: [], summaryChars: 0, tokensBefore: 100 })).toBeUndefined();
  });

  test("rescales to the provider-measured size: removing everything leaves the summary", () => {
    // 2000 chars of projection, measured at 1000 tokens -> 2 chars/token in
    // effect, so a 200-char summary should come back as ~100 tokens.
    const projection = [msg(1000), msg(1000)];
    const observed = estimatePostCompactionTokens({
      projection, removed: projection, summaryChars: 200, tokensBefore: 1000,
    })!;
    expect(observed).toBe(100);
  });

  test("keeps an untouched projection at the measured size", () => {
    const projection = [msg(1000), msg(1000)];
    const observed = estimatePostCompactionTokens({
      projection, removed: [], summaryChars: 0, tokensBefore: 1000,
    })!;
    expect(observed).toBe(1000);
  });

  test("scales with the provider measurement", () => {
    const projection = [msg(800)];
    const at100 = estimatePostCompactionTokens({ projection, removed: [], summaryChars: 0, tokensBefore: 100 })!;
    const at400 = estimatePostCompactionTokens({ projection, removed: [], summaryChars: 0, tokensBefore: 400 })!;
    expect(at400).toBe(at100 * 4);
  });

  test("a larger summary yields a larger post-compaction estimate", () => {
    const projection = [msg(8000)];
    const small = estimatePostCompactionTokens({ projection, removed: [msg(4000)], summaryChars: 100, tokensBefore: 2000 })!;
    const large = estimatePostCompactionTokens({ projection, removed: [msg(4000)], summaryChars: 1000, tokensBefore: 2000 })!;
    expect(large).toBeGreaterThan(small);
  });

  test("never returns a negative size when the summary exceeds what was removed", () => {
    const projection = [msg(10)];
    const observed = estimatePostCompactionTokens({
      projection, removed: [msg(10)], summaryChars: 100_000, tokensBefore: 5,
    })!;
    expect(observed).toBeGreaterThanOrEqual(0);
  });
});
