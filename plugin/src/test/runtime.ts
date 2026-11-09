import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Message } from "@opencode/ai";
import type { Plugin } from "@opencode/plugin";
import type { SessionContext } from "@opencode/plugin/promise/session";
import { Runtime } from "../runtime.js";
import { digest, sourceRecord, sourceUnits, unitRecord, validateSummaries } from "../source.js";
import { transform } from "../transform.js";

const fixture = JSON.parse(readFileSync(new URL("../../../tests/fixtures/source-v1.json", import.meta.url), "utf8"));

function setup() {
  const data = structuredClone(fixture);
  const model = { ...data.session.model, package: "@opencode/ai/providers/openai-compatible", variants: [], limit: { context: 100000 } };
  let now = 0, calls = 0;
  const units = [...sourceUnits(data.session, data.messages).values()];
  const ctx = { app: { version: "2.1.2" }, location: data.session.location, options: {}, storage: { get: async () => undefined },
    session: { get: async () => data.session, context: async () => data.messages },
    provider: { get: async () => ({ data: { package: model.package } }) }, model: { list: async () => ({ data: [model] }) },
    generate: { text: async () => { calls++; return { text: JSON.stringify({ [units[0].unit_id]: "Reviewed summary." }) }; } },
  } as unknown as Plugin.Context;
  const runtime = new Runtime(ctx, () => now);
  const scope = { session_id: data.session.id, run_id: "run_test", instance_id: runtime.instanceID };
  const input = { ...scope, operation_id: "op_activate", source_guard: digest(sourceRecord(data.session, data.messages)),
    draft_version: 1, units: units.map(({ unit_id, message_id, call_id, fingerprint }) => ({ unit_id, message_id, call_id, fingerprint })),
    summaries: { [units[0].unit_id]: "Reviewed summary." } };
  const unit = units[0];
  const messages = [new Message({ id: unit.message_id, role: "assistant", content: [
    { type: "text", text: "Before." }, { type: "reasoning", text: "Reasoning." },
    { type: "tool-call", id: unit.call_id, name: unit.name, input: unit.input },
    { type: "tool-call", id: "call_other", name: "read", input: {} }, { type: "text", text: "After." },
  ] }), new Message({ role: "tool", content: [
    { type: "tool-result", id: unit.call_id, name: unit.name, result: { type: "content", value: unit.content } },
    { type: "tool-result", id: "call_other", name: "read", result: { type: "text", value: "Unselected." } },
  ] })];
  const event = () => ({ sessionID: data.session.id, model: data.session.model, messages, system: [], options: {}, tools: {}, agent: "build" }) as unknown as SessionContext;
  return { runtime, input, scope, data, model, ctx, units, messages, event, advance: (ms: number) => { now += ms; }, calls: () => calls };
}

test("canonical input and strict complete summary validation", () => {
  assert.equal(digest({ "é": 2, "a": 1 }), digest({ a: 1, "é": 2 }));
  for (const value of [NaN, Infinity, 9007199254740992, "\uD800"]) assert.throws(() => digest(value));
  const invalid: Record<string, string>[] = [{}, { a: "" }, { a: "yes", b: "no" }, { a: "x".repeat(16385) }];
  for (const summaries of invalid) {
    assert.throws(() => validateSummaries(["a"], summaries));
  }
});

test("atomic transform preserves unrelated text/reasoning/order and source immutability", () => {
  const { messages, units, input } = setup(), original = JSON.stringify(messages);
  const result = transform(messages, input.session_id, units, input.summaries);
  assert.equal(JSON.stringify(messages), original);
  assert.deepEqual(result[0].content.map((part) => part.type), ["text", "reasoning", "text", "tool-call", "text"]);
  assert.equal(result[1].content.length, 1);
  assert.match(JSON.stringify(result), /Reviewed summary/);
  const broken = [{ ...units[0], call_id: "missing" }, units[0]];
  assert.throws(() => transform(messages, input.session_id, broken, input.summaries));
  assert.equal(JSON.stringify(messages), original);
  assert.throws(() => transform([...messages, messages[1]], input.session_id, units, input.summaries));
});

test("idempotent activation, closure, deactivation and nonoverlap", async () => {
  const { runtime, input, scope, event } = setup();
  const first = await runtime.activate(input);
  assert.equal((await runtime.activate(input)).bundle_id, first.bundle_id);
  await assert.rejects(runtime.activate({ ...input, summaries: { [input.units[0].unit_id]: "Changed" } }), /Operation ID/);
  await assert.rejects(runtime.activate({ ...input, operation_id: "overlap" }), /already has/);
  const request = event(); runtime.hook(request);
  assert.equal(runtime.status(scope).bundles[0].state, "observed-applied");
  runtime.deactivate({ ...scope, operation_id: "stop", bundle_id: first.bundle_id });
  assert.equal(runtime.status({ ...scope, operation_id: "stop" }).bundles[0].state, "deactivated");
  const restored = event(); runtime.hook(restored);
  assert.ok(!JSON.stringify(restored.messages).includes("Reviewed summary"));
  runtime.close();
});

