import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export const registerPiVccCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc", {
    description: "Compact conversation with pi-vcc structured summary",
    handler: async (args, ctx) => {
      const instructions = args.trim() || undefined;
      await ctx.actions.compact({ customInstructions: instructions });
      ctx.ui.notify("Compacted with pi-vcc", "info");
    },
  });
};
