// FTC Film Room — browser app. Plain JavaScript, no build step.
'use strict';
{
// ---------- constants ----------
const PREROLL = 6;          // seconds shown before the match starts
const AUTO = 30, TRANSITION = 8, TELEOP = 120;
const MATCH_LEN = AUTO + TRANSITION + TELEOP; // 158 s
const POSTROLL = 12;
const ENDGAME = 30;         // last 30 s of TeleOp shaded on the timeline
const CATEGORIES = ['Auto', 'TeleOp', 'Endgame', 'Scoring', 'Defense', 'Penalty', 'Breakdown', 'Driving', 'Strategy', 'Other'];

// ---------- tiny DOM helper: every value goes in as text, never as markup ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const mount = (...nodes) => { app.replaceChildren(...nodes); };

let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, err ? 6000 : 3000);
}

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method, credentials: 'same-origin',
    headers: { 'x-film-room': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !url.endsWith('/login')) { state.me = null; go('#/login'); throw new Error('Please sign in.'); }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const tryApi = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toast(e.message, true); return undefined; } };

// ---------- state + formatting ----------
const state = { me: null, ourTeam: null, events: null, eventCache: new Map() };
const canLead = () => state.me && (state.me.role === 'lead' || state.me.role === 'admin');
const isAdmin = () => state.me && state.me.role === 'admin';
function clock(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '–';
  const neg = sec < 0; const s = Math.floor(Math.abs(sec));
  return (neg ? '-' : '') + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function phase(t) {
  if (t < 0) return 'Pre-match';
  if (t < AUTO) return 'Auto';
  if (t < AUTO + TRANSITION) return 'Transition';
  if (t < MATCH_LEN - ENDGAME) return 'TeleOp';
  if (t <= MATCH_LEN) return 'Endgame';
  return 'After match';
}
const fmtTime = (iso, tz) => iso ? new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Detroit', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '';
const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
const ago = (iso) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
function resultFor(m, team) {
  if (!team || m.redScore === null || m.blueScore === null) return null;
  const side = m.red.includes(team) ? 'red' : m.blue.includes(team) ? 'blue' : null;
  if (!side) return null;
  const mine = side === 'red' ? m.redScore : m.blueScore, theirs = side === 'red' ? m.blueScore : m.redScore;
  return mine > theirs ? 'W' : mine < theirs ? 'L' : 'T';
}
async function loadEvent(id, force = false) {
  if (!force && state.eventCache.has(+id)) return state.eventCache.get(+id);
  const data = await api('GET', `/api/events/${id}`);
  state.eventCache.set(+id, data);
  return data;
}
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  return { parts: p.split('/').filter(Boolean), query: new URLSearchParams(q || '') };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ---------- shared pieces ----------
function nav() {
  const n = $('#nav');
  if (!state.me) { n.replaceChildren(); return; }
  n.replaceChildren(
    h('a', { class: 'btn small ghost', href: '#/' }, 'Events'),
    state.ourTeam ? h('a', { class: 'btn small ghost', href: `#/t/${state.ourTeam}` }, `Team ${state.ourTeam}`) : null,
    canLead() ? h('a', { class: 'btn small ghost', href: '#/admin' }, isAdmin() ? 'Admin' : 'Features') : null,
    h('a', { class: 'btn small ghost', href: '#/account', title: 'Account' }, state.me.displayName),
  );
}
function chipFor(f, extra) {
  return h('span', { class: `chip ${f.kind}` }, f.label, f.votes > 1 ? ` ×${f.votes}` : '', extra || null);
}
function allianceBox(m, side, highlight) {
  const score = side === 'red' ? m.redScore : m.blueScore, other = side === 'red' ? m.blueScore : m.redScore;
  const cls = score === null || other === null ? '' : score > other ? ' won' : score < other ? ' lost' : '';
  return h('div', { class: `al ${side}${cls}` },
    h('span', { class: 'ts' }, m[side].map((t) => (t === highlight ? h('b', {}, t) : h('span', {}, t)))),
    h('span', { class: 'score' }, score ?? '–'));
}
function matchRow(m, tz, highlight, ctxQuery) {
  const res = resultFor(m, highlight);
  const status = m.video ? m.video.status : 'novideo';
  const statusText = { synced: 'Clip ready', estimated: 'Clip ready', unsynced: 'Needs sync', novideo: 'No video' }[status];
  return h('a', { class: 'mrow', href: `#/m/${m.id}${ctxQuery || ''}` },
    h('div', {}, h('div', { class: 'lbl' }, m.label), h('div', { class: 'when' }, fmtTime(m.start, tz))),
    h('div', { class: 'vs' }, allianceBox(m, 'red', highlight), allianceBox(m, 'blue', highlight)),
    h('div', { class: 'meta' },
      res ? h('span', { class: `res ${res}` }, res === 'W' ? 'Win' : res === 'L' ? 'Loss' : 'Tie') : h('span', {}, ''),
      h('span', {}, h('span', { class: `dot ${status}` }), ' ', statusText),
      h('span', {}, m.notes ? `${m.notes} note${m.notes === 1 ? '' : 's'}` : '')));
}
function confirmButton(label, really, onConfirm, cls = 'small danger') {
  const b = h('button', { class: cls, type: 'button' }, label);
  let armed = false, timer;
  b.addEventListener('click', async () => {
    if (!armed) { armed = true; b.textContent = really; timer = setTimeout(() => { armed = false; b.textContent = label; }, 4000); return; }
    clearTimeout(timer); armed = false; b.textContent = label; await onConfirm();
  });
  return b;
}

// ---------- views ----------
async function viewLogin() {
  const err = h('p', { class: 'muted', role: 'alert' });
  const user = h('input', { id: 'u', autocomplete: 'username', autocapitalize: 'none', required: true });
  const pw = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'card stack', onsubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    try { await api('POST', '/api/login', { username: user.value, password: pw.value }); await boot(); go('#/'); }
    catch (x) { err.textContent = x.message; }
  } },
  h('h1', {}, 'Film Room'), h('p', { class: 'muted' }, 'Match video and scouting notes for the team. Sign in with the account your coach gave you.'),
  h('div', {}, h('label', { for: 'u' }, 'Username'), user), h('div', {}, h('label', { for: 'p' }, 'Password'), pw),
  h('button', { class: 'primary', type: 'submit' }, 'Sign in'), err);
  mount(h('div', { class: 'login' }, form));
  user.focus();
}

async function viewEvents() {
  const events = await api('GET', '/api/events');
  state.events = events;
  if (events.length === 1) return go(`#/e/${events[0].id}`);
  mount(h('h1', {}, 'Events'),
    events.length ? h('div', { class: 'mlist' }, events.map((e) => h('a', { class: 'mrow', href: `#/e/${e.id}` },
      h('div', { class: 'lbl' }, e.season), h('div', {}, h('h3', {}, e.name), h('div', { class: 'muted small' }, [fmtDate(e.startDate), e.venue].filter(Boolean).join(' · '))),
      h('div', { class: 'meta' }, e.live ? h('span', { class: 'badge live' }, 'Live') : '', `${e.matchCount} matches`, `${e.teamCount} teams`))))
      : h('p', { class: 'callout' }, isAdmin() ? 'No events yet. Add one from the Admin page.' : 'No events yet. Ask your coach to add one.'));
}

