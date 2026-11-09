const review = { mode: 'live', runId: null, liveContext: null, history: null,
  historyRequest: 0, viewRequest: 0, diffRequest: 0, diff: null, diffRows: 80,
  pinState: null, pinRequest: 0, pinBusy: false, pairChosen: false };

function resetReview() {
  resetPruning();
  resetSummaries();
  review.mode = 'live'; review.runId = null; review.liveContext = null; review.history = null; review.diff = null;
  review.historyRequest++; review.viewRequest++; review.diffRequest++;
  review.pairChosen = false;
  review.pinRequest++; review.pinState = null; review.pinBusy = false;
  $('pin-list').replaceChildren(); $('pin-count').textContent = '0'; $('pin-status').textContent = '';
  $('history-rows').replaceChildren(); $('history-chart').replaceChildren();
  $('diff-before').replaceChildren(); $('diff-after').replaceChildren();
  $('diff-panel').hidden = true; $('return-live').hidden = true;
  $('view-status').textContent = ''; $('history-status').textContent = '';
  document.querySelector('.preview-panel').hidden = false;
  $('control-events').replaceChildren(); $('control-event-loss').textContent = '';
}

function runChanged() {
  resetReview(); resetAnalysis('Dashboard restarted. Refresh to begin a new run.');
  state.detailRequest++; state.contextRequest++; $('inspector').close();
  state.context = null; state.partsById.clear();
  $('dashboard').hidden = true; $('welcome').hidden = false;
  $('welcome').replaceChildren(element('h1', '', 'Dashboard restarted'), element('p', '', 'Refresh to load the new run. Previous history, pins, and selections are no longer available.'));
}

async function loadHistory() {
  const session = state.session, run = review.runId, request = ++review.historyRequest;
  try {
    const history = await api(`/api/sessions/${encodeURIComponent(session)}/history`);
    if (request !== review.historyRequest || session !== state.session || run !== review.runId) return;
    if (history.run_id !== run) { runChanged(); return; }
    review.history = history;
    renderHistory();
  } catch (error) {
    if (request === review.historyRequest && session === state.session) $('history-status').textContent = error.message;
  }
}

function renderViewStatus() {
  renderPruning();
  $('return-live').hidden = review.mode === 'live';
  document.querySelector('.preview-panel').hidden = review.mode !== 'live';
  $('bulk-controls').hidden = review.mode !== 'live'; $('pins-panel').hidden = review.mode !== 'live';
  $('replacement-list').querySelectorAll('button').forEach((button) => { button.disabled = review.mode !== 'live'; });
  renderSummaryActions();
  $('view-status').textContent = review.mode === 'live' ? 'Live original API context'
    : `${review.mode === 'diff' ? 'Snapshot comparison' : 'Historical snapshot'} — inspection only.${review.liveContext?.revision !== state.context?.revision ? ' Newer live context is available.' : ''}`;
}

