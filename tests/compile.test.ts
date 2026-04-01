import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("compile", () => {
  it("returns empty string for no messages", () => {
    expect(compile({ messages: [] })).toBe("");
  });

  it("produces structured output from a conversation", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        toolResult("Read", "function login() {}"),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("[Files And Changes]");
    expect(r).toContain("auth.ts");
  });

  it("merges with previousSummary", () => {
    const r = compile({
      messages: [userMsg("continue")],
      previousSummary: "[Session Goal]\n- Original goal",
    });
    expect(r).toContain("[Session Goal]\n- Original goal");
    expect(r).toContain("[Delta Since Last Compaction]");
  });

  it("passes fileOps through to sections", () => {
    const r = compile({
      messages: [userMsg("check")],
      fileOps: { readFiles: ["config.ts"] },
    });
    expect(r).toContain("config.ts");
  });
});


