import assert from "node:assert/strict";
import { test } from "node:test";
import { Message } from "@opencode/ai";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext, SessionTitle } from "@opencode/plugin/promise/session";
import { Runtime } from "../runtime.js";
import { pruningTargets, pruneRequest, type Action, type Edit } from "../pruning-source.js";
import { digest, sourceRecord, sourceUnits } from "../source.js";
import { executePruningCommand } from "../pruning-command.js";

function fixture() {
  const ref = { providerID: "fixture", id: "fixture" };
  const session: Record<string, any> = { id: "ses_pruning", location: { directory: "/fictional" }, model: ref, title: "Fictional session" };
  const tool = (id: string) => ({ type: "tool", id, name: "read", state: {
    status: "completed", input: { path: id }, content: [{ type: "text", text: `Original ${id}` }] } });
  const native: Record<string, any>[] = [{ id: "msg_calls", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { type: "text", text: "Keep text" }, { type: "reasoning", text: "Private thought", state: { reasoningField: "reasoning_content" } }, tool("call_a"), tool("call_b") ] }];
  const messages = [new Message({ role: "assistant", id: "msg_calls", content: [
    { type: "text", text: "Keep text" }, { type: "reasoning", text: "Private thought", providerMetadata: { fixture: { reasoningField: "reasoning_content" } } },
    ...["call_a", "call_b"].map((id) => ({ type: "tool-call" as const, id, name: "read", input: { path: id } })),
  ] }), new Message({ role: "tool", content: ["call_a", "call_b"].map((id) => ({ type: "tool-result" as const,
    id, name: "read", result: { type: "text" as const, value: `Original ${id}` } })) })];
  const store = new Map<string, any>();
  let failWrite = false, busy = false;
  const model = { ...ref, package: "@opencode/ai/providers/openai-compatible", variants: [], limit: { context: 100000 } };
  const ctx = { app: { version: "2.1.2" }, location: session.location, options: { manualPruning: true },
    storage: { get: async (key: string) => structuredClone(store.get(key)), set: async (key: string, value: unknown) => {
      if (failWrite) throw new Error("Storage unavailable"); store.set(key, structuredClone(value)); } },
    session: { get: async () => session, context: async () => native, wait: async () => { if (busy) throw new Error("Busy"); } },
    model: { list: async () => ({ data: [model] }) }, provider: { get: async () => ({ data: { package: model.package } }) },
  } as unknown as Plugin.Context;
  const runtime = new Runtime(ctx);
  const scope = { session_id: session.id, run_id: "run_pruning", instance_id: runtime.instanceID };
  const event = () => ({ sessionID: session.id, model: ref, messages: [...messages], system: [{ type: "text", text: "Keep system" }],
    options: {}, agent: "build", tools: {} }) as SessionContext;
  const preview = async (action: Action = "prune-result", call = "call_a") => {
    const status = await runtime.pruning.inspect(scope);
    assert.ok(status.source_guard);
    return runtime.pruning.preview({ ...scope, revision: status.revision, source_guard: status.source_guard, action,
      target_ids: [status.targets.find((target) => action === "remove-reasoning" ? target.kind === "reasoning" : target.call_id === call)!.id] });
  };
  const apply = async (action?: Action) => runtime.pruning.apply({ ...scope, preview_id: (await preview(action)).preview_id, operation_id: "apply" });
  return { ctx, runtime, scope, native, messages, session, model, store, preview, apply, event,
    writeFailure: (value = true) => { failWrite = value; }, busy: () => { busy = true; } };
}

