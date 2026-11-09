// Synthetic shell exercising the shipped CJS bundle with real Solid rendering and public GUI/RPC modules.
import * as gui from "@opencode/plugin/gui";
import * as rpc from "@opencode/plugin/rpc";
import * as solid from "solid-js";
import * as web from "solid-js/web";
import bundle from "../../dist/gui-experimental.cjs?raw";

const modules = { "@opencode/plugin/gui": gui, "@opencode/plugin/rpc": rpc, "solid-js": solid, "solid-js/web": web };
const module = { exports: {} };
new Function("module", "exports", "require", bundle)(module, module.exports, (name) => {
  if (!Object.hasOwn(modules, name)) throw new Error(`Unexpected dependency ${name}`);
  return modules[name];
});
const plugin = module.exports.default;
const registrations = new Map();
const requests = [], opened = [], deferred = [];
let slow = false, failure = false, disposed, cleanup;
function session(server, id = "ses_fictional") {
  const client = {
    session: { get: async ({ sessionID }) => ({ title: `${server} fictional session`, location: { directory: `/fictional/${server}` } }) },
    rpc: () => ({
      capabilities: async () => ({ instance_id: `instance_${server}` }),
      pruningCommand: async (input, options) => {
        requests.push({ server, input, location: options.location });
        if (failure) throw new Error("Unsupported provider profile");
        if (slow) return new Promise((resolve) => deferred.push({ resolve, signal: options.signal }));
        return { report: input.text.startsWith("apply ") ? "Saved policy revision 1." :
          input.text === "status" ? "Policy revision 0: 0 active edits." :
          "Preview only: 1 edit.\nApply: /lens-prune apply preview_fixture\nBEFORE\n<script>window.unsafe=true</script>\nAFTER\n[Output pruned]" };
      },
    }),
  };
  return { key: `${server}\n${id}`, id, server: { id: server, name: server, client }, pending: false, directory: `/fictional/${server}` };
}
const [current, setCurrent] = solid.createSignal(session("Remote Alpha"));
solid.createRoot((dispose) => {
  disposed = dispose;
  cleanup = plugin.setup({
    id: "context-lens", sessions: { current },
    get client() { throw new Error("Must not use sidecar client"); },
    t: (key) => plugin.i18n.en[key],
    layout: { open: (key, target) => opened.push({ key, target: target.key }), state: () => "closed" },
    add: (registry, contribution) => {
      if (registry === gui.Style) { const style = document.createElement("style"); style.textContent = contribution; document.head.append(style); return; }
      const list = registrations.get(registry) ?? []; list.push(contribution); registrations.set(registry, list);
    },
  });
});
const panel = registrations.get(gui.Panel)[0];
const unmount = web.render(() => panel.render({ get session() { return current(); }, tab: panel.list({ open: ["main"] })[0], screen: {} }), document.getElementById("panel"));
window.fixture = {
  requests, opened,
  command: (text) => registrations.get(gui.Command).map((factory) => factory()).find((item) => item.id === "prune").run(text),
  menu: () => registrations.get(gui.MenuItem)[0]().run(),
  switch: (server) => setCurrent(session(server)),
  slow: (value) => { slow = value; },
  fail: (value) => { failure = value; },
  finish: () => deferred.splice(0).forEach(({ resolve }) => resolve({ report: "Delayed Alpha report" })),
  pendingAborted: () => deferred.every(({ signal }) => signal.aborted),
  close: () => { cleanup(); unmount(); disposed(); },
};
