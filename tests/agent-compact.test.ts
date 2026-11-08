/**
 * compact_context: the model-initiated compaction tool. The cut must keep the
 * recent tail at a safe boundary, the summary must come from pi-vcc's own
 * builder (same sections and (#N) refs as auto-compaction), and registration
 * must be gated on the agentCompact setting and Pi >= 0.87.0.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import {
  registerAgentCompactTool,
  supportsActionableTurnEnd,
  isSafeBoundary,
  findCompactCut,
  collectFileOps,
  buildVccCompaction,
  type CompactEntry,
} from "../src/tools/agent-compact";
import { userMsg, assistantText, assistantWithToolCall, toolResult } from "./fixtures";

let tmpDir: string;
let configPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-agent-compact-"));
  configPath = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const setConfig = (settings: Record<string, unknown>) =>
  writeFileSync(configPath, JSON.stringify(settings));

const stubPi = (overrides: Record<string, unknown> = {}) => {
  const tools: any[] = [];
  const handlers: Record<string, any> = {};
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    on: (event: string, handler: any) => { handlers[event] = handler; },
    getActiveTools: () => pi.activeTools,
    setActiveTools: (names: string[]) => { pi.activeTools = names; },
    activeTools: ["bash"],
    ...overrides,
  };
  return { pi, tools, handlers };
};

/** entry with one message; role "toolResult" makes an unsafe boundary. */
const entry = (id: string, message: any, type = "message"): CompactEntry => ({
  sourceEntry: { id, type, message: { role: message.role } },
  messages: [message],
});

describe("supportsActionableTurnEnd", () => {
  test("true from 0.87.0 on, false below and for unusable versions", () => {
    expect(supportsActionableTurnEnd("0.87.0")).toBe(true);
    expect(supportsActionableTurnEnd("0.87.1")).toBe(true);
    expect(supportsActionableTurnEnd("1.3.0")).toBe(true);
    expect(supportsActionableTurnEnd("v2.0.0-rc.1")).toBe(true);
    expect(supportsActionableTurnEnd("0.86.9")).toBe(false);
    expect(supportsActionableTurnEnd("0.85.1")).toBe(false);
    expect(supportsActionableTurnEnd("garbage")).toBe(false);
    expect(supportsActionableTurnEnd(undefined)).toBe(false);
  });
});

describe("isSafeBoundary", () => {
  test("user/assistant messages and structural entries; never a tool result", () => {
    expect(isSafeBoundary({ type: "message", message: { role: "user" } })).toBe(true);
    expect(isSafeBoundary({ type: "message", message: { role: "assistant" } })).toBe(true);
    expect(isSafeBoundary({ type: "compaction" })).toBe(true);
    expect(isSafeBoundary({ type: "branch_summary" })).toBe(true);
    expect(isSafeBoundary({ type: "custom_message" })).toBe(true);
    expect(isSafeBoundary({ type: "message", message: { role: "toolResult" } })).toBe(false);
    expect(isSafeBoundary({ type: "message" })).toBe(false);
    expect(isSafeBoundary({ type: "tool_call" })).toBe(false);
  });
});

describe("collectFileOps", () => {
  test("buckets assistant tool calls and codemode nested calls by path", () => {
    const ops = collectFileOps([
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
          { type: "toolCall", name: "write", arguments: { path: "b.ts" } },
          { type: "toolCall", name: "edit", arguments: { path: "c.ts" } },
          { type: "toolCall", name: "bash", arguments: { command: "ls" } },
          { type: "toolCall", name: "edit", arguments: { file_path: "ignored.ts" } },
        ],
      },
      { role: "toolResult", nestedCalls: { calls: [{ name: "read", arguments: { path: "d.ts" } }] } },
    ]);
    expect([...ops.read]).toEqual(["a.ts", "d.ts"]);
    expect([...ops.written]).toEqual(["b.ts"]);
    expect([...ops.edited]).toEqual(["c.ts"]);
  });
});

describe("findCompactCut", () => {
  test("cuts at the first safe boundary that keeps the newest ~budget tokens", () => {
    const big = userMsg(`${"x ".repeat(2000)}`); // well over any per-message noise
    const size = estimateTokens(big);
    // e2 is an oversized tool result: the budget covers e2..e4 but not e3+e4,
    // so the raw cut is e2 — unsafe — and it advances to e3.
    const bigResult = { role: "toolResult", content: "x ".repeat(4000) };
    const entries = [
      entry("e0", big),
      entry("e1", big),
      entry("e2", bigResult),
      entry("e3", big),
      entry("e4", big),
    ];
    const cut = findCompactCut(entries, Math.floor(size * 3));
    expect(cut).toBe(3);
  });

  test("whole window fits the budget, or no safe boundary exists", () => {
    const big = userMsg("x ".repeat(2000));
    expect(findCompactCut([entry("e0", big)], 1_000_000)).toBe(-1);
    // Raw cut at the only entry, which is unsafe: advance falls off the end.
    expect(findCompactCut([entry("e0", { role: "toolResult", content: "out" })], 0)).toBe(1);
  });
});

