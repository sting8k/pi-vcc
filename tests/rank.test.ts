import { describe, expect, it } from "bun:test";
import { compile, compileRanked } from "../src/core/summarize";
import { rankBriefBlocks, selectRankedBriefBlocks } from "../src/core/rank";
import { compileBrief } from "../src/core/brief";
import type { NormalizedBlock } from "../src/types";
import { assistantText, assistantWithToolCall, userMsg } from "./fixtures";

const briefPart = (summary: string): string => summary.split("\n\n---\n\n")[1] ?? "";

describe("section-aware brief ranking prototype", () => {
  it("scores structural edit/test events above read-only exploration", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "bash", args: { command: "bun test tests/auth.test.ts" } },
    ];

    const ranked = rankBriefBlocks(blocks);
    const read = ranked.find((r) => r.block.kind === "tool_call" && r.block.name === "Read")!;
    const edit = ranked.find((r) => r.block.kind === "tool_call" && r.block.name === "Edit")!;
    const test = ranked.find((r) => r.block.kind === "tool_call" && r.block.name === "bash")!;

    expect(edit.score).toBeGreaterThan(read.score);
    expect(test.score).toBeGreaterThan(read.score);
    expect(edit.reasons).toContain("edit-tool");
    expect(test.reasons).toContain("test-command");
  });

  it("penalizes scaffolding-only bash so it ranks below substantive commands", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "set -euo pipefail\ncd /tmp/proj\nls -la", exitCode: 0 },
      { kind: "bash", command: "set -euo pipefail\ngit commit -m \"fix\"\ngit push", exitCode: 0 },
    ];
    const ranked = rankBriefBlocks(blocks);
    const scaffold = ranked[0];
    const work = ranked[1];
    expect(scaffold.reasons).toContain("trivial-bash");
    expect(work.reasons).not.toContain("trivial-bash");
    expect(work.score).toBeGreaterThan(scaffold.score);
  });

  it("does not penalize a real command hidden after a stray '<<' with no terminator", () => {
    const blocks: NormalizedBlock[] = [
      // `<<NOTE` has no closing `NOTE` line, so it must not be treated as a
      // heredoc opener that swallows the git commit below into a skipped body.
      { kind: "bash", command: "echo \"see <<NOTE for details\"\ngit commit -m fix", exitCode: 0 },
    ];
    const ranked = rankBriefBlocks(blocks);
    expect(ranked[0].reasons).not.toContain("trivial-bash");
  });

  it("does not penalize a scaffolding command that failed (nonzero exit is a real fact)", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "cd /tmp/missing", exitCode: 1 },
    ];
    const ranked = rankBriefBlocks(blocks);
    expect(ranked[0].reasons).not.toContain("trivial-bash");
    expect(ranked[0].reasons).toContain("nonzero-exit");
  });

  it("selects ranked blocks chronologically after scoring", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Read", args: { file_path: "noise-a.ts" } },
      { kind: "tool_call", name: "Read", args: { file_path: "noise-b.ts" } },
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "bash", args: { command: "bun test tests/auth.test.ts" } },
    ];

    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 4, preserveRecentBlocks: 1 });

    expect(selected).toEqual([
      blocks[2],
      blocks[3],
      blocks[4],
      blocks[5],
    ]);
  });

  it("boosts non-trivial assistant turns that close a user segment", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "I'll inspect this now." },
      { kind: "tool_call", name: "Read", args: { file_path: "noise-a.ts" } },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_call", name: "bash", args: { command: "bun test tests/auth.test.ts" } },
      {
        kind: "assistant",
        text: "Implemented the auth fix, verified the focused auth test, confirmed the changed file is limited to src/auth.ts, and no follow-up blockers remain for this task.",
      },
      { kind: "user", text: "ok next" },
    ];
    const ranked = rankBriefBlocks(blocks);
    const report = ranked.find((r) => r.block === blocks[5])!;
    const chatter = ranked.find((r) => r.block === blocks[1])!;

    expect(report.reasons).toContain("segment-closing-assistant");
    expect(chatter.reasons).not.toContain("segment-closing-assistant");
    expect(report.score).toBeGreaterThan(chatter.score);
  });

  it("does not spend ranked selection budget on tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix auth bug" },
      { kind: "assistant", text: "Root cause is stale token refresh." },
      { kind: "tool_call", name: "Edit", args: { file_path: "src/auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "large hidden tool output".repeat(200) },
      { kind: "tool_result", name: "bash", text: "more hidden output".repeat(200) },
    ];

    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 4, preserveRecentBlocks: 2 });

    expect(selected).toContain(blocks[0]);
    expect(selected).toContain(blocks[1]);
    expect(selected).toContain(blocks[2]);
    expect(selected).not.toContain(blocks[3]);
    expect(selected).not.toContain(blocks[4]);
  });

  it("deduplicates repeated gh PR polling commands", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Merge PR 123 when green" },
      { kind: "tool_call", name: "bash", args: { command: "gh pr view 123 --json mergeStateStatus" } },
      { kind: "tool_call", name: "bash", args: { command: "gh pr checks 123 --watch" } },
      { kind: "tool_call", name: "bash", args: { command: "gh pr merge 123 --squash --delete-branch" } },
    ];
    const selected = selectRankedBriefBlocks(blocks, { maxBlocks: 3, preserveRecentBlocks: 0 });
    const pollCount = selected.filter((block) =>
      block.kind === "tool_call"
        && /^bash$/i.test(block.name)
        && typeof block.args.command === "string"
        && /gh pr (?:view|checks) 123/.test(block.args.command),
    ).length;

    expect(pollCount).toBeLessThanOrEqual(1);
    expect(selected).toContain(blocks[3]);
  });

  it("compileRanked reduces brief noise while keeping semantic sections from all blocks", () => {
    const exploration = Array.from({ length: 15 }, (_, i) => [
      userMsg(`look around ${i}`),
      assistantWithToolCall("Read", { file_path: `noise${i}.ts` }),
    ]).flat();
    const critical = [
      userMsg("Fix auth bug"),
      assistantText("Root cause is stale token refresh."),
      assistantWithToolCall("Edit", { file_path: "src/auth.ts" }),
      assistantWithToolCall("bash", { command: "bun test tests/auth.test.ts" }),
      assistantText("Fixed auth bug and tests passed."),
    ];

    const baseline = compile({ messages: [...exploration, ...critical] });
    const ranked = compileRanked({
      messages: [...exploration, ...critical],
      ranking: { maxBlocks: 10, preserveRecentBlocks: 4 },
    });

    expect(ranked.length).toBeLessThan(baseline.length);
    expect(ranked).toContain("[User Messages]");
    expect(ranked).toContain("Fix auth bug");
    expect(ranked).toContain('* Edit "src/auth.ts"');
    expect(ranked).toContain('* bash "bun test tests/auth.test.ts"');
    expect(briefPart(ranked)).not.toContain('Read "noise0.ts"');
  });

  it("keeps fresh ranked brief and gives previous brief the remaining budget", () => {
    const previousBrief = Array.from({ length: 200 }, (_, i) => `[user]\nold context ${i}`).join("\n\n");
    const previousSummary = `[Early Session Requests]\n- Original goal\n\n---\n\n${previousBrief}`;
    const ranked = compileRanked({
      previousSummary,
      messages: [
        userMsg("Fix fresh ranked bug"),
        assistantText("Fresh ranked root cause should survive merge."),
        assistantWithToolCall("Edit", { file_path: "src/fresh.ts" }),
        assistantWithToolCall("bash", { command: "bun test tests/fresh.test.ts" }),
        assistantText("Fresh ranked fix passed tests."),
      ],
      ranking: { maxBlocks: 5, preserveRecentBlocks: 2 },
    });

    expect(ranked).toContain("Fresh ranked root cause should survive merge.");
    expect(ranked).toContain('* Edit "src/fresh.ts"');
    expect(ranked).toContain('* bash "bun test tests/fresh.test.ts"');
    expect(ranked).toContain("Fresh ranked fix passed tests.");
    expect(ranked).toContain("old context 199");
    expect(ranked).not.toContain("old context 0");
  });

  it("charges preserve-recent blocks against the char budget so large recent runs cannot blow past it", () => {
    // Regression: on very long transcripts the newest blocks alone could exceed
    // maxBriefChars because preserve-recent was added unconditionally. They must
    // now be charged against the budget (iterating newest-first) and skipped once full.
    const blocks: NormalizedBlock[] = Array.from({ length: 8 }, (_, i) => ({
      kind: "assistant" as const,
      text: `recent block ${i} ` + "x".repeat(1200),
    }));
    const maxBriefChars = 3000;

    const selected = selectRankedBriefBlocks(blocks, {
      maxBlocks: 80,
      preserveRecentBlocks: 8, // ask to preserve every block
      maxBriefChars,
    });
    const rendered = compileBrief(selected);

    // Budget is a true ceiling even though all candidates are "recent" blocks.
    expect(rendered.length).toBeLessThanOrEqual(maxBriefChars);
    // Newest block is always kept (recency preserved).
    expect(selected).toContain(blocks[7]);
    // ...but not everything fits, so oldest recent blocks are dropped.
    expect(selected).not.toContain(blocks[0]);
    expect(selected.length).toBeLessThan(blocks.length);
  });

  it("keeps the ranked brief within the char budget even when recent turns are huge", () => {
    const huge = Array.from({ length: 10 }, (_, i) =>
      assistantText(`huge recent turn ${i} ` + "y".repeat(900)),
    );
    const maxBriefChars = 3000;

    const ranked = compileRanked({
      messages: [userMsg("start a big task"), ...huge],
      ranking: { maxBlocks: 80, preserveRecentBlocks: 10, maxBriefChars },
    });
    const brief = briefPart(ranked);

    // Without the fix this brief would be ~9000+ chars; the budget caps it.
    // Small slack covers the "...omitted" marker and line-wrap newlines.
    expect(brief.length).toBeLessThanOrEqual(maxBriefChars + 400);
    expect(brief.length).toBeGreaterThan(0);
  });

  it("scales the char budget with transcript length between floor and ceiling", () => {
    // Size-relative budget: clamp(briefCharsPerBlock * blockCount, floor, ceiling).
    const mkBlocks = (n: number): NormalizedBlock[] =>
      Array.from({ length: n }, (_, i) => ({ kind: "assistant" as const, text: `block ${i} ` + "x".repeat(300) }));
    const opts = { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400, maxBriefCharsCeiling: 8000, briefCharsPerBlock: 60 };

    // Small transcript (10 blocks -> 600 < floor): pinned at the floor.
    const small = compileBrief(selectRankedBriefBlocks(mkBlocks(10), opts));
    expect(small.length).toBeLessThanOrEqual(4400);

    // Mid transcript (100 blocks -> 6000, between floor and ceiling): exceeds the floor.
    const mid = compileBrief(selectRankedBriefBlocks(mkBlocks(100), opts));
    expect(mid.length).toBeGreaterThan(4400);
    expect(mid.length).toBeLessThanOrEqual(6000);

    // Huge transcript (400 blocks -> 24000, clamped): never exceeds the ceiling.
    const huge = compileBrief(selectRankedBriefBlocks(mkBlocks(400), opts));
    expect(huge.length).toBeLessThanOrEqual(8000);
    expect(huge.length).toBeGreaterThan(mid.length);
  });

  it("ignores the size-relative ceiling unless slope and floor are both set", () => {
    // Ceiling alone must not change behavior: falls back to the flat maxBriefChars.
    const blocks: NormalizedBlock[] = Array.from({ length: 200 }, (_, i) => ({
      kind: "assistant" as const,
      text: `block ${i} ` + "x".repeat(300),
    }));
    const flat = compileBrief(selectRankedBriefBlocks(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400 }));
    const ceilOnly = compileBrief(
      selectRankedBriefBlocks(blocks, { maxBlocks: 500, preserveRecentBlocks: 0, maxBriefChars: 4400, maxBriefCharsCeiling: 8000 }),
    );
    expect(ceilOnly.length).toBe(flat.length);
    expect(flat.length).toBeLessThanOrEqual(4400);
  });
});
