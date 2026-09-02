import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INTER_TURN_COMPACTION_TOKENS,
  interTurnCompactionThreshold,
  registerInterTurnCompaction,
} from "../src/hooks/inter-turn-compaction";
import { DEFAULT_SETTINGS } from "../src/core/settings";

let tmpDir: string;
let configPath: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-vcc-inter-turn-test-"));
  configPath = join(tmpDir, "pi-vcc-config.json");
  process.env.PI_VCC_CONFIG_PATH = configPath;
});

afterEach(() => {
  try { unlinkSync(configPath); } catch {}
});

afterAll(() => {
  delete process.env.PI_VCC_CONFIG_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function setConfig(config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config));
}

function harness(initialTokens: number | null = DEFAULT_INTER_TURN_COMPACTION_TOKENS) {
  let handler: ((event: unknown, ctx: any) => void) | undefined;
  let tokens = initialTokens;
  const compactions: any[] = [];
  const messages: any[] = [];
  const pi = {
    on(event: string, candidate: (event: unknown, ctx: any) => void) {
      expect(event).toBe("before_provider_request");
      handler = candidate;
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
  } as any;
  registerInterTurnCompaction(pi);
  const ctx = {
    getContextUsage: () => ({ tokens }),
    compact: (options: unknown) => compactions.push(options),
  };
  return {
    fire: () => handler!({}, ctx),
    setTokens: (value: number | null) => { tokens = value; },
    compactions,
    messages,
  };
}

describe("inter-turn compaction", () => {
  test("starts at 250,000 active-context tokens", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness(DEFAULT_INTER_TURN_COMPACTION_TOKENS - 1);
    run.fire();
    expect(run.compactions).toHaveLength(0);
    run.setTokens(DEFAULT_INTER_TURN_COMPACTION_TOKENS);
    run.fire();
    expect(run.compactions).toHaveLength(1);
  });

  test("keeps one compaction in flight and resumes the interrupted tool loop", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness();
    run.fire();
    run.fire();
    expect(run.compactions).toHaveLength(1);

    run.compactions[0].onComplete();
    expect(run.messages).toEqual([{
      message: {
        customType: "pi-vcc-auto-continue",
        content: [],
        display: false,
        details: undefined,
      },
      options: { triggerTurn: true, deliverAs: "followUp" },
    }]);
  });

  test("a failed compaction may retry", () => {
    setConfig({ ...DEFAULT_SETTINGS });
    const run = harness();
    run.fire();
    run.compactions[0].onError(new Error("failed"));
    run.fire();
    expect(run.compactions).toHaveLength(2);
  });

  test("null disables inter-turn compaction", () => {
    setConfig({ ...DEFAULT_SETTINGS, interTurnCompactionTokens: null });
    const run = harness(900_000);
    run.fire();
    expect(run.compactions).toHaveLength(0);
  });

  test("leaves automatic compaction to Pi when default override is disabled", () => {
    setConfig({ ...DEFAULT_SETTINGS, overrideDefaultCompaction: false });
    const run = harness();
    run.fire();
    expect(run.compactions).toHaveLength(0);
  });

  test("does not resume when automatic continuation is disabled", () => {
    setConfig({ ...DEFAULT_SETTINGS, continueAfterThresholdCompact: false });
    const run = harness();
    run.fire();
    run.compactions[0].onComplete();
    expect(run.messages).toEqual([]);
  });

  test("invalid threshold values fail closed", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "250000"] as unknown[]) {
      expect(interTurnCompactionThreshold({
        ...DEFAULT_SETTINGS,
        interTurnCompactionTokens: value as number,
      })).toBeNull();
    }
  });
});
