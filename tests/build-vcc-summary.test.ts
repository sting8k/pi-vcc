/**
 * buildVccSummary is the summary pipeline shared by the compaction hook and by
 * extensions that append a compaction entry themselves. Both callers must get
 * the same text and the same session-global `(#N)` refs.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildVccSummary,
  registerBeforeCompactHook,
  PI_VCC_COMPACT_INSTRUCTION,
} from "../src/hooks/before-compact";
import { DEFAULT_SETTINGS } from "../src/core/settings";
import { DEFAULT_CHARS_PER_TOKEN } from "../src/core/token-estimate";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-build-summary-"));
  const configPath = join(tmpDir, "pi-vcc-config.json");
  writeFileSync(configPath, JSON.stringify({ smartKeepTail: false }));
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const msgEntry = (id: string, message: unknown) => ({ id, type: "message", message });

const summarized = [
  msgEntry("m1", userMsg("Modify the beta fixture")),
  msgEntry("m2", assistantWithToolCall("edit", { file_path: "beta.txt" })),
  msgEntry("m3", toolResult("edit", "done")),
];
const all = [
  msgEntry("m0", userMsg("Earlier unrelated request")),
  msgEntry("m0b", assistantText("Earlier answer")),
  ...summarized,
  msgEntry("m4", userMsg("Kept tail request")),
  msgEntry("m5", assistantText("Kept tail answer")),
];

describe("buildVccSummary", () => {
  test("matches the hook's summary and resolves refs against the whole session", () => {
    let handler: ((event: any, ctx: any) => any) | undefined;
    registerBeforeCompactHook({ on: (name: string, h: any) => { if (name === "session_before_compact") handler = h; } } as any, "0.84.4");
    const fileOps = { read: [], written: [], edited: [] };
    const hookResult = handler!(
      {
        type: "session_before_compact",
        branchEntries: all.slice(2),
        preparation: { previousSummary: undefined, fileOps, tokensBefore: undefined },
        customInstructions: PI_VCC_COMPACT_INSTRUCTION,
        signal: new AbortController().signal,
      },
      { hasUI: false, ui: { notify: () => {} }, sessionManager: { getEntries: () => all } },
    );

    const built = buildVccSummary({
      messages: summarized.map((e) => e.message),
      entryIds: summarized.map((e) => e.id),
      sessionManager: { getEntries: () => all },
      fileOps,
      charsPerToken: DEFAULT_CHARS_PER_TOKEN,
      settings: DEFAULT_SETTINGS,
    });

    expect(built.summary).toBe(hookResult.compaction.summary);
    expect(built.convertedMessages).toBe(summarized.length);
    // The edit call (m2) is the fourth counted message of the session (m0, m0b, m1, m2): index 3.
    expect(built.summary).toContain('* edit "beta.txt" (#3)');
  });

  test("omits refs rather than emitting window-relative ones without a session manager", () => {
    const built = buildVccSummary({
      messages: summarized.map((e) => e.message),
      entryIds: summarized.map((e) => e.id),
      fileOps: { read: [], written: [], edited: [] },
      charsPerToken: DEFAULT_CHARS_PER_TOKEN,
      settings: DEFAULT_SETTINGS,
    });
    expect(built.summary).toContain('* edit "beta.txt"');
    expect(built.summary).not.toMatch(/\(#\d+\)/);
  });
});
