import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCompactReport } from "../src/core/report";
import { prepareSessionSamples, readSourceStat, type SessionSample } from "./support/real-sessions";
import { loadSessionMessages } from "./support/load-session";

let samples: SessionSample[] = [];

// Integration test against real ~/.pi session transcripts — skipped where no
// sessions exist (CI runners) instead of failing on ENOENT. The guard must
// live in beforeAll too: file-scope hooks run even when the describe below
// is skipped.
const HAS_SESSIONS = existsSync(join(homedir(), ".pi/agent/sessions"));

beforeAll(async () => {
  if (HAS_SESSIONS) samples = await prepareSessionSamples(2);
});

describe.if(HAS_SESSIONS)("real session integration", () => {
  it("compiles copied large sessions without mutating originals", async () => {
    for (const sample of samples) {
      const before = await readSourceStat(sample);
      const loaded = loadSessionMessages(sample.copy);
      const report = buildCompactReport({ messages: loaded.messages });
      const after = await readSourceStat(sample);

      expect(loaded.messageCount).toBeGreaterThan(0);
      expect(loaded.skippedCount).toBeGreaterThanOrEqual(0);
      expect(report.summary.length).toBeGreaterThan(0);
      expect(report.summary).toContain("[");
      expect(report.before.preview.length).toBeGreaterThan(0);
      expect(report.after.summaryPreview.length).toBeGreaterThan(0);
      expect(report.compression.charsBefore).toBeGreaterThan(0);
      expect(report.recall.probes.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
    }
  });

  it("uses read-only copied fixtures", () => {
    for (const sample of samples) {
      expect(sample.copy).not.toBe(sample.source);
      expect(sample.copy.includes("pi-vcc-sessions-")).toBe(true);
    }
  });
});