function renderHistory() {
  const history = review.history, observations = history.observations;
  $('history-status').textContent = `${observations.length} retained observations · ${history.evicted} observations evicted · ${history.skipped} oversized captures skipped · ${history.evicted_sessions} sessions evicted. Run-only, observed coverage; not complete transcript history.`;
  const rows = document.createDocumentFragment();
  for (const observation of observations) {
    const row = element('tr');
    const when = element('td', '', new Date(observation.first_observed).toLocaleTimeString());
    when.append(element('div', 'tiny', `${observation.compaction ? 'Observed checkpoint · ' : ''}${observation.gap ? 'Capture gap · ' : ''}Last seen ${new Date(observation.last_observed).toLocaleTimeString()}`));
    when.title = `${observation.tokenizer} · window ${number(observation.window)}\n${observation.categories.map((c) => `${c.name}: ${number(c.tokens)}`).join('\n')}\n[${observation.snapshot_id}]`;
    const breakdown = element('details');
    breakdown.append(element('summary', 'tiny', 'Category totals and measurement basis'));
    breakdown.append(element('p', 'tiny', when.title)); when.append(breakdown);
    const open = element('button', 'text-button', 'Inspect');
    open.setAttribute('aria-label', `Inspect snapshot ${observation.snapshot_id}`);
    open.addEventListener('click', () => openHistory(observation.snapshot_id).catch(showError));
    const action = element('td'); action.append(open);
    row.append(when, element('td', '', number(observation.tokens)), element('td', '', number(observation.delta)), element('td', '', number(observation.unknown_count)), action);
    rows.append(row);
  }
  $('history-rows').replaceChildren(rows);
  const max = Math.max(1, ...observations.map((entry) => entry.tokens));
  const svg = $('history-chart'); svg.replaceChildren();
  const points = observations.map((entry, i) => `${10 + i * 780 / Math.max(1, observations.length - 1)},${100 - entry.tokens / max * 90}`);
  // Discontinuities deliberately break the chart rather than imply uninterrupted capture.
  let segment = [];
  const draw = () => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', segment.join(' ')); line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#45d4ba'); line.setAttribute('stroke-width', '2'); svg.append(line);
  };
  observations.forEach((entry, i) => {
    if (entry.gap && segment.length) { draw(); segment = []; }
    segment.push(points[i]);
    const point = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    const [x, y] = points[i].split(','); point.setAttribute('cx', x); point.setAttribute('cy', y);
    point.setAttribute('r', '3'); point.setAttribute('fill', entry.compaction ? '#f3bd69' : '#45d4ba'); svg.append(point);
  });
  if (segment.length) draw();
  for (const [id, fallback] of [['diff-before', observations.at(-2)], ['diff-after', observations.at(-1)]]) {
    const selected = $(id).value;
    const placeholder = element('option', '', 'Choose a snapshot'); placeholder.value = '';
    $(id).replaceChildren(placeholder, ...observations.map((entry) => {
      const option = element('option', '', `${new Date(entry.first_observed).toLocaleTimeString()} · ≈ ${number(entry.tokens)} [${entry.snapshot_id}]`);
      option.value = entry.snapshot_id; return option;
    }));
    if (review.pairChosen && observations.some((entry) => entry.snapshot_id === selected)) $(id).value = selected;
    else if (fallback) $(id).value = fallback.snapshot_id;
  }
  $('compare-snapshots').disabled = !$('diff-before').value || !$('diff-after').value;
  if (observations.length < 2) $('history-status').textContent += ' Another observation is needed for a default comparison; you can explicitly compare this snapshot with itself.';
  $('control-events').replaceChildren(...(history.control_events || []).map((event) =>
    element('p', 'tiny', `${new Date(event.at).toLocaleTimeString()} · ${event.label}`)));
  $('control-event-loss').textContent = `${history.control_events_lost || 0} earlier control events evicted across this run.`;
  renderViewStatus();
}

function setDisplayedContext(context, analysis) {
  pruning.selected.clear(); invalidatePruning();
  invalidateSummary('Historical context is inspection-only.');
  resetAnalysis('Historical view. Selection cleared.');
  state.context = context; state.partsById = new Map(context.parts.map((part) => [part.id, part]));
  state.analysis = analysis;
  state.unitsById = new Map((analysis?.units || []).map((unit) => [unit.id, unit]));
  state.partUnits = new Map((analysis?.units || []).flatMap((unit) => unit.part_ids.map((id) => [id, unit])));
  renderMetrics(); renderCategories(); renderParts(); renderFindings(); renderViewStatus();
}

async function openHistory(snapshotId) {
  const session = state.session, run = review.runId, request = ++review.viewRequest;
  review.diffRequest++; state.detailRequest++; $('inspector').close();
  const context = await api(`/api/sessions/${encodeURIComponent(session)}/history/${encodeURIComponent(snapshotId)}?${new URLSearchParams({run_id: run})}`);
  if (request !== review.viewRequest || session !== state.session || run !== review.runId) return;
  review.mode = 'history'; $('diff-panel').hidden = true;
  setDisplayedContext(context, context.historical_analysis);
  $('snapshot-age').textContent = `Historical snapshot · ${new Date(context.observation.first_observed).toLocaleString()} [${snapshotId}]`;
}