describe("registerAgentCompactTool", () => {
  test("registered only with the setting on and Pi >= 0.87.0", () => {
    setConfig({ agentCompact: true });
    const gated = stubPi();
    registerAgentCompactTool(gated.pi, "0.86.9");
    expect(gated.tools).toHaveLength(0);
    expect(gated.handlers).toEqual({});

    const off = stubPi();
    setConfig({ agentCompact: false });
    registerAgentCompactTool(off.pi, "1.3.0");
    expect(off.tools).toHaveLength(0);

    setConfig({ agentCompact: true });
    const on = stubPi();
    registerAgentCompactTool(on.pi, "0.87.0");
    expect(on.tools.map((t: any) => t.name)).toEqual(["compact_context"]);
  });

  test("before_agent_start rejoins compact_context and vcc_recall to the loadout once", () => {
    setConfig({ agentCompact: true });
    const { pi, handlers } = stubPi();
    registerAgentCompactTool(pi, "1.3.0");
    handlers.before_agent_start();
    expect(pi.activeTools).toEqual(["bash", "compact_context", "vcc_recall"]);
    pi.setActiveTools(["bash"]); // a later session restore
    handlers.before_agent_start();
    expect(pi.activeTools).toEqual(["bash"]); // once per process
  });

  test("turn_end appends a pi-vcc compaction entry and continues", async () => {
    setConfig({ agentCompact: true });
    const { pi, tools, handlers } = stubPi({ getSettings: () => ({ compaction: { keepRecentTokens: 0 } }) });
    registerAgentCompactTool(pi, "1.3.0");

    await tools[0].execute("t1", { instructions: "keep the plan" }, undefined, undefined, {});

    const all = [
      { id: "m0", type: "message", message: userMsg("First request") },
      { id: "m1", type: "message", message: assistantWithToolCall("edit", { path: "b.txt" }) },
      { id: "m2", type: "message", message: toolResult("edit", "done") },
      { id: "m3", type: "message", message: userMsg("Kept tail") },
    ];
    const entries: CompactEntry[] = [
      entry("m0", userMsg("First request")),
      entry("m1", assistantText("First answer")),
      entry("m2", assistantText("Middle")),
      entry("m3", userMsg("Kept tail")),
    ];
    const result = await handlers.turn_end(
      { context: { canContinue: true, contextEntries: entries } },
      { sessionManager: { getEntries: () => all } },
    );
    expect(result.continue).toBe(true);
    const compacted = result.entries[0];
    expect(compacted.type).toBe("compaction");
    expect(compacted.firstKeptEntryId).toBe("m3");
    expect(compacted.summary).toContain("Focus requested for this compaction: keep the plan");
    expect(compacted.details.compactor).toBe("pi-vcc");
    expect(Array.isArray(compacted.details.sections)).toBe(true);
  });
});

describe("buildVccCompaction", () => {
  const spanEntries = [
    entry("m1", userMsg("Modify the beta fixture")),
    entry("m2", assistantWithToolCall("edit", { path: "beta.txt" })),
    entry("m3", toolResult("edit", "done")),
  ];
  const tailEntries = [entry("m4", userMsg("Kept tail request"))];

  test("builds the summary with pi-vcc details and (#N) refs", () => {
    setConfig({ trackCommands: [], agentCompact: true });
    const all = [...spanEntries, ...tailEntries].map((e) => e.sourceEntry);
    const built = buildVccCompaction(spanEntries, [...spanEntries, ...tailEntries], { getEntries: () => all });
    expect(built).not.toBeNull();
    expect(built!.details.compactor).toBe("pi-vcc");
    expect(built!.summary).toMatch(/\[#?\d|Files|Brief/i);
  });

  test("refuses a previous summary pi-vcc did not write, and an empty span", () => {
    const previous = {
      sourceEntry: { id: "p", type: "compaction", details: { compactor: "pi-core" }, summary: "old" },
      messages: [],
    } as unknown as CompactEntry;
    expect(buildVccCompaction([previous, ...spanEntries], tailEntries, undefined)).toBeNull();

    const onlyCompaction = [{
      sourceEntry: { id: "p2", type: "compaction", details: { compactor: "pi-vcc" }, summary: "old" },
      messages: [],
    } as unknown as CompactEntry];
    expect(buildVccCompaction(onlyCompaction, tailEntries, undefined)).toBeNull();
  });
});
