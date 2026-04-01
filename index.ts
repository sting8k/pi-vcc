import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";
import { registerRecallTool } from "./src/tools/recall";

export default (pi: ExtensionAPI) => {
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
  registerRecallTool(pi);
};