test("result pruning keeps call, input, sibling output and source; delete expands reasoning and preserves ordering", async () => {
  const f = fixture(), original = JSON.stringify({ native: f.native, messages: f.messages });
  const preview = await f.preview("delete-invocation");
  assert.equal(preview.expanded_count, 1); assert.equal(preview.rows.length, 2); assert.equal(f.store.size, 0);
  assert.match(JSON.stringify(preview.rows), /Private thought/);
  const saved = await f.apply();
  const event = f.event(); await f.runtime.pruning.hook(event, "primary");
  assert.match(JSON.stringify(event.messages), /\[Output pruned\]/);
  assert.equal(event.messages[0], f.messages[0]); assert.deepEqual(event.messages[1].content[1], f.messages[1].content[1]);
  await f.runtime.pruning.restore({ ...f.scope, revision: saved.revision, group_ids: [saved.edits[0].group_id], operation_id: "restore" });
  const deletion = await f.preview("delete-invocation");
  await f.runtime.pruning.apply({ ...f.scope, preview_id: deletion.preview_id, operation_id: "delete" });
  const deleted = f.event(); await f.runtime.pruning.hook(deleted, "primary");
  assert.deepEqual(deleted.messages[0].content.map((part) => part.type), ["text", "tool-call"]);
  assert.doesNotMatch(JSON.stringify(deleted.messages), /call_a|Private thought/);
  assert.match(JSON.stringify(deleted.messages), /call_b|Keep text/);
  assert.equal(JSON.stringify({ native: f.native, messages: f.messages }), original);
  assert.deepEqual(deleted.system, [{ type: "text", text: "Keep system" }]);
});

function conversation() {
  const f = fixture();
  f.native.unshift({ id: "msg_first", type: "user", text: "Original user goal", files: [], time: { created: 0 } });
  f.native.push({ id: "msg_last", type: "user", text: "Keep later user", files: [], time: { created: 3 } });
  f.messages.unshift(new Message({ id: "msg_first", role: "user", content: [{ type: "text", text: "Original user goal" }] }));
  f.messages.push(new Message({ id: "msg_last", role: "user", content: [{ type: "text", text: "Keep later user" }] }));
  const prompts: string[] = [];
  Object.assign(f.ctx, { generate: { text: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return { text: "Reviewed range summary." }; } } });
  const range = async (action: Action = "delete-range", first = "msg_first", last = "msg_calls") => {
    const status = await f.runtime.pruning.inspect(f.scope);
    return f.runtime.pruning.preview({ ...f.scope, revision: status.revision, source_guard: status.source_guard!, action,
      target_ids: [first, last].map((id) => status.targets.find((target) => target.kind === "message" && target.message_id === id)!.id) });
  };
  return { ...f, range, prompts };
}

test("inclusive ranges remove user/assistant text and whole pairs, preserve later context, restore and reject partial request pairs", async () => {
  const f = conversation(), original = JSON.stringify(f.native);
  const preview = await f.range(); assert.equal(preview.rows.length, 2);
  const saved = await f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "range" });
  const event = f.event(); await f.runtime.pruning.hook(event, "primary");
  assert.deepEqual(event.messages, [f.messages.at(-1)]);
  const half = f.event(); half.messages.splice(2, 1);
  await assert.rejects(f.runtime.pruning.hook(half, "primary"), /pair/);
  const unknown = f.event(); unknown.messages[1] = new Message({ ...unknown.messages[1], content: [...unknown.messages[1].content, { type: "text", text: "Injected by another hook" }] });
  await assert.rejects(f.runtime.pruning.hook(unknown, "primary"), /range message/);
  const restarted = new Runtime(f.ctx), scope = { ...f.scope, instance_id: restarted.instanceID };
  const future = f.event(); future.messages.push(new Message({ role: "user", content: [{ type: "text", text: "Future turn" }] }));
  await restarted.pruning.hook(future, "generate");
  assert.equal(future.messages.length, 2); assert.match(JSON.stringify(future.messages), /Future turn/);
  await restarted.pruning.restore({ ...scope, revision: saved.revision, group_ids: [saved.edits[0].group_id], operation_id: "restore" });
  const restored = f.event(); await restarted.pruning.hook(restored, "primary"); assert.deepEqual(restored.messages, f.messages);
  assert.equal(JSON.stringify(f.native), original);
});

