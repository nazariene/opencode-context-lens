const summaries = { request: 0, statusRequest: 0, status: null, draft: null, dirty: false,
  manual: false, busy: false, selection: '', operation: null };

function summarySelection() { return [...state.selected].sort().join('\n'); }

function invalidateSummary(reason = '') {
  summaries.request++; summaries.draft = null; summaries.dirty = false; summaries.manual = false;
  summaries.busy = false; summaries.selection = ''; summaries.operation = null;
  $('summary-editor').replaceChildren(); $('draft-actions').hidden = true;
  $('draft-status').textContent = reason; $('summary-preview').textContent = '';
}

function resetSummaries() {
  invalidateSummary(); summaries.statusRequest++; summaries.status = null;
  $('replacement-list').replaceChildren(); $('replacement-status').textContent = '';
  $('replacement-projection').textContent = ''; $('summary-model').replaceChildren();
}

function summaryCurrent(request, session, run, revision, selection) {
  return request === summaries.request && session === state.session && run === review.runId
    && revision === state.context?.revision && selection === summarySelection() && review.mode === 'live';
}

function renderSummaryActions() {
  const live = review.mode === 'live', selected = state.selected.size > 0 && !!review.pinState;
  $('summary-actions').hidden = !live; $('draft-actions').hidden = !live || (!summaries.draft && !summaries.manual);
  $('manual-summary').disabled = !selected || summaries.busy;
  $('generate-summary').disabled = !selected || summaries.busy || !summaries.status?.available;
  const draft = summaries.draft, editable = draft?.state === 'draft' || summaries.manual;
  $('save-summary').disabled = !editable || summaries.busy;
  $('preview-summary').disabled = !draft || draft.state !== 'draft' || summaries.dirty || !!draft.stale || summaries.busy;
  $('activate-summary').disabled = !draft?.preview || draft.state !== 'draft' || summaries.dirty || !!draft.stale
    || summaries.busy || !summaries.status?.available || !summaries.status?.profiles?.length;
  $('discard-summary').disabled = summaries.busy || ['active', 'pending'].includes(draft?.state);
}

function summaryFields(units, values, parts = null) {
  const fragment = document.createDocumentFragment();
  for (const unit of units) {
    const id = unit.unit_id || unit.id, analysis = state.unitsById.get(id);
    const card = element('article', 'candidate summary-card');
    card.append(element('h3', '', `${analysis?.tool_name || 'Tool invocation'} [${id}]`));
    const originals = element('details'), title = element('summary', '', 'Inspect original call and results');
    originals.append(title);
    if (parts) {
      for (const part of parts.filter((part) => part.id.startsWith(id + ':'))) {
        originals.append(element('h4', 'tiny', part.title), element('pre', 'diff-text', part.text));
      }
    } else {
      for (const partID of analysis?.part_ids || []) {
        const part = state.partsById.get(partID), open = element('button', 'text-button', part.title);
        open.addEventListener('click', () => inspect(part)); originals.append(open);
      }
    }
    const label = element('label', 'summary-label', 'Replacement summary');
    const input = element('textarea', 'summary-input'); input.value = values?.[id] || '';
    input.dataset.unitId = id; input.setAttribute('aria-label', `Summary for ${id}`);
    input.addEventListener('input', () => {
      summaries.dirty = true; summaries.request++; summaries.busy = false;
      if (summaries.draft) summaries.draft.preview = null;
      $('summary-preview').textContent = 'Edits invalidate the reviewed preview. Save, then preview again.';
      renderSummaryActions();
    });
    label.append(input); card.append(originals, label); fragment.append(card);
  }
  $('summary-editor').replaceChildren(fragment);
}

function acceptDraft(draft) {
  summaries.draft = draft; summaries.dirty = false; summaries.manual = false;
  $('draft-status').textContent = `${draft.state} · version ${draft.draft_version} [${draft.draft_id}]${draft.stale ? ' · ' + draft.stale : ''}${draft.reason ? ' · ' + draft.reason : ''}${draft.estimated_input != null ? ' · Estimated generation input: ' + number(draft.estimated_input) + ' (UTF-8 byte upper estimate); actual usage unavailable.' : ''}`;
  if (draft.summaries) summaryFields(draft.units, draft.summaries, draft.parts);
  renderSummaryPreview(draft.preview); renderSummaryActions();
}

