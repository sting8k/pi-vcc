import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadAllMessages } from "../src/core/load-messages";

describe("loadAllMessages", () => {
  it("loads all message entries when no lineage filter is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-all-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "session", id: "s1" }),
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "custom", id: "c1", customType: "x", data: {} }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "ok" }] } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toHaveLength(3);
      expect(loaded.rawMessages).toHaveLength(3);
      expect(loaded.rendered.map((e) => e.index)).toEqual([0, 1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads JSONL incrementally across read-chunk boundaries", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-chunked-"));
    const file = join(dir, "session.jsonl");
    try {
      const largeText = `${"x".repeat(70_000)} unicode: λ`;
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: largeText } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "user", content: "after boundary" } }),
      ];
      // Deliberately omit the final newline to cover the buffered tail as well.
      writeFileSync(file, lines.join("\n"), "utf8");

      const loaded = loadAllMessages(file, true);
      expect(loaded.rendered).toHaveLength(2);
      expect(loaded.rendered[0].summary).toBe(largeText);
      expect(loaded.rendered[1].summary).toBe("after boundary");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a not-yet-written session file as empty history instead of throwing ENOENT", () => {
    // Fresh session: pi has not persisted any entry, so the JSONL does not exist.
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-missing-"));
    try {
      const loaded = loadAllMessages(join(dir, "nope", "session.jsonl"), false);
      expect(loaded.rendered).toEqual([]);
      expect(loaded.rawMessages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty history for an existing but empty session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-empty-"));
    const file = join(dir, "session.jsonl");
    try {
      writeFileSync(file, "", "utf8");
      const loaded = loadAllMessages(file, false);
      expect(loaded.rendered).toEqual([]);
      expect(loaded.rawMessages).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still surfaces read errors that are not 'file does not exist'", () => {
    // A directory is readable-but-not-a-file (EISDIR): a real I/O problem, not
    // an empty history. It must not be swallowed.
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-eisdir-"));
    try {
      expect(() => loadAllMessages(dir, false)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters messages by allowed lineage entry IDs and preserves original message index", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-vcc-load-filter-"));
    const file = join(dir, "session.jsonl");
    try {
      const lines = [
        JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "u1" } }),
        JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
        JSON.stringify({ type: "message", id: "m3", message: { role: "user", content: "u2" } }),
      ];
      writeFileSync(file, lines.join("\n") + "\n", "utf8");

      const loaded = loadAllMessages(file, false, new Set(["m2"]));
      expect(loaded.rendered).toHaveLength(1);
      expect(loaded.rawMessages).toHaveLength(1);
      expect(loaded.rendered[0].index).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
