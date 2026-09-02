import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_INTER_TURN_COMPACTION_TOKENS,
  loadSettings,
  type PiVccSettings,
} from "../core/settings";
import { triggerInvisibleContinue } from "./before-compact";

export { DEFAULT_INTER_TURN_COMPACTION_TOKENS } from "../core/settings";

export function interTurnCompactionThreshold(settings: PiVccSettings): number | null {
  const value = settings.interTurnCompactionTokens;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function registerInterTurnCompaction(pi: ExtensionAPI): void {
  let compacting = false;

  pi.on("before_provider_request", (_event, ctx) => {
    const settings = loadSettings();
    if (!settings.overrideDefaultCompaction) return;

    const threshold = interTurnCompactionThreshold(settings);
    const tokens = ctx.getContextUsage()?.tokens;
    if (compacting || threshold === null || tokens === null || tokens === undefined || tokens < threshold) return;

    compacting = true;
    ctx.compact({
      onComplete: () => {
        compacting = false;
        if (loadSettings().continueAfterThresholdCompact) triggerInvisibleContinue(pi);
      },
      onError: () => {
        compacting = false;
      },
    });
  });
}
