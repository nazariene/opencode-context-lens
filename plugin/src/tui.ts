import { randomUUID } from "node:crypto";
import type { Plugin } from "@opencode/plugin/tui";
import { LensRPC } from "./protocol.js";

export default {
  id: "context-lens.tui",
  setup(ctx) {
    const run = `terminal_${randomUUID()}`;
    const requests = new Set<AbortController>();
    ctx.keymap.layer(() => ({ mode: "global", commands: [{
      id: "context-lens.prune", title: "Prune conversation context", group: "Context Lens", palette: true,
      slash: { name: "lens-prune", arguments: true },
      enabled: () => ctx.ui.router.current().type === "session",
      run: async (input) => {
        const route = ctx.ui.router.current();
        if (route.type !== "session") return;
        const controller = new AbortController(); requests.add(controller);
        try {
          const session = await ctx.client.session.get({ sessionID: route.sessionID }, { signal: controller.signal });
          const rpc = ctx.client.rpc(LensRPC), options = { location: session.location, signal: controller.signal };
          const capability = await rpc.capabilities({}, options);
          const output = await rpc.pruningCommand({ session_id: route.sessionID, run_id: run,
            instance_id: capability.instance_id, text: typeof input === "string" ? input : "help" }, options);
          await ctx.ui.dialog.alert({ title: "Context Lens pruning", message: output.report });
        } catch (error) {
          if (!controller.signal.aborted) await ctx.ui.dialog.alert({ title: "Context Lens pruning", message: error instanceof Error ? error.message : "Command failed. Inspect saved edits before retrying." });
        } finally { requests.delete(controller); }
      },
    }] }));
    return () => { for (const controller of requests) controller.abort(); };
  },
} satisfies Plugin.Definition;
