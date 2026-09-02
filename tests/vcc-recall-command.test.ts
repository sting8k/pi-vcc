import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerVccRecallCommand } from "../src/commands/vcc-recall";

// ── Helpers (mirrors tests/recall-quality.test.ts, adapted for the command's
//    sendMessage-based API instead of the tool's return-value API) ─────────

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

let dirCount = 0;
const makeSession = (n: number, textOf: (i: number) => string) => {
  const dir = mkdtempSync(join(tmpdir(), `pi-vcc-recall-command-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const lines = ids.map((id, i) => JSON.stringify(userMsg(id, textOf(i))));
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file, ids };
};

const register = () => {
  let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const sent: Array<{ customType: string; content: string; display: boolean }> = [];
  const pi = {
    registerCommand: (name: string, command: { handler: typeof handler }) => {
      expect(name).toBe("pi-vcc-recall");
      handler = command.handler;
    },
    sendMessage: (msg: any) => {
      sent.push(msg);
    },
  } as any;
  registerVccRecallCommand(pi);
  return { handler: handler!, sent };
};

const invoke = async (handler: (args: string, ctx: any) => Promise<void>, file: string, ids: string[], args: string) => {
  await handler(args, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => ids.map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
    ui: { notify: () => {} },
  });
};

describe("/pi-vcc-recall command pagination and hard-cap truncation signaling", () => {
  it("reports a capped page count and an explicit truncation message when raw hits exceed the cap", async () => {
    // "." makes this a regex-mode query, matching every one of the 60
    // messages deterministically (no BM25/floor involved) — isolates the
    // hard cap's effect on the command-facing message.
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry");

      expect(sent).toHaveLength(1);
      const content = sent[0].content;
      // 60 raw matches capped to 50 → 10 pages of 5.
      expect(content).toContain("Page 1/10");
      expect(content).toContain("50 total matches");
      // Truthful, neutral truncation signal (no "top" — regex hits aren't ranked).
      expect(content).toContain("showing 50 of 60 matches");
      expect(content).not.toContain("showing top");
      expect(content).toContain("refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not show a truncation message when raw hits are under the cap", async () => {
    const { dir, file, ids } = makeSession(3, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry");

      const content = sent[0].content;
      expect(content).toContain("3 matches");
      expect(content).not.toContain("showing");
      expect(content).not.toContain("refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an explicit out-of-range page (not a false 'No matches') using /pi-vcc-recall syntax, without duplicating 'refine your query'", async () => {
    // 60 raw matches capped to 50 → pages 1-10 exist. Page 11 has no rows to
    // slice, but hits.length (50) is > 0 — must not claim "No matches", and
    // since this IS a truncated result, the guidance must not repeat the
    // "refine your query" suggestion the truncation note already gave.
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry page:11");

      const content = sent[0].content;
      expect(content).toContain("Page 11 is outside the available range 1-10");
      expect(content).toContain("50 matches");
      expect(content).not.toContain("No matches");
      expect(content).toContain("/pi-vcc-recall");
      expect(content).toContain("page:N");
      // "refine your query" must appear exactly once (from the truncation
      // note), not again in the out-of-range guidance.
      expect(content.match(/refine your query/g)?.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps normal zero-hit behavior unchanged for an out-of-range page with no matches at all", async () => {
    const { dir, file, ids } = makeSession(3, (i) => `entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "NO_SUCH_MARKER_ANYWHERE page:5");

      const content = sent[0].content;
      expect(content).toContain("No matches");
      expect(content).not.toContain("is outside the available range");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries the scope:all label through an out-of-range page response", async () => {
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const { handler, sent } = register();
      await invoke(handler, file, ids, "zebra_query_tag.*entry scope:all page:11");

      const content = sent[0].content;
      expect(content).toContain("(scope: all)");
      expect(content).toContain("scope:all");
      expect(content).toContain("Page 11 is outside the available range 1-10");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Issue #1: a brand-new session has no JSONL on disk yet.
describe("/pi-vcc-recall in a fresh session with no session file on disk", () => {
  const freshSessionFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-fresh-"));
    return { dir, file: join(dir, "sessions", "not-written-yet.jsonl") };
  };

  it("no-query path answers with the empty-history message instead of throwing ENOENT", async () => {
    const { dir, file } = freshSessionFile();
    try {
      const { handler, sent } = register();
      await invoke(handler, file, [], "");

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe("No entries in session history.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("query path answers with the no-match message instead of throwing ENOENT", async () => {
    const { dir, file } = freshSessionFile();
    try {
      const { handler, sent } = register();
      await invoke(handler, file, [], "redis cache decision");

      expect(sent).toHaveLength(1);
      expect(sent[0].content).toBe('No matches for "redis cache decision" in session history.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
