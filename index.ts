import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { scaffoldSettings } from "./src/core/settings";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerInterTurnCompaction } from "./src/hooks/inter-turn-compaction";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerVccRecallCommand } from "./src/commands/vcc-recall";
import { registerRecallTool } from "./src/tools/recall";

export default (pi: ExtensionAPI) => {
  scaffoldSettings();
  registerBeforeCompactHook(pi);
  registerInterTurnCompaction(pi);
  registerPiVccCommand(pi);
  registerVccRecallCommand(pi);
  registerRecallTool(pi);
};