test("brief/full summaries are reviewed, inserted once, survive restart and summarize pruned compaction input", async () => {
  for (const action of ["summarize-brief", "summarize-full"] as const) {
    const f = conversation(), preview = await f.range(action);
    assert.equal(f.store.size, 0); assert.match(String(preview.rows[0].after), /historical context.*\nReviewed range summary/s);
    assert.equal(preview.rows[1].after, "");
    assert.match(f.prompts[0], action === "summarize-brief" ? /at most 200 words/ : /full, detailed/);
    assert.doesNotMatch(f.prompts[0], /Keep later user/);
    const saved = await f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "summary" });
    const restarted = new Runtime(f.ctx), event = f.event(); await restarted.pruning.hook(event, "generate");
    assert.equal(event.messages.length, 2); assert.equal(event.messages[0].role, "user");
    assert.doesNotMatch(JSON.stringify(event.messages), /Original|call_a|call_b|Private thought|Keep text/);
    assert.equal(JSON.stringify(event.messages).match(/Reviewed range summary/g)!.length, 1);
    const older = f.event(); older.messages.pop(); await restarted.pruning.hook(older, "compaction");
    assert.equal(older.messages.length, 1); assert.match(JSON.stringify(older.messages), /Reviewed range summary/);
    const absent = f.event(); absent.messages = [f.messages.at(-1)!]; await restarted.pruning.hook(absent, "compaction");
    assert.deepEqual(absent.messages, [f.messages.at(-1)]);
    const checkpoint = { id: "msg_compacted", type: "compaction", status: "completed", summary: "Native checkpoint", time: { created: 4 } };
    f.native.splice(0, f.native.length, checkpoint);
    const reset = await restarted.pruning.policy(f.scope.session_id);
    assert.equal(reset!.revision, saved.revision + 1); assert.deepEqual(reset!.edits, []);
  }
});

test("range guards enforce internal pins, unsupported messages, reverse boundaries and overlapping tool edits", async () => {
  const f = conversation();
  await assert.rejects(f.range("delete-range", "msg_last", "msg_first"), /precede/);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 1, target_ids: [pruningTargets(f.native).find((target) => target.call_id === "call_a")!.id] });
  await assert.rejects(f.range(), /protected/);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 2, target_ids: [] });
  f.native.splice(1, 0, { id: "msg_instruction", type: "system", text: "Keep instructions" });
  await assert.rejects(f.range(), /unsupported/); f.native.splice(1, 1);
  await f.apply(); await assert.rejects(f.range(), /Restore existing edits/);
  const g = conversation(), preview = await g.range();
  await g.runtime.pruning.apply({ ...g.scope, preview_id: preview.preview_id, operation_id: "range" });
  await assert.rejects(g.preview(), /Restore existing edits/);
  await assert.rejects(g.runtime.pruning.protect({ ...g.scope, pin_version: 1, target_ids: [pruningTargets(g.native).find((target) => target.call_id === "call_a")!.id] }), /Restore pruning/);
  const single = conversation(); assert.equal((await single.range("delete-range", "msg_calls", "msg_calls")).rows.length, 1);
});

test("summary errors, cancellation, source drift and competing edits leave prior policy intact", async () => {
  for (const failure of ["empty", "oversize", "throw", "source", "policy", "cancel"]) {
    const f = conversation(), controller = new AbortController();
    Object.assign(f.ctx, { generate: { text: async () => {
      if (failure === "throw") throw new Error("Provider failed");
      if (failure === "source") f.native[0].text = "Changed goal";
      if (failure === "policy") await f.apply();
      if (failure === "cancel") controller.abort();
      return { text: failure === "empty" ? " " : failure === "oversize" ? "x".repeat(17000) : "Summary" };
    } } });
    const status = await f.runtime.pruning.inspect(f.scope);
    await assert.rejects(f.runtime.pruning.preview({ ...f.scope, revision: status.revision, source_guard: status.source_guard!, action: "summarize-brief",
      target_ids: ["msg_first", "msg_calls"].map((id) => status.targets.find((target) => target.kind === "message" && target.message_id === id)!.id) }, controller.signal));
    assert.equal((await f.runtime.pruning.policy(f.scope.session_id))?.edits.length ?? 0, failure === "policy" ? 1 : 0);
  }
});

