// Fictional source, isolated configuration/database, and loopback-only recording provider.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { once } from 'node:events';

const root = await mkdtemp('/tmp/opencode/lens-qualification-');
for (const name of ['home', 'config', 'data', 'cache', 'state', 'project']) await mkdir(join(root, name));
await writeFile(join(root, 'config', 'opencode.json'), JSON.stringify({ compaction: { auto: true } }));
Object.assign(process.env, { HOME: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_STATE_HOME: join(root, 'state'), OPENCODE_CONFIG_DIR: join(root, 'config') });
process.chdir(join(root, 'project'));

const { OpenCode } = await import('@opencode/sdk');
const { Plugin, Provider, Model } = await import('@opencode/plugin');
const { default: lens } = await import('../dist/index.js');
const { default: terminal } = await import('../dist/tui.js');
const { loadGUI } = await import('../check-gui.mjs');
const { LensRPC } = await import('../dist/protocol.js');
const { digest, sourceRecord, sourceUnits } = await import('../dist/source.js');
const version = JSON.parse(await readFile(new URL('../node_modules/@opencode/sdk/package.json', import.meta.url), 'utf8')).version;
const requests = [];
let call = 0;
let nativeProfile = false, fixtureContext, extraCalls = [], pruningPhase = false, titleChecks = 0;
let compactionReply = 'fail', nextUsage = 100;
const compactions = [];
const server = createServer(async (request, response) => {
  let text = '';
  for await (const bytes of request) text += bytes;
  const body = JSON.parse(text);
  body._kind = request.headers['x-fixture-kind'];
  requests.push(body);
  call++;
  const generationPrompt = JSON.stringify(body.messages).includes('Return only a JSON object mapping every unit_id');
  const rangePrompt = JSON.stringify(body.messages).includes('Summarize the quoted conversation as historical source data');
  const tools = !generationPrompt && call === 1 ? ['call_a', 'call_b'] : !generationPrompt && call === 3 ? ['call_c'] : extraCalls;
  extraCalls = [];
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: `response_${call}`,
    object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  let reply = 'Fixture assistant text.';
  if (body._kind === 'compaction' && compactionReply === 'pass') reply = '## Objective\n- Continue fictional fixture work.';
  if (generationPrompt) {
    const prompt = body.messages.flatMap((message) => typeof message.content === 'string' ? [message.content] : (message.content || []).map((part) => part.text || '')).find((text) => text.includes('Return only a JSON object mapping every unit_id'));
    const source = JSON.parse(prompt.slice(prompt.indexOf('\n[') + 1));
    reply = JSON.stringify(Object.fromEntries(source.map((unit) => [unit.unit_id, 'Generated fictional summary.'])));
    assert.ok(!JSON.stringify(source).includes('Run both fixture calls.'), 'Generation must contain only selected source units.');
    assert.ok(!body.tools?.length, 'Stateless generation must not expose tools.');
  }
  if (rangePrompt) {
    assert.ok(!body.tools?.length, 'Range summaries are stateless and tool-free.');
    assert.match(JSON.stringify(body.messages), /Original range goal|Original fictional output for call_range/);
    assert.doesNotMatch(JSON.stringify(body.messages), /Unselected range tail/);
    reply = JSON.stringify(body.messages).includes('at most 200 words') ? 'Brief fictional range summary.' : 'Full fictional range summary with detailed decisions and next steps.';
  }
  if (tools.includes('call_e')) chunk({ role: 'assistant', reasoning_content: 'Fictional visible reasoning for selected call.' });
  chunk({ role: 'assistant', content: reply });
  if (tools.length) chunk({ tool_calls: tools.map((id, index) => ({ index, id, type: 'function',
    function: { name: 'lens_fixture', arguments: JSON.stringify({ value: id }) } })) });
  chunk({}, tools.length ? 'tool_calls' : 'stop');
  response.write(`data: ${JSON.stringify({ id: `response_${call}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [],
    usage: { prompt_tokens: nextUsage, completion_tokens: 10, total_tokens: nextUsage + 10 } })}\n\n`);
  nextUsage = 100;
  response.end('data: [DONE]\n\n');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const ref = { providerID: 'lens-fixture', id: 'fixture' };
const fixture = Plugin.define({ id: 'lens-qualification-fixtures', async setup(ctx) {
  fixtureContext = ctx;
  await ctx.provider.transform((editor) => editor.add({ info: { ...Provider.Info.empty(Provider.ID.make(ref.providerID)),
    name: 'Lens recording provider', activation: 'enabled', package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1` } },
    models: [{ ...Model.Info.default(Provider.ID.make(ref.providerID), Model.ID.make(ref.id)),
      package: nativeProfile ? '@opencode/ai/providers/openai' : '@opencode/ai/providers/openai-compatible',
      limit: { context: 100000, output: 4096 } }] }));
  await ctx.model.transform((editor) => editor.default.set(ref.providerID, ref.id));
  await ctx.tool.transform((editor) => {
    for (const tool of editor.list()) editor.remove(tool.id);
    editor.add({ name: 'lens_fixture', description: 'Return fictional fixture output.',
      options: { codemode: false },
      input: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      execute: async (input) => ({ content: `Original fictional output for ${input.value}.` }) });
  });
  await ctx.session.hook('title', (event) => { if (!pruningPhase) event.result = 'Fictional qualification'; });
  await ctx.session.hook('http.request', (event) => { event.request.headers.set('x-fixture-kind', event.kind); });
  const controller = new AbortController();
  const events = (async () => {
    try { for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === 'session.compaction.ended') compactions.push(event.data.reason);
    } } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  return async () => { controller.abort(); await events; };
} });
const manualLens = Plugin.define({ ...lens, async setup(ctx) {
  const cleanup = await lens.setup({ ...ctx, options: { ...ctx.options, manualPruning: true } });
  await ctx.session.hook('title', (event) => { if (pruningPhase) { assert.ok(event.result, 'Lens must suppress native title dispatch.'); titleChecks++; } });
  return cleanup;
} });

