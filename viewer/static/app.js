const $ = (id) => document.getElementById(id);
const number = (value) => value == null ? '—' : new Intl.NumberFormat().format(value);
const percent = (value) => value == null ? '—' : `${value.toFixed(value > 0 && value < 1 ? 2 : 1)}%`;
const state = { sessions: [], session: null, context: null, category: null, live: true, interval: 5000,
  next: null, sessionRequest: 0, contextRequest: 0, detailRequest: 0, rows: 80, timer: null, detail: null,
  analysis: null, analysisRequest: 0, analysisLoading: false, analysisError: '', partsById: new Map(),
  unitsById: new Map(), partUnits: new Map(), expanded: new Set(), evidenceExpanded: new Set(), findingRows: 80,
  selected: new Set(), selectionNotice: '', preview: null, previewRequest: 0, previewLoading: false, previewError: '' };

const blockedLabels = { 'instruction-content': 'Instruction or skill content', failed: 'Failed call',
  incomplete: 'Unfinished call', 'missing-result': 'Missing input or result', 'unknown-size': 'Unknown token size' };
const ruleLabels = { 'duplicate-result': 'Exact duplicate', 'repeated-read': 'Repeated read', 'large-result': 'Large result' };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body.detail;
    const message = typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map((error) => error.msg).join('; ') : detail?.message;
    const error = new Error(message || `Request failed (${response.status})`);
    error.code = detail?.code;
    throw error;
  }
  return body;
}

function showError(error) {
  $('error').textContent = error.message;
  $('error').hidden = false;
  $('connection-dot').classList.add('error-dot');
  $('connection-label').textContent = 'Connection error';
}

function connected() {
  $('error').hidden = true;
  $('connection-dot').classList.remove('error-dot');
  $('connection-label').textContent = 'OpenCode connected';
}

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

function renderSessions() {
  const fragment = document.createDocumentFragment();
  for (const session of state.sessions) {
    const button = element('button', `session${session.id === state.session ? ' selected' : ''}`);
    button.setAttribute('aria-current', session.id === state.session ? 'true' : 'false');
    button.title = `${session.title || 'Untitled session'} [${session.id}]\n${session.location?.directory || ''}`;
    button.append(element('div', 'session-title', session.title || 'Untitled session'));
    const meta = element('div', 'session-path');
    const directory = session.location?.directory?.replace(/\/$/, '').split('/').pop() || 'No directory';
    meta.append(element('span', '', `${session.parentID ? '↳ ' : ''}${directory}`));
    meta.append(element('span', session.active ? 'active-label' : '', session.active ? '● Running' : timeAgo(session.time?.updated)));
    button.append(meta);
    button.addEventListener('click', () => selectSession(session.id).catch(showError));
    fragment.append(button);
  }
  if (!state.sessions.length) fragment.append(element('p', 'loading muted', 'No matching sessions.'));
  $('sessions').replaceChildren(fragment);
  $('session-count').textContent = `${state.sessions.length}${state.next ? '+' : ''}`;
  $('load-more').hidden = !state.next;
}

async function loadSessions(append = false, retain = false) {
  const request = ++state.sessionRequest;
  const params = new URLSearchParams({ search: $('session-search').value });
  if (append && state.next) params.set('cursor', state.next);
  const response = await api(`/api/sessions?${params}`);
  if (request !== state.sessionRequest) return;
  if (append) {
    const known = new Set(state.sessions.map((session) => session.id));
    state.sessions.push(...response.sessions.filter((session) => !known.has(session.id)));
  } else if (retain && state.sessions.length > 50) {
    const firstPage = new Set(response.sessions.map((session) => session.id));
    state.sessions = [...response.sessions, ...state.sessions.filter((session) => !firstPage.has(session.id))];
  } else state.sessions = response.sessions;
  if (!retain || state.sessions.length <= 50) state.next = response.next;
  renderSessions();
  if (!state.session && state.sessions.length) {
    await selectSession(state.sessions[0].id);
  } else if (!state.session) {
    $('welcome').replaceChildren(element('h1', '', 'No sessions yet'), element('p', '', 'Start a conversation in OpenCode, then refresh.'));
  }
}