test("native command previews by default, applies explicitly, filters bytes and names, reports exclusions, restores and rejects invalid options", async () => {
  const f = conversation(), reports: string[] = [];
  const execute = async (text: string) => reports.push(await executePruningCommand(f.runtime, f.scope, text));
  await execute("large 100000 --apply"); assert.match(reports.at(-1)!, /No eligible matches/); assert.equal(f.store.size, 0);
  await execute("tools missing --apply"); assert.match(reports.at(-1)!, /No eligible matches/);
  await execute("tools read --min-bytes 1 --outputs"); assert.equal(f.store.size, 0); assert.match(reports.at(-1)!, /Preview only: 2 edits/);
  const id = reports.at(-1)!.match(/apply (preview_[\w-]+)/)![1];
  await execute(`apply ${id}`); assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.edits.length, 2);
  await execute(`apply ${id}`); assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.revision, 1);
  await execute("restore all"); assert.deepEqual((await f.runtime.pruning.policy(f.scope.session_id))!.edits, []);
  await assert.rejects(execute("tools --unknown --apply"), /Invalid/);
  await execute("summarize brief msg_first msg_calls --apply"); assert.match(reports.at(-1)!, /Applied 2 edits/);
  assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.edits[0].summary, "Reviewed range summary.");
});

test("pin leases renew while a slow range summary is generating outside the session lock", { timeout: 2000 }, async (t) => {
  const f = conversation(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  let started!: () => void, finish!: (value: { text: string }) => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  Object.assign(f.ctx, { generate: { text: () => { started(); return new Promise((resolve) => { finish = resolve; }); } } });
  const target = pruningTargets(f.native).find((target) => target.kind === "message" && target.message_id === "msg_last")!;
  const pins = { ...f.scope, pin_version: 1, target_ids: [target.id] };
  await f.runtime.pruning.protect(pins);
  const pending = f.range("summarize-full"); await ready;
  for (let i = 0; i < 2; i++) {
    now += 30000;
    await f.runtime.serialized(f.scope.session_id, () => f.runtime.pruning.protect(pins));
  }
  finish({ text: "Slow reviewed summary" });
  const preview = await pending;
  const saved = await f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "slow" });
  assert.equal(saved.edits[0].summary, "Slow reviewed summary");
});

test("reasoning-only removal and atomic refusal of missing/duplicate pairs, opaque state and changed input", () => {
  const f = fixture(), targets = pruningTargets(f.native);
  const edits = (id: string, action: Action): Edit[] => targets.filter((target) => target.call_id === id || target.kind === id)
    .map((target) => ({ target_id: target.id, message_id: target.message_id, fingerprint: target.fingerprint, action, group_id: "g" }));
  assert.doesNotMatch(JSON.stringify(pruneRequest(f.native, f.messages, edits("reasoning", "remove-reasoning"))), /Private thought/);
  const toolEdits = edits("call_a", "prune-result"), original = JSON.stringify(f.messages);
  assert.throws(() => pruneRequest(f.native, f.messages, edits("call_a", "delete-invocation")), /associated reasoning/);
  for (const messages of [[f.messages[0]], [...f.messages, f.messages[1]],
    [new Message({ ...f.messages[0], providerMetadata: { fixture: {} } }), f.messages[1]]]) {
    assert.throws(() => pruneRequest(f.native, messages, toolEdits));
  }
  assert.throws(() => pruneRequest(f.native, [...f.messages, f.messages[0]], edits("reasoning", "remove-reasoning")));
  const changed = structuredClone(f.native); changed[0].content[2].state!.input.path = "different";
  assert.throws(() => pruneRequest(changed, f.messages, toolEdits), /source changed/);
  assert.equal(JSON.stringify(f.messages), original);
  for (const state of [{ signature: "signed" }, { reasoningEncryptedContent: "opaque" }, { reasoningField: "reasoning_content", signature: "signed" }]) {
    const source = structuredClone(f.native); source[0].content[1].state = state;
    assert.ok(pruningTargets(source)[0].reason);
    assert.throws(() => pruneRequest(source, f.messages, toolEdits), /Opaque/);
  }
  for (const change of [
    (call: Record<string, any>) => { call.state.status = "running"; },
    (call: Record<string, any>) => { call.state.status = "error"; },
    (call: Record<string, any>) => { call.state.content = [{ type: "file", name: "example.png" }]; },
    (call: Record<string, any>) => { call.executed = true; },
  ]) {
    const source = structuredClone(f.native); change(source[0].content[2]);
    assert.ok(pruningTargets(source)[1].reason);
  }
});

