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

  it("produces hybrid output with header + brief transcript", () => {
    const r = compile({
      messages: [
        userMsg("Fix login bug"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        assistantText("Found the issue.\n1. Fix validation"),
      ],
    });
    expect(r).toContain("[Session Goal]");
    expect(r).toContain("Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("merges previous summary goals", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Session Goal]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r).toContain("- Original goal");
    expect(r).toContain("- New task");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Session Goal]\n- Original goal",
      "---",
      "[user]\nOriginal goal\n\n[assistant]\n* Read \"old.ts\"",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [
        userMsg("Next step"),
        assistantWithToolCall("Read", { path: "new.ts" }),
      ],
    });
    expect(r).toContain('* Read "old.ts"');
    expect(r).toContain('* Read "new.ts"');
    expect(r).toContain("Next step");
  });

  it("outstanding context is volatile (fresh only)", () => {
    const previousSummary = "[Outstanding Context]\n- old blocker\n\n---\n\n[user]\nhi";
    const r = compile({
      previousSummary,
      messages: [userMsg("continue")],
    });
    expect(r).not.toContain("old blocker");
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) =>
      `[user]\nmessage ${i}`
    ).join("\n\n");
    const previousSummary = `[Session Goal]\n- goal\n\n---\n\n${longTranscript}`;
    const r = compile({
      previousSummary,
      messages: [userMsg("latest")],
    });
    expect(r).toContain("earlier lines omitted");
    expect(r).toContain("latest");
  });

  it("wraps final output including recall note", () => {
    const r = compile({
      messages: [userMsg("check final summary wrapping")],
    });
    const maxLineLength = Math.max(...r.split("\n").map((line) => line.length));
    expect(r).toContain("vcc_recall");
    expect(maxLineLength).toBeLessThanOrEqual(120);
  });
});

describe("compile with trackCommands", () => {
  it("omits Commands Run by default even with real trackable commands", () => {
    const r = compile({
      messages: [userMsg("restart the backend"), assistantWithToolCall("bash", { command: "ssh prod-server 'docker restart web-frontend'" })],
    });
    expect(r).not.toContain("[Commands Run]");
  });

  it("includes Commands Run when explicitly enabled, including the nested ssh remote command", () => {
    const r = compile({
      messages: [userMsg("restart the backend"), assistantWithToolCall("bash", { command: "ssh prod-server 'docker restart web-frontend'" })],
      trackCommands: ["ssh", "docker"],
    });
    expect(r).toContain("[Commands Run]");
    expect(r).toContain("ssh: ssh prod-server");
    expect(r).toContain("docker: docker restart web-frontend");
  });

  it("merges Commands Run across compactions, deduping by command name", () => {
    const previousSummary = [
      "[Commands Run]\n- ssh: ssh prod-server | ssh staging-server",
      "---",
      "[user]\nfirst task",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("now check another host"), assistantWithToolCall("bash", { command: "ssh build-mac 'uptime'" })],
      trackCommands: ["ssh"],
    });
    expect(r).toContain("[Commands Run]");
    expect(r).toContain("ssh prod-server");
    expect(r).toContain("ssh staging-server");
    expect(r).toContain("ssh build-mac");
  });

  it("does not corrupt an entry containing a literal pipe-adjacent comma across a merge round-trip", () => {
    const previousSummary = [
      "[Commands Run]\n- kubectl: kubectl get pods,svc -n production",
      "---",
      "[user]\nfirst task",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("next")],
      trackCommands: ["kubectl"],
    });
    expect(r).toContain("kubectl get pods,svc -n production");
  });

  it("multiline bash blocks are captured through the full compile pipeline, not just the first line", () => {
    const r = compile({
      messages: [
        userMsg("deploy"),
        assistantWithToolCall("bash", { command: "cd /app\nssh prod-server 'docker restart web'\nkubectl get pods -n prod" }),
      ],
      trackCommands: ["ssh", "docker", "kubectl"],
    });
    expect(r).toContain("docker restart web");
    expect(r).toContain("kubectl get pods -n prod");
  });
});

describe("compile fileOps wiring", () => {
  it("renders hook-provided file ops in the summary", () => {
    // Guards the seam: CompileInput.fileOps -> buildSections -> extractFiles.
    // Without it the hook's authoritative read/modified sets are silently dropped.
    const out = compile({
      messages: [userMsg("check the config")],
      fileOps: { readFiles: ["src/only-from-hook.ts"], modifiedFiles: ["src/changed-by-hook.ts"] },
    });
    expect(out).toContain("only-from-hook.ts");
    expect(out).toContain("changed-by-hook.ts");
  });
});
