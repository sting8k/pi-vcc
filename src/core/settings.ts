import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const SETTINGS_PATH_DEFAULT = join(homedir(), ".pi", "agent", "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? SETTINGS_PATH_DEFAULT;
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

/** Per-model or global compaction threshold. */
export interface ModelThreshold {
  /**
   * Tokens to reserve for LLM response. Overrides pi-core's
   * compaction.reserveTokens for matching models.
   *
   * A higher value compacts earlier (more conservative); a lower value
   * lets context grow larger before compacting.
   *
   * Takes precedence over compactAtTokens and compactPercent when multiple are set.
   */
  reserveTokens?: number;
  /**
   * Absolute context token count where compaction triggers.
   *
   * Useful when you want the same trigger point across models with
   * different context windows. Ignored when reserveTokens is also set;
   * takes precedence over compactPercent.
   */
  compactAtTokens?: number;
  /**
   * Compaction trigger as a percentage of context window (1–99).
   * Compaction fires when: contextTokens > contextWindow × compactPercent / 100
   *
   * Ignored when reserveTokens or compactAtTokens is also set.
   */
  compactPercent?: number;
}

export interface PiVccSettings {
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - /compact <text>
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /**
   * When true (default), pi-vcc asks the agent to continue after a successful
   * automatic compaction (threshold, or overflow after the assistant already
   * finished with stop). This avoids a UX cliff where the agent finishes a response,
   * immediately compacts, and then stops instead of continuing the task.
   * Overflow retry is still owned by pi-core via willRetry.
   */
  continueAfterThresholdCompact: boolean;
  /**
   * Per-model compaction thresholds. Keys are matched against
   * "provider/modelId" (e.g., "anthropic/claude-3-5-sonnet") or
   * just "modelId" (e.g., "claude-3-5-sonnet").
   *
   * When a model matches, its threshold overrides pi-core's global
   * compaction settings for the *when to compact* decision. This lets
   * different models compact at different context fill levels.
   */
  modelThresholds?: Record<string, ModelThreshold>;
  /**
   * Global threshold applied to all models not matched by modelThresholds.
   * Uses reserveTokens, compactAtTokens, or compactPercent. If omitted,
   * pi-core's global compaction settings apply (no override).
   */
  globalThreshold?: ModelThreshold;
  /** Write debug snapshot to /tmp/pi-vcc-debug.json on each compaction. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
}

/**
 * Resolve the effective ModelThreshold for a given model.
 *
 * Lookup order:
 *  1. Exact match on "provider/modelId" key
 *  2. Exact match on "modelId" key
 *  3. globalThreshold from settings
 *  4. undefined (no override — pi-core's global settings apply)
 */
export function getModelThreshold(
  settings: PiVccSettings,
  model: { id: string; provider?: string } | undefined,
): ModelThreshold | undefined {
  if (!model) return settings.globalThreshold;

  const providerModelId = model.provider ? `${model.provider}/${model.id}` : undefined;

  // Exact match on provider/modelId
  if (providerModelId && settings.modelThresholds?.[providerModelId]) {
    return settings.modelThresholds[providerModelId];
  }

  // Exact match on just modelId
  if (settings.modelThresholds?.[model.id]) {
    return settings.modelThresholds[model.id];
  }

  return settings.globalThreshold;
}

/**
 * Resolve the context token count where compaction should trigger.
 *
 * Precedence: reserveTokens > compactAtTokens > compactPercent.
 * Returns undefined when the threshold cannot produce a usable trigger.
 */
export function resolveTriggerTokens(
  threshold: ModelThreshold,
  contextWindow: number,
): number | undefined {
  if (contextWindow <= 0) return undefined;

  if (threshold.reserveTokens != null) {
    return contextWindow - threshold.reserveTokens;
  }

  if (threshold.compactAtTokens != null) {
    const tokens = threshold.compactAtTokens;
    if (!Number.isFinite(tokens) || tokens < 1) return undefined;
    return Math.round(tokens);
  }

  if (threshold.compactPercent != null) {
    const pct = threshold.compactPercent;
    if (pct < 1 || pct > 99) return undefined;
    return Math.round(contextWindow * (1 - pct / 100));
  }

  return undefined;
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
