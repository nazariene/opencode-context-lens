import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionRef } from "@opencode/plugin/gui";
import { DesktopCommands } from "../desktop-command.js";

function fixture(server = "remote", id = "ses_example") {
  const calls: { method: string; input: any; options: any }[] = [];
  let reply = async () => ({ report: "Preview only: apply preview_fixture" });
  const client = {
    session: { get: async (input: any, options: any) => {
      calls.push({ method: "get", input, options });
      return { title: "Fictional session", location: { directory: `/fictional/${server}` } };
    } },
    rpc: () => ({
      capabilities: async (input: any, options: any) => {
        calls.push({ method: "capabilities", input, options }); return { instance_id: `instance_${server}` };
      },
      pruningCommand: async (input: any, options: any) => { calls.push({ method: "command", input, options }); return reply(); },
    }),
  };
  const serverRef = { client };
  const session = { key: `${server}\n${id}`, id, pending: false, server: serverRef } as unknown as SessionRef;
  return { session, calls, serverRef, respond: (fn: typeof reply) => { reply = fn; } };
}

test("Desktop preview/apply use one window run and the selected server's fresh client and location", async () => {
  const commands = new DesktopCommands(() => {}), remote = fixture();
  await commands.execute(remote.session, "/lens-prune tools all --outputs");
  await commands.execute(remote.session, "apply preview_fixture");
  const requests = remote.calls.filter((call) => call.method === "command");
  assert.equal(requests[0].input.text, "tools all --outputs");
  assert.equal(requests[1].input.text, "apply preview_fixture");
  assert.equal(requests[0].input.run_id, requests[1].input.run_id);
  assert.equal(requests[0].input.session_id, remote.session.id);
  assert.equal(requests[0].input.instance_id, "instance_remote");
  assert.deepEqual(requests[0].options.location, { directory: "/fictional/remote" });
  const restarted = fixture("restarted");
  remote.serverRef.client = restarted.serverRef.client;
  await commands.execute(remote.session, "status");
  assert.equal(restarted.calls.at(-1)!.input.instance_id, "instance_restarted");
  const otherWindow = new DesktopCommands(() => {});
  await otherWindow.execute(remote.session);
  assert.notEqual(restarted.calls.at(-1)!.input.run_id, requests[0].input.run_id);
  commands.close(); otherWindow.close();
});

test("late Desktop reports are server/session isolated and duplicate pending commands do not dispatch", async () => {
  const commands = new DesktopCommands(() => {}), a = fixture("alpha"), b = fixture("beta");
  let finish!: (value: { report: string }) => void;
  a.respond(() => new Promise((resolve) => { finish = resolve; }));
  const pending = commands.execute(a.session, "summarize brief first last");
  await commands.execute(a.session, "restore all");
  await commands.execute(b.session, "status");
  assert.equal(a.calls.filter((call) => call.method === "command").length, 1);
  finish({ report: "Alpha summary" }); await pending;
  assert.equal(commands.state(a.session.key)?.report, "Alpha summary");
  assert.notEqual(commands.state(b.session.key)?.report, "Alpha summary");
  commands.close();
});

test("Desktop errors stay local, report cache is bounded, and unload aborts requests and ignores replies", async () => {
  let changes = 0;
  const commands = new DesktopCommands(() => changes++), failed = fixture();
  failed.respond(async () => { throw new Error("Unsupported provider profile"); });
  await commands.execute(failed.session, "tools all");
  assert.equal(commands.state(failed.session.key)?.failed, true);
  assert.match(commands.state(failed.session.key)!.report, /Unsupported provider profile/);
  for (let index = 0; index < 8; index++) await commands.execute(fixture(`server_${index}`).session, "status");
  assert.equal(commands.state(failed.session.key), undefined);
  const slow = fixture("slow");
  let finish!: (value: { report: string }) => void;
  slow.respond(() => new Promise((resolve) => { finish = resolve; }));
  const pending = commands.execute(slow.session, "status");
  await Promise.resolve(); await Promise.resolve();
  const signal = slow.calls.at(-1)!.options.signal;
  commands.close();
  const count = changes;
  assert.equal(signal.aborted, true);
  finish({ report: "Late reply" }); await pending;
  assert.equal(changes, count);
  assert.equal(commands.state(slow.session.key), undefined);
});
