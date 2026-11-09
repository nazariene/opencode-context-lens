const pruning = { status: null, selected: new Set(), preview: null, request: 0, generation: 0, rows: 60, busy: false, applyId: null };
const pruningLabels = {'prune-result': 'Prune output', 'remove-reasoning': 'Remove reasoning', 'delete-invocation': 'Delete invocation', 'delete-range': 'Remove range', 'summarize-brief': 'Brief range summary', 'summarize-full': 'Full range summary'};
const pruningRange = () => ['delete-range', 'summarize-brief', 'summarize-full'].includes($('pruning-action').value);

function resetPruning() {
  pruning.request++; pruning.generation++; pruning.status = null; pruning.selected.clear();
  pruning.preview = null; pruning.applyId = null; pruning.busy = false; pruning.rows = 60;
  $('pruning-items').replaceChildren(); $('pruning-review').replaceChildren(); $('pruning-edits').replaceChildren();
  $('pruning-first').replaceChildren(); $('pruning-last').replaceChildren();
  $('pruning-message').textContent = ''; $('pruning-evidence').textContent = '';
  renderPruning();
}

function invalidatePruning(message = '') {
  pruning.generation++; pruning.preview = null; pruning.applyId = null;
  $('pruning-review').replaceChildren(); $('pruning-message').textContent = message;
  renderPruning();
}

function pruningCurrent(session, run, revision, generation) {
  return session === state.session && run === review.runId && revision === state.context?.revision
    && generation === pruning.generation && review.mode === 'live';
}

async function loadPruning() {
  if (review.mode !== 'live' || !state.context || pruning.busy) return;
  const session = state.session, run = review.runId, revision = state.context.revision, request = ++pruning.request;
  try {
    const status = await api(`/api/sessions/${encodeURIComponent(session)}/pruning?revision=${encodeURIComponent(revision)}`);
    if (session !== state.session || run !== review.runId || revision !== state.context?.revision || request !== pruning.request || review.mode !== 'live') return;
    if (status.run_id !== run) { runChanged(); return; }
    const previous = pruning.status;
    const changed = previous && (['revision', 'source_guard', 'instance_id', 'pin_version', 'available', 'reason'].some((key) => previous[key] !== status[key])
      || JSON.stringify(previous.targets) !== JSON.stringify(status.targets));
    pruning.status = status;
    if (changed) { pruning.selected.clear(); invalidatePruning('Context, saved edits or protection changed. Review a new selection.'); }
    const selectable = new Set((status.targets || []).filter(pruningEligible).map((target) => target.id));
    for (const id of pruning.selected) if (!selectable.has(id)) pruning.selected.delete(id);
    renderPruning();
  } catch (error) {
    if (request === pruning.request && session === state.session) {
      pruning.status = null; invalidatePruning(error.message);
    }
  }
}

function pruningEligible(target) {
  return !target.reason && !target.edit && !target.pinned && !target.summary_conflict
    && (target.kind === 'message') === pruningRange()
    && (target.kind === 'reasoning') === ($('pruning-action').value === 'remove-reasoning');
}

function matchingPruning() {
  const query = $('pruning-search').value.trim().toLowerCase();
  const kind = pruningRange() ? 'message' : $('pruning-action').value === 'remove-reasoning' ? 'reasoning' : 'tool';
  return (pruning.status?.targets || []).filter((target) => target.kind === kind
    && (!query || `${target.title} ${target.preview}`.toLowerCase().includes(query)));
}

