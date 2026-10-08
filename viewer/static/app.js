const $ = (id) => document.getElementById(id);
const number = (value) => value == null ? '—' : new Intl.NumberFormat().format(value);
const percent = (value) => value == null ? '—' : `${value.toFixed(value > 0 && value < 1 ? 2 : 1)}%`;
const state = { sessions: [], session: null, context: null, category: null, live: true, interval: 5000,
  next: null, sessionRequest: 0, contextRequest: 0, detailRequest: 0, rows: 80, timer: null, detail: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(path) {
  const response = await fetch(path, { cache: 'no-store' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.detail || `Request failed (${response.status})`);
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
  state.context = context;
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

function renderParts() {
  if (!state.context) return;
  const query = $('part-search').value.trim().toLowerCase();
  let parts = state.context.parts.filter((part) => (!state.category || part.category === state.category)
    && (!query || `${part.title} ${part.preview}`.toLowerCase().includes(query)));
  const sort = $('sort').value;
  parts.sort((a, b) => sort === 'largest' ? (b.tokens ?? -1) - (a.tokens ?? -1) : sort === 'newest' ? b.order - a.order : a.order - b.order);
  const fragment = document.createDocumentFragment();
  const max = Math.max(1, ...state.context.categories.map((category) => category.tokens));
  for (const part of parts.slice(0, state.rows)) {
    const category = state.context.categories.find((category) => category.id === part.category);
    const row = element('tr', 'part-row');
    const label = element('td');
    const open = element('button', 'part-open');
    open.setAttribute('aria-label', `Inspect ${part.title}`);
    const title = element('div', 'part-title');
    const swatch = element('span', 'swatch');
    swatch.style.backgroundColor = category.color;
    title.append(swatch, element('span', '', part.title));
    open.append(title, element('div', 'part-preview', part.preview || part.note || 'No readable text'));
    open.addEventListener('click', () => inspect(part));
    label.append(open);
    const size = element('td', 'part-size', part.tokens == null ? 'Unknown' : `≈ ${number(part.tokens)}`);
    const meter = element('div', 'size-meter');
    const fill = element('span');
    fill.style.width = `${Math.min(100, (part.tokens || 0) / max * 100)}%`;
    fill.style.backgroundColor = category.color;
    meter.append(fill); size.append(meter);
    const arrow = element('td', 'part-arrow', '›');
    arrow.setAttribute('aria-hidden', 'true');
    row.append(label, size, element('td', '', percent(part.percent)), element('td', '', percent(part.window_percent)), arrow);
    fragment.append(row);
  }
  $('parts').replaceChildren(fragment);
  $('filtered-count').textContent = `${parts.length} parts`;
  $('parts-empty').hidden = parts.length !== 0;
  $('more-parts').hidden = parts.length <= state.rows;
  $('more-parts').textContent = `Show more (${parts.length - state.rows} remaining)`;
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
  if (state.live) refresh();
  schedule();
});
$('clear-filter').addEventListener('click', () => toggleCategory(state.category));
for (const id of ['part-search', 'sort']) $(id).addEventListener('input', () => { state.rows = 80; renderParts(); });
$('more-parts').addEventListener('click', () => { state.rows += 80; renderParts(); });
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
