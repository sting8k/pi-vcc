import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerBeforeCompactHook } from "./src/hooks/before-compact";
import { registerPiVccCommand } from "./src/commands/pi-vcc";

export default (pi: ExtensionAPI) => {
  registerBeforeCompactHook(pi);
  registerPiVccCommand(pi);
};
