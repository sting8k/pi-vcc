import { describe, it, expect } from "bun:test";
import { renderMessage } from "../src/core/render-entries";
import type { Message } from "@mariozechner/pi-ai";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

describe("renderMessage", () => {
  it("renders user message", () => {
    const r = renderMessage(userMsg("hello"), 0);
    expect(r).toEqual({ index: 0, role: "user", summary: "hello" });
  });

  it("renders assistant text", () => {
    const r = renderMessage(assistantText("done"), 1);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("done");
  });

  it("renders tool result", () => {
    const r = renderMessage(toolResult("Read", "file contents"), 2);
    expect(r.role).toBe("tool_result");
    expect(r.summary).toContain("[Read]");
  });

  it("renders tool call arguments with values", () => {
    const r = renderMessage(assistantWithToolCall("Read", { path: "a.ts" }), 2);
    expect(r.summary).toContain("Read(path=a.ts)");
  });

  it("renders error tool result with prefix", () => {
    const r = renderMessage(toolResult("bash", "not found", true), 3);
    expect(r.summary).toStartWith("ERROR");
  });

  it("truncates long user text", () => {
    const long = "x".repeat(500);
    const r = renderMessage(userMsg(long), 0);
    expect(r.summary.length).toBeLessThanOrEqual(300);
  });

  it("renders bashExecution message", () => {
    const msg = { role: "bashExecution", command: "ls -la", output: "total 0\n" } as any;
    const r = renderMessage(msg, 5);
    expect(r.role).toBe("bash");
    expect(r.summary).toContain("$ ls -la");
    expect(r.summary).toContain("total 0");
  });

  it("renders bashExecution with missing output", () => {
    const msg = { role: "bashExecution", command: "exit 1" } as any;
    const r = renderMessage(msg, 6);
    expect(r.role).toBe("bash");
    expect(r.summary).toContain("$ exit 1");
  });

  it("handles message with undefined content", () => {
    const msg = { role: "assistant", content: undefined } as any;
    const r = renderMessage(msg, 3);
    expect(r.role).toBe("assistant");
    expect(r.summary).toBe("");
  });
});