async function showLive() {
  review.viewRequest++; review.diffRequest++; state.detailRequest++; $('inspector').close();
  review.mode = 'live'; review.diff = null; $('diff-panel').hidden = true;
  resetAnalysis('Returned to live context. Selection cleared.');
  renderViewStatus(); await loadContext();
}

async function loadDiff() {
  review.pairChosen = true;
  const session = state.session, run = review.runId, request = ++review.diffRequest;
  const before = $('diff-before').value, after = $('diff-after').value;
  review.viewRequest++; state.detailRequest++; $('inspector').close();
  $('diff-status').textContent = 'Comparing retained snapshots…';
  $('diff-panel').hidden = false;
  try {
    const diff = await api(`/api/sessions/${encodeURIComponent(session)}/diff?${new URLSearchParams({run_id: run, before, after})}`);
    if (request !== review.diffRequest || session !== state.session || run !== review.runId) return;
    review.mode = 'diff'; review.diff = diff; review.diffRows = 80;
    pruning.selected.clear(); invalidatePruning();
    invalidateSummary('Snapshot comparison is inspection-only.');
    resetAnalysis('Comparison view. Selection cleared.');
    const categories = new Map([...diff.before.categories, ...diff.after.categories].map((category) => [category.id, category.name]));
    $('diff-category').replaceChildren(element('option', '', 'All categories'));
    $('diff-category').firstChild.value = '';
    for (const [id, name] of categories) { const option = element('option', '', name); option.value = id; $('diff-category').append(option); }
    $('diff-summary').textContent = `Known delta ${number(diff.known_delta)} · unknown delta ${number(diff.unknown_delta)} · ${Object.entries(diff.counts).map(([kind, count]) => `${count} ${kind}`).join(' · ')}`;
    $('diff-basis').textContent = `Before: ${diff.before.tokenizer}, window ${number(diff.before.window)}. After: ${diff.after.tokenizer}, window ${number(diff.after.window)}. Provider request usage remains separate.`;
    const totals = element('details');
    totals.append(element('summary', '', 'Category totals (full comparison)'));
    for (const category of diff.categories) totals.append(element('p', 'tiny',
      `${category.name}: before ≈ ${number(category.before_known)}, after ≈ ${number(category.after_known)}, Δ ${number(category.known_delta)}; unknown Δ ${number(category.unknown_delta)}`));
    $('diff-basis').append(totals);
    $('diff-status').textContent = ''; renderDiff(); renderParts(); renderViewStatus();
  } catch (error) { if (request === review.diffRequest) $('diff-status').textContent = error.message; }
}

function renderDiff() {
  if (!review.diff) return;
  const diff = review.diff, query = $('diff-search').value.toLowerCase(), category = $('diff-category').value;
  const matching = diff.rows.filter((row) => (!$('diff-class').value || row.kind === $('diff-class').value)
    && (!category || [row.before, row.after].some((part) => part?.category === category))
    && (!query || [row.before, row.after].some((part) => part && `${part.title} ${part.preview}`.toLowerCase().includes(query))));
  const rows = document.createDocumentFragment();
  for (const row of matching.slice(0, review.diffRows)) {
    const card = element('article', 'candidate');
    card.append(element('h3', '', `${row.kind} · ${(row.after || row.before).title} · Δ ${number(row.known_delta)}`));
    const flags = Object.entries(row).filter(([key, value]) => key.endsWith('_changed') && value).map(([key]) => key.replaceAll('_', ' '));
    card.append(element('p', 'tiny', flags.join(' · ')));
    const pair = element('div', 'diff-pair');
    for (const side of ['before', 'after']) {
      const part = row[side], box = element('div', 'diff-side');
      if (!part) { box.append(element('p', 'tiny', `${side}: absent`)); pair.append(box); continue; }
      const open = element('button', 'text-button', `${side}: ≈ ${number(part.tokens)} [${part.id}]`);
      const context = {...diff[side], run_id: diff.run_id, snapshot_id: diff[`${side}_id`]};
      open.addEventListener('click', () => inspect(part, context));
      box.append(open, element('p', 'tiny', part.preview)); pair.append(box);
    }
    const expand = element('button', 'text-button', 'Compare full text');
    expand.addEventListener('click', () => expandDiff(row, card).catch((error) => { expand.textContent = error.message; }));
    card.append(pair, expand); rows.append(card);
  }
  if (!matching.length) rows.append(element('p', 'tiny', 'No differences match these filters.'));
  $('diff-rows').replaceChildren(rows); $('diff-more').hidden = matching.length <= review.diffRows;
}