test("lease expiry, ownership, restart and suspension never revive", async () => {
  const { runtime, input, scope, advance, event } = setup();
  const bundle = await runtime.activate(input);
  await assert.rejects(runtime.activate({ ...input, run_id: "other", operation_id: "other" }), /Another dashboard/);
  advance(44000); runtime.renew({ ...scope, bundle_ids: [bundle.bundle_id], job_ids: [] });
  advance(44000); assert.equal(runtime.status(scope).bundles[0].state, "registered");
  advance(1000); assert.equal(runtime.status(scope).bundles[0].state, "expired");
  runtime.renew({ ...scope, bundle_ids: [bundle.bundle_id], job_ids: [] });
  assert.equal(runtime.status(scope).bundles[0].state, "expired");
  const next = await runtime.activate({ ...input, operation_id: "new_review" });
  const changed = event(); changed.messages = [];
  runtime.hook(changed);
  assert.equal(runtime.status(scope).bundles.find((b) => b.bundle_id === next.bundle_id)?.state, "suspended");
  runtime.renew({ ...scope, bundle_ids: [next.bundle_id], job_ids: [] });
  assert.equal(runtime.status(scope).bundles.find((b) => b.bundle_id === next.bundle_id)?.state, "suspended");
  assert.notEqual(setup().runtime.instanceID, runtime.instanceID);
  runtime.close(); assert.throws(() => runtime.status(scope), /restarted/);
});

test("source/profile admission rejects drift, duplicate IDs, native state, unsafe numbers", async () => {
  for (const mutate of [
    (s: ReturnType<typeof setup>) => { s.data.messages[0].text = "changed"; },
    (s: ReturnType<typeof setup>) => { s.model.package = "@opencode/ai/providers/openai"; },
    (s: ReturnType<typeof setup>) => { s.data.messages[0].providerContext = { opaque: true }; s.input.source_guard = digest(sourceRecord(s.data.session, s.data.messages)); },
    (s: ReturnType<typeof setup>) => { s.data.messages[0].native = { messages: [] }; s.input.source_guard = digest(sourceRecord(s.data.session, s.data.messages)); },
    (s: ReturnType<typeof setup>) => { s.data.messages[1].content[1].native = { signature: "signed" }; s.input.source_guard = digest(sourceRecord(s.data.session, s.data.messages)); },
    (s: ReturnType<typeof setup>) => { s.data.messages[1].content.push(s.data.messages[1].content[1]); s.input.source_guard = digest(sourceRecord(s.data.session, s.data.messages)); },
  ]) {
    const s = setup(); mutate(s); await assert.rejects(s.runtime.activate(s.input));
    assert.deepEqual(s.runtime.status(s.scope).bundles, []); s.runtime.close();
  }
});

test("host versions are informational, including future versions; profile and instance checks remain", async () => {
  for (const version of ["2.0.25", "2.1.2", "99.7.3-next", "development"]) {
    const s = setup(); Object.assign(s.ctx.app, { version });
    assert.equal(s.runtime.capabilities().host_version, version);
    assert.deepEqual(s.runtime.capabilities().profiles, ["openai-compatible-http-full-replay-v1"]);
    assert.equal((await s.runtime.activate(s.input)).state, "registered");
    await assert.rejects(s.runtime.activate({ ...s.input, instance_id: "other" }), /restarted/);
    s.model.package = "@opencode/ai/providers/openai";
    await assert.rejects(s.runtime.activate({ ...s.input, operation_id: "unsupported" }), /profile/);
    s.runtime.close();
  }
});