async function viewEvent(id, tab, query) {
  const data = await loadEvent(id, true);
  const { event: ev, matches, teams } = data;
  const teamFilter = +query.get('team') || null;
  const byNum = new Map(teams.map((t) => [t.number, t]));
  const teamLabel = (n) => `${n}${byNum.get(n)?.name ? ' ' + byNum.get(n).name : ''}`;

  const head = h('div', { class: 'ehead' },
    h('div', {}, h('h1', {}, ev.name), h('div', { class: 'muted' }, [fmtDate(ev.startDate), ev.venue, `${ev.season} · ${ev.code}`].filter(Boolean).join(' · '))),
    h('div', { class: 'row' }, ev.live ? h('span', { class: 'badge live' }, 'Live: refreshing every 3 min') : null,
      h('span', { class: 'badge' }, `Results from ${ago(ev.lastRefresh) || 'import'}`)));
  const setQuery = (team, t = tab) => go(`#/e/${ev.id}${t === 'teams' ? '/teams' : ''}${team ? `?team=${team}` : ''}`);
  const tabs = h('div', { class: 'tabs', role: 'tablist' },
    h('button', { role: 'tab', 'aria-selected': tab !== 'teams' ? 'true' : 'false', onclick: () => setQuery(teamFilter, 'matches') }, 'Matches'),
    h('button', { role: 'tab', 'aria-selected': tab === 'teams' ? 'true' : 'false', onclick: () => setQuery(teamFilter, 'teams') }, 'Teams'));

  const list = h('datalist', { id: 'teamlist' }, teams.map((t) => h('option', { value: teamLabel(t.number) })));
  const input = h('input', { list: 'teamlist', placeholder: 'Filter by team number or name', value: teamFilter ? teamLabel(teamFilter) : '', 'aria-label': 'Filter by team',
    onchange: () => { const n = parseInt(input.value, 10); const hit = teams.find((t) => t.number === n) || teams.find((t) => (t.name || '').toLowerCase().includes(input.value.trim().toLowerCase())); setQuery(input.value.trim() && hit ? hit.number : null); } });
  const filter = h('div', { class: 'filter' }, input, list,
    state.ourTeam && byNum.has(state.ourTeam) ? h('button', { class: 'chip', 'aria-pressed': teamFilter === state.ourTeam ? 'true' : 'false', onclick: () => setQuery(teamFilter === state.ourTeam ? null : state.ourTeam) }, `Our matches (${state.ourTeam})`) : null,
    teamFilter ? h('button', { class: 'small', onclick: () => setQuery(null) }, 'Clear') : null,
    teamFilter ? h('a', { class: 'btn small', href: `#/t/${teamFilter}?e=${ev.id}` }, `Team ${teamFilter} page`) : null);

  let body;
  if (tab === 'teams') body = teamsTable(ev, teams, data.features);
  else {
    const shown = teamFilter ? matches.filter((m) => m.red.includes(teamFilter) || m.blue.includes(teamFilter)) : matches;
    const ctx = teamFilter ? `?team=${teamFilter}` : '';
    const quals = shown.filter((m) => m.level === 'qual'), playoffs = shown.filter((m) => m.level !== 'qual');
    const unsynced = matches.length && matches.every((m) => !m.video || m.video.status === 'unsynced');
    body = h('div', {},
      unsynced ? h('p', { class: 'callout warn' }, canLead()
        ? 'This event’s video isn’t synced yet. Open any match, find the moment it starts in the stream, and tap “Match starts here”. One sync places every match.'
        : 'This event’s video hasn’t been synced yet. Your coach needs to sync it once, then every match clip works.') : null,
      quals.length ? [h('div', { class: 'section-title' }, `Qualifications (${quals.length})`), h('div', { class: 'mlist' }, quals.map((m) => matchRow(m, ev.timezone, teamFilter, ctx)))] : null,
      playoffs.length ? [h('div', { class: 'section-title' }, `Playoffs (${playoffs.length})`), h('div', { class: 'mlist' }, playoffs.map((m) => matchRow(m, ev.timezone, teamFilter, ctx)))] : null,
      !shown.length ? h('p', { class: 'muted' }, 'No matches for that team here.') : null);
  }
  mount(head, h('div', { class: 'row' }, tabs), filter, body);
}

function teamsTable(ev, teams, features) {
  let sortKey = 'number', dir = 1, featureFilter = null;
  const wrap = h('div', {});
  const cols = [
    ['number', 'Team', (t) => t.number], ['record', 'Qual record', (t) => t.wins * 2 + t.ties - t.played * 0.001],
    ['avg', 'Avg alliance pts', (t) => t.avgAlliance ?? -1], ['notes', 'Notes', (t) => t.notes], ['tags', 'Tags', (t) => t.features.reduce((a, f) => a + f.votes, 0)],
  ];
  function draw() {
    const col = cols.find((c) => c[0] === sortKey);
    const rows = teams.filter((t) => !featureFilter || t.features.some((f) => f.featureId === featureFilter))
      .slice().sort((a, b) => (col[2](a) - col[2](b)) * dir || a.number - b.number);
    const th = (c) => h('th', { 'aria-sort': sortKey === c[0] ? (dir > 0 ? 'ascending' : 'descending') : null },
      h('button', { onclick: () => { if (sortKey === c[0]) dir = -dir; else { sortKey = c[0]; dir = c[0] === 'number' ? 1 : -1; } draw(); } }, c[1], sortKey === c[0] ? (dir > 0 ? ' ▲' : ' ▼') : ''));
    wrap.replaceChildren(
      h('div', { class: 'filter' }, h('span', { class: 'muted small' }, 'Show teams tagged:'),
        features.filter((f) => !f.archived).map((f) => h('button', { class: `chip ${f.kind}`, 'aria-pressed': featureFilter === f.id ? 'true' : 'false', onclick: () => { featureFilter = featureFilter === f.id ? null : f.id; draw(); } }, f.label))),
      h('div', { class: 'scroll' }, h('table', { class: 'stack-t' },
        h('thead', {}, h('tr', {}, cols.map(th))),
        h('tbody', {}, rows.map((t) => h('tr', { class: 'click' + (t.number === state.ourTeam ? ' ours' : ''), tabindex: '0',
          onclick: () => go(`#/t/${t.number}?e=${ev.id}`), onkeydown: (e) => { if (e.key === 'Enter') go(`#/t/${t.number}?e=${ev.id}`); } },
          h('td', { 'data-l': 'Team' }, h('b', {}, t.number), ' ', t.name || '', t.city ? h('div', { class: 'muted small' }, t.city) : null),
          h('td', { class: 'n', 'data-l': 'Qual record' }, t.played ? `${t.wins}-${t.losses}-${t.ties}` : '–'),
          h('td', { class: 'n', 'data-l': 'Avg alliance' }, t.avgAlliance ?? '–'),
          h('td', { class: 'n', 'data-l': 'Notes' }, t.notes || ''),
          h('td', { 'data-l': 'Tags' }, h('div', { class: 'tags' }, t.features.slice(0, 6).map((f) => chipFor(f))))))))),
      rows.length ? null : h('p', { class: 'muted' }, 'No teams have that tag yet.'),
      h('p', { class: 'muted small' }, 'Record and average are from qualification matches. Average is the alliance score, so it includes the partner.'));
  }
  draw();
  return wrap;
}