async function expandDiff(row, card) {
  const diff = review.diff, request = review.diffRequest;
  const sides = await Promise.all(['before', 'after'].map(async (side) => {
    if (!row[side]) return '(Absent)';
    const detail = await api(`/api/sessions/${encodeURIComponent(state.session)}/history/${encodeURIComponent(diff[`${side}_id`])}/part?${new URLSearchParams({run_id: diff.run_id, id: row[side].id})}`);
    const bytes = new TextEncoder().encode(detail.text), lines = new TextDecoder().decode(bytes.slice(0, 200 * 1024)).split('\n');
    return lines.slice(0, 2000).join('\n') + (bytes.length > 200 * 1024 || lines.length > 2000 ? '\n[Truncated comparison — open the inspector for complete text]' : '');
  }));
  if (request !== review.diffRequest || diff !== review.diff || !card.isConnected) return;
  const pair = card.querySelector('.diff-pair');
  pair.querySelectorAll('pre').forEach((node) => node.remove());
  sides.forEach((text, i) => pair.children[i].append(element('pre', 'diff-text', text)));
}

$('return-live').addEventListener('click', () => showLive().catch(showError));
$('compare-snapshots').addEventListener('click', () => loadDiff().catch(showError));
for (const id of ['diff-before', 'diff-after']) $(id).addEventListener('change', () => {
  review.pairChosen = true;
  review.diffRequest++; state.detailRequest++;
  $('compare-snapshots').disabled = !$('diff-before').value || !$('diff-after').value;
});
for (const id of ['diff-class', 'diff-category', 'diff-search']) $(id).addEventListener('input', () => { review.diffRows = 80; renderDiff(); });
$('diff-more').addEventListener('click', () => { review.diffRows += 80; renderDiff(); });

function selectionNotice(ids, scope, checked = true) {
  const units = [...new Set(ids)].map((id) => state.unitsById.get(id)).filter(Boolean);
  const blocked = units.filter((unit) => !unit.eligible).length;
  const pinned = units.filter((unit) => unit.eligible && unit.pinned).length;
  const eligible = units.length - blocked - pinned;
  return `${checked ? 'Selected' : 'Deselected'} ${scope}: ${eligible} selectable complete units. ${blocked} ineligible units skipped. ${pinned} pinned units skipped.${eligible ? '' : ' No selectable tool invocations in this scope.'}`;
}

function matchingUnitIds() {
  return [...new Set((state.context ? matchingParts() : []).map((part) => state.partUnits.get(part.id)?.id).filter(Boolean))];
}

function renderBulkState() {
  const states = [];
  for (const [id, label, ids] of [['select-all-tools', 'All snapshot tools', [...state.unitsById.keys()]],
    ['select-matching-tools', 'Matching tools', matchingUnitIds()]]) {
    const selectable = ids.filter((id) => state.unitsById.get(id)?.eligible && !state.unitsById.get(id)?.pinned);
    const selected = selectable.filter((id) => state.selected.has(id)).length;
    const status = selected === 0 ? 'empty' : selected === selectable.length ? 'all' : 'partial';
    $(id).disabled = !state.analysis || review.mode !== 'live';
    $(id).setAttribute('aria-pressed', status === 'partial' ? 'mixed' : String(status === 'all'));
    states.push(`${label}: ${status} (${selected}/${selectable.length})`);
  }
  $('bulk-state').textContent = states.join(' · ');
}