test("current native metadata participates in source bindings and only plain reasoning qualifies", async () => {
  const f = conversation(), before = digest(sourceRecord(f.session, f.native));
  f.native[1].content[1].native = f.native[1].content[1].state; delete f.native[1].content[1].state;
  assert.notEqual(digest(sourceRecord(f.session, f.native)), before);
  const preview = await f.range("summarize-brief");
  await f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "native" });
  const event = f.event(); await f.runtime.pruning.hook(event, "primary");
  assert.match(JSON.stringify(event.messages), /Reviewed range summary/);
  for (const mutate of [
    (source: Record<string, any>[]) => { source[1].native = { messages: [] }; },
    (source: Record<string, any>[]) => { source[1].content[0].native = { signature: "opaque" }; },
    (source: Record<string, any>[]) => { source[1].content[1].native.signature = "opaque"; },
    (source: Record<string, any>[]) => { source[1].content[2].native = {}; },
  ]) {
    const source = structuredClone(f.native); mutate(source);
    assert.notEqual(digest(sourceRecord(f.session, source)), digest(sourceRecord(f.session, f.native)));
    assert.throws(() => pruneRequest(source, f.messages, (f.store.get(`pruning/v1/${f.session.id}`)).edits), /Opaque|Native/);
    assert.ok(pruningTargets(source).some((target) => target.reason));
  }
});

test("successful checkpoint cancels range generation and preview-only state without clearing fresh reviews or pins", async () => {
  const f = conversation();
  const preview = await f.range();
  const pinned = pruningTargets(f.native).find((target) => target.message_id === "msg_last" && target.kind === "message")!;
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 1, target_ids: [pinned.id] });
  let started!: () => void, finish!: (value: { text: string }) => void, signal: AbortSignal | undefined;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  f.ctx.generate.text = async (_, options) => { signal = options?.signal; started(); return new Promise((resolve) => { finish = resolve; }); };
  const pending = f.range("summarize-full"); const rejected = assert.rejects(pending, /abort/i); await ready;
  f.native.unshift({ id: "msg_checkpoint", type: "compaction", status: "completed", summary: "New", time: { created: 4 } });
  await f.runtime.pruning.policy(f.scope.session_id);
  assert.ok(signal?.aborted); finish({ text: "Obsolete summary" }); await rejected;
  await assert.rejects(f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "old" }), /Preview expired/);
  const fresh = await f.range(); await f.runtime.pruning.policy(f.scope.session_id);
  assert.ok((await f.runtime.pruning.inspect(f.scope)).targets.find((target) => target.id === pinned.id)!.pinned);
  assert.equal((await f.runtime.pruning.apply({ ...f.scope, preview_id: fresh.preview_id, operation_id: "fresh" })).edits.length, 2);
});