// ---------- YouTube player ----------
let ytReady;
function loadYouTube() {
  if (!ytReady) ytReady = new Promise((resolve, reject) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.onerror = () => reject(new Error('YouTube could not load. Check the internet connection.'));
    document.head.append(s);
  });
  return ytReady;
}
let activePlayer = null, tickTimer = null, keyHandler = null;
function teardownPlayer() {
  clearInterval(tickTimer); tickTimer = null;
  if (keyHandler) { document.removeEventListener('keydown', keyHandler); keyHandler = null; }
  if (activePlayer) { try { activePlayer.destroy(); } catch {} activePlayer = null; }
}

async function viewMatch(id, query) {
  const d = await api('GET', `/api/matches/${id}`);
  const ev = await loadEvent(d.match.eventId);
  const m = d.match;
  const tz = d.event.timezone;
  const ctxTeam = +query.get('team') || null;
  const seq = ctxTeam ? ev.matches.filter((x) => x.red.includes(ctxTeam) || x.blue.includes(ctxTeam)) : ev.matches;
  const i = seq.findIndex((x) => x.id === m.id);
  const ctx = ctxTeam ? `?team=${ctxTeam}` : '';
  const prev = i > 0 ? seq[i - 1] : null, next = i >= 0 && i < seq.length - 1 ? seq[i + 1] : null;

  // where the match sits in the video
  let videoId = m.video?.videoId ?? (d.videos[0]?.id ?? null);
  let matchStart = m.video && m.video.start !== null ? m.video.start : null;   // seconds into the video
  const videoById = new Map(d.videos.map((v) => [v.id, v]));
  const synced = () => matchStart !== null;
  const ready = () => !!activePlayer && typeof activePlayer.getCurrentTime === 'function';
  const matchTime = () => (ready() && synced() ? activePlayer.getCurrentTime() - matchStart : null);
  const seekMatch = (t) => { if (ready() && synced()) { activePlayer.seekTo(Math.max(0, matchStart + t), true); } };

  // ----- header -----
  const head = h('div', { class: 'mhead' },
    h('div', {}, h('h1', {}, m.title), h('div', { class: 'muted' }, `${d.event.name} · ${fmtTime(m.start, tz)}`,
      ctxTeam ? ` · stepping through team ${ctxTeam}’s matches` : '')),
    h('div', { class: 'nav2' },
      h('a', { class: 'btn small', href: `#/e/${m.eventId}${ctx}` }, 'All matches'),
      prev ? h('a', { class: 'btn small', href: `#/m/${prev.id}${ctx}`, title: 'Previous match' }, `← ${prev.label}`) : null,
      next ? h('a', { class: 'btn small', href: `#/m/${next.id}${ctx}`, title: 'Next match' }, `${next.label} →`) : null));

  // ----- player + timeline -----
  const holder = h('div', { id: 'yt' });
  const player = h('div', { class: 'player' }, holder);
  const head2 = h('div', { class: 'head' });
  const bar = h('div', { class: 'bar', role: 'slider', 'aria-label': 'Match timeline', tabindex: '0', 'aria-valuemin': -PREROLL, 'aria-valuemax': MATCH_LEN + POSTROLL });
  const span = MATCH_LEN + PREROLL + POSTROLL;
  const pct = (t) => `${((t + PREROLL) / span) * 100}%`;
  const band = (cls, a, b, text) => h('div', { class: `band ${cls}`, style: { left: pct(a), width: `${((b - a) / span) * 100}%` } }, text);
  bar.append(band('auto', 0, AUTO, 'Auto'), band('trans', AUTO, AUTO + TRANSITION, ''), band('tele', AUTO + TRANSITION, MATCH_LEN - ENDGAME, 'TeleOp'), band('end', MATCH_LEN - ENDGAME, MATCH_LEN, 'End'), head2);
  const pinLayer = h('div', {});
  bar.append(pinLayer);
  const seekFromPointer = (e) => { const r = bar.getBoundingClientRect(); const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); seekMatch(f * span - PREROLL); };
  bar.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('pin')) return; bar.setPointerCapture(e.pointerId); seekFromPointer(e); });
  bar.addEventListener('pointermove', (e) => { if (bar.hasPointerCapture(e.pointerId)) seekFromPointer(e); });
  bar.addEventListener('keydown', (e) => { const t = matchTime(); if (t === null) return; if (e.key === 'ArrowLeft') { seekMatch(t - 5); e.preventDefault(); } if (e.key === 'ArrowRight') { seekMatch(t + 5); e.preventDefault(); } });
  const clockEl = h('div', { class: 'clock' }, '–');
  const playBtn = h('button', { class: 'small primary', onclick: () => { if (!ready()) return; activePlayer.getPlayerState() === 1 ? activePlayer.pauseVideo() : activePlayer.playVideo(); } }, 'Play');
  let rate = 1;
  const rateBtn = h('button', { class: 'small', title: 'Playback speed', onclick: () => { rate = rate === 1 ? 0.5 : rate === 0.5 ? 2 : 1; if (ready()) activePlayer.setPlaybackRate(rate); rateBtn.textContent = `${rate}×`; } }, '1×');
  const nudge = (s) => { if (ready()) activePlayer.seekTo(Math.max(0, activePlayer.getCurrentTime() + s), true); };
  const controls = h('div', { class: 'controls' }, clockEl,
    h('button', { class: 'small', onclick: () => seekMatch(-3), title: 'Back to the start of the match' }, 'Start'),
    h('button', { class: 'small', onclick: () => nudge(-5), title: 'Back 5 seconds (J)' }, '−5s'), playBtn,
    h('button', { class: 'small', onclick: () => nudge(5), title: 'Forward 5 seconds (L)' }, '+5s'),
    h('button', { class: 'small', onclick: () => seekMatch(AUTO + TRANSITION), title: 'Jump to TeleOp' }, 'TeleOp'), rateBtn);
  const timeline = h('div', { class: 'timeline' }, bar, h('div', { class: 'ticks' }, ['0:00', '0:30', '1:00', '1:30', '2:00', '2:38'].map((x) => h('span', {}, x))));

  // ----- sync panel -----
  const syncBox = h('div', { class: 'sync' });
  function drawSync() {
    const v = m.video || {};
    const videoSel = d.videos.length > 1 ? h('select', { 'aria-label': 'Stream video', onchange: (e) => { videoId = +e.target.value; matchStart = null; loadVideo(); drawSync(); } },
      d.videos.map((x) => h('option', { value: x.id, selected: x.id === videoId ? true : null }, x.label))) : null;
    const status = !d.videos.length ? 'No stream video is attached to this event yet.'
      : d.anchor ? `Synced by ${d.anchor.by || 'a coach'}.`
      : v.status === 'estimated' ? `Placed using the sync on ${ev.matches.find((x) => x.id === v.fromMatchId)?.label || 'another match'} and the official start time. If it’s off, fix it here.`
      : 'Not synced yet: the video starts at the top of the stream.';
    syncBox.replaceChildren(h('div', { class: synced() ? 'callout' : 'callout warn' },
      h('div', { class: 'small' }, status),
      canLead() && d.videos.length ? h('div', { class: 'row', style: { marginTop: '8px' } }, videoSel,
        h('button', { class: 'small primary', onclick: setStart, title: 'Pause on the moment the match starts (the “GO” / buzzer), then tap' }, 'Match starts here'),
        synced() ? h('button', { class: 'small', onclick: () => nudgeStart(-1) }, 'Start −1s') : null,
        synced() ? h('button', { class: 'small', onclick: () => nudgeStart(1) }, 'Start +1s') : null,
        d.anchor ? confirmButton('Clear sync', 'Tap again to clear', async () => { await tryApi(() => api('DELETE', `/api/matches/${m.id}/sync`), 'Sync cleared'); render(); }) : null)
        : (!synced() && d.videos.length ? h('div', { class: 'small muted' }, 'A coach or team lead can sync it. Until then, use the video’s own scrubber.') : null),
      canLead() && !synced() && d.videos.length ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, 'Tip: the match list says the stream shows this match around ', fmtTime(m.start, tz), '. Scrub there, pause on the start buzzer, then tap “Match starts here”.') : null));
    if (videoSel) videoSel.value = String(videoId);
  }
  async function setStart() {
    if (!ready()) return toast('Wait for the video to load first.', true);
    const secs = Math.round(activePlayer.getCurrentTime() * 10) / 10;
    if (await tryApi(() => api('PUT', `/api/matches/${m.id}/sync`, { videoId, seconds: secs }), 'Synced. Every other match is placed from this one.') !== undefined) {
      state.eventCache.delete(m.eventId); render();
    }
  }
  async function nudgeStart(delta) {
    const secs = Math.max(0, matchStart + delta);
    if (await tryApi(() => api('PUT', `/api/matches/${m.id}/sync`, { videoId, seconds: secs })) !== undefined) {
      matchStart = secs; d.anchor = { videoId, seconds: secs, by: state.me.displayName }; state.eventCache.delete(m.eventId); drawSync(); drawPins(); toast(`Start moved ${delta > 0 ? 'later' : 'earlier'} by 1s`);
    }
  }

  // ----- teams in the match -----
  const teamsBox = h('div', { class: 'alli' });
  function drawTeams() {
    teamsBox.replaceChildren(...d.teams.map((t) => {
      const side = m.red.includes(t.number) ? 'red' : 'blue';
      const picker = h('div', { class: 'picker', hidden: true });
      const open = () => {
        const sel = h('select', { 'aria-label': 'Feature' }, d.features.filter((f) => !f.archived).map((f) => h('option', { value: f.id }, f.label)));
        const note = h('input', { placeholder: 'What did you see? (optional)', maxlength: '500' });
        picker.replaceChildren(h('div', { class: 'row' }, sel, h('div', { class: 'grow' }, note)),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'small primary', onclick: async () => {
              if (await tryApi(() => api('POST', `/api/teams/${t.number}/features`, { featureId: +sel.value, matchId: m.id, note: note.value }), `Tagged ${t.number}`) !== undefined) {
                const fresh = await api('GET', `/api/matches/${m.id}`); d.teams = fresh.teams; state.eventCache.delete(m.eventId); drawTeams();
              } } }, 'Add tag'),
            h('button', { class: 'small ghost', onclick: () => { picker.hidden = true; } }, 'Cancel')));
        picker.hidden = false; sel.focus();
      };
      return h('div', { class: `tcard ${side}` },
        h('div', { class: 'tn' }, h('a', { href: `#/t/${t.number}?e=${m.eventId}` }, t.number), h('span', {}, t.name || ''),
          h('button', { class: 'small', style: { marginLeft: 'auto' }, onclick: open }, '+ Tag')),
        h('div', { class: 'tags' }, t.features.length ? t.features.map((f) => chipFor(f)) : h('span', { class: 'muted small' }, 'No tags yet')),
        picker);
    }));
  }

  // ----- notes -----
  let noteTeam = ctxTeam && [...m.red, ...m.blue].includes(ctxTeam) ? ctxTeam : null, noteCat = null, stampT = null;
  const stampEl = h('span', { class: 'stamp' });
  const text = h('textarea', { placeholder: 'What happened? Start typing and the note is pinned to the current moment.', 'aria-label': 'Note', maxlength: '4000' });
  const whoRow = h('div', { class: 'who' }), catRow = h('div', { class: 'cats' });
  function drawComposerChoices() {
    whoRow.replaceChildren(h('span', { class: 'small muted' }, 'About:'),
      h('button', { class: 'small', 'aria-pressed': noteTeam === null ? 'true' : 'false', onclick: () => { noteTeam = null; drawComposerChoices(); } }, 'Whole match'),
      ...[...m.red.map((t) => ['red', t]), ...m.blue.map((t) => ['blue', t])].map(([side, t]) =>
        h('button', { class: `small ${side}`, 'aria-pressed': noteTeam === t ? 'true' : 'false', onclick: () => { noteTeam = t; drawComposerChoices(); } }, t)));
    catRow.replaceChildren(...CATEGORIES.map((c) => h('button', { class: 'chip', 'aria-pressed': noteCat === c ? 'true' : 'false', onclick: () => { noteCat = noteCat === c ? null : c; drawComposerChoices(); } }, c)));
  }
  function drawStamp() {
    stampEl.replaceChildren(synced()
      ? (stampT === null ? h('span', { class: 'muted small' }, 'Pins to the video time when you start typing')
        : ['At ', h('b', {}, clock(stampT)), h('span', { class: 'muted small' }, ` (${phase(stampT)})`), h('button', { class: 'small ghost', onclick: () => { stampT = matchTime(); drawStamp(); }, title: 'Use the current video time' }, 'Use now')])
      : h('span', { class: 'muted small' }, 'Timed notes unlock once this match is synced. Match notes work now.'));
  }
  text.addEventListener('input', () => { if (stampT === null && synced()) { stampT = matchTime(); drawStamp(); } });
  async function addNote(kind) {
    if (!text.value.trim()) { toast('Write something first.', true); return; }
    const body = { kind, team: noteTeam, category: noteCat, text: text.value };
    if (kind === 'timed') {
      const t = stampT ?? matchTime();
      if (t === null) { toast('Sync the match first, or add it as a match note.', true); return; }
      Object.assign(body, { t: Math.round(t * 10) / 10, vt: Math.round((matchStart + t) * 10) / 10, videoId });
    }
    const n = await tryApi(() => api('POST', `/api/matches/${m.id}/notes`, body));
    if (n) { d.notes.push(n); text.value = ''; stampT = null; drawStamp(); drawNotes(); drawPins(); state.eventCache.delete(m.eventId); toast('Note saved'); }
  }
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addNote(synced() ? 'timed' : 'match'); } });
  const composer = h('div', { class: 'card composer' }, h('h3', {}, 'Add a note'), whoRow, text, catRow,
    h('div', { class: 'row', style: { marginTop: '10px' } }, stampEl),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'primary', onclick: () => addNote('timed') }, 'Add timed note'),
      h('button', { onclick: () => addNote('match') }, 'Add match note')),
    h('p', { class: 'kbd' }, h('kbd', {}, 'N'), ' new note · ', h('kbd', {}, 'Ctrl'), '+', h('kbd', {}, 'Enter'), ' save · ', h('kbd', {}, 'K'), ' play/pause · ', h('kbd', {}, 'J'), '/', h('kbd', {}, 'L'), ' ±5s'));

  const noteTime = (n) => (n.vt !== null && n.videoId === videoId && synced() ? n.vt - matchStart : n.t);
  const notesBox = h('div', {});
  function noteItem(n) {
    const mine = n.userId === state.me.id || isAdmin();
    const t = n.kind === 'timed' ? noteTime(n) : null;
    const li = h('li', { class: 'note', 'data-id': n.id },
      t !== null ? h('button', { class: 't', onclick: () => { seekMatch(t - 2); if (ready()) activePlayer.playVideo(); }, title: 'Jump to this moment' }, clock(t)) : h('span', { class: 't static' }, 'Match'),
      h('div', { class: 'body' }, n.text),
      h('div', { class: 'by' },
        n.team ? h('span', { class: 'chip' }, n.team) : null, n.category ? h('span', { class: 'chip' }, n.category) : null,
        h('span', {}, n.author), h('span', {}, ago(n.created)), n.updated ? h('span', {}, '(edited)') : null,
        mine ? h('button', { class: 'small ghost', onclick: () => editNote(li, n) }, 'Edit') : null,
        mine ? confirmButton('Delete', 'Delete?', async () => { if (await tryApi(() => api('DELETE', `/api/notes/${n.id}`)) !== undefined) { d.notes = d.notes.filter((x) => x.id !== n.id); drawNotes(); drawPins(); } }, 'small ghost') : null));
    return li;
  }
  function editNote(li, n) {
    const ta = h('textarea', { value: n.text, 'aria-label': 'Edit note' });
    const body = li.querySelector('.body'); body.replaceWith(ta); ta.focus();
    const by = li.querySelector('.by');
    by.replaceChildren(h('button', { class: 'small primary', onclick: async () => {
      const r = await tryApi(() => api('PATCH', `/api/notes/${n.id}`, { text: ta.value }));
      if (r) { Object.assign(n, r); drawNotes(); }
    } }, 'Save'), h('button', { class: 'small ghost', onclick: drawNotes }, 'Cancel'));
  }
  function drawNotes() {
    const timed = d.notes.filter((n) => n.kind === 'timed').sort((a, b) => noteTime(a) - noteTime(b));
    const general = d.notes.filter((n) => n.kind === 'match');
    notesBox.replaceChildren(
      h('h2', {}, `Timeline notes (${timed.length})`),
      timed.length ? h('ul', { class: 'notes', id: 'timed' }, timed.map(noteItem)) : h('p', { class: 'muted' }, 'No timed notes yet.'),
      h('h2', {}, `Match notes (${general.length})`),
      general.length ? h('ul', { class: 'notes' }, general.map(noteItem)) : h('p', { class: 'muted' }, 'No match notes yet.'));
  }
  function drawPins() {
    pinLayer.replaceChildren(...(synced() ? d.notes.filter((n) => n.kind === 'timed') : []).map((n) => {
      const t = noteTime(n);
      return h('button', { class: 'pin', style: { left: pct(Math.min(MATCH_LEN + POSTROLL, Math.max(-PREROLL, t))) }, title: `${clock(t)} ${n.text.slice(0, 80)}`, 'aria-label': `Note at ${clock(t)}`,
        onclick: () => { seekMatch(t - 2); const li = document.querySelector(`.note[data-id="${n.id}"]`); li?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } });
    }));
  }

  // ----- layout -----
  mount(head, h('div', { class: 'mgrid mlay' },
    h('div', { class: 'a-video' }, player, timeline, controls, syncBox),
    h('div', { class: 'a-notes stack' }, composer, notesBox),
    h('div', { class: 'a-teams' }, h('h2', {}, 'Teams in this match'), teamsBox)));
  drawSync(); drawTeams(); drawComposerChoices(); drawStamp(); drawNotes(); drawPins();

  // ----- video -----
  function loadVideo() {
    teardownPlayer();
    const v = videoById.get(videoId);
    const fresh = h('div', { id: 'yt' });
    player.replaceChildren(fresh);
    if (!v) { player.replaceChildren(h('div', { class: 'empty' }, 'No stream video for this event yet.')); return; }
    loadYouTube().then((YT) => {
      const seekTo = +query.get('t');
      const start = synced() ? Math.max(0, Math.floor(matchStart + (Number.isFinite(seekTo) && query.has('t') ? seekTo - 2 : -PREROLL))) : 0;
      activePlayer = new YT.Player(fresh, {
        videoId: v.youtubeId, playerVars: { start, playsinline: 1, rel: 0, modestbranding: 1 },
        events: { onStateChange: (e) => { playBtn.textContent = e.data === 1 ? 'Pause' : 'Play'; } },
      });
      tickTimer = setInterval(tick, 200);
    }).catch((e) => player.replaceChildren(h('div', { class: 'empty' }, e.message)));
  }
  let lastActive = null;
  function tick() {
    if (!ready()) return;
    const t = matchTime();
    if (t === null) { clockEl.replaceChildren(clock(activePlayer.getCurrentTime()), h('small', {}, 'video')); head2.style.display = 'none'; bar.setAttribute('aria-valuetext', 'not synced'); return; }
    head2.style.display = '';
    head2.style.left = pct(Math.min(MATCH_LEN + POSTROLL, Math.max(-PREROLL, t)));
    clockEl.replaceChildren(t < 0 ? `-${clock(-t)}` : clock(t), h('small', {}, phase(t)));
    bar.setAttribute('aria-valuenow', Math.round(t)); bar.setAttribute('aria-valuetext', `${clock(t)} ${phase(t)}`);
    // highlight the latest note we've passed
    const passed = d.notes.filter((n) => n.kind === 'timed' && noteTime(n) <= t && noteTime(n) > t - 4).map((n) => n.id);
    const key = passed.join(',');
    if (key !== lastActive) { lastActive = key; document.querySelectorAll('.note.active').forEach((el) => el.classList.remove('active')); passed.forEach((id) => document.querySelector(`.note[data-id="${id}"]`)?.classList.add('active')); }
  }
  loadVideo();

  keyHandler = (e) => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'k' || e.key === ' ') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'j') nudge(-5);
    else if (e.key === 'l') nudge(5);
    else if (e.key === 'n') { e.preventDefault(); text.focus(); if (synced()) { stampT = matchTime(); drawStamp(); } }
  };
  document.addEventListener('keydown', keyHandler);
}

