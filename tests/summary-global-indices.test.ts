/**
 * Summary references must use session-global `#N` indices (the recall index
 * space), not the selected window's zero-based positions.
 *
 * Regression tests for issue #28: normalization numbered the compaction
 * window from zero while recall counts every message in the session file,
 * so second-cycle summaries retrieved unrelated operations (or failed
 * lineage checks after branching). Ported from k0valik/pi-blackhole
 * commit f82e07a, adapted to this repo's harness (bun:test).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildGlobalIndexById,
  isCountedMessageEntry,
  loadGlobalIndexById,
} from "../src/core/global-indices";
import { normalize } from "../src/core/normalize";
import { compile } from "../src/core/summarize";
import {
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact";
import { userMsg, assistantWithToolCall, toolResult } from "./fixtures";

let tmpDir: string;
let CONFIG_PATH: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-gidx-"));
  CONFIG_PATH = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = CONFIG_PATH;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => setConfig({ debug: false, overrideDefaultCompaction: false }));
afterEach(() => {
  if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
});

function setConfig(cfg: Record<string, unknown>) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg));
}

// ── global-indices unit ─────────────────────────────────────────────────

describe("buildGlobalIndexById", () => {
  test("counts only message entries in order", () => {
    const entries = [
      { type: "session", id: "header" },
      { id: "m1", type: "message", message: { role: "user" } },
      { id: "c1", type: "compaction", firstKeptEntryId: "" },
      { id: "x1", type: "custom_message", customType: "ext.foo" },
      { id: "m2", type: "message", message: { role: "assistant" } },
      { id: "m3", type: "message", message: { role: "toolResult" } },
    ];
    const map = buildGlobalIndexById(entries);
    expect(map.get("m1")).toBe(0);
    expect(map.get("m2")).toBe(1);
    expect(map.get("m3")).toBe(2);
    expect(map.has("c1")).toBe(false);
    expect(map.has("x1")).toBe(false);
  });

  test("drops duplicate ids fail-closed but still advances positions", () => {
    const entries = [
      { id: "a", type: "message", message: { role: "user" } },
      { id: "a", type: "message", message: { role: "assistant" } },
      { id: "b", type: "message", message: { role: "assistant" } },
    ];
    const map = buildGlobalIndexById(entries);
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
  });

  test("entries without ids still occupy an index", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { id: "x", type: "message", message: { role: "assistant" } },
    ];
    expect(buildGlobalIndexById(entries).get("x")).toBe(1);
  });

  test("isCountedMessageEntry requires a message payload", () => {
    expect(isCountedMessageEntry({ type: "message", message: {} })).toBe(true);
    expect(isCountedMessageEntry({ type: "message" })).toBe(false);
    expect(isCountedMessageEntry({ type: "compaction" })).toBe(false);
    expect(isCountedMessageEntry(null)).toBe(false);
  });
});

describe("loadGlobalIndexById (streaming file fallback)", () => {
  test("counts message entries in file order across non-message lines", () => {
    const file = join(tmpDir, "session.jsonl");
    const lines = [
      { type: "session", id: "h" },
      { id: "m1", type: "message", message: { role: "user" } },
      { id: "c1", type: "compaction", firstKeptEntryId: "" },
      "not-json{{{",
      { id: "m2", type: "message", message: { role: "assistant" } },
    ];
    writeFileSync(file, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
    const map = loadGlobalIndexById(file);
    expect(map?.get("m1")).toBe(0);
    expect(map?.get("m2")).toBe(1);
    expect(map?.has("c1")).toBe(false);
  });

  test("returns undefined for a missing file", () => {
    expect(loadGlobalIndexById(join(tmpDir, "does-not-exist.jsonl"))).toBeUndefined();
  });
});

// ── normalize / compile threading ───────────────────────────────────────

describe("normalize with explicit sourceIndices", () => {
  test("uses global indices instead of window positions", () => {
    const blocks = normalize(
      [userMsg("inspect"), assistantWithToolCall("edit", { file_path: "beta.txt" })],
      [3, 4],
    );
    expect(blocks.map((b) => b.sourceIndex)).toEqual([3, 4]);
  });

  test("a missing entry yields no sourceIndex (fail-closed, not positional)", () => {
    const blocks = normalize(
      [userMsg("inspect"), assistantWithToolCall("edit", { file_path: "beta.txt" })],
      [3, undefined],
    );
    expect(blocks[0].sourceIndex).toBe(3);
    expect(blocks[1].sourceIndex).toBeUndefined();
  });

  test("omitted indices preserve the legacy positional behavior", () => {
    const blocks = normalize([userMsg("a"), userMsg("b")]);
    expect(blocks.map((b) => b.sourceIndex)).toEqual([0, 1]);
  });
});

describe("compile with sourceIndices", () => {
  test("emits the global ref for a second-window edit", () => {
    const summary = compile({
      messages: [
        userMsg("Modify the beta fixture"),
        assistantWithToolCall("edit", { file_path: "beta.txt" }),
        toolResult("edit", "done"),
      ],
      sourceIndices: [3, 4, 5],
    });
    expect(summary).toContain('* edit "beta.txt" (#4)');
    expect(summary).not.toContain('* edit "beta.txt" (#1)');
  });
});

// ── hook boundary: second compaction + branching ────────────────────────

const msgEntry = (id: string, message: unknown) => ({ id, type: "message", message });
const compactionEntry = (id: string, firstKeptEntryId: string) => ({
  id,
  type: "compaction",
  firstKeptEntryId,
  summary: "prior summary",
});
const customEntry = (id: string, content: string) => ({
  id,
  type: "custom_message",
  customType: "ext.inject",
  content,
  display: false,
  timestamp: "2026-01-01T00:00:00.000Z",
});

function hookHarness(allEntries: any[] | undefined) {
  let handler: ((event: any, ctx: any) => any) | undefined;
  const pi = {
    on: (name: string, h: (e: any, c: any) => any) => {
      if (name === "session_before_compact") handler = h;
    },
  } as any;
  const ctx = {
    cwd: "/synthetic",
    hasUI: true,
    ui: { notify: () => {} },
    // When undefined, exercises the fail-closed path (no refs at all).
    sessionManager: allEntries === undefined ? undefined : { getEntries: () => allEntries },
  };
  registerBeforeCompactHook(pi, "0.84.4");
  if (!handler) throw new Error("hook not registered");
  const invoke = (branchEntries: any[], preparation: any = {}) =>
    handler(
      {
        type: "session_before_compact",
        branchEntries,
        preparation: {
          previousSummary: undefined,
          fileOps: { read: [], written: [], edited: [] },
          tokensBefore: 1000,
          ...preparation,
        },
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        signal: new AbortController().signal,
      },
      ctx,
    );
  return { invoke };
}

const alphaRead = assistantWithToolCall("read", { file_path: "alpha.txt" });
const betaEdit = assistantWithToolCall("edit", { file_path: "beta.txt" });

describe("before-compact hook emits session-global refs", () => {
  test("second compact-all numbers the edit at its global index", () => {
    const all = [
      msgEntry("m1", userMsg("Inspect the alpha fixture")),
      msgEntry("m2", alphaRead),
      msgEntry("m3", toolResult("read", "alpha contents")),
      compactionEntry("c1", ""),
      msgEntry("m4", userMsg("Modify the beta fixture")),
      msgEntry("m5", betaEdit),
      msgEntry("m6", toolResult("edit", "done")),
    ];
    const { invoke } = hookHarness(all);
    const result = invoke(all, {
      previousSummary: "[Session Goal]\n- Inspect the alpha fixture",
    });
    expect(result.compaction).toBeDefined();
    expect(result.compaction.details.version).toBe(2);
    expect(result.compaction.summary).toContain('* edit "beta.txt" (#4)');
    expect(result.compaction.summary).not.toContain('* edit "beta.txt" (#1)');
  });

  test("compaction after branching numbers the active edit globally", () => {
    const fileOrder = [
      msgEntry("r1", userMsg("Inspect the active fixture")),
      msgEntry("a1", assistantWithToolCall("read", { file_path: "abandoned.txt" })),
      msgEntry("a2", toolResult("read", "abandoned contents")),
      msgEntry("b1", assistantWithToolCall("edit", { file_path: "active.txt" })),
      msgEntry("b2", toolResult("edit", "done")),
    ];
    // Active lineage only — abandoned entries are in the file, not the branch.
    const branch = [fileOrder[0], fileOrder[3], fileOrder[4]];
    const { invoke } = hookHarness(fileOrder);
    const result = invoke(branch);
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).toContain('* edit "active.txt" (#3)');
    expect(result.compaction.summary).not.toContain('* edit "active.txt" (#1)');
  });

  test("custom_message in the live window renders no ref; later lines stay global", () => {
    const all = [
      msgEntry("m1", userMsg("Do the beta thing")),
      customEntry("cm1", "injected per-turn guidance block"),
      msgEntry("m2", betaEdit),
      msgEntry("m3", toolResult("edit", "done")),
    ];
    const { invoke } = hookHarness(all);
    const result = invoke(all);
    expect(result.compaction).toBeDefined();
    const summary: string = result.compaction.summary;
    // The injected custom message is not a counted message entry — its line
    // must carry no ref, and the edit after it keeps its true global index.
    const injectedLine = summary.split("\n").find((l) => l.includes("injected per-turn guidance"));
    expect(injectedLine).toBeDefined();
    expect(injectedLine!).not.toContain("(#");
    // Global: m1=0, m2(edit)=1. Legacy positional would emit (#2) because the
    // converted custom message occupied window slot 1.
    expect(summary).toContain('* edit "beta.txt" (#1)');
    expect(summary).not.toContain('* edit "beta.txt" (#2)');
  });

  test("collapse never emits a malformed empty ref for a ref-less duplicate line", () => {
    const dupEdit = assistantWithToolCall("edit", { file_path: "a.ts" });
    const all = [
      msgEntry("m1", userMsg("Run the edits")),
      msgEntry("m2", dupEdit),
      // Second identical edit shares id "dup" with a later entry → ambiguous
      // → dropped fail-closed → its brief line renders no ref.
      msgEntry("dup", dupEdit),
      msgEntry("m3", toolResult("edit", "done")),
      msgEntry("dup", toolResult("read", "later dup")),
    ];
    const { invoke } = hookHarness(all);
    const result = invoke(all);
    expect(result.compaction).toBeDefined();
    const summary: string = result.compaction.summary;
    expect(summary).toContain('* edit "a.ts" (#1)');
    expect(summary).not.toContain(", #)");
    expect(summary).not.toContain("x2");
  });

  test("no index map at all → refs are omitted entirely (fail-closed)", () => {
    const { invoke } = hookHarness(undefined);
    const result = invoke([
      msgEntry("m1", userMsg("Do the beta thing")),
      msgEntry("m2", betaEdit),
      msgEntry("m3", toolResult("edit", "done")),
    ]);
    expect(result.compaction).toBeDefined();
    expect(result.compaction.summary).not.toContain("(#");
  });
});