async function selectSession(id) {
  if (id === state.session && state.context) return;
  resetAnalysis(state.session && id !== state.session ? 'Session changed. Selection cleared.' : '');
  state.session = id;
  state.context = null;
  state.category = null;
  state.rows = 80;
  state.detailRequest++;
  $('inspector').close();
  $('part-search').value = '';
  $('dashboard').hidden = true;
  $('welcome').hidden = false;
  $('welcome').replaceChildren(element('div', 'loader'), element('h1', '', 'Focusing context…'), element('p', '', 'Reading the active session snapshot.'));
  const url = new URL(location.href);
  url.searchParams.set('session', id);
  history.replaceState(null, '', url);
  try { localStorage.setItem('context-lens-session', id); } catch { /* Storage may be disabled. */ }
  renderSessions();
  try { await loadContext(); } catch (error) {
    if (state.session !== id) return;
    $('welcome').replaceChildren(element('h1', '', 'Could not load this session'), element('p', '', 'Select another session or try refreshing.'));
    throw error;
  }
}

async function loadContext() {
  if (!state.session) return;
  const session = state.session;
  const request = ++state.contextRequest;
  let context;
  try { context = await api(`/api/sessions/${encodeURIComponent(session)}/context`); }
  catch (error) {
    if (session !== state.session || request !== state.contextRequest) return;
    throw error;
  }
  if (session !== state.session || request !== state.contextRequest) return;
  const changed = context.revision !== state.context?.revision;
  if (changed) resetAnalysis(state.context ? 'Snapshot changed. Selection cleared; review the new context.' : state.selectionNotice);
  state.context = context;
  state.partsById = new Map(context.parts.map((part) => [part.id, part]));
  connected();
  $('welcome').hidden = true;
  $('dashboard').hidden = false;
  renderMetrics();
  if (changed) {
    renderCategories();
    renderParts();
    // The inspector keeps the version the user opened, even while live updates arrive.
    if ($('inspector').open && state.detail) {
      $('detail-note').hidden = false;
      $('detail-note').textContent = 'Context has updated. This inspector shows the snapshot you opened; reopen the part for its latest content.';
    }
  }
  if (!state.analysis && !state.analysisLoading) await loadAnalysis();
}