async function viewTeam(number, query) {
  const d = await api('GET', `/api/teams/${number}`);
  const t = d.team;
  const evId = +query.get('e') || d.events[0]?.id;
  // group tags by feature
  const groups = new Map();
  for (const tag of d.tags) { if (!groups.has(tag.featureId)) groups.set(tag.featureId, { ...tag, items: [] }); groups.get(tag.featureId).items.push(tag); }
  const sel = h('select', { 'aria-label': 'Feature' }, d.features.filter((f) => !f.archived).map((f) => h('option', { value: f.id }, f.label)));
  const note = h('input', { placeholder: 'Why? (optional)', maxlength: '500' });
  const tagsBox = h('div', { class: 'card' }, h('h3', {}, 'Features'),
    groups.size ? h('div', { class: 'stack' }, [...groups.values()].map((g) => h('div', {},
      h('div', { class: 'row' }, chipFor({ ...g, votes: g.items.length })),
      h('ul', { class: 'small muted', style: { margin: '4px 0 0', paddingLeft: '18px' } }, g.items.map((it) => h('li', {},
        `${it.author || 'Former user'}${it.matchLabel ? ' in ' + it.matchLabel : ''}${it.note ? ': ' : ''}`, it.note || '',
        (it.userId === state.me.id || canLead()) ? [' ', confirmButton('Remove', 'Remove?', async () => { if (await tryApi(() => api('DELETE', `/api/team-features/${it.id}`)) !== undefined) render(); }, 'small ghost')] : null))))))
      : h('p', { class: 'muted' }, 'No one has tagged this team yet.'),
    h('div', { class: 'row', style: { marginTop: '12px' } }, sel, h('div', { class: 'grow' }, note),
      h('button', { class: 'small primary', onclick: async () => { if (await tryApi(() => api('POST', `/api/teams/${t.number}/features`, { featureId: +sel.value, note: note.value }), 'Tag added') !== undefined) render(); } }, 'Add tag')));

  const evBlocks = d.events.map((e) => {
    const ms = e.matches;
    const qual = ms.filter((m) => m.level === 'qual'); const rec = { W: 0, L: 0, T: 0 };
    qual.forEach((m) => { const r = resultFor(m, t.number); if (r) rec[r]++; });
    return h('div', {}, h('h2', {}, e.name, h('span', { class: 'muted small' }, `  ${rec.W}-${rec.L}-${rec.T} in quals`)),
      h('div', { class: 'mlist' }, ms.map((m) => matchRow(m, e.timezone, t.number, `?team=${t.number}`))));
  });

  const byMatch = new Map();
  for (const n of d.notes) { if (!byMatch.has(n.matchId)) byMatch.set(n.matchId, { label: n.matchLabel, notes: [] }); byMatch.get(n.matchId).notes.push(n); }
  const notesBox = h('div', {}, h('h2', {}, `Notes about ${t.number} (${d.notes.length})`),
    d.notes.length ? h('div', { class: 'stack' }, [...byMatch.entries()].map(([mid, g]) => h('div', { class: 'card' },
      h('h3', {}, h('a', { href: `#/m/${mid}?team=${t.number}` }, g.label)),
      h('ul', { class: 'notes' }, g.notes.sort((a, b) => (a.t ?? 999) - (b.t ?? 999)).map((n) => h('li', { class: 'note' },
        n.kind === 'timed' ? h('a', { class: 'btn t small', href: `#/m/${mid}?team=${t.number}&t=${Math.round(n.t)}` }, clock(n.t)) : h('span', { class: 't static' }, 'Match'),
        h('div', { class: 'body' }, n.team ? '' : '(whole match) ', n.text),
        h('div', { class: 'by' }, n.category ? h('span', { class: 'chip' }, n.category) : null, h('span', {}, n.author), h('span', {}, ago(n.created)))))))))
      : h('p', { class: 'muted' }, 'No notes yet. Open one of the matches above to add some.'));

  mount(h('div', { class: 'ehead' }, h('div', {}, h('h1', {}, `${t.number} ${t.name || ''}`), h('div', { class: 'muted' }, t.city || '')),
    evId ? h('a', { class: 'btn small', href: `#/e/${evId}?team=${t.number}` }, 'Back to event') : null),
  h('div', { class: 'mgrid' }, h('div', {}, evBlocks, notesBox), h('div', {}, tagsBox)));
}