function pinButton(part) {
  const pin = review.pinState?.pins.find((pin) => pin.part_ids.includes(part.id));
  const button = element('button', 'text-button pin-button', pin ? 'Unpin' : 'Pin');
  button.setAttribute('aria-label', `${pin ? 'Unpin' : 'Pin'} ${part.title}`);
  button.title = pin?.kind === 'unit' || state.partUnits.has(part.id) ? 'Protect the complete tool invocation' : 'Protect this context part';
  button.disabled = !review.pinState || review.pinBusy;
  button.addEventListener('click', () => updatePin(part, pin));
  return button;
}

function acceptPins(pins) {
  const changed = review.pinState && pins.pin_version !== review.pinState.pin_version;
  review.pinState = pins;
  const protectedIds = new Set(pins.pins.map((pin) => pin.unit_id).filter(Boolean));
  for (const unit of state.unitsById.values()) {
    unit.pinned = protectedIds.has(unit.id); unit.selectable = unit.eligible && !unit.pinned;
    if (unit.pinned) state.selected.delete(unit.id);
  }
  if (changed) {
    invalidatePruning('Pins changed. Review pruning again.');
    invalidateSummary('Pins changed. Draft review was invalidated.');
    state.previewRequest++; state.preview = null; state.previewLoading = false;
    state.selectionNotice = 'Pins changed. Protected units were deselected; preview invalidated.';
  }
  $('pin-count').textContent = String(pins.pins.length);
  const fragment = document.createDocumentFragment();
  for (const pin of pins.pins) {
    const row = element('div', 'pin-entry');
    row.append(element('span', '', `${pin.label} · ${pin.kind === 'unit' ? 'Whole invocation' : 'Part'} · ${pin.resolved ? 'protected' : 'unresolved: source missing or ambiguous'} [${pin.id}]`));
    if (pin.resolved) {
      const inspectButton = element('button', 'text-button', 'Inspect');
      inspectButton.addEventListener('click', () => inspect(state.partsById.get(pin.part_ids[0])));
      row.append(inspectButton);
    }
    const unpin = element('button', 'text-button', 'Unpin');
    unpin.disabled = review.pinBusy; unpin.addEventListener('click', () => updatePin(null, pin)); row.append(unpin); fragment.append(row);
  }
  $('pin-list').replaceChildren(fragment);
  renderParts(); renderFindings(); renderPreview();
}

async function loadPins() {
  if (review.mode !== 'live' || !review.runId) return;
  const session = state.session, run = review.runId, revision = state.context?.revision, request = ++review.pinRequest;
  try {
    const pins = await api(`/api/sessions/${encodeURIComponent(session)}/pins`);
    if (request !== review.pinRequest || session !== state.session || run !== review.runId || revision !== state.context?.revision || review.mode !== 'live') return;
    if (pins.run_id !== run) { runChanged(); return; }
    $('pin-status').textContent = ''; acceptPins(pins);
  } catch (error) { if (request === review.pinRequest) $('pin-status').textContent = error.message; }
}

async function updatePin(part, pin) {
  if (!review.pinState || review.pinBusy || review.mode !== 'live') return;
  const session = state.session, run = review.runId, revision = state.context.revision, request = ++review.pinRequest;
  review.pinBusy = true; renderParts();
  const body = {run_id: run, pin_version: review.pinState.pin_version};
  if (!pin) Object.assign(body, {revision, part_ids: [part.id]});
  try {
    const pins = await api(`/api/sessions/${encodeURIComponent(session)}/pins${pin ? '/' + encodeURIComponent(pin.id) : ''}`,
      {method: pin ? 'DELETE' : 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (request !== review.pinRequest || session !== state.session || run !== review.runId || revision !== state.context?.revision) return;
    $('pin-status').textContent = ''; acceptPins(pins);
  } catch (error) { if (request === review.pinRequest) $('pin-status').textContent = error.message; }
  finally { if (session === state.session && run === review.runId) { review.pinBusy = false; renderParts(); } }
}

$('select-all-tools').addEventListener('click', () => {
  const ids = [...state.unitsById.keys()]; changeSelection(ids, true, selectionNotice(ids, 'all tools in this snapshot'));
});
$('select-matching-tools').addEventListener('click', () => {
  const ids = matchingUnitIds(); changeSelection(ids, true, selectionNotice(ids, 'tools matching the current filters'));
});