function renderMetrics() {
  const context = state.context;
  const session = context.session;
  $('session-title').textContent = session.title || 'Untitled session';
  document.title = `${session.title || 'Session'} · Context Lens`;
  $('session-directory').textContent = session.location?.directory || '';
  $('session-id').textContent = `[${session.id}]`;
  $('model-name').textContent = context.model?.name || session.model?.id || 'Model unknown';
  $('model-name').title = `[${session.model?.providerID || '?'}/${session.model?.id || '?'}]`;
  $('visible-tokens').textContent = number(context.tokens);
  $('visible-window').textContent = context.window ? `${percent(context.window_percent)} of model window` : 'Window size unknown';
  $('visible-bar').style.width = `${Math.min(100, context.window_percent || 0)}%`;
  $('window-tokens').textContent = number(context.window);
  $('input-limit').textContent = context.model?.limit?.input ? `${number(context.model.limit.input)} input limit` : 'Selected model capacity';
  $('part-count').textContent = number(context.part_count);
  $('message-count').textContent = `Across ${number(context.message_count)} active messages`;
  $('unknown-count').textContent = context.unknown_count ? `${context.unknown_count} parts with unknown token size` : 'Text content available to inspect';
  const reported = context.reported;
  $('reported-tokens').textContent = number(reported?.input);
  $('reported-caption').textContent = !reported ? 'No completed request in active context' : reported.same_model
    ? `${percent(reported.percent)} of window · ${timeAgo(reported.completed)}` : `Previous model: ${reported.model.id}`;
  $('reported-cache').textContent = reported ? `${number(reported.cache_read)} cached · ${number(reported.output)} output tokens` : 'Provider usage will appear after a reply';
  $('reported-cache').title = reported ? `Uncached input: ${number(reported.uncached_input)}; cache read: ${number(reported.cache_read)}; cache write: ${number(reported.cache_write)}; reasoning: ${number(reported.reasoning)}. Request [${reported.message_id}]` : '';
  $('updated').textContent = `Updated ${new Date(context.fetched_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  $('snapshot-age').textContent = `${state.live ? 'Displayed snapshot' : 'Paused snapshot'} · ${new Date(context.fetched_at).toLocaleString()} · ${timeAgo(context.fetched_at)}`;
  $('tokenizer').textContent = context.tokenizer;
  $('scope').textContent = context.scope;
  $('model-warning').textContent = context.warning || '';
  $('excluded').textContent = Object.keys(context.excluded).length ? `Non-content events excluded: ${Object.entries(context.excluded).map(([key, value]) => `${key} (${value})`).join(', ')}.` : '';
}

function toggleCategory(id) {
  state.category = state.category === id ? null : id;
  state.rows = 80;
  renderCategories();
  renderParts();
}

function renderCategories() {
  const bars = document.createDocumentFragment();
  const cards = document.createDocumentFragment();
  for (const category of state.context.categories) {
    const selected = state.category === category.id;
    if (category.tokens) {
      const segment = element('button', `segment${selected ? ' selected' : ''}${state.category && !selected ? ' dimmed' : ''}`);
      segment.style.flexGrow = category.tokens;
      segment.style.backgroundColor = category.color;
      segment.title = `${category.name}: ≈${number(category.tokens)} tokens · ${percent(category.percent)} visible`;
      segment.setAttribute('aria-label', segment.title);
      segment.setAttribute('aria-pressed', String(selected));
      segment.addEventListener('click', () => toggleCategory(category.id));
      bars.append(segment);
    }
    const card = element('button', `category${selected ? ' selected' : ''}`);
    card.setAttribute('aria-pressed', String(selected));
    const label = element('div', 'category-label');
    const swatch = element('span', 'swatch');
    swatch.style.backgroundColor = category.color;
    label.append(swatch, document.createTextNode(category.name));
    const values = element('div', 'category-values');
    values.append(document.createTextNode(`${number(category.tokens)}${category.unknown ? ' + ?' : ''}`), element('small', '', percent(category.percent)));
    card.append(label, values);
    card.title = `${category.count} parts · ${percent(category.window_percent)} of window${category.unknown ? ' · Some sizes unknown' : ''}`;
    card.addEventListener('click', () => toggleCategory(category.id));
    cards.append(card);
  }
  $('composition-bar').replaceChildren(bars);
  $('categories').replaceChildren(cards);
  $('clear-filter').hidden = !state.category;
}

function matchingParts() {
  const query = $('part-search').value.trim().toLowerCase();
  return state.context.parts.filter((part) => (!state.category || part.category === state.category)
    && (!query || `${part.title} ${part.preview}`.toLowerCase().includes(query)));
}

function sortParts(parts) {
  const sort = $('sort').value;
  return parts.sort((a, b) => sort === 'largest' ? (b.tokens ?? -1) - (a.tokens ?? -1) || a.order - b.order
    : sort === 'newest' ? b.order - a.order : a.order - b.order);
}

function unitCheckbox(unit, id, label) {
  const wrapper = element('label', 'unit-select');
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.id = id;
  checkbox.disabled = !unit?.eligible;
  checkbox.checked = !!unit && state.selected.has(unit.id);
  checkbox.setAttribute('aria-label', `Select ${label}`);
  wrapper.title = unit ? (unit.eligible ? `Complete tool invocation [${unit.id}]` : blockedLabels[unit.blocked_reason]) : 'Not a selectable tool invocation';
  checkbox.addEventListener('change', () => changeSelection([unit.id], checkbox.checked));
  wrapper.append(checkbox);
  return wrapper;
}

function partRow(part, grouped = false) {
  const category = state.context.categories.find((category) => category.id === part.category);
  const unit = state.partUnits.get(part.id);
  const row = element('tr', `part-row${grouped ? ' group-members' : ''}${unit && state.selected.has(unit.id) ? ' is-selected' : ''}`);
  row.dataset.partId = part.id;
  const label = element('td');
  const content = element('div', 'part-label');
  if (state.analysis) content.append(unitCheckbox(unit, `select-part:${part.id}`, part.title));
  const open = element('button', 'part-open');
  open.setAttribute('aria-label', `Inspect ${part.title}`);
  open.title = `[${part.id}]`;
  const title = element('div', 'part-title');
  const swatch = element('span', 'swatch');
  swatch.style.backgroundColor = category.color;
  title.append(swatch, element('span', '', part.title));
  open.append(title, element('div', 'part-preview', part.preview || part.note || 'No readable text'));
  if (unit && !unit.eligible) open.append(element('div', 'blocked-reason', blockedLabels[unit.blocked_reason]));
  open.addEventListener('click', () => inspect(part));
  content.append(open); label.append(content);
  const size = element('td', 'part-size', part.tokens == null ? 'Unknown' : `≈ ${number(part.tokens)}`);
  const meter = element('div', 'size-meter');
  const fill = element('span');
  const max = Math.max(1, ...state.context.categories.map((category) => category.tokens));
  fill.style.width = `${Math.min(100, (part.tokens || 0) / max * 100)}%`;
  fill.style.backgroundColor = category.color;
  meter.append(fill); size.append(meter);
  const arrow = element('td', 'part-arrow', '›');
  arrow.setAttribute('aria-hidden', 'true');
  row.append(label, size, element('td', '', percent(part.percent)), element('td', '', percent(part.window_percent)), arrow);
  return row;
}

function renderParts() {
  if (!state.context) return;
  const parts = sortParts(matchingParts());
  const mode = $('group-mode').value;
  const grouped = mode !== 'flat' && !!state.analysis;
  $('group-status').hidden = mode === 'flat' || grouped;
  $('group-status').textContent = 'Grouping awaits analysis. Showing the flat inventory.';
  const fragment = document.createDocumentFragment();
  let remaining = 0;
  if (!grouped) {
    fragment.append(...parts.slice(0, state.rows).map((part) => partRow(part)));
    remaining = parts.length - state.rows;
  } else {
    const matching = new Set(parts.map((part) => part.id));
    const groups = state.analysis.groups.filter((group) => group.mode === mode).map((group) => {
      const members = group.part_ids.filter((id) => matching.has(id)).map((id) => state.partsById.get(id));
      return { ...group, members, tokens: members.reduce((total, part) => total + (part.tokens || 0), 0),
        unknown: members.filter((part) => part.tokens == null).length };
    }).filter((group) => group.members.length);
    const sort = $('sort').value;
    groups.sort((a, b) => sort === 'largest' ? b.tokens - a.tokens || a.members[0].order - b.members[0].order
      : sort === 'newest' ? b.members.at(-1).order - a.members.at(-1).order : a.members[0].order - b.members[0].order);
    let budget = state.rows;
    for (const group of groups) {
      if (budget <= 0) { remaining++; continue; }
      budget--;
      const expanded = state.expanded.has(group.id);
      const row = element('tr', 'group-row');
      row.dataset.groupId = group.id;
      const label = element('td');
      const toggle = element('button', 'group-toggle', `${expanded ? '▾' : '▸'} ${group.label}`);
      toggle.id = `group-toggle:${group.id}`;
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.title = `[${group.id}]`;
      toggle.addEventListener('click', () => {
        if (expanded) state.expanded.delete(group.id); else state.expanded.add(group.id);
        renderParts(); $(toggle.id)?.focus();
      });
      label.append(toggle, element('div', 'tiny', `${group.members.length} matching parts${group.unknown ? ` · ${group.unknown} unmeasured` : ''}`));
      const ids = [...new Set(group.members.map((part) => state.partUnits.get(part.id)?.id).filter(Boolean))];
      if (ids.length) {
        const actions = element('div', 'group-actions');
        for (const [text, checked] of [['Select eligible', true], ['Deselect', false]]) {
          const button = element('button', 'text-button', text);
          button.setAttribute('aria-label', `${text} in ${group.label}`);
          button.id = `group-${checked ? 'select' : 'clear'}:${group.id}`;
          button.addEventListener('click', () => {
            const skipped = ids.filter((id) => !state.unitsById.get(id).eligible).length;
            changeSelection(ids, checked, `${checked ? 'Selected' : 'Deselected'} eligible units in ${group.label}. ${skipped} ineligible units skipped.`);
          });
          actions.append(button);
        }
        label.append(actions);
      }
      const share = (total) => total ? group.tokens / total * 100 : null;
      row.append(label, element('td', 'part-size', `≈ ${number(group.tokens)}${group.unknown ? ' + ?' : ''}`),
        element('td', '', percent(share(state.context.tokens))), element('td', '', percent(share(state.context.window))), element('td'));
      fragment.append(row);
      if (expanded) {
        const members = sortParts(group.members);
        fragment.append(...members.slice(0, budget).map((part) => partRow(part, true)));
        remaining += Math.max(0, members.length - budget);
        budget -= Math.min(budget, members.length);
      }
    }
  }
  $('parts').replaceChildren(fragment);
  $('filtered-count').textContent = `${parts.length} parts`;
  $('parts-empty').hidden = parts.length !== 0;
  $('more-parts').hidden = remaining <= 0;
  $('more-parts').textContent = 'Show more inventory';
  renderSelectionSummary();
}

function resetAnalysis(notice) {
  state.analysisRequest++;
  state.previewRequest++;
  state.analysis = null;
  state.analysisLoading = false;
  state.analysisError = '';
  state.unitsById.clear();
  state.partUnits.clear();
  state.expanded.clear();
  state.evidenceExpanded.clear();
  state.findingRows = 80;
  state.selected.clear();
  state.selectionNotice = notice;
  state.preview = null;
  state.previewLoading = false;
  state.previewError = '';
  renderFindings();
  renderPreview();
}

async function loadAnalysis() {
  const session = state.session;
  const revision = state.context.revision;
  const request = ++state.analysisRequest;
  const current = () => request === state.analysisRequest && session === state.session && revision === state.context?.revision;
  state.analysisLoading = true;
  state.analysisError = '';
  renderFindings();
  try {
    const params = new URLSearchParams({ revision });
    const analysis = await api(`/api/sessions/${encodeURIComponent(session)}/analysis?${params}`);
    if (!current()) return;
    if (analysis.session_id !== session || analysis.revision !== revision) throw new Error('Analysis returned a different snapshot. Refresh to retry.');
    state.analysis = analysis;
    state.unitsById = new Map(analysis.units.map((unit) => [unit.id, unit]));
    state.partUnits = new Map(analysis.units.flatMap((unit) => unit.part_ids.map((id) => [id, unit])));
  } catch (error) {
    if (!current()) return;
    state.analysisError = `Analysis unavailable. ${error.message}`;
  } finally {
    if (current()) {
      state.analysisLoading = false;
      renderFindings(); renderParts(); renderPreview();
    }
  }
}

function renderFindings() {
  $('analysis-status').textContent = state.analysisError || (state.analysisLoading ? 'Analyzing this snapshot…'
    : state.analysis ? (state.analysis.findings.length ? 'Evidence refers to the full displayed snapshot.' : 'No repeated or large eligible tool results found.')
      : 'Analysis will appear after the snapshot loads.');
  $('analysis-status').classList.toggle('failed', !!state.analysisError);
  const candidates = new Map();
  for (const finding of state.analysis?.findings || []) {
    if (!candidates.has(finding.unit_id)) candidates.set(finding.unit_id, []);
    candidates.get(finding.unit_id).push(finding);
  }
  const units = (state.analysis?.units || []).filter((unit) => candidates.has(unit.id));
  if ($('findings-sort').value === 'largest') units.sort((a, b) => b.tokens - a.tokens);
  const total = units.reduce((tokens, unit) => tokens + unit.tokens, 0);
  $('candidate-count').textContent = state.analysis ? String(units.length) : '—';
  $('opportunity-total').textContent = state.analysis
    ? `${units.length} unique candidate units · ≈ ${number(total)} tokens to review. Overlapping reasons count each unit once.` : '';
  const fragment = document.createDocumentFragment();
  for (const unit of units.slice(0, state.findingRows)) {
    const card = element('article', 'candidate');
    card.dataset.unitId = unit.id;
    const heading = element('div', 'candidate-heading');
    const label = element('div', 'candidate-label');
    label.append(unitCheckbox(unit, `select-finding:${unit.id}`, unit.label), document.createTextNode(` ${unit.label}`),
      element('span', 'technical technical-id', `[${unit.id}]`));
    heading.append(label, element('span', 'candidate-size', `≈ ${number(unit.tokens)} tokens`));
    card.append(heading);
    for (const finding of candidates.get(unit.id)) card.append(element('span', 'reason-badge', ruleLabels[finding.rule]));
    const details = element('details');
    details.open = state.evidenceExpanded.has(unit.id);
    details.append(element('summary', '', 'Reasons and evidence'));
    details.addEventListener('toggle', () => {
      if (details.open) state.evidenceExpanded.add(unit.id); else state.evidenceExpanded.delete(unit.id);
    });
    for (const finding of candidates.get(unit.id)) {
      const evidence = element('div', 'evidence');
      evidence.append(element('p', '', finding.reason));
      const reference = state.unitsById.get(finding.reference_unit_id);
      if (reference) evidence.append(element('p', 'muted', `Newest reference: ${reference.label} [${reference.id}]`));
      const links = element('div', 'evidence-links');
      for (const id of finding.evidence_part_ids) {
        const part = state.partsById.get(id);
        if (!part) continue;
        const button = element('button', 'text-button', `${part.title} [${id}]`);
        button.addEventListener('click', () => inspect(part));
        links.append(button);
      }
      evidence.append(links); details.append(evidence);
    }
    card.append(details); fragment.append(card);
  }
  $('findings').replaceChildren(fragment);
  $('more-findings').hidden = units.length <= state.findingRows;
}

function renderSelectionSummary() {
  const members = new Set([...state.selected].flatMap((id) => state.unitsById.get(id)?.part_ids || []));
  const matching = new Set(state.context ? matchingParts().map((part) => part.id) : []);
  const hidden = [...members].filter((id) => !matching.has(id)).length;
  $('selection-summary').textContent = `${state.selected.size} complete tool units · ${members.size} selected parts${hidden ? ` · ${hidden} paired parts outside the filter` : ''}.`;
  $('selection-notice').textContent = state.selectionNotice;
  $('clear-selection').disabled = state.selected.size === 0;
  $('preview-selection').disabled = !state.analysis || state.previewLoading;
}

function changeSelection(ids, checked, notice = '') {
  for (const id of ids) {
    if (!state.unitsById.get(id)?.eligible) continue;
    if (checked) state.selected.add(id); else state.selected.delete(id);
  }
  state.selectionNotice = notice;
  const focus = document.activeElement?.id;
  renderParts(); renderFindings();
  if (focus) $(focus)?.focus();
  requestPreview();
}

async function requestPreview() {
  if (!state.analysis) return;
  const session = state.session;
  const revision = state.context.revision;
  const request = ++state.previewRequest;
  const current = () => request === state.previewRequest && session === state.session && revision === state.context?.revision;
  state.preview = null;
  state.previewError = '';
  state.previewLoading = true;
  renderPreview();
  try {
    const preview = await api(`/api/sessions/${encodeURIComponent(session)}/cleanup-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, unit_ids: [...state.selected] }),
    });
    if (!current()) return;
    if (preview.session_id !== session || preview.revision !== revision) throw new Error('Preview returned a different snapshot. Refresh and reselect.');
    state.preview = preview;
  } catch (error) {
    if (!current()) return;
    state.previewError = error.message;
  } finally {
    if (current()) { state.previewLoading = false; renderPreview(); }
  }
}

