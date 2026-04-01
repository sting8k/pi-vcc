import { describe, expect, it } from "bun:test";
import { buildCompactReport } from "../src/core/report";
import {
  userMsg,
  assistantText,
  assistantWithToolCall,
  toolResult,
} from "./fixtures";

describe("buildCompactReport", () => {
  it("includes before and after compact metrics", () => {
    const report = buildCompactReport({
      messages: [
        userMsg("Fix login bug in auth.ts"),
        assistantWithToolCall("Read", { path: "auth.ts" }),
        toolResult("Read", "function login() {}"),
        assistantText("Found the root cause in auth.ts.\n1. Fix validation\n2. Run tests"),
      ],
    });

    expect(report.summary).toContain("[Session Goal]");
    expect(report.before.messageCount).toBe(4);
    expect(report.before.roleCounts.user).toBe(1);
    expect(report.before.topFiles).toContain("auth.ts");
    expect(report.before.preview).toContain("Fix login bug in auth.ts");
    expect(report.after.sectionCount).toBeGreaterThan(0);
    expect(report.after.summaryPreview).toContain("[Files And Changes]");
    expect(report.compression.charsBefore).toBeGreaterThan(0);
    expect(report.recall.probes.length).toBeGreaterThan(0);
  });

  it("marks recall probe coverage for goal and file queries", () => {
    const report = buildCompactReport({
      messages: [
        userMsg("Investigate timeout in api/server.ts"),
        assistantWithToolCall("Read", { path: "api/server.ts" }),
        toolResult("Read", "timeout error in api/server.ts"),
        assistantText("Confirmed timeout error in api/server.ts.\n- Patch retry handling"),
      ],
    });

    const goalProbe = report.recall.probes.find((probe) => probe.label === "goal");
    const fileProbe = report.recall.probes.find((probe) => probe.label === "file");

    expect(goalProbe).toBeDefined();
    expect(goalProbe?.sourceText).toContain("Investigate timeout");
    expect(goalProbe?.summaryMentioned).toBe(true);
    expect(goalProbe?.recallHits).toBeGreaterThan(0);
    expect(fileProbe).toBeDefined();
    expect(fileProbe?.sourceText).toBe("api/server.ts");
    expect(fileProbe?.summaryMentioned).toBe(true);
    expect(fileProbe?.recallHits).toBeGreaterThan(0);
  });
});