async function viewAccount() {
  const cur = h('input', { type: 'password', id: 'cur', autocomplete: 'current-password' });
  const nxt = h('input', { type: 'password', id: 'nxt', autocomplete: 'new-password', minlength: '8' });
  const msg = h('p', { class: 'muted', role: 'alert' });
  mount(h('div', { class: 'login' }, h('div', { class: 'card stack' },
    h('h1', {}, state.me.displayName), h('p', { class: 'muted' }, `Signed in as ${state.me.username} · ${state.me.role}`),
    state.me.mustChange ? h('p', { class: 'callout warn' }, 'Please choose your own password before you continue.') : null,
    h('form', { onsubmit: async (e) => { e.preventDefault(); msg.textContent = '';
      try { await api('POST', '/api/me/password', { current: cur.value, next: nxt.value }); state.me.mustChange = false; toast('Password changed'); go('#/'); } catch (x) { msg.textContent = x.message; } } },
    h('label', { for: 'cur' }, 'Current password'), cur, h('label', { for: 'nxt' }, 'New password (8+ characters)'), nxt,
    h('div', { class: 'row', style: { marginTop: '14px' } }, h('button', { class: 'primary', type: 'submit' }, 'Change password')), msg),
    h('button', { onclick: async () => { await api('POST', '/api/logout'); state.me = null; nav(); go('#/login'); } }, 'Sign out'))));
}