function renderPreview() {
  renderSelectionSummary();
  $('preview-status').textContent = state.previewError || (state.previewLoading ? 'Calculating selection…' : '');
  $('preview-status').classList.toggle('failed', !!state.previewError);
  const preview = state.preview;
  const fragment = document.createDocumentFragment();
  if (preview) {
    for (const [label, tokens, caption] of [
      ['Before', preview.before_visible_tokens, 'visible text tokens'],
      ['Selected', preview.selected_estimated_tokens, `${percent(preview.selected_visible_percent)} of visible · ${percent(preview.selected_window_percent)} of window`],
      ['Remaining', preview.after_visible_tokens, `${percent(preview.after_window_percent)} of window`],
    ]) {
      const card = element('div', 'preview-value');
      card.append(element('span', '', label), element('strong', '', `≈ ${number(tokens)}`), element('span', '', caption));
      fragment.append(card);
    }
  }
  $('preview-values').replaceChildren(fragment);
  $('preview-values').hidden = !preview;
  $('preview-scope').textContent = preview
    ? `${preview.tokenizer} · ${preview.unmeasured_parts} unmeasured parts remain. ${preview.window_tokens == null ? 'Model window unknown. ' : ''}Visible-text estimate only; provider-reported usage is unchanged.`
    : 'Select complete tool units. Estimates cover visible text only; provider-reported usage stays separate.';
}