test("durable restart, disabled admission replay, future messages, compaction/title isolation, independent child and restore", async () => {
  const f = fixture(), saved = await f.apply();
  f.runtime.close(); (f.ctx.options as Record<string, unknown>).manualPruning = false;
  const restarted = new Runtime(f.ctx), scope = { ...f.scope, instance_id: restarted.instanceID, run_id: "run_after_restart" };
  const event = f.event(); event.messages.push(new Message({ role: "user", content: [{ type: "text", text: "Future turn" }] }));
  await restarted.pruning.hook(event, "generate");
  assert.match(JSON.stringify(event.messages), /Future turn/); assert.doesNotMatch(JSON.stringify(event.messages), /Original call_a/);
  const compaction = f.event(); await restarted.pruning.hook(compaction, "compaction");
  assert.doesNotMatch(JSON.stringify(compaction.messages), /Original call_a/);
  assert.equal((await restarted.pruning.policy(scope.session_id))!.edits.length, 1);
  const title = { ...f.event() } as SessionTitle; await restarted.pruning.title(title); assert.equal(title.result, f.session.title);
  const child = f.event(); (child as { sessionID: string }).sessionID = "ses_child";
  await restarted.pruning.hook(child, "primary"); assert.match(JSON.stringify(child.messages), /Original call_a/);
  await restarted.pruning.restore({ ...scope, revision: saved.revision, group_ids: [saved.edits[0].group_id], operation_id: "restore" });
  const original = f.event(); await restarted.pruning.hook(original, "primary"); assert.deepEqual(original.messages, f.messages);
});

test("successful checkpoint resets after restart, invalidates previews and receipts cannot revive old edits", async () => {
  const f = fixture(), preview = await f.preview();
  const apply = { ...f.scope, preview_id: preview.preview_id, operation_id: "original" };
  const saved = await f.runtime.pruning.apply(apply);
  const pending = await f.preview("prune-result", "call_b");
  const nextMessage = structuredClone(f.native[0]); nextMessage.id = "msg_new"; nextMessage.time.created = 4;
  f.native.splice(0, f.native.length, { id: "msg_checkpoint", type: "compaction", status: "completed", time: { created: 3 }, summary: "Summary", recent: "Native recent" }, nextMessage);
  const restarted = new Runtime(f.ctx), scope = { ...f.scope, instance_id: restarted.instanceID };
  const status = await restarted.pruning.inspect(scope);
  assert.equal(status.revision, saved.revision + 1); assert.deepEqual(status.edits, []);
  assert.equal(status.last_compaction?.id, "msg_checkpoint");
  assert.deepEqual((await restarted.pruning.apply({ ...apply, instance_id: restarted.instanceID })).edits, []);
  await assert.rejects(f.runtime.pruning.apply({ ...f.scope, preview_id: pending.preview_id, operation_id: "stale" }), /Preview expired|changed/);
  const fresh = await restarted.pruning.preview({ ...scope, revision: status.revision, source_guard: status.source_guard!,
    action: "prune-result", target_ids: [status.targets.find((target) => target.call_id === "call_a")!.id] });
  const applied = await restarted.pruning.apply({ ...scope, preview_id: fresh.preview_id, operation_id: "fresh" });
  assert.equal(applied.edits.length, 1); assert.equal((await restarted.pruning.policy(scope.session_id))!.edits.length, 1);
});

test("compaction prefix prunes present targets, tolerates excluded recent owners, and refuses half-pairs", async () => {
  const f = fixture(); await f.apply("delete-invocation");
  const older = f.event(); await f.runtime.pruning.hook(older, "compaction");
  assert.doesNotMatch(JSON.stringify(older.messages), /call_a|Private thought/);
  assert.match(JSON.stringify(older.messages), /call_b/);
  const absent = f.event(); absent.messages = [new Message({ role: "user", content: [{ type: "text", text: "Older prefix" }] })];
  await f.runtime.pruning.hook(absent, "compaction"); assert.match(JSON.stringify(absent.messages), /Older prefix/);
  const half = f.event(); half.messages = [f.messages[1]];
  await assert.rejects(f.runtime.pruning.hook(half, "compaction"), /pair/);
  assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.edits.length, 2);
});