// ---------- admin ----------
async function viewAdmin() {
  const sections = [];
  if (isAdmin()) sections.push(await adminUsers(), await adminEvents(), await adminBackups());
  sections.push(await adminFeatures());
  mount(h('h1', {}, isAdmin() ? 'Admin' : 'Features'), h('div', { class: 'admin-grid' }, sections));
}
function secretBox(title, username, pw) {
  return h('div', { class: 'callout warn' }, h('div', {}, title), h('div', { class: 'row' }, h('span', {}, `Username: ${username}`), h('span', { class: 'pw' }, pw),
    h('button', { class: 'small', onclick: async () => { try { await navigator.clipboard.writeText(`Film Room login\nUsername: ${username}\nPassword: ${pw}`); toast('Copied'); } catch { toast('Copy failed: select the text instead', true); } } }, 'Copy')),
  h('div', { class: 'small muted' }, 'Shown only once. They choose their own password when they first sign in.'));
}
async function adminUsers() {
  const users = await api('GET', '/api/admin/users');
  const out = h('div', {});
  const uname = h('input', { placeholder: 'username (e.g. jsmith)', autocapitalize: 'none', 'aria-label': 'Username' });
  const dname = h('input', { placeholder: 'Display name', 'aria-label': 'Display name' });
  const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'scout' }, 'Scout (student)'), h('option', { value: 'lead' }, 'Lead (can sync video, manage tags)'), h('option', { value: 'admin' }, 'Admin (coach)'));
  return h('section', { class: 'card' }, h('h2', { style: { marginTop: 0 } }, 'People'),
    h('p', { class: 'muted small' }, 'Everyone needs an account to see anything. Scouts watch and take notes; leads can also sync video and edit the tag list; admins manage everything.'),
    h('div', { class: 'scroll' }, h('table', { class: 'stack-t' }, h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Status', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', { 'data-l': 'Username' }, u.username), h('td', { 'data-l': 'Name' }, u.displayName),
        h('td', { 'data-l': 'Role' }, h('select', { 'aria-label': `Role for ${u.username}`, onchange: (e) => tryApi(() => api('PATCH', `/api/admin/users/${u.id}`, { role: e.target.value }), 'Role updated') },
          ['scout', 'lead', 'admin'].map((r) => h('option', { value: r, selected: u.role === r ? true : null }, r)))),
        h('td', { 'data-l': 'Status' }, u.disabled ? 'Disabled' : u.mustChange ? 'Temp password' : 'Active'),
        h('td', {}, h('div', { class: 'row' },
          h('button', { class: 'small', onclick: async () => { const r = await tryApi(() => api('PATCH', `/api/admin/users/${u.id}`, { resetPassword: true })); if (r) out.replaceChildren(secretBox('New temporary password', u.username, r.tempPassword)); } }, 'Reset password'),
          h('button', { class: 'small', onclick: async () => { if (await tryApi(() => api('PATCH', `/api/admin/users/${u.id}`, { disabled: !u.disabled })) !== undefined) render(); } }, u.disabled ? 'Enable' : 'Disable')))))))),
    out,
    h('h3', { style: { marginTop: '16px' } }, 'Add a person'),
    h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault();
      const r = await tryApi(() => api('POST', '/api/admin/users', { username: uname.value, displayName: dname.value, role: role.value }));
      if (r) { await render(); $('#newpw')?.replaceChildren(secretBox('Account created', r.username, r.tempPassword)); } } },
    h('div', { class: 'grow' }, uname), h('div', { class: 'grow' }, dname), role, h('button', { class: 'primary', type: 'submit' }, 'Create')),
    h('div', { id: 'newpw' }));
}
async function adminEvents() {
  const events = await api('GET', '/api/events');
  const season = h('input', { value: String(new Date().getMonth() >= 7 ? new Date().getFullYear() : new Date().getFullYear() - 1), inputmode: 'numeric', 'aria-label': 'Season', style: { maxWidth: '110px' } });
  const code = h('input', { placeholder: 'Event code, e.g. USMINOQ', autocapitalize: 'characters', 'aria-label': 'Event code' });
  const ourTeam = h('input', { value: state.ourTeam || '', inputmode: 'numeric', 'aria-label': 'Our team number', style: { maxWidth: '140px' } });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Event JSON file' });
  const blocks = await Promise.all(events.map(async (e) => {
    const full = await loadEvent(e.id, true);
    const vurl = h('input', { placeholder: 'YouTube link', 'aria-label': 'YouTube link' });
    const vlabel = h('input', { placeholder: 'Label, e.g. Day 2', 'aria-label': 'Video label' });
    const vdate = h('input', { type: 'date', 'aria-label': 'Video date' });
    return h('details', { class: 'card' }, h('summary', {}, `${e.name} (${e.season} ${e.code})`, e.live ? h('span', { class: 'badge live', style: { marginLeft: '8px' } }, 'Live') : null),
      h('div', { class: 'row' },
        h('button', { class: 'small', onclick: async () => { const r = await tryApi(() => api('POST', `/api/admin/events/${e.id}/refresh`), 'Refreshed from FTCScout'); if (r) render(); } }, 'Refresh results now'),
        h('button', { class: 'small', onclick: async () => { if (await tryApi(() => api('PATCH', `/api/admin/events/${e.id}`, { live: !e.live })) !== undefined) render(); } }, e.live ? 'Stop live refresh' : 'Mark live (refresh every 3 min)'),
        confirmButton('Delete event', 'Delete event and all its notes?', async () => { if (await tryApi(() => api('DELETE', `/api/admin/events/${e.id}`), 'Deleted (a backup was saved first)') !== undefined) render(); })),
      h('h3', { style: { marginTop: '14px' } }, 'Stream videos'),
      h('ul', { class: 'notes' }, full.videos.map((v) => h('li', { class: 'note' }, h('span', { class: 't static' }, v.date || 'no date'),
        h('div', {}, h('b', {}, v.label), ' ', h('a', { href: `https://www.youtube.com/watch?v=${encodeURIComponent(v.youtubeId)}`, target: '_blank', rel: 'noopener' }, v.youtubeId)),
        h('div', { class: 'by' }, confirmButton('Remove', 'Remove video?', async () => { if (await tryApi(() => api('DELETE', `/api/admin/videos/${v.id}`)) !== undefined) render(); }, 'small ghost'))))),
      h('form', { class: 'row', style: { marginTop: '8px' }, onsubmit: async (ev) => { ev.preventDefault(); if (await tryApi(() => api('POST', `/api/admin/events/${e.id}/videos`, { url: vurl.value, label: vlabel.value, date: vdate.value }), 'Video added') !== undefined) render(); } },
        h('div', { class: 'grow' }, vurl), h('div', { class: 'grow' }, vlabel), vdate, h('button', { type: 'submit' }, 'Add video')),
      h('p', { class: 'small muted' }, 'Give each video the date it covers so unsynced matches open the right day.'));
  }));
  return h('section', { class: 'card' }, h('h2', { style: { marginTop: 0 } }, 'Events'),
    h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const r = await tryApi(() => api('PUT', '/api/admin/settings', { ourTeam: ourTeam.value }), 'Saved'); if (r) { state.ourTeam = +ourTeam.value || null; nav(); } } },
      h('span', {}, 'Our team number'), ourTeam, h('button', { class: 'small', type: 'submit' }, 'Save')),
    h('h3', { style: { marginTop: '16px' } }, 'Add an event from FTCScout'),
    h('p', { class: 'muted small' }, 'Use the event code from ftc-events.firstinspires.org (Michigan qualifiers look like USMI…Q). Matches, scores, start times, team names and FIRST in Michigan stream videos are pulled in automatically.'),
    h('form', { class: 'row', onsubmit: async (e) => { e.preventDefault(); const r = await tryApi(() => api('POST', '/api/admin/events/ftcscout', { season: season.value, code: code.value })); if (r) { toast(`Imported ${r.matches} matches, ${r.videosFound} video(s)`); render(); } } },
      season, h('div', { class: 'grow' }, code), h('button', { class: 'primary', type: 'submit' }, 'Import')),
    h('details', {}, h('summary', { class: 'small' }, 'Or import an event file (JSON)'),
      h('div', { class: 'row' }, file, h('button', { class: 'small', onclick: async () => {
        const f = file.files[0]; if (!f) return toast('Choose a file first', true);
        let json; try { json = JSON.parse(await f.text()); } catch { return toast('That file is not JSON', true); }
        if (await tryApi(() => api('POST', '/api/admin/events/json', json), 'Event imported') !== undefined) render(); } }, 'Import file'))),
    h('div', { class: 'stack', style: { marginTop: '14px' } }, blocks));
}
async function adminFeatures() {
  const feats = await api('GET', '/api/features');
  const label = h('input', { placeholder: 'New feature, e.g. Scores from far zone', 'aria-label': 'Feature name' });
  const kind = h('select', { 'aria-label': 'Kind' }, h('option', { value: 'strength' }, 'Strength'), h('option', { value: 'weakness' }, 'Weakness'), h('option', { value: 'info' }, 'Info'));
  return h('section', { class: 'card' }, h('h2', { style: { marginTop: 0 } }, 'Team features'),
    h('p', { class: 'muted small' }, 'The tags students can put on teams. Archiving hides a tag from the pickers but keeps what was already tagged.'),
    h('div', { class: 'tags' }, feats.map((f) => h('span', { class: `chip ${f.kind}`, style: { opacity: f.archived ? 0.5 : 1 } }, f.label,
      h('button', { class: 'small ghost', onclick: async () => { if (await tryApi(() => api('PATCH', `/api/admin/features/${f.id}`, { archived: !f.archived })) !== undefined) render(); } }, f.archived ? 'Restore' : 'Archive')))),
    h('form', { class: 'row', style: { marginTop: '12px' }, onsubmit: async (e) => { e.preventDefault(); if (await tryApi(() => api('POST', '/api/admin/features', { label: label.value, kind: kind.value }), 'Feature added') !== undefined) render(); } },
      h('div', { class: 'grow' }, label), kind, h('button', { type: 'submit' }, 'Add')));
}
async function adminBackups() {
  const b = await api('GET', '/api/admin/backups');
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Backup file' });
  return h('section', { class: 'card' }, h('h2', { style: { marginTop: 0 } }, 'Backups'),
    h('p', { class: 'muted small' }, `The server saves a full copy every ${b.everyHours} hours when anything changed, keeps the latest ${b.keep}, and also saves one before any delete or restore. Folder: `, h('code', {}, b.dir)),
    h('div', { class: 'row' },
      h('button', { class: 'primary', onclick: async () => { if (await tryApi(() => api('POST', '/api/admin/backups'), 'Backup saved') !== undefined) render(); } }, 'Back up now'),
      h('a', { class: 'btn', href: '/api/admin/export', download: '' }, 'Download everything (JSON)')),
    h('ul', { class: 'notes', style: { marginTop: '12px' } }, b.backups.slice(0, 12).map((x) => h('li', { class: 'note' }, h('span', { class: 't static' }, `${Math.max(1, Math.round(x.bytes / 1024))} KB`),
      h('div', {}, h('a', { href: `/api/admin/backups/${encodeURIComponent(x.name)}`, download: x.name }, x.name), h('div', { class: 'small muted' }, new Date(x.created).toLocaleString()))))),
    b.backups.length > 12 ? h('p', { class: 'small muted' }, `${b.backups.length - 12} older backups are in the folder.`) : null,
    h('details', {}, h('summary', {}, 'Restore from a JSON export'),
      h('p', { class: 'small muted' }, 'This replaces everything (people, events, notes, tags) with the file’s contents and signs everyone out. A backup of the current data is saved first.'),
      h('div', { class: 'row' }, file, confirmButton('Restore', 'Replace everything?', async () => {
        const f = file.files[0]; if (!f) return toast('Choose a file first', true);
        let json; try { json = JSON.parse(await f.text()); } catch { return toast('That file is not JSON', true); }
        if (await tryApi(() => api('POST', '/api/admin/restore', json)) !== undefined) { state.me = null; go('#/login'); toast('Restored. Sign in again.'); }
      }))));
}