async function inspect(part) {
  const request = ++state.detailRequest;
  const context = state.context;
  state.detail = null;
  $('detail-title').textContent = part.title;
  $('detail-category').textContent = context.categories.find((category) => category.id === part.category).name;
  $('detail-id').textContent = `[${part.message_id}]`;
  $('detail-note').hidden = !part.note;
  $('detail-note').textContent = part.note || '';
  $('detail-stats').replaceChildren(...[`${part.tokens == null ? 'Unknown' : `≈ ${number(part.tokens)}`} tokens`, `${percent(part.percent)} of visible`, `${percent(part.window_percent)} of window`, `${number(part.bytes)} text bytes`].map((text) => element('span', '', text)));
  $('detail-text').textContent = 'Loading content…';
  $('copy').disabled = true;
  $('copy').textContent = 'Copy text';
  $('inspector').showModal();
  try {
    const params = new URLSearchParams({ id: part.id, revision: context.revision });
    const detail = await api(`/api/sessions/${encodeURIComponent(state.session)}/part?${params}`);
    if (request !== state.detailRequest) return;
    state.detail = detail;
    $('detail-text').textContent = detail.text || '(No readable text)';
    $('copy').disabled = false;
  } catch (error) { if (request === state.detailRequest) $('detail-text').textContent = error.message; }
}

