import { describe, it, expect } from "bun:test";
import { normalize } from "../src/core/normalize";
import {
  userMsg,
  assistantText,
  assistantWithThinking,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("normalize", () => {
  it("returns empty for empty input", () => {
    expect(normalize([])).toEqual([]);
  });

  it("normalizes user message (string content)", () => {
    const blocks = normalize([userMsg("fix the bug")]);
    expect(blocks).toEqual([{ kind: "user", text: "fix the bug" }]);
  });

  it("normalizes assistant text message", () => {
    const blocks = normalize([assistantText("done")]);
    expect(blocks).toEqual([{ kind: "assistant", text: "done" }]);
  });

  it("splits assistant thinking + text", () => {
    const blocks = normalize([assistantWithThinking("result", "hmm")]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      kind: "thinking", text: "hmm", redacted: false,
    });
    expect(blocks[1]).toEqual({ kind: "assistant", text: "result" });
  });

  it("normalizes tool call", () => {
    const blocks = normalize([assistantWithToolCall("Read", { path: "a.ts" })]);
    expect(blocks).toEqual([{
      kind: "tool_call", name: "Read", args: { path: "a.ts" },
    }]);
  });

  it("normalizes tool result", () => {
    const blocks = normalize([toolResult("Read", "file contents")]);
    expect(blocks).toEqual([{
      kind: "tool_result", name: "Read",
      text: "file contents", isError: false,
    }]);
  });

  it("normalizes error tool result", () => {
    const blocks = normalize([toolResult("Edit", "not found", true)]);
    expect(blocks[0]).toMatchObject({
      kind: "tool_result", isError: true,
    });
  });

  it("handles mixed message sequence", () => {
    const blocks = normalize([
      userMsg("fix it"),
      assistantWithToolCall("Read", { path: "x.ts" }),
      toolResult("Read", "code"),
      assistantText("done"),
    ]);
    expect(blocks).toHaveLength(4);
    expect(blocks.map((b) => b.kind)).toEqual([
      "user", "tool_call", "tool_result", "assistant",
    ]);
  });
});