test("failed/interrupted compaction, old checkpoints and undo preserve edits; reset writes retry safely", async () => {
  const f = fixture(); f.native.unshift({ id: "msg_old", type: "compaction", status: "completed", time: { created: 0 }, summary: "Old" });
  const saved = await f.apply();
  for (const status of ["running", "failed"]) {
    f.native.push({ id: `msg_${status}`, type: "compaction", status, time: { created: 3 } });
    assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.revision, saved.revision);
    f.native.pop();
  }
  const checkpoint = { id: "msg_new_checkpoint", type: "compaction", status: "completed", time: { created: 4 }, summary: "New" };
  f.native.unshift(checkpoint); f.session.revert = {};
  assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.edits.length, 1);
  delete f.session.revert;
  // The latest completed checkpoint appears first in API context; simulate its normal replacement of the old one.
  f.native.splice(1, 1);
  f.writeFailure(); const before = JSON.stringify([...f.store]);
  await assert.rejects(f.runtime.pruning.hook(f.event(), "primary"), /Storage/);
  assert.equal(JSON.stringify([...f.store]), before);
  f.writeFailure(false);
  assert.deepEqual((await f.runtime.pruning.policy(f.scope.session_id))!.edits, []);
});

test("legacy saved policies acquire a checkpoint baseline before compaction dispatch", async () => {
  const f = fixture(); await f.apply();
  const policy = f.store.get(`pruning/v1/${f.scope.session_id}`); delete policy.checkpoint;
  await f.runtime.pruning.hook(f.event(), "compaction");
  assert.equal(f.store.get(`pruning/v1/${f.scope.session_id}`).checkpoint.id, null);
  f.native.splice(0, f.native.length, { id: "msg_checkpoint", type: "compaction", status: "completed", time: { created: 3 }, summary: "New" });
  assert.deepEqual((await f.runtime.pruning.policy(f.scope.session_id))!.edits, []);
});

test("source/policy/pin guards, busy and foreign previews refuse without writes; retries are idempotent", async () => {
  const f = fixture(), preview = await f.preview();
  const apply = { ...f.scope, preview_id: preview.preview_id, operation_id: "apply" };
  await assert.rejects(f.runtime.pruning.apply({ ...apply, run_id: "foreign" }), /belongs/);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 1, target_ids: [pruningTargets(f.native)[1].id] });
  await assert.rejects(f.runtime.pruning.apply(apply), /pins changed/);
  await assert.rejects(f.preview(), /protected/);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 2, target_ids: [] });
  const next = await f.preview();
  f.native[0].content[2].state!.content[0].text = "Changed result";
  await assert.rejects(f.runtime.pruning.apply({ ...apply, preview_id: next.preview_id }), /changed/);
  assert.equal(f.store.size, 0);
  const saved = await f.apply();
  const persisted = JSON.stringify([...f.store]);
  const receiptPreview = (await f.runtime.pruning.policy(f.scope.session_id))!.receipts[0];
  assert.equal(receiptPreview.id, "apply");
  await assert.rejects(f.runtime.pruning.apply(apply), /Operation ID/);
  const state = await f.runtime.pruning.inspect(f.scope);
  const second = await f.preview("prune-result", "call_b");
  const request = { ...f.scope, preview_id: second.preview_id, operation_id: "second" };
  await f.runtime.pruning.apply(request); const repeated = await f.runtime.pruning.apply(request);
  assert.equal(repeated.edits.length, 2); assert.equal(repeated.revision, saved.revision + 1);
  await assert.rejects(f.runtime.pruning.restore({ ...f.scope, revision: state.revision, group_ids: [saved.edits[0].group_id], operation_id: "old" }), /changed/);
  assert.notEqual(JSON.stringify([...f.store]), persisted);
  const busy = fixture(); busy.busy(); await assert.rejects(busy.preview(), /idle/); assert.equal(busy.store.size, 0);
});

