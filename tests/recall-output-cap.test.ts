import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall";
import { RECALL_OUTPUT_BYTES } from "../src/core/recall-run";
import { searchEntries } from "../src/core/search-entries";

// One tool result is a ~600 KB base64 image on a single line (issue #63).
const blob = Buffer.concat(Array.from({ length: 14_000 }, (_, i) => createHash("sha256").update(String(i)).digest())).toString("base64");

let dir: string;
let file: string;
const ids: string[] = [];
let blobIndex = -1;
let longLineIndex = -1;
// Multi-byte text (#68): the cap counts UTF-8 bytes, not string length.
const cjk = "中".repeat(50 * 1024); // 51,200 chars, 153,600 bytes
const emoji = `a${"😀".repeat(20_000)}`; // a cut at 50 KB lands inside an emoji
const cjkFile = "中文內容一行\n".repeat(20_000);
let cjkIndex = -1;
let emojiIndex = -1;
let cjkFileIndex = -1;
// A long single line that is not base64 (minified code, a JSON event): search keeps it.
const longLine = `${"a1,".repeat(100_000)}needle_mark${"b2,".repeat(100_000)}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-vcc-recall-cap-"));
  file = join(dir, "session.jsonl");
  const lines: string[] = [];
  const add = (message: unknown) => {
    const id = `e${ids.length}`;
    lines.push(JSON.stringify({ type: "message", id, parentId: ids.at(-1) ?? null, message }));
    ids.push(id);
  };
  for (let i = 0; i < 60; i++) {
    if (i === 30) {
      add({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "other_tool", arguments: { action: "tail" } }] });
      blobIndex = ids.length;
      add({ role: "toolResult", toolCallId: "t1", toolName: "other_tool", content: [{ type: "text", text: blob }] });
      continue;
    }
    if (i === 40) {
      longLineIndex = ids.length;
      add({ role: "user", content: longLine });
      continue;
    }
    if (i === 50) {
      cjkIndex = ids.length;
      add({ role: "user", content: cjk });
      emojiIndex = ids.length;
      add({ role: "user", content: emoji });
      cjkFileIndex = ids.length;
      add({ role: "assistant", content: [{ type: "toolCall", id: "w1", name: "write", arguments: { path: "notes/cjk.txt", content: cjkFile } }] });
      continue;
    }
    add({ role: "user", content: i % 10 === 0 ? `Step ${i}: set max retries to 3` : `Step ${i}: run the tests` });
    add({ role: "assistant", content: [{ type: "text", text: `Done with step ${i}.` }] });
  }
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const recall = async (params: Record<string, unknown>) => {
  let tool: any;
  registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
  const result = await tool.execute("call", params, undefined, undefined, {
    sessionManager: { getSessionFile: () => file, getBranch: () => ids.map((id) => ({ id })), getEntries: () => ids.map((id) => ({ id })) },
  });
  return result.content[0].text as string;
};

describe("vcc_recall output size (issue #63)", () => {
  it("keeps a search snippet of a long single-line entry small", async () => {
    const out = await recall({ query: "needle_mark" });
    expect(out).toContain(`#${longLineIndex} [user]`);
    expect(out).toContain("needle_mark");
    expect(out.length).toBeLessThan(5_000);
    expect(out).not.toContain("Warning: output clipped");
  });

  it("ranks entries with every term above a blob that only contains one inside base64", async () => {
    expect(blob).toMatch(/max/i);
    const out = await recall({ query: "max retries" });
    const first = out.match(/^#(\d+) /m)?.[1];
    expect(out.slice(out.indexOf(`#${first} `)).split("\n")[0]).toContain("max retries");
    expect(out).not.toContain(`#${blobIndex} `);
  });

  it("clips an expand over the cap and says so first", async () => {
    const out = await recall({ expand: [blobIndex] });
    expect(out.startsWith(`Warning: output clipped at ${RECALL_OUTPUT_BYTES} of `)).toBe(true);
    expect(Buffer.byteLength(out)).toBeLessThan(RECALL_OUTPUT_BYTES + 500);
    expect(out.endsWith("...[clipped at 50 KB]")).toBe(true);
  });

  // The kept part of a clipped result: between the warning and the footer.
  const keptOf = (out: string) => out.slice(out.indexOf("\n\n") + 2, out.lastIndexOf("\n...[clipped at 50 KB]"));

  it("counts the cap in UTF-8 bytes for multi-byte text (#68)", async () => {
    const out = await recall({ expand: [cjkIndex] });
    expect(out).toMatch(/^Warning: output clipped at \d+ of \d+ bytes/);
    expect(Buffer.byteLength(keptOf(out))).toBeLessThanOrEqual(RECALL_OUTPUT_BYTES);
    expect(Buffer.byteLength(out)).toBeLessThan(RECALL_OUTPUT_BYTES + 500);
  });

  it("never splits a character at the cut", async () => {
    for (const index of [cjkIndex, emojiIndex]) {
      const kept = keptOf(await recall({ expand: [index] }));
      expect(kept).not.toContain("\uFFFD");
      expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
      expect(Buffer.byteLength(kept)).toBeGreaterThan(RECALL_OUTPUT_BYTES - 4);
    }
  });

  it("caps a full file read the same way", async () => {
    const out = await recall({ query: `#${cjkFileIndex}:cjk.txt:full` });
    expect(out).toMatch(/^Warning: output clipped at \d+ of \d+ bytes/);
    expect(out).toContain("File: notes/cjk.txt");
    expect(Buffer.byteLength(out)).toBeLessThan(RECALL_OUTPUT_BYTES + 500);
  });
});

describe("search ranking with a long unbroken entry", () => {
  it("leaves the order of the other entries unchanged", () => {
    // A short doc with one hit and a long doc with many: their order depends on the average doc length.
    const texts = [
      "set max to 3",
      `${"filler ".repeat(60)} max max max max`,
      "the max retries value",
      `${"note ".repeat(20)} max max`,
    ];
    const plain = texts.map((t, i) => ({ entry: { index: i, role: "user", summary: t }, msg: { role: "user", content: t } }));
    const blobDoc = { entry: { index: 9, role: "tool_result", summary: "[other_tool]" }, msg: { role: "toolResult", toolName: "other_tool", content: [{ type: "text", text: `max ${blob}` }] } };
    const order = (docs: typeof plain) =>
      searchEntries(docs.map((d) => d.entry) as any, docs.map((d) => d.msg) as any, "max").map((h) => h.index).filter((i) => i !== 9);
    expect(order([...plain, blobDoc as any])).toEqual(order(plain));
  });

  it("keeps long joined identifiers searchable", () => {
    const joined = "capturedNormalCompletionRecordOrdinaryObjectCreateDataProperty".repeat(30);
    const hits = searchEntries([{ index: 0, role: "tool_result", summary: "" }] as any, [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: joined }] }] as any, "OrdinaryObjectCreate");
    expect(hits.map((h) => h.index)).toEqual([0]);
  });
});
