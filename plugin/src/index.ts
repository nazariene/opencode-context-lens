import { Plugin } from "@opencode/plugin";
import { LensRPC, Rejected } from "./protocol.js";
import { Runtime } from "./runtime.js";
import { executePruningCommand } from "./pruning-command.js";

export default Plugin.define({
  id: "context-lens",
  async setup(ctx) {
    const runtime = new Runtime(ctx);
    const registration = await ctx.rpc.register(LensRPC, {
      pruningCommand: async (input, rpc) => {
        try { return { report: await executePruningCommand(runtime, input, input.text, rpc.signal) }; } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      capabilities: async () => runtime.capabilities(),
      pruningInspect: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, () => runtime.pruning.inspect(input)); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      pruningPreview: async (input, rpc) => {
        try { return await runtime.pruning.preview(input, rpc.signal); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      pruningApply: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, () => runtime.pruning.apply(input, rpc.signal)); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      pruningRestore: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, () => runtime.pruning.restore(input, rpc.signal)); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      pruningProtect: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, () => runtime.pruning.protect(input)); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      status: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, async () => { runtime.check(input); await runtime.pruning.policy(input.session_id); return runtime.status(input); }); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      generate: async (input, rpc) => {
        try { return await runtime.generate(input, rpc.signal); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      generationStatus: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, async () => { runtime.check(input); await runtime.pruning.policy(input.session_id); return runtime.generationStatus(input); }); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      cancelGeneration: async (input, rpc) => {
        try { return runtime.cancelGeneration(input); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      activate: async (input, rpc) => {
        try { return await runtime.activate(input, rpc.signal); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      deactivate: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, async () => runtime.deactivate(input)); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
      renew: async (input, rpc) => {
        try { return await runtime.serialized(input.session_id, async () => { runtime.check(input); await runtime.pruning.policy(input.session_id); return runtime.renew(input); }); } catch (error) { if (error instanceof Rejected) return rpc.error("rejected", error.message, { code: error.code, message: error.message }); throw error; }
      },
    });
    const hooks = await Promise.all([
      ctx.session.hook("context", (event) => runtime.serialized(event.sessionID, async () => {
        await runtime.pruning.hook(event, "primary"); runtime.hook(event);
      })),
      ctx.session.hook("generate", (event) => runtime.serialized(event.sessionID, () => runtime.pruning.hook(event, "generate"))),
      ctx.session.hook("compaction", (event) => runtime.serialized(event.sessionID, () => runtime.pruning.hook(event, "compaction"))),
      ctx.session.hook("title", (event) => runtime.serialized(event.sessionID, () => runtime.pruning.title(event))),
    ]);
    const controller = new AbortController();
    const events = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type !== "session.compaction.ended" || event.location?.directory !== ctx.location.directory) continue;
          try { await runtime.serialized(event.data.sessionID, () => runtime.pruning.policy(event.data.sessionID)); }
          catch { console.warn("Context Lens: compaction reset will retry on the next session access."); }
        }
      } catch {
        if (!controller.signal.aborted) console.warn("Context Lens: event stream closed; checkpoint resets will reconcile on session access.");
      }
    })();
    const timer = setInterval(() => runtime.expire(), 1000);
    timer.unref();
    return async () => {
      clearInterval(timer); controller.abort(); await events; runtime.close();
      await Promise.all(hooks.map((hook) => hook.dispose())); await registration.dispose();
    };
  },
});