function renderSummaryPreview(preview) {
  $('summary-preview').textContent = preview ? `Original ≈ ${number(preview.before_visible_tokens)} · Selected source ≈ ${number(preview.selected_source_tokens)} · Wrapped summaries ≈ ${number(preview.replacement_tokens)} · Projected ≈ ${number(preview.projected_visible_tokens)} · Signed savings ≈ ${number(preview.estimated_savings)}. ${preview.tokenizer}; ${preview.unknown_count} unknown-sized parts; ${percent(preview.projected_window_percent)} of model window. Provider usage remains separate.` : '';
  if (preview?.cumulative_projected_visible_tokens != null) $('summary-preview').textContent += ` With other active bundles: ≈ ${number(preview.cumulative_projected_visible_tokens)}.`;
}

async function draftAction(action) {
  const session = state.session, run = review.runId, revision = state.context.revision;
  const selection = summarySelection(), request = ++summaries.request;
  const draft = summaries.draft;
  const current = () => summaryCurrent(request, session, run, revision, selection);
  const base = `/api/sessions/${encodeURIComponent(session)}`;
  let path, method = 'POST', body;
  const textMap = () => Object.fromEntries([...document.querySelectorAll('.summary-input')].map((input) => [input.dataset.unitId, input.value]));
  const version = {run_id: run, draft_version: draft?.draft_version};
  if (action === 'generate' || (action === 'save' && !draft)) {
    body = {run_id: run, revision, pin_version: review.pinState.pin_version,
      operation_id: crypto.randomUUID(), unit_ids: [...state.selected], mode: action === 'generate' ? 'generated' : 'manual'};
    if (action === 'generate') {
      if ($('summary-model').value) body.model = JSON.parse($('summary-model').value);
    } else body.summaries = textMap();
    path = base + '/summary-drafts';
  } else {
    path = base + '/summary-drafts/' + encodeURIComponent(draft.draft_id); body = version;
    if (action === 'save') { method = 'PATCH'; body.summaries = textMap(); }
    if (action === 'discard') method = 'DELETE';
    if (action === 'preview') path += '/preview';
    if (action === 'activate') {
      path += '/activate'; body.pin_version = review.pinState.pin_version;
      summaries.operation ??= crypto.randomUUID(); body.operation_id = summaries.operation;
    }
  }
  summaries.busy = true; renderSummaryActions(); $('draft-status').textContent = `${action}…`;
  try {
    const result = await api(path, {method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (!current()) return;
    if (action === 'discard') invalidateSummary('Draft discarded / generation cancelled.');
    else if (action === 'preview') { draft.preview = result; renderSummaryPreview(result); }
    else if (action === 'activate') {
      draft.state = result.state === 'pending' ? 'pending' : 'active';
      $('draft-status').textContent = result.state === 'pending' ? 'Activation outcome pending reconciliation.' : 'Registered for future requests. Waiting for hook evidence.';
      await loadReplacements();
    } else acceptDraft(result);
  } catch (error) { if (current()) $('draft-status').textContent = error.message; }
  finally { if (current()) { summaries.busy = false; renderSummaryActions(); } }
}

async function pollDraft() {
  const draft = summaries.draft;
  if (!draft || !['generating', 'pending'].includes(draft.state) || summaries.busy || review.mode !== 'live') return;
  const request = summaries.request, session = state.session, run = review.runId, revision = state.context.revision, selection = summarySelection();
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session)}/summary-drafts/${encodeURIComponent(draft.draft_id)}?${new URLSearchParams({run_id: run})}`);
    if (summaryCurrent(request, session, run, revision, selection) && summaries.draft === draft) acceptDraft(result);
  } catch (error) { if (request === summaries.request) $('draft-status').textContent = error.message; }
}

async function loadReplacements() {
  if (!state.session || !review.runId) return;
  const session = state.session, run = review.runId, request = ++summaries.statusRequest;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session)}/replacements`);
    if (request !== summaries.statusRequest || session !== state.session || run !== review.runId) return;
    if (result.run_id !== run) { runChanged(); return; }
    if (summaries.status?.instance_id && result.instance_id && result.instance_id !== summaries.status.instance_id) invalidateSummary('Plugin restarted. Create a fresh reviewed draft.');
    summaries.status = result;
    const currentBundle = result.bundles.find((bundle) => bundle.draft_id === summaries.draft?.draft_id);
    if (currentBundle && summaries.draft && !summaries.dirty) {
      summaries.draft.state = ['registered', 'observed-applied'].includes(currentBundle.state) ? 'active' : currentBundle.state;
      if (summaries.draft.state !== 'active') summaries.draft.preview = null;
      $('draft-status').textContent = `${currentBundle.state} · version ${summaries.draft.draft_version} [${summaries.draft.draft_id}]`;
    }
    $('replacement-status').textContent = result.available ? (result.reason || 'Plugin available · registration and hook evidence shown separately.') : (result.reason || 'Companion plugin unavailable. Manual drafts and previews remain available.');
    const projection = result.projection;
    $('replacement-projection').textContent = projection ? `Original API context ≈ ${number(projection.original_visible_tokens)} · Cumulative Lens projection ≈ ${number(projection.projected_visible_tokens)} · Estimated savings ≈ ${number(projection.estimated_savings)}. Not a complete provider request.` : 'Runtime projection unavailable.';
    const fragment = document.createDocumentFragment();
    for (const bundle of result.bundles) {
      const row = element('div', 'pin-entry');
      row.append(element('span', '', `${bundle.state} [${bundle.bundle_id}] · version ${bundle.draft_version}${bundle.evidence ? ' · Lens hook observed ' + bundle.evidence.count + ' request(s)' : ' · No hook application observed'}${bundle.reason ? ' · ' + bundle.reason : ''}`));
      if (['registered', 'observed-applied', 'suspended'].includes(bundle.state) && bundle.run_id === run && review.mode === 'live') {
        const button = element('button', 'text-button', 'Deactivate');
        const operation_id = crypto.randomUUID();
        button.addEventListener('click', async () => {
          if (session !== state.session || run !== review.runId || review.mode !== 'live') return;
          button.disabled = true;
          try {
            await api(`/api/sessions/${encodeURIComponent(session)}/replacements/${encodeURIComponent(bundle.bundle_id)}/deactivate`,
              {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({run_id: run, operation_id})});
            if (session === state.session && run === review.runId) await loadReplacements();
          } catch (error) { if (session === state.session && run === review.runId) $('replacement-status').textContent = error.message; }
          finally { button.disabled = false; }
        }); row.append(button);
      }
      fragment.append(row);
    }
    $('replacement-list').replaceChildren(fragment);
    const selectedModel = $('summary-model').value;
    $('summary-model').replaceChildren(element('option', '', 'Current session model'));
    $('summary-model').firstChild.value = '';
    for (const model of result.models || []) {
      const option = element('option', '', `${model.name || model.id} [${model.providerID}/${model.id}]`);
      option.value = JSON.stringify({providerID: model.providerID, id: model.id}); $('summary-model').append(option);
    }
    if ([...$('summary-model').options].some((option) => option.value === selectedModel)) $('summary-model').value = selectedModel;
    renderSummaryActions();
  } catch (error) { if (request === summaries.statusRequest) $('replacement-status').textContent = error.message; }
}

$('manual-summary').addEventListener('click', () => {
  invalidateSummary('Write one summary per complete tool invocation, then save and preview.');
  summaries.manual = true; summaries.selection = summarySelection();
  summaryFields([...state.selected].map((id) => state.unitsById.get(id)), {}); renderSummaryActions();
});
for (const [id, action] of [['generate-summary', 'generate'], ['save-summary', 'save'], ['preview-summary', 'preview'], ['activate-summary', 'activate'], ['discard-summary', 'discard']]) {
  $(id).addEventListener('click', () => draftAction(action).catch(showError));
}
start();