test("checkpoint reset retires retained-tail leases and jobs, ignores failed checkpoints and never revives retries", async () => {
  for (const running of [false, true]) {
    const s = setup();
    const bundle = await s.runtime.activate(s.input);
    const { summaries: _, draft_version: __, ...source } = s.input;
    let finish!: (value: { text: string }) => void, signal: AbortSignal | undefined;
    if (running) s.ctx.generate.text = async (_, options) => { signal = options?.signal; return new Promise((resolve) => { finish = resolve; }); };
    const generation = { ...source, operation_id: "job", model: s.data.session.model };
    const job = await s.runtime.generate(generation);
    await new Promise((resolve) => setImmediate(resolve));
    const marker = { id: "msg_checkpoint", type: "compaction", status: "failed", summary: "Checkpoint", time: { created: Date.now() } };
    s.data.messages.unshift(marker);
    await s.runtime.pruning.policy(s.scope.session_id);
    assert.equal(s.runtime.status(s.scope).bundles[0].state, "registered");
    marker.status = "completed";
    // Source invocations are deliberately retained: matching them must not keep old replacements alive.
    const event = s.event(); await s.runtime.pruning.hook(event, "primary"); s.runtime.hook(event);
    assert.deepEqual(event.messages, s.messages);
    assert.equal((await s.runtime.activate(s.input)).state, "deactivated");
    assert.equal((await s.runtime.generate(generation)).state, "cancelled");
    s.runtime.renew({ ...s.scope, bundle_ids: [bundle.bundle_id], job_ids: [job.job_id] });
    if (running) {
      assert.ok(signal?.aborted); finish({ text: JSON.stringify(s.input.summaries) });
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(s.runtime.generationStatus({ ...s.scope, job_id: job.job_id }).summaries, null);
    const fresh = await s.runtime.activate({ ...s.input, operation_id: "fresh", source_guard: digest(sourceRecord(s.data.session, s.data.messages)) });
    await s.runtime.pruning.policy(s.scope.session_id); // Delayed completion event for the same checkpoint.
    assert.equal(s.runtime.status(s.scope).bundles.find((entry) => entry.bundle_id === fresh.bundle_id)!.state, "registered");
    s.runtime.close();
  }
});

test("generation is stateless, idempotent, leased and validates exact maps", async () => {
  const s = setup();
  const { summaries: _, draft_version: __, ...source } = s.input;
  const input = { ...source, model: s.data.session.model };
  const job = await s.runtime.generate(input);
  assert.equal((await s.runtime.generate(input)).job_id, job.job_id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(s.runtime.generationStatus({ ...s.scope, job_id: job.job_id }).state, "completed");
  assert.equal(s.calls(), 1);
  assert.deepEqual(s.runtime.status(s.scope).bundles, []);
  s.runtime.close();
});

test("changed unit fingerprints suspend entire bundles", async () => {
  const s = setup();
  await s.runtime.activate(s.input);
  const event = s.event();
  event.messages = [event.messages[0], new Message({ role: "tool", content: [
    { type: "tool-result", id: s.units[0].call_id, name: "read", result: { type: "text", value: "Changed" } },
  ] })];
  const original = JSON.stringify(event.messages);
  s.runtime.hook(event);
  assert.equal(JSON.stringify(event.messages), original);
  assert.equal(s.runtime.status(s.scope).bundles[0].state, "suspended");
  assert.notEqual(s.units[0].fingerprint, digest(unitRecord(s.input.session_id, s.units[0].message_id, s.units[0].call_id, "read", {}, [])));
  s.runtime.close();
});

test("generation cancellation and lease expiry abort the stateless request", async () => {
  for (const cancel of [true, false]) {
    const s = setup();
    let aborted = false;
    s.ctx.generate.text = async (_, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("Cancelled")); });
    });
    const { summaries: _, draft_version: __, ...source } = s.input;
    const job = await s.runtime.generate({ ...source, model: s.data.session.model });
    if (cancel) s.runtime.cancelGeneration({ ...s.scope, job_id: job.job_id });
    else { s.advance(45000); s.runtime.expire(); }
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(aborted);
    assert.equal(s.runtime.generationStatus({ ...s.scope, job_id: job.job_id }).state, cancel ? "cancelled" : "expired");
    assert.deepEqual(s.runtime.status(s.scope).bundles, []);
    s.runtime.close();
  }
});

test("generation prompt bounds and incomplete maps fail without partial summaries", async () => {
  const s = setup();
  const { summaries: _, draft_version: __, ...source } = s.input;
  s.model.limit.context = 10;
  await assert.rejects(s.runtime.generate({ ...source, model: s.data.session.model }), /capacity bound/);
  assert.equal(s.calls(), 0);
  s.model.limit.context = 100000;
  s.ctx.generate.text = async () => ({ text: '{"unselected":"Wrong mapping"}' });
  const job = await s.runtime.generate({ ...source, operation_id: "incomplete", model: s.data.session.model });
  await new Promise((resolve) => setImmediate(resolve));
  const result = s.runtime.generationStatus({ ...s.scope, job_id: job.job_id });
  assert.equal(result.state, "failed"); assert.equal(result.summaries, null);
  s.runtime.close();
});

test("generation deadline aborts work even while its lease remains renewed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  let aborted = false;
  s.ctx.generate.text = async (_, options) => new Promise((_, reject) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("Deadline")); });
  });
  const { summaries: _, draft_version: __, ...source } = s.input;
  const job = await s.runtime.generate({ ...source, model: s.data.session.model });
  t.mock.timers.tick(120000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(aborted);
  assert.equal(s.runtime.generationStatus({ ...s.scope, job_id: job.job_id }).state, "failed");
  s.runtime.close();
});