test("failed persistence and corrupt policies fail closed; drift still allows restoration", async () => {
  const f = fixture(), preview = await f.preview(); f.writeFailure();
  await assert.rejects(f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: "fail" }), /Storage/);
  assert.equal(f.store.size, 0);
  const existing = fixture(), first = await existing.apply();
  const next = await existing.preview("prune-result", "call_b"), before = JSON.stringify([...existing.store]);
  existing.writeFailure();
  await assert.rejects(existing.runtime.pruning.apply({ ...existing.scope, preview_id: next.preview_id, operation_id: "failed_second" }), /Storage/);
  assert.equal(JSON.stringify([...existing.store]), before); assert.equal((await existing.runtime.pruning.policy(existing.scope.session_id))!.revision, first.revision);
  const g = fixture(), saved = await g.apply(); g.native[0].content[2].state!.content[0].text = "Drift";
  const event = g.event(); await assert.rejects(g.runtime.pruning.hook(event, "primary"), /changed/); assert.deepEqual(event.messages, g.messages);
  await g.runtime.pruning.restore({ ...g.scope, revision: saved.revision, group_ids: [saved.edits[0].group_id], operation_id: "restore" });
  g.store.set(`pruning/v1/${g.scope.session_id}`, { version: 999 });
  await assert.rejects(g.runtime.pruning.hook(g.event(), "primary"), /invalid/);
  await assert.rejects(g.runtime.pruning.title(g.event()), /invalid/);
  const h = fixture(), valid = await h.apply(); h.native[0].content[2].state.input.path = NaN;
  const drifted = await h.runtime.pruning.inspect(h.scope);
  assert.equal(drifted.edits.length, 1); assert.match(drifted.reason!, /interoperable/);
  await h.runtime.pruning.restore({ ...h.scope, revision: valid.revision, group_ids: [valid.edits[0].group_id], operation_id: "restore_invalid_source" });
});

test("model/revert/location changes block replay; summaries cannot expose pruned source", async () => {
  const f = fixture(); await f.apply();
  const unit = [...sourceUnits(f.session, f.native).values()][0];
  const input = { ...f.scope, operation_id: "summary", source_guard: digest(sourceRecord(f.session, f.native)), units: [unit], model: f.session.model };
  await assert.rejects(f.runtime.generate(input), /Restore pruning/);
  await assert.rejects(f.runtime.activate({ ...input, draft_version: 1, summaries: { [unit.unit_id]: "Summary" } }), /Restore pruning/);
  f.session.revert = {}; await assert.rejects(f.runtime.pruning.hook(f.event(), "primary"), /undo/); delete f.session.revert;
  f.session.model = { ...f.session.model, id: "changed" }; await assert.rejects(f.runtime.pruning.hook(f.event(), "primary"), /model/);
  f.session.location = { directory: "/moved" }; await assert.rejects(f.runtime.pruning.hook(f.event(), "primary"), /moved/);
});

test("live protection expires, summary overlap is rejected, and competing reviewed commits serialize", async (t) => {
  const f = fixture(); let now = Date.now(); t.mock.method(Date, "now", () => now);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 0, target_ids: [pruningTargets(f.native)[0].id] });
  await assert.rejects(f.preview("delete-invocation"), /associated reasoning/);
  await f.runtime.pruning.protect({ ...f.scope, pin_version: 1, target_ids: [pruningTargets(f.native)[1].id] });
  await assert.rejects(f.preview(), /protected/);
  now += 45001;
  const a = await f.preview(), b = await f.preview("prune-result", "call_b");
  const results = await Promise.allSettled([a, b].map((preview, index) => f.runtime.serialized(f.scope.session_id,
    () => f.runtime.pruning.apply({ ...f.scope, preview_id: preview.preview_id, operation_id: `concurrent_${index}` }))));
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.equal((await f.runtime.pruning.policy(f.scope.session_id))!.edits.length, 1);
  const g = fixture(); delete g.native[0].content[1].state;
  const unit = [...sourceUnits(g.session, g.native).values()][0];
  await g.runtime.activate({ ...g.scope, source_guard: digest(sourceRecord(g.session, g.native)), operation_id: "summary",
    draft_version: 1, units: [unit], summaries: { [unit.unit_id]: "Summary" } });
  await assert.rejects(g.preview(), /overlapping summaries/);
});
