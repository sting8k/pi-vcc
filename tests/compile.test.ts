import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

// A section's body, with wrapped lines (wrapLongLines, 120 chars) rejoined.
const sectionOf = (s: string, h: string) =>
  (s.match(new RegExp(`\\[${h}\\]\\n([\\s\\S]*?)(?=\\n\\n|$)`))?.[1] ?? "").replace(/\n[ \t]+/g, " ");

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
    expect(r).toContain("[User Messages]\n- Fix login bug");
    expect(r).toContain("---");
    expect(r).toContain("[user]\nFix login bug");
    expect(r).toContain('* Read "auth.ts"');
    expect(r).toContain("Found the issue.");
  });

  it("drops early requests from an older version; new requests are user messages", () => {
    const r = compile({
      messages: [userMsg("New task")],
      previousSummary: "[Early Session Requests]\n- Original goal\n\n---\n\n[user]\nOriginal goal",
    });
    expect(r.startsWith("[User Messages]\n- New task\n")).toBe(true);
    expect(r).not.toContain("[Early Session Requests]");
  });

  it("appends brief transcript on merge", () => {
    const previousSummary = [
      "[Early Session Requests]\n- Original goal",
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

  it("reads a summary written by an older version", () => {
    const previousSummary = [
      "[Session Goal]\n- [skill: tdd]\n- Original goal\n- [Scope change]\n- old scope",
      "[Commits]\n- abc1234: first",
      "[Outstanding Context]\n- old blocker",
      "[User Preferences]\n- always use tabs",
    ].join("\n\n") + "\n\n---\n\n[user]\nhi";
    const r = compile({ previousSummary, messages: [userMsg("continue please")] });
    expect(r.slice(0, r.indexOf("\n\n---\n\n"))).toBe(
      "[Commits]\n- abc1234: first\n\n[User Messages]\n- continue please",
    );
  });

  it("user messages keep the newest, and a repeated message moves to the end", () => {
    let summary = compile({ messages: [userMsg("the first goal")] });
    for (let i = 1; i <= 20; i++) summary = compile({ previousSummary: summary, messages: [userMsg(`step number ${i}`)] });
    summary = compile({ previousSummary: summary, messages: [userMsg("step number 10")] });
    const items = sectionOf(summary, "User Messages").split("\n");
    expect(items).toHaveLength(15);
    expect(items[0]).toBe("- step number 6");
    expect(items.at(-1)).toBe("- step number 10");
    expect(items).not.toContain("- the first goal"); // rolled out like any other message
  });

  it("caps long brief transcript with rolling window", () => {
    // Build a very long previous transcript
    const longTranscript = Array.from({ length: 200 }, (_, i) =>
      `[user]\nmessage ${i}`
    ).join("\n\n");
    const previousSummary = `[Early Session Requests]\n- goal\n\n---\n\n${longTranscript}`;
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

describe("compile merge of wrapped header sections", () => {
  it("keeps files on wrapped lines when the new turn also edits", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/some/deeply/nested/module-${i}/implementation-${i}.ts`);
    const first = compile({
      messages: [userMsg("edit"), ...paths.map((path) => assistantWithToolCall("edit", { path, edits: [] }))],
    });
    expect(first).toMatch(/\[Files And Changes\]\n.*\n  \S/); // really wrapped
    const r = compile({
      previousSummary: first,
      messages: [userMsg("next"), assistantWithToolCall("edit", { path: "src/new-file.ts", edits: [] })],
    });
    const files = sectionOf(r, "Files And Changes");
    for (let i = 0; i < 8; i++) expect(files).toContain(`implementation-${i}.ts`);
  });

  it("keeps the tail of a wrapped user message", () => {
    const goal =
      "Please migrate the billing service from the legacy cron scheduler to the new queue workers and keep the retry semantics identical for failed invoices";
    const first = compile({ messages: [userMsg(goal)] });
    expect(first).toMatch(/\[User Messages\]\n.*\n  \S/); // really wrapped
    const r = compile({ previousSummary: first, messages: [userMsg("also update the README for the queue workers")] });
    expect(sectionOf(r, "User Messages")).toContain(goal);
  });

  it("keeps wrapped items of the new turn", () => {
    // The fresh summary is wrapped before the merge too. Both sides need the
    // section: with one side empty the merge returns the other unchanged.
    const goal =
      "Please migrate the billing service from the legacy cron scheduler to the new queue workers and keep the retry semantics identical for failed invoices";
    const paths = Array.from({ length: 8 }, (_, i) => `src/some/deeply/nested/module-${i}/implementation-${i}.ts`);
    const first = compile({
      messages: [userMsg("set up the project"), userMsg("add a CI config"), assistantWithToolCall("edit", { path: "a.ts", edits: [] })],
    });
    const r = compile({
      previousSummary: first,
      messages: [userMsg(goal), ...paths.map((path) => assistantWithToolCall("edit", { path, edits: [] }))],
    });
    expect(sectionOf(r, "User Messages")).toContain(goal);
    const files = sectionOf(r, "Files And Changes");
    for (let i = 0; i < 8; i++) expect(files).toContain(`implementation-${i}.ts`);
  });
});

describe("compile with trackCommands", () => {
  it("omits Tracked Commands by default even with real trackable commands", () => {
    const r = compile({
      messages: [userMsg("restart the backend"), assistantWithToolCall("bash", { command: "ssh prod-server 'docker restart web-frontend'" })],
    });
    expect(r).not.toContain("[Tracked Commands]");
  });

  it("includes Tracked Commands when explicitly enabled, including the nested ssh remote command", () => {
    const r = compile({
      messages: [userMsg("restart the backend"), assistantWithToolCall("bash", { command: "ssh prod-server 'docker restart web-frontend'" })],
      trackCommands: ["ssh", "docker"],
    });
    expect(r).toContain("[Tracked Commands]");
    expect(r).toContain("ssh: ssh prod-server");
    expect(r).toContain("docker: docker restart web-frontend");
  });

  it("merges Tracked Commands across compactions, deduping by command name", () => {
    const previousSummary = [
      "[Tracked Commands]\n- ssh: ssh prod-server | ssh staging-server",
      "---",
      "[user]\nfirst task",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("now check another host"), assistantWithToolCall("bash", { command: "ssh build-mac 'uptime'" })],
      trackCommands: ["ssh"],
    });
    expect(r).toContain("[Tracked Commands]");
    expect(r).toContain("ssh prod-server");
    expect(r).toContain("ssh staging-server");
    expect(r).toContain("ssh build-mac");
  });

  it("does not corrupt an entry containing a literal pipe-adjacent comma across a merge round-trip", () => {
    const previousSummary = [
      "[Tracked Commands]\n- kubectl: kubectl get pods,svc -n production",
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

  it("merge round-trip: a prev '(+N earlier)' marker never becomes a fake entry", () => {
    const previousSummary = [
      "[Tracked Commands]\n- ssh: (+10 earlier) ssh host9 | ssh host10",
      "---",
      "[user]\nfirst task",
    ].join("\n\n");
    const r = compile({
      previousSummary,
      messages: [userMsg("next"), assistantWithToolCall("bash", { command: "ssh newhost" })],
      trackCommands: ["ssh"],
    });
    expect(r).toContain("ssh newhost");
    expect(r).not.toMatch(/earlier\) ssh/); // marker must not merge in as an entry
  });

  it("merge round-trip keeps entries on wrapped continuation lines", () => {
    // The stored summary goes through wrapLongLines, so a long section line
    // comes back split over indented continuation lines.
    const cmds = Array.from({ length: 6 }, (_, i) => `docker logs --tail 200 service-${i}-with-a-long-name`);
    const first = compile({
      messages: [userMsg("check logs"), ...cmds.map((command) => assistantWithToolCall("bash", { command }))],
      trackCommands: ["docker"],
    });
    expect(first).toMatch(/\n  \S.*service-5/); // really wrapped
    // The new turn must also have a docker entry: that is what forces a re-parse.
    const r = compile({
      previousSummary: first,
      messages: [userMsg("next"), assistantWithToolCall("bash", { command: "docker ps" })],
      trackCommands: ["docker"],
    });
    // Look in the section only: the brief transcript also lists the commands.
    const section = (r.match(/\[Tracked Commands\]\n([\s\S]*?)(?=\n\n|$)/)?.[1] ?? "").replace(/\n[ \t]+/g, " ");
    for (const c of cmds) expect(section).toContain(c);
  });

  it("merge round-trip keeps entries that contain ' | ' whole", () => {
    const cmds = Array.from({ length: 10 }, (_, i) => `ssh host${i} 'docker ps | head -1'`);
    const first = compile({
      messages: [userMsg("check"), ...cmds.map((command) => assistantWithToolCall("bash", { command }))],
      trackCommands: ["ssh"],
    });
    const r = compile({
      previousSummary: first,
      messages: [userMsg("next"), assistantWithToolCall("bash", { command: "ssh newhost uptime" })],
      trackCommands: ["ssh"],
    });
    const section = (r.match(/\[Tracked Commands\]\n([\s\S]*?)(?=\n\n|$)/)?.[1] ?? "").replace(/\n[ \t]+/g, " ");
    expect(section).toContain("(+1 earlier)"); // 11 commands, not fragments
    for (let i = 1; i < 10; i++) expect(section).toContain(`ssh host${i} 'docker ps \\| head -1'`);
    expect(section).toContain("ssh newhost uptime");
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

describe("compile: header sections are read from the header area only", () => {
  const headerArea = (s: string) => s.slice(0, s.indexOf("\n\n---\n\n"));
  // A transcript line that starts like a header but is not one.
  const lookalike = "[Tracked Commands], the --- separators are the hint for the model";

  it("a transcript line starting with a header name never becomes a section", () => {
    let summary: string | undefined;
    for (let round = 1; round <= 3; round++) {
      summary = compile({
        previousSummary: summary,
        messages: [userMsg(`round ${round} question`), assistantText(round === 1 ? lookalike : `round ${round} answer`)],
      });
    }
    expect(headerArea(summary!)).not.toContain("Tracked Commands");
    expect(summary!.split(lookalike)).toHaveLength(2);
  });

  it("drops lookalike lines copied into the header area by an older version, without leaking into Commits", () => {
    const previousSummary = [
      "[Commits]\n- abc1234: first",
      `${lookalike}\n- a bullet of that copied transcript`,
      "[User Messages]\n- old request",
    ].join("\n\n") + "\n\n---\n\n[user]\nold request";
    const out = compile({ previousSummary, messages: [assistantText("ok")] });
    expect(headerArea(out)).toBe("[Commits]\n- abc1234: first\n\n[User Messages]\n- old request");
  });
});

describe("compile: Commits across compactions", () => {
  const commit = (message: string, output: string) => [
    assistantWithToolCall("bash", { command: `git commit -m "${message}"` }),
    toolResult("bash", output),
  ];
  const prevWith = (lines: string[]) => `[Commits]\n${lines.join("\n")}\n\n---\n\n[user]\nhi`;

  it("keeps one line per commit when only one side captured the hash, preferring the hashed line", () => {
    // Hashed fresh line replaces the hashless one in place.
    const hashedLater = compile({
      previousSummary: prevWith(["- docs: X", "- aaaaaaa: other"]),
      messages: [userMsg("next"), ...commit("docs: X", "[main 3cc34cc] docs: X")],
    });
    expect(sectionOf(hashedLater, "Commits")).toBe("- 3cc34cc: docs: X\n- aaaaaaa: other");
    // Hashless fresh line adds nothing next to the hashed one already kept.
    const hashlessLater = compile({
      previousSummary: prevWith(["- 3cc34cc: docs: X", "- aaaaaaa: other"]),
      messages: [userMsg("next"), ...commit("docs: X", "nothing to report")],
    });
    expect(sectionOf(hashlessLater, "Commits")).toBe("- 3cc34cc: docs: X\n- aaaaaaa: other");
  });

  it("keeps two commits that share a message but not a hash, newest 8", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `- ${String(i).repeat(7)}: commit ${i}`);
    const out = compile({
      previousSummary: prevWith([...lines, "- 1234567: commit 8"]),
      messages: [userMsg("next"), ...commit("commit 8", "[main 7654321] commit 8")],
    });
    expect(sectionOf(out, "Commits").split("\n")).toEqual([...lines.slice(3), "- 1234567: commit 8", "- 7654321: commit 8"]);
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

describe("compile: the recall note across compactions", () => {
  const notes = (s: string) => s.match(/Use `vcc_recall` to search/g)?.length ?? 0;

  it("keeps exactly one note, at the end, after repeated compactions", () => {
    let summary: string | undefined;
    for (let round = 1; round <= 3; round++) {
      summary = compile({
        messages: [userMsg(`round ${round} question`), assistantText(`round ${round} answer`)],
        previousSummary: summary,
      });
      expect(notes(summary)).toBe(1);
      expect(summary.trimEnd().endsWith("Do not redo work already\ncompleted.")).toBe(true);
    }
    expect(summary).toContain("round 1 question");
    expect(summary).toContain("round 3 answer");
  });

  it("cleans notes stacked inside a summary written by an older version", () => {
    const note = "---\n\nUse `vcc_recall` to search for prior work, decisions, and context from before this summary. Do not redo work already\ncompleted.";
    const stacked = `[Early Session Requests]\n- fix the bucket\n\n---\n\n[user]\nfix the bucket\n\n${note}\n\n[assistant]\ndone\n\n${note}`;
    const out = compile({ messages: [userMsg("next"), assistantText("ok")], previousSummary: stacked });
    expect(notes(out)).toBe(1);
    expect(out).toContain("[user]\nfix the bucket\n\n[assistant]\ndone");
  });

  describe("file lists follow recent work", () => {
    const touch = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => assistantWithToolCall("Edit", { path: `/repo/src/f${from + i}.ts` }));

    it("keeps the newest files with an earlier-count marker on a first compaction", () => {
      const r = compile({ messages: [userMsg("work"), ...touch(15)] });
      expect(r).toContain("(+5 earlier)");
      expect(r).toContain("f14.ts");
      expect(r).not.toContain("f4.ts");
    });

    it("keeps adding new files across merges instead of freezing on the first ones", () => {
      const first = compile({ messages: [userMsg("work"), ...touch(10)] });
      const second = compile({ messages: [userMsg("more"), ...touch(10, 10)], previousSummary: first });
      expect(second).toContain("f19.ts");
      expect(second).toContain("(+10 earlier)");
      expect(second).not.toContain("f0.ts");
    });

    it("moves a re-edited file back to the newest end", () => {
      const first = compile({ messages: [userMsg("work"), ...touch(10)] });
      const second = compile({
        messages: [userMsg("more"), ...touch(1, 0), ...touch(5, 10)],
        previousSummary: first,
      });
      expect(second).toContain("f0.ts");
      expect(second).not.toContain("f1.ts");
    });

    // Summaries written before this fix end the list with "(+N more)".
    it("drops the old (+N more) marker when merging a summary from an older version", () => {
      const old = "[Files And Changes]\n- Modified: src/a.ts, src/b.ts (+7 more)";
      const out = compile({ messages: [userMsg("more"), ...touch(1, 50)], previousSummary: old });
      expect(out).toContain("- Modified: src/a.ts, src/b.ts, /repo/src/f50.ts");
      expect(out).not.toContain("more)");
    });
  });
});