function renderPruning() {
  $('pruning-panel').hidden = review.mode !== 'live';
  const status = pruning.status, enabled = status?.available && !status.reason && review.mode === 'live' && !pruning.busy;
  const range = pruningRange();
  $('pruning-range').hidden = !range;
  $('pruning-large-controls').hidden = range || $('pruning-action').value === 'remove-reasoning';
  for (const id of ['pruning-first', 'pruning-last']) {
    const select = $(id), value = select.value;
    const messages = (status?.targets || []).filter((target) => target.kind === 'message');
    select.replaceChildren(...messages.map((target) => { const option = element('option', '', `${target.title} [${target.message_id}]${pruningEligible(target) ? '' : ' · ineligible'}`); option.value = target.id; return option; }));
    if (messages.some((target) => target.id === value)) select.value = value;
    select.disabled = !enabled;
  }
  $('pruning-status').textContent = !status?.available ? status?.reason || 'Companion pruning status unavailable.'
    : status.reason || `Policy revision ${status.revision} · ${status.edits.length} saved edits · manual actions only${status.last_compaction ? ' · reset after native compaction' : ''}`;
  $('pruning-evidence').textContent = status?.evidence ? `Last hook observation: ${status.evidence.kind}, revision ${status.evidence.revision}, ${new Date(status.evidence.at).toLocaleTimeString()}. Provider savings are not measured.`
    : 'No pruning hook application observed in this plugin instance.';
  $('pruning-preview').disabled = !enabled || (range ? !$('pruning-first').value || !$('pruning-last').value : !pruning.selected.size);
  $('pruning-apply').disabled = !enabled || !pruning.preview || Date.now() >= pruning.preview.expires_at;
  for (const id of ['pruning-all', 'pruning-matching', 'pruning-clear', 'pruning-action']) $(id).disabled = !enabled;
  for (const id of ['pruning-all', 'pruning-matching', 'pruning-clear']) $(id).disabled ||= range;
  $('pruning-large').disabled = !enabled;
  const targets = matchingPruning(), selected = pruning.selected.size;
  $('pruning-selection').textContent = `${range ? 'Select inclusive message boundaries above' : `${selected} selected`} · ${targets.length} matching items · ${targets.filter((target) => target.pinned).length} pinned · ${targets.filter((target) => !target.pinned && !pruningEligible(target)).length} otherwise ineligible. Bulk selection includes unrendered items.`;
  const fragment = document.createDocumentFragment();
  for (const target of targets.slice(0, pruning.rows)) {
    const row = element('article', 'candidate'); row.dataset.pruningId = target.id;
    const label = element('label', 'unit-select'), input = element('input'); input.type = 'checkbox';
    input.checked = pruning.selected.has(target.id); input.disabled = range || !enabled || !pruningEligible(target); input.hidden = range;
    input.setAttribute('aria-label', `Prune ${target.title} [${target.id}]`);
    input.addEventListener('change', () => { if (input.checked) pruning.selected.add(target.id); else pruning.selected.delete(target.id); invalidatePruning(); });
    label.append(input, element('strong', '', `${target.title} [${target.call_id || target.message_id}]`));
    row.append(label, element('p', 'tiny', target.reason || (target.pinned ? 'Pinned' : target.summary_conflict ? 'Overlapping summary or running generation' : target.edit ? pruningLabels[target.edit.action] : `${number(target.characters)} original characters · ${number(target.bytes ?? target.characters)} bytes including arguments`)));
    row.append(element('p', 'tiny', `Effective: ${target.effective_preview || '(empty)'}`));
    if (target.edit) {
      const original = element('details'); original.append(element('summary', 'tiny', 'Original preview'), element('p', 'tiny', target.preview)); row.append(original);
    }
    fragment.append(row);
  }
  $('pruning-items').replaceChildren(fragment); $('pruning-more').hidden = targets.length <= pruning.rows;
  const groups = new Map();
  for (const edit of status?.edits || []) { if (!groups.has(edit.group_id)) groups.set(edit.group_id, []); groups.get(edit.group_id).push(edit); }
  $('pruning-edits').replaceChildren(...[...groups].map(([id, edits]) => {
    const row = element('div', 'pin-entry'), button = element('button', 'text-button', 'Restore');
    button.disabled = pruning.busy || review.mode !== 'live';
    button.addEventListener('click', () => restorePruning(id));
    row.append(element('span', '', `${edits.length} edits · ${[...new Set(edits.map((edit) => pruningLabels[edit.action]))].join(', ')} [${id}]`), button);
    return row;
  }));
}