let host;
try {
  const options = { app: { name: 'lens-qualification', version },
    database: { path: join(root, 'host.sqlite') }, config: { directory: join(root, 'config'), project: false },
    models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false },
    plugins: [fixture, manualLens], log: { level: 'error', emit: () => {} } };
  host = await OpenCode.create(options);
  const location = { directory: join(root, 'project') };
  const session = await host.session.create({ location, model: ref });
  const rpc = host.rpc(LensRPC, { location });
  const capabilities = await rpc.capabilities({});
  assert.equal(capabilities.protocol, 1);
  assert.equal(capabilities.host_version, version);
  assert.equal(capabilities.profiles.length, 1);
  await host.session.prompt({ sessionID: session.id, text: 'Run both fixture calls.' });
  await host.session.wait({ sessionID: session.id });
  assert.equal(requests.length, 2, 'Initial call and tool continuation must both reach the mock provider.');
  const original = await host.session.context({ sessionID: session.id });
  const current = await host.session.get({ sessionID: session.id });
  const unit = [...sourceUnits(current, original).values()].find((unit) => unit.call_id === 'call_a');
  assert.ok(unit, `Native fixture call IDs must be retained: ${JSON.stringify(original)}`);
  const scope = { session_id: session.id, run_id: 'run_fixture', instance_id: capabilities.instance_id };
  const selected = Object.fromEntries(['unit_id', 'message_id', 'call_id', 'fingerprint'].map((key) => [key, unit[key]]));
  const input = { ...scope, operation_id: 'activate_fixture', source_guard: digest(sourceRecord(current, original)),
    units: [selected], draft_version: 1, summaries: { [unit.unit_id]: 'Reviewed fictional call A summary.' } };
  const active = await rpc.activate(input);
  assert.equal(active.state, 'registered');
  assert.equal((await rpc.activate(input)).bundle_id, active.bundle_id);
  await host.session.prompt({ sessionID: session.id, text: 'Continue with the third fixture call.' });
  await host.session.wait({ sessionID: session.id });
  assert.equal(requests.length, 4);
  for (const request of requests.slice(2)) {
    const text = JSON.stringify(request.messages);
    assert.ok(text.includes('Reviewed fictional call A summary.'), 'Outgoing request must contain the reviewed summary.');
    assert.ok(!text.includes('Original fictional output for call_a'), 'Outgoing request must omit replaced output.');
    assert.ok(!request.messages.some((message) => message.tool_calls?.some((call) => call.id === 'call_a')));
    assert.ok(text.includes('Original fictional output for call_b'), 'Unselected paired result must remain.');
    assert.ok(text.includes('Fixture assistant text.'), 'Unrelated assistant text must remain.');
  }
  const status = await rpc.status(scope);
  assert.equal(status.bundles[0].state, 'observed-applied');
  assert.equal(status.bundles[0].evidence.count, 2);
  const after = await host.session.context({ sessionID: session.id });
  assert.deepEqual(after.slice(0, original.length), original, 'Original stored messages must remain intact.');
  await rpc.deactivate({ ...scope, operation_id: 'deactivate_fixture', bundle_id: active.bundle_id });
  await host.session.prompt({ sessionID: session.id, text: 'Finish the fictional review.' });
  await host.session.wait({ sessionID: session.id });
  const restored = JSON.stringify(requests.at(-1).messages);
  assert.ok(restored.includes('Original fictional output for call_a'));
  assert.ok(restored.includes('Original fictional output for call_c'));
  assert.ok(!restored.includes('Reviewed fictional call A summary.'));
  const generationSource = await host.session.context({ sessionID: session.id });
  const generationSession = await host.session.get({ sessionID: session.id });
  const job = await rpc.generate({ ...scope, operation_id: 'generation_fixture',
    source_guard: digest(sourceRecord(generationSession, generationSource)), units: [selected], model: ref });
  let generated = job;
  const deadline = Date.now() + 10000;
  while (generated.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    generated = await rpc.generationStatus({ ...scope, job_id: job.job_id });
  }
  assert.equal(generated.state, 'completed', JSON.stringify(generated));
  assert.equal(generated.summaries[unit.unit_id], 'Generated fictional summary.');
  assert.deepEqual(await host.session.context({ sessionID: session.id }), generationSource);
  nativeProfile = true;
  await fixtureContext.provider.reload();
  await assert.rejects(rpc.activate({ ...input, operation_id: 'unsupported_fixture',
    source_guard: digest(sourceRecord(generationSession, generationSource)) }), (error) => error.data?.code === 'unsupported_profile');
  nativeProfile = false;
  await fixtureContext.provider.reload();
  extraCalls = ['call_e'];
  await host.session.prompt({ sessionID: session.id, text: 'Produce a reasoning-bearing fixture invocation.' });
  await host.session.wait({ sessionID: session.id });
  const inspect = await rpc.pruningInspect(scope);
  assert.equal(inspect.reason, null, JSON.stringify(inspect));
  const targetA = inspect.targets.find((target) => target.call_id === 'call_e');
  const targetB = inspect.targets.find((target) => target.call_id === 'call_b');
  const reason = inspect.targets.find((target) => target.kind === 'reasoning');
  assert.ok(reason, 'Recording provider must produce visible reasoning.');
  const reasoningPreview = await rpc.pruningPreview({ ...scope, revision: inspect.revision, source_guard: inspect.source_guard,
    action: 'remove-reasoning', target_ids: [reason.id] });
  const reasoningSaved = await rpc.pruningApply({ ...scope, preview_id: reasoningPreview.preview_id, operation_id: 'reasoning_only' });
  await host.session.generate({ sessionID: session.id, prompt: 'Reasoning-only pruning check.' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Fictional visible reasoning/);
  assert.match(JSON.stringify(requests.at(-1)), /Original fictional output for call_e/);
  await rpc.pruningRestore({ ...scope, revision: reasoningSaved.revision, group_ids: [reasoningSaved.edits[0].group_id], operation_id: 'restore_reasoning' });
  const afterReasoning = await rpc.pruningInspect(scope);
  const preview = await rpc.pruningPreview({ ...scope, revision: afterReasoning.revision, source_guard: afterReasoning.source_guard,
    action: 'delete-invocation', target_ids: [targetA.id] });
  assert.equal(preview.expanded_count, 1);
  const saved = await rpc.pruningApply({ ...scope, preview_id: preview.preview_id, operation_id: 'prune_a' });
  const stateB = await rpc.pruningInspect(scope);
  const previewB = await rpc.pruningPreview({ ...scope, revision: stateB.revision, source_guard: stateB.source_guard,
    action: 'prune-result', target_ids: [targetB.id] });
  await rpc.pruningApply({ ...scope, preview_id: previewB.preview_id, operation_id: 'prune_b' });
  pruningPhase = true;
  // Returning to the native untitled label triggers the public title request path on the next prompt.
  await host.session.update({ sessionID: session.id, title: `New session - ${new Date(session.time.created).toISOString()}` });
  const beforePruning = requests.length;
  extraCalls = ['call_d'];
  await host.session.prompt({ sessionID: session.id, text: 'Future turn: run the fourth fixture call.' });
  await host.session.wait({ sessionID: session.id });
  assert.equal(requests.length, beforePruning + 2, 'Pruned request and new tool continuation reach provider.');
  assert.ok(titleChecks > 0, 'An actual native title attempt must be intercepted.');
  const assertPruned = (request) => {
    const text = JSON.stringify(request.messages);
    assert.doesNotMatch(text, /Original fictional output for call_e|Original fictional output for call_b|Fictional visible reasoning/);
    assert.match(text, /\[Output pruned\]/);
    assert.match(text, /Future turn/);
    assert.ok(!request.messages.some((message) => message.tool_calls?.some((call) => call.id === 'call_e')));
    assert.ok(request.messages.some((message) => message.tool_calls?.some((call) => call.id === 'call_b')));
    assert.match(text, /Original fictional output for call_c/);
  };
  requests.slice(beforePruning).forEach(assertPruned);
  assert.match(JSON.stringify(requests.at(-1)), /Original fictional output for call_d/);
  await host.session.generate({ sessionID: session.id, prompt: 'Transient fixture inspection.' });
  assertPruned(requests.at(-1));
  assert.equal((await rpc.pruningInspect(scope)).evidence.kind, 'generate');
  const beforeCompact = requests.length;
  await host.session.compact({ sessionID: session.id });
  await host.session.wait({ sessionID: session.id });
  assert.equal(requests.length, beforeCompact + 2, 'Invalid summary receives one native retry.');
  for (const request of requests.slice(beforeCompact)) {
    assert.equal(request._kind, 'compaction');
    assert.doesNotMatch(JSON.stringify(request.messages), /Original fictional output for call_e|Original fictional output for call_b|Fictional visible reasoning/);
    assert.match(JSON.stringify(request.messages), /\[Output pruned\]/);
  }
  assert.equal((await rpc.pruningInspect(scope)).edits.length, 3, 'Failed compaction preserves edits.');
  const compacted = await host.session.context({ sessionID: session.id });
  assert.ok(!compacted.some((message) => message.type === 'compaction' && message.status === 'completed'));
  assert.deepEqual(compacted.slice(0, original.length), original, 'Persistent edits do not rewrite original history.');
  nativeProfile = true; await fixtureContext.provider.reload();
  await assert.rejects(host.session.generate({ sessionID: session.id, prompt: 'Unsupported request.' }));
  assert.equal(requests.length, beforeCompact + 2, 'Unsupported requests must not reach provider.');
  nativeProfile = false;
  await host.close(); host = null;
  host = await OpenCode.create(options);
  const restarted = host.rpc(LensRPC, { location });
  const next = await restarted.capabilities({});
  assert.notEqual(next.instance_id, capabilities.instance_id);
  assert.deepEqual((await restarted.status({ ...scope, instance_id: next.instance_id })).bundles, []);
  const nextScope = { ...scope, instance_id: next.instance_id, run_id: 'run_after_dashboard_restart' };
  const recovered = await restarted.pruningInspect(nextScope);
  assert.equal(recovered.edits.length, 3, JSON.stringify(recovered));
  await host.session.generate({ sessionID: session.id, prompt: 'After host and dashboard restart.' });
  assertPruned(requests.at(-1));
  await restarted.pruningRestore({ ...nextScope, revision: recovered.revision,
    group_ids: [saved.edits[0].group_id], operation_id: 'restore_a' });
  await host.session.generate({ sessionID: session.id, prompt: 'After selective restore.' });
  assert.match(JSON.stringify(requests.at(-1)), /Original fictional output for call_e/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Original fictional output for call_b/);
  const remaining = await restarted.pruningInspect(nextScope);
  await restarted.pruningRestore({ ...nextScope, revision: remaining.revision,
    group_ids: [...new Set(remaining.edits.map((edit) => edit.group_id))], operation_id: 'restore_b' });
  pruningPhase = false;
  await host.session.generate({ sessionID: session.id, prompt: 'After full restore.' });
  assert.match(JSON.stringify(requests.at(-1)), /Original fictional output for call_b/);
  const applyTargets = async (action, calls, operation) => {
    const state = await restarted.pruningInspect(nextScope);
    const preview = await restarted.pruningPreview({ ...nextScope, revision: state.revision, source_guard: state.source_guard,
      action, target_ids: state.targets.filter((target) => calls.includes(target.call_id)).map((target) => target.id) });
    return restarted.pruningApply({ ...nextScope, preview_id: preview.preview_id, operation_id: operation });
  };
  await applyTargets('delete-invocation', ['call_e'], 'delete_before_compaction');
  await applyTargets('prune-result', ['call_b', 'call_d'], 'outputs_before_compaction');
  compactionReply = 'pass';
  const successfulStart = requests.length;
  await host.session.compact({ sessionID: session.id });
  await host.session.wait({ sessionID: session.id });
  assert.equal(requests.length, successfulStart + 1);
  const summaryInput = JSON.stringify(requests.at(-1).messages);
  assert.doesNotMatch(summaryInput, /Original fictional output for call_b|Original fictional output for call_e|Fictional visible reasoning/);
  assert.match(summaryInput, /\[Output pruned\]/);
  assert.match(summaryInput, /call_d/, 'Current host summarizes full context, including the retained recent tail.');
  assert.doesNotMatch(summaryInput, /Original fictional output for call_d/);
  const reset = await restarted.pruningInspect(nextScope);
  assert.deepEqual(reset.edits, []); assert.ok(reset.last_compaction);
  const retainedContext = await host.session.context({ sessionID: session.id });
  const checkpoint = retainedContext.find((message) => message.type === 'compaction' && message.status === 'completed');
  assert.ok(checkpoint?.metadata?.keepID);
  assert.match(checkpoint.metadata.recent, /Original fictional output for call_d/, 'Native recent text is released after reset.');
  await host.session.generate({ sessionID: session.id, prompt: 'Use the new checkpoint.' });
  assert.match(JSON.stringify(requests.at(-1).messages), /Original fictional output for call_d/);
  extraCalls = ['call_f'];
  await host.session.prompt({ sessionID: session.id, text: 'Create a new-cycle tool result.' });
  await host.session.wait({ sessionID: session.id });
  await applyTargets('prune-result', ['call_f'], 'fresh_cycle');
  extraCalls = ['call_g'];
  await host.session.prompt({ sessionID: session.id, text: 'Create a separately reviewed leased-summary result.' });
  await host.session.wait({ sessionID: session.id });
  const leasedSource = await host.session.context({ sessionID: session.id });
  const leasedSession = await host.session.get({ sessionID: session.id });
  const leasedUnit = [...sourceUnits(leasedSession, leasedSource).values()].find((unit) => unit.call_id === 'call_g');
  const leased = await restarted.activate({ ...nextScope, operation_id: 'lease_before_auto',
    source_guard: digest(sourceRecord(leasedSession, leasedSource)),
    units: [Object.fromEntries(['unit_id', 'message_id', 'call_id', 'fingerprint'].map((key) => [key, leasedUnit[key]]))],
    draft_version: 1, summaries: { [leasedUnit.unit_id]: 'Pre-checkpoint leased summary.' } });
  nextUsage = 99000;
  await host.session.prompt({ sessionID: session.id, text: 'Report high fixture usage to trigger automatic compaction.' });
  await host.session.wait({ sessionID: session.id });
  await host.session.prompt({ sessionID: session.id, text: 'Continue after automatic compaction.' });
  await host.session.wait({ sessionID: session.id });
  const autoReset = await restarted.pruningInspect(nextScope);
  assert.deepEqual(autoReset.edits, []); assert.notEqual(autoReset.last_compaction.id, reset.last_compaction.id);
  assert.ok(compactions.includes('auto'), 'Native automatic compaction must complete.');
  assert.equal((await restarted.status(nextScope)).bundles.find((bundle) => bundle.bundle_id === leased.bundle_id).state, 'deactivated');
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Pre-checkpoint leased summary/);
  const autoInput = requests.filter((request) => request._kind === 'compaction').at(-1);
  assert.doesNotMatch(JSON.stringify(autoInput.messages), /Original fictional output for call_f/);
  assert.match(JSON.stringify(autoInput.messages), /\[Output pruned\]/);
  const commandSession = await host.session.create({ location, model: ref });
  extraCalls = ['call_range_a', 'call_range_b'];
  await host.session.prompt({ sessionID: commandSession.id, text: 'Original range goal.' });
  await host.session.wait({ sessionID: commandSession.id });
  await host.session.prompt({ sessionID: commandSession.id, text: 'Unselected range tail.' });
  await host.session.wait({ sessionID: commandSession.id });
  const rangeSource = await host.session.context({ sessionID: commandSession.id });
  const first = rangeSource.find((message) => message.type === 'user').id;
  const last = rangeSource.find((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'tool')).id;
  let commandRPC = restarted, commandScope = { ...nextScope, session_id: commandSession.id };
  const commandReports = [];
  let terminalCommand;
  terminal.setup({
    client: { session: { get: (input) => host.session.get(input) }, rpc: (definition) => ({
      capabilities: (input, options) => host.rpc(definition, options).capabilities(input),
      pruningCommand: (input, options) => host.rpc(definition, options).pruningCommand(input),
    }) },
    keymap: { layer: (factory) => { terminalCommand = factory().commands[0]; } },
    ui: { router: { current: () => ({ type: 'session', sessionID: commandSession.id }) },
      dialog: { alert: async ({ message }) => { commandReports.push(message); } } },
  });
  assert.equal(terminalCommand.slash.name, 'lens-prune'); assert.equal(terminalCommand.slash.arguments, true);
  const command = async (text) => {
    const before = await host.session.context({ sessionID: commandSession.id });
    const count = commandReports.length;
    await terminalCommand.run(text);
    assert.equal(commandReports.length, count + 1, `Command must display an informational report: ${text}`);
    assert.deepEqual(await host.session.context({ sessionID: commandSession.id }), before, 'Command reports must not enter context.');
    return commandReports.at(-1);
  };
  const beforeCommands = requests.length;
  assert.match(await command('list messages'), /Original range goal/);
  assert.match(await command('large 999999 --apply'), /No eligible matches/);
  const toolReport = await command('tools lens_fixture --outputs');
  assert.match(toolReport, /Preview only: 2 edits/);
  assert.equal(requests.length, beforeCommands, 'Preview/list commands must not invoke the model.');
  assert.deepEqual((await commandRPC.pruningInspect(commandScope)).edits, []);
  const previewID = (report) => report.match(/apply (preview_[\w-]+)/)[1];
  assert.match(await command(`apply ${previewID(toolReport)}`), /Saved policy/);
  await host.session.generate({ sessionID: commandSession.id, prompt: 'Check command tool pruning.' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Original fictional output for call_range/);
  assert.match(JSON.stringify(requests.at(-1).messages), /\[Output pruned\]/);
  await command('restore all');
  // Exercise the shipped Desktop command registration against real isolated RPC.
  const desktop = await loadGUI(true), desktopReports = [];
  let desktopCommand;
  const desktopSession = { id: commandSession.id, key: `fictional-remote\n${commandSession.id}`, pending: false,
    server: { client: { session: { get: (input) => host.session.get(input) }, rpc: (definition) => ({
      capabilities: (input, options) => host.rpc(definition, options).capabilities(input),
      pruningCommand: async (input, options) => {
        assert.equal(input.session_id, commandSession.id);
        assert.deepEqual(options.location, commandSession.location);
        const output = await host.rpc(definition, options).pruningCommand(input);
        desktopReports.push(output.report); return output;
      },
    }) } } };
  const disposeDesktop = desktop.setup({ id: 'context-lens',
    get client() { throw new Error('Desktop must not fall back to its sidecar client.'); },
    sessions: { current: () => desktopSession }, t: (key) => key,
    layout: { open: (key, target) => { assert.equal(key, 'context-lens:main'); assert.equal(target, desktopSession); } },
    add: (registry, contribution) => {
      if (registry.id === 'command') { const item = contribution(); if (item.id === 'prune') desktopCommand = item; }
    },
  });
  assert.equal(desktopCommand.slash.name, 'lens-prune'); assert.equal(desktopCommand.slash.arguments, true);
  const desktopBefore = await host.session.context({ sessionID: commandSession.id });
  await desktopCommand.run('tools lens_fixture --outputs');
  assert.match(desktopReports.at(-1), /Preview only: 2 edits/);
  assert.deepEqual((await commandRPC.pruningInspect(commandScope)).edits, []);
  await desktopCommand.run(`apply ${previewID(desktopReports.at(-1))}`);
  assert.match(desktopReports.at(-1), /Saved policy/);
  await host.session.generate({ sessionID: commandSession.id, prompt: 'Check native Desktop pruning.' });
  assert.match(JSON.stringify(requests.at(-1).messages), /\[Output pruned\]/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Original fictional output for call_range|Preview only|BEFORE/);
  await desktopCommand.run('restore all');
  assert.match(desktopReports.at(-1), /Restored/);
  assert.deepEqual(await host.session.context({ sessionID: commandSession.id }), desktopBefore);
  disposeDesktop();
  assert.match(await command('large 1 --apply'), /Applied 2 edits/);
  await host.session.generate({ sessionID: commandSession.id, prompt: 'Check large invocation removal.' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /call_range/);
  await command('restore all');
  const rangeReport = await command(`range ${first} ${last}`);
  assert.match(rangeReport, /Preview only: 2 edits/);
  await command(`apply ${previewID(rangeReport)}`);
  await host.session.generate({ sessionID: commandSession.id, prompt: 'Check command range pruning.' });
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Original range goal|call_range/);
  assert.match(JSON.stringify(requests.at(-1).messages), /Unselected range tail/);
  await command('restore all');
  const briefReport = await command(`summarize brief ${first} ${last}`);
  assert.match(briefReport, /Brief fictional range summary/);
  assert.deepEqual((await commandRPC.pruningInspect(commandScope)).edits, []);
  await command(`apply ${previewID(briefReport)}`);
  const beforeFuture = requests.length;
  extraCalls = ['call_range_future'];
  await host.session.prompt({ sessionID: commandSession.id, text: 'Continue beyond the summarized range.' });
  await host.session.wait({ sessionID: commandSession.id });
  assert.equal(requests.length, beforeFuture + 2);
  for (const request of requests.slice(beforeFuture)) {
    assert.match(JSON.stringify(request.messages), /Brief fictional range summary/);
    assert.doesNotMatch(JSON.stringify(request.messages), /Original range goal|call_range_a|call_range_b|BEFORE|Preview only/);
    assert.match(JSON.stringify(request.messages), /Unselected range tail|Continue beyond/);
  }
  await host.close(); host = await OpenCode.create(options);
  commandRPC = host.rpc(LensRPC, { location });
  commandScope = { ...commandScope, instance_id: (await commandRPC.capabilities({})).instance_id };
  await host.session.generate({ sessionID: commandSession.id, prompt: 'Use durable summary after restart.' });
  assert.match(JSON.stringify(requests.at(-1).messages), /Brief fictional range summary/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /Original range goal|call_range_a|call_range_b/);
  await command('restore all');
  assert.match(await command(`summarize full ${first} ${last} --apply`), /Applied 2 edits/);
  await host.session.compact({ sessionID: commandSession.id }); await host.session.wait({ sessionID: commandSession.id });
  const rangeCompaction = requests.filter((request) => request._kind === 'compaction').at(-1);
  assert.match(JSON.stringify(rangeCompaction.messages), /Full fictional range summary/);
  assert.doesNotMatch(JSON.stringify(rangeCompaction.messages), /Original range goal|call_range_a|call_range_b/);
  assert.deepEqual((await commandRPC.pruningInspect(commandScope)).edits, []);
  await host.close(); host = null;
  console.log(JSON.stringify({ result: 'passed', host: version, sdk: version,
    profile: capabilities.profiles[0], outgoing_requests: requests.length, pruning_title_hook_observations: titleChecks, compactions, command_reports: commandReports.length, desktop_reports: desktopReports.length,
    checks: ['multi-call mapping', 'initial and continued HTTP replay', 'stored history', 'deactivation',
      'stateless selected-source generation', 'unsupported-profile refusal', 'host unload/reload instance reset',
      'durable deletion with reasoning expansion', 'result-only pruning', 'new tool continuation and future messages',
      'reasoning-only pruning', 'native title isolation', 'transient session generation', 'failed compaction preserves edits', 'pruning unsupported dispatch refused',
      'saved policy after host restart and new run', 'selective and complete restoration', 'manual compaction pruned input and durable reset',
      'native retained-tail release', 'fresh pruning cycle', 'automatic compaction pruned input and reset', 'automatic compaction retires leased summaries',
      'terminal command callback through public RPC, reports excluded from context', 'default preview and immediate apply', 'large tool byte selection',
      'shipped Desktop bundle command via selected server RPC, preview/apply/restore and outgoing replay',
      'inclusive user/assistant range deletion', 'brief/full stateless range summaries', 'range summary continuation and restart', 'range summary compaction reset'] }, null, 2));
} finally {
  if (host) await host.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.chdir('/tmp/opencode');
  await rm(root, { recursive: true, force: true });
}