// ---------- router ----------
let rendering = 0;
async function render() {
  const my = ++rendering;
  teardownPlayer();
  const { parts, query } = parseHash();
  if (!state.me && parts[0] !== 'login') { try { await boot(); } catch { /* not signed in */ } }
  if (my !== rendering) return;
  nav();
  if (!state.me) return viewLogin();
  if (state.me.mustChange && parts[0] !== 'account') return go('#/account');
  try {
    if (parts[0] === 'login') return go('#/');
    if (parts[0] === 'e' && parts[1]) return await viewEvent(+parts[1], parts[2] === 'teams' ? 'teams' : 'matches', query);
    if (parts[0] === 'm' && parts[1]) return await viewMatch(+parts[1], query);
    if (parts[0] === 't' && parts[1]) return await viewTeam(+parts[1], query);
    if (parts[0] === 'account') return await viewAccount();
    if (parts[0] === 'admin' && canLead()) return await viewAdmin();
    return await viewEvents();
  } catch (e) {
    if (my === rendering) mount(h('p', { class: 'callout warn' }, e.message), h('a', { class: 'btn', href: '#/' }, 'Back to events'));
  }
}
async function boot() {
  const r = await fetch('/api/me', { credentials: 'same-origin' });
  if (!r.ok) { state.me = null; return; }
  const d = await r.json();
  state.me = d.user; state.ourTeam = d.ourTeam;
  if (!state.events) { try { state.events = await api('GET', '/api/events'); } catch {} }
}
window.addEventListener('hashchange', render);
render();
}