async function previewPruning() {
  const status = pruning.status;
  if (!status?.available || pruning.busy || !pruningRange() && !pruning.selected.size) return;
  invalidatePruning();
  const session = state.session, run = review.runId, revision = state.context.revision, generation = pruning.generation;
  pruning.busy = true; renderPruning(); $('pruning-message').textContent = $('pruning-action').value.startsWith('summarize-') ? 'Generating range summary for review…' : 'Building exact pruning preview…';
  try {
    const preview = await api(`/api/sessions/${encodeURIComponent(session)}/pruning/preview`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      run_id: run, snapshot_revision: revision, instance_id: status.instance_id, pin_version: status.pin_version,
      revision: status.revision, source_guard: status.source_guard, action: $('pruning-action').value,
      target_ids: pruningRange() ? [$('pruning-first').value, $('pruning-last').value] : [...pruning.selected],
    })});
    if (!pruningCurrent(session, run, revision, generation)) return;
    pruning.preview = preview; pruning.applyId = crypto.randomUUID();
    $('pruning-message').textContent = `${preview.rows.length} edits · ${preview.expanded_count} items included by range/pair closure · estimated saving ≈ ${number(preview.estimated_savings)} tokens. ${preview.measurement}`;
    $('pruning-review').replaceChildren(...preview.rows.map((row) => {
      const detail = element('details'); detail.append(element('summary', '', `${row.title} · ${pruningLabels[row.action]}${row.expanded ? ' · required expansion' : ''}`));
      const pair = element('div', 'diff-pair');
      for (const [label, text] of [['Before', row.before], ['After', row.after || '(omitted)']]) {
        const side = element('div', 'diff-side'); side.append(element('strong', '', label), element('pre', 'diff-text', text)); pair.append(side);
      }
      detail.append(pair); return detail;
    }));
  } catch (error) { if (pruningCurrent(session, run, revision, generation)) $('pruning-message').textContent = error.message; }
  finally { if (session === state.session && run === review.runId) { pruning.busy = false; renderPruning(); } }
}

async function applyPruning() {
  const preview = pruning.preview;
  if (!preview || pruning.busy || review.mode !== 'live') return;
  const session = state.session, run = review.runId, revision = state.context.revision, generation = pruning.generation;
  pruning.busy = true; renderPruning();
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}/pruning/apply`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      run_id: run, pin_version: preview.pin_version, instance_id: preview.instance_id, preview_id: preview.preview_id, operation_id: pruning.applyId,
    })});
    if (!pruningCurrent(session, run, revision, generation)) return;
    pruning.selected.clear(); invalidatePruning('Pruning saved. It applies to subsequent supported requests.');
  } catch (error) { if (pruningCurrent(session, run, revision, generation)) $('pruning-message').textContent = `${error.message} Refresh saved edits or retry the same reviewed operation.`; }
  finally { if (session === state.session && run === review.runId) { pruning.busy = false; await loadPruning(); } }
}

async function restorePruning(group) {
  if (!pruning.status?.available || pruning.busy || review.mode !== 'live') return;
  const status = pruning.status, session = state.session, run = review.runId;
  pruning.busy = true; invalidatePruning();
  try {
    await api(`/api/sessions/${encodeURIComponent(session)}/pruning/restore`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
      run_id: run, instance_id: status.instance_id, revision: status.revision, group_ids: [group], operation_id: crypto.randomUUID(),
    })});
    if (session === state.session && run === review.runId) $('pruning-message').textContent = 'Edits restored for subsequent requests.';
  } catch (error) { if (session === state.session && run === review.runId) $('pruning-message').textContent = error.message; }
  finally { if (session === state.session && run === review.runId) { pruning.busy = false; await loadPruning(); } }
}

for (const [id, matching] of [['pruning-all', false], ['pruning-matching', true]]) $(id).addEventListener('click', () => {
  for (const target of matching ? matchingPruning() : pruning.status?.targets || []) if (pruningEligible(target)) pruning.selected.add(target.id);
  invalidatePruning();
});
$('pruning-clear').addEventListener('click', () => { pruning.selected.clear(); invalidatePruning(); });
$('pruning-action').addEventListener('change', () => { pruning.selected.clear(); pruning.rows = 60; invalidatePruning(); });
$('pruning-search').addEventListener('input', () => { pruning.rows = 60; renderPruning(); });
for (const id of ['pruning-first', 'pruning-last']) $(id).addEventListener('change', () => invalidatePruning());
$('pruning-large').addEventListener('click', () => {
  const min = Number($('pruning-min-bytes').value);
  if (!Number.isSafeInteger(min) || min < 0) { $('pruning-message').textContent = 'Enter a nonnegative byte threshold.'; return; }
  pruning.selected.clear();
  for (const target of matchingPruning()) if (target.kind === 'tool' && pruningEligible(target) && target.bytes >= min) pruning.selected.add(target.id);
  invalidatePruning();
});
$('pruning-more').addEventListener('click', () => { pruning.rows += 60; renderPruning(); });
$('pruning-preview').addEventListener('click', previewPruning);
$('pruning-apply').addEventListener('click', applyPruning);