async function refresh() {
  $('refresh').disabled = true;
  const outcomes = await Promise.allSettled([loadSessions(false, true), loadContext()]);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed) showError(failed.reason);
  else connected();
  $('refresh').disabled = false;
}

function schedule() {
  clearTimeout(state.timer);
  state.timer = setTimeout(async () => {
    if (state.live && !document.hidden && !$('refresh').disabled) await refresh();
    schedule();
  }, state.interval);
}

let searchTimer;
$('session-search').addEventListener('input', () => {
  state.sessionRequest++;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadSessions().catch(showError), 250);
});
$('load-more').addEventListener('click', async () => {
  $('load-more').disabled = true;
  try { await loadSessions(true); } catch (error) { showError(error); }
  $('load-more').disabled = false;
});
$('refresh').addEventListener('click', async () => { await refresh(); schedule(); });
$('live').addEventListener('click', () => {
  state.live = !state.live;
  $('live').setAttribute('aria-pressed', String(state.live));
  $('live').querySelector('span').textContent = state.live ? 'Live' : 'Paused';
  $('live').querySelector('.dot').classList.toggle('off', !state.live);
  if (state.context) renderMetrics();
  if (state.live) refresh();
  schedule();
});
$('clear-filter').addEventListener('click', () => toggleCategory(state.category));
for (const id of ['part-search', 'sort', 'group-mode']) $(id).addEventListener('input', () => { state.rows = 80; renderParts(); });
$('more-parts').addEventListener('click', () => { state.rows += 80; renderParts(); });
$('findings-sort').addEventListener('input', () => { state.findingRows = 80; renderFindings(); });
$('more-findings').addEventListener('click', () => { state.findingRows += 80; renderFindings(); });
$('clear-selection').addEventListener('click', () => changeSelection([...state.selected], false, 'Selection cleared.'));
$('preview-selection').addEventListener('click', requestPreview);
$('detail-close').addEventListener('click', () => $('inspector').close());
$('inspector').addEventListener('close', () => { state.detailRequest++; });
$('settings-open').addEventListener('click', () => $('settings-dialog').showModal());
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.detail.text); $('copy').textContent = 'Copied'; }
  catch { $('copy').textContent = 'Select text to copy'; }
});

async function start() {
  try {
    const settings = await api('/api/settings');
    state.interval = settings.refresh_seconds * 1000;
    $('setting-path').textContent = settings.executable;
    $('setting-server').textContent = settings.server;
    $('setting-refresh').textContent = `${settings.refresh_seconds} seconds`;
    let requested = new URLSearchParams(location.search).get('session');
    if (!requested) { try { requested = localStorage.getItem('context-lens-session'); } catch { /* Optional preference. */ } }
    if (requested) state.session = requested;
    await loadSessions();
    if (requested) await selectSession(requested);
    connected();
  } catch (error) {
    showError(error);
    $('welcome').replaceChildren(element('h1', '', 'Waiting for OpenCode'), element('p', '', 'Check the connection above, then use Refresh to retry.'));
  }
  schedule();
}
start();
