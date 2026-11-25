#!/usr/bin/env node
// FTC Film Room — scouting video server. Zero dependencies: needs Node.js 22.13 or newer.
'use strict';
process.removeAllListeners('warning'); // hide node:sqlite's "experimental" notice
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const DB = require('./lib/db');
const A = require('./lib/auth');
const E = require('./lib/events');
const B = require('./lib/backup');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(DATA_DIR, 'backups'));
const BACKUP_HOURS = +process.env.BACKUP_INTERVAL_HOURS || 6;
const BACKUP_KEEP = +process.env.BACKUP_KEEP || 40;
const SECURE_COOKIE = process.env.SECURE_COOKIE === '1';
const PUBLIC = path.join(__dirname, 'public');

const db = DB.open(DATA_DIR);
let changesSinceBackup = 0;

// ---------- first run ----------
function firstRun() {
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const username = process.env.ADMIN_USER || 'coach';
    const pw = process.env.ADMIN_PASSWORD || A.randomPassword();
    db.prepare('INSERT INTO users (username, display_name, role, pw_hash, must_change) VALUES (?, ?, ?, ?, ?)')
      .run(username, 'Coach', 'admin', A.hashPassword(pw), process.env.ADMIN_PASSWORD && process.env.ADMIN_MUST_CHANGE !== '1' ? 0 : 1);
    console.log('\n  First run: created admin account');
    console.log(`    username: ${username}`);
    console.log(`    password: ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw + '   (you will be asked to change it)'}\n`);
  }
  if (DB.getSetting(db, 'our_team') === null) DB.setSetting(db, 'our_team', process.env.OUR_TEAM || '10137');
  if (db.prepare('SELECT COUNT(*) AS n FROM events').get().n === 0) {
    for (const f of fs.readdirSync(path.join(__dirname, 'seed')).filter((x) => x.endsWith('.json'))) {
      const r = E.importEvent(db, JSON.parse(fs.readFileSync(path.join(__dirname, 'seed', f), 'utf8')));
      console.log(`  Loaded ${f}: ${r.matches} matches`);
    }
  }
}

// ---------- tiny router ----------
const routes = [];
const route = (method, pattern, minRole, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, minRole, handler });
};

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store', ...headers,
  });
  res.end(payload);
}
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
const sessionCookie = (token, maxAge) => `fr_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${SECURE_COOKIE ? '; Secure' : ''}`;

async function readBody(req, limit = 25e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw E.httpError(413, 'Upload too large.'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw E.httpError(400, 'Body must be JSON.'); }
}
const str = (v, max = 4000) => (v === undefined || v === null ? '' : String(v)).trim().slice(0, max);
const intOrNull = (v) => (v === '' || v === null || v === undefined || Number.isNaN(+v) ? null : Math.trunc(+v));

// ---------- data shaping ----------
function teamsOf(matchIds) {
  if (!matchIds.length) return new Map();
  const rows = db.prepare(`SELECT match_id, team, alliance, slot FROM match_teams WHERE match_id IN (${matchIds.map(() => '?').join(',')}) ORDER BY slot`).all(...matchIds);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.match_id)) map.set(r.match_id, { red: [], blue: [] });
    map.get(r.match_id)[r.alliance].push(r.team);
  }
  return map;
}
function shapeMatches(eventId, rows) {
  const place = E.placeMatches(db, eventId);
  const teams = teamsOf(rows.map((r) => r.id));
  const counts = new Map(db.prepare(`SELECT match_id, COUNT(*) AS n FROM notes WHERE match_id IN (SELECT id FROM matches WHERE event_id = ?) GROUP BY match_id`).all(eventId).map((r) => [r.match_id, r.n]));
  return rows.map((m) => ({
    id: m.id, eventId, label: E.matchLabel(m), title: E.matchTitle(m), level: m.level, series: m.series, num: m.num, ftcId: m.ftc_id,
    start: m.start_time, redScore: m.red_score, blueScore: m.blue_score, ...(teams.get(m.id) || { red: [], blue: [] }),
    video: place.get(m.id) || null, notes: counts.get(m.id) || 0,
  }));
}
const matchOrder = 'ORDER BY CASE level WHEN \'qual\' THEN 0 ELSE 1 END, COALESCE(start_time, \'\'), series, num';

function teamStats(eventId) {
  const matches = shapeMatches(eventId, db.prepare(`SELECT * FROM matches WHERE event_id = ? ${matchOrder}`).all(eventId));
  const stats = new Map();
  const get = (t) => { if (!stats.has(t)) stats.set(t, { w: 0, l: 0, t: 0, pts: 0, played: 0, playoff: 0 }); return stats.get(t); };
  for (const m of matches) {
    if (m.redScore === null || m.blueScore === null) continue;
    for (const side of ['red', 'blue']) {
      const mine = side === 'red' ? m.redScore : m.blueScore, theirs = side === 'red' ? m.blueScore : m.redScore;
      for (const t of m[side]) {
        const s = get(t);
        if (m.level !== 'qual') { s.playoff++; continue; }
        s.played++; s.pts += mine;
        if (mine > theirs) s.w++; else if (mine < theirs) s.l++; else s.t++;
      }
    }
  }
  return { matches, stats };
}
function featureSummary(teamNumbers) {
  if (!teamNumbers.length) return new Map();
  const rows = db.prepare(`SELECT tf.team, f.id AS featureId, f.label, f.kind, COUNT(*) AS votes
    FROM team_features tf JOIN features f ON f.id = tf.feature_id
    WHERE tf.team IN (${teamNumbers.map(() => '?').join(',')}) GROUP BY tf.team, f.id ORDER BY votes DESC, f.sort`).all(...teamNumbers);
  const map = new Map();
  for (const r of rows) { if (!map.has(r.team)) map.set(r.team, []); map.get(r.team).push({ featureId: r.featureId, label: r.label, kind: r.kind, votes: r.votes }); }
  return map;
}
function noteRows(where, ...args) {
  return db.prepare(`SELECT n.*, u.display_name AS author, m.event_id, m.level, m.series, m.num, m.ftc_id
    FROM notes n LEFT JOIN users u ON u.id = n.user_id JOIN matches m ON m.id = n.match_id WHERE ${where}
    ORDER BY n.kind DESC, n.t, n.created_at`).all(...args)
    .map((n) => ({ id: n.id, matchId: n.match_id, matchLabel: E.matchLabel(n), eventId: n.event_id, userId: n.user_id, author: n.author || 'Former user',
      team: n.team, kind: n.kind, t: n.t, videoId: n.video_id, vt: n.vt, category: n.category, text: n.text, created: n.created_at, updated: n.updated_at }));
}
const features = () => db.prepare('SELECT id, label, kind, sort, archived FROM features ORDER BY sort, label').all();
const teamName = (n) => db.prepare('SELECT name, city FROM teams WHERE number = ?').get(n) || {};

// ---------- routes: session ----------
route('POST', '/api/login', null, async (req, res, { body, ip }) => {
  const username = str(body.username, 64), password = String(body.password || '');
  const key = `${ip}|${username.toLowerCase()}`;
  if (A.loginBlocked(key)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes and try again.' });
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || u.disabled || !A.verifyPassword(password, u.pw_hash)) { A.noteFailure(key); return send(res, 401, { error: 'Wrong username or password.' }); }
  A.clearFailures(key);
  const s = A.createSession(db, u.id);
  send(res, 200, { ok: true }, { 'set-cookie': sessionCookie(s.token, s.maxAge) });
});
route('POST', '/api/logout', null, (req, res, { token }) => { A.destroySession(db, token); send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) }); });
route('GET', '/api/me', 'scout', (req, res, { user }) => send(res, 200, { user, ourTeam: +DB.getSetting(db, 'our_team', '0') || null }));
route('POST', '/api/me/password', 'scout', (req, res, { user, body }) => {
  const u = db.prepare('SELECT pw_hash FROM users WHERE id = ?').get(user.id);
  if (!A.verifyPassword(String(body.current || ''), u.pw_hash)) return send(res, 400, { error: 'Your current password is not right.' });
  const next = String(body.next || '');
  if (next.length < 8) return send(res, 400, { error: 'Use at least 8 characters.' });
  db.prepare('UPDATE users SET pw_hash = ?, must_change = 0 WHERE id = ?').run(A.hashPassword(next), user.id);
  send(res, 200, { ok: true });
});

// ---------- routes: browsing ----------
route('GET', '/api/events', 'scout', (req, res) => {
  const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM matches m WHERE m.event_id = e.id) AS match_count,
    (SELECT COUNT(*) FROM event_teams t WHERE t.event_id = e.id) AS team_count FROM events e ORDER BY e.start_date DESC, e.id DESC`).all();
  send(res, 200, rows.map((e) => ({ id: e.id, season: e.season, code: e.code, name: e.name, venue: e.venue, startDate: e.start_date, endDate: e.end_date,
    live: !!e.live, lastRefresh: e.last_refresh, matchCount: e.match_count, teamCount: e.team_count })));
});
route('GET', '/api/events/:id', 'scout', (req, res, { params }) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(+params.id);
  if (!e) return send(res, 404, { error: 'No such event.' });
  const { matches, stats } = teamStats(e.id);
  const numbers = db.prepare('SELECT team FROM event_teams WHERE event_id = ? ORDER BY team').all(e.id).map((r) => r.team);
  const feats = featureSummary(numbers);
  const noteCounts = new Map(db.prepare(`SELECT n.team, COUNT(*) AS c FROM notes n JOIN matches m ON m.id = n.match_id WHERE m.event_id = ? AND n.team IS NOT NULL GROUP BY n.team`).all(e.id).map((r) => [r.team, r.c]));
  const teams = numbers.map((n) => {
    const s = stats.get(n) || { w: 0, l: 0, t: 0, pts: 0, played: 0, playoff: 0 };
    const tn = teamName(n);
    return { number: n, name: tn.name || null, city: tn.city || null, wins: s.w, losses: s.l, ties: s.t, played: s.played, playoffMatches: s.playoff,
      avgAlliance: s.played ? Math.round((s.pts / s.played) * 10) / 10 : null, notes: noteCounts.get(n) || 0, features: feats.get(n) || [] };
  });
  const videos = db.prepare('SELECT id, youtube_id AS youtubeId, label, date FROM videos WHERE event_id = ? ORDER BY sort, id').all(e.id);
  send(res, 200, { event: { id: e.id, season: e.season, code: e.code, name: e.name, venue: e.venue, startDate: e.start_date, endDate: e.end_date,
    timezone: e.timezone, live: !!e.live, lastRefresh: e.last_refresh }, matches, teams, videos, features: features(), ourTeam: +DB.getSetting(db, 'our_team', '0') || null });
});
route('GET', '/api/matches/:id', 'scout', (req, res, { params }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(+params.id);
  if (!m) return send(res, 404, { error: 'No such match.' });
  const [match] = shapeMatches(m.event_id, [m]);
  const e = db.prepare('SELECT id, name, timezone FROM events WHERE id = ?').get(m.event_id);
  const teamNums = [...match.red, ...match.blue];
  const feats = featureSummary(teamNums);
  const teams = teamNums.map((n) => ({ number: n, ...teamName(n), features: feats.get(n) || [] }));
  const videos = db.prepare('SELECT id, youtube_id AS youtubeId, label, date FROM videos WHERE event_id = ? ORDER BY sort, id').all(m.event_id);
  const anchor = db.prepare('SELECT a.*, u.display_name AS who FROM anchors a LEFT JOIN users u ON u.id = a.user_id WHERE a.match_id = ?').get(m.id);
  send(res, 200, { event: e, match, teams, videos, features: features(), notes: noteRows('n.match_id = ?', m.id),
    anchor: anchor ? { videoId: anchor.video_id, seconds: anchor.video_seconds, by: anchor.who, at: anchor.created_at } : null });
});
route('GET', '/api/teams/:number', 'scout', (req, res, { params }) => {
  const n = +params.number;
  const tn = db.prepare('SELECT * FROM teams WHERE number = ?').get(n);
  if (!tn) return send(res, 404, { error: 'That team is not in any loaded event.' });
  const eventIds = db.prepare('SELECT DISTINCT m.event_id FROM match_teams mt JOIN matches m ON m.id = mt.match_id WHERE mt.team = ?').all(n).map((r) => r.event_id);
  const events = eventIds.map((id) => {
    const e = db.prepare('SELECT id, name, start_date, timezone FROM events WHERE id = ?').get(id);
    const rows = db.prepare(`SELECT m.* FROM matches m JOIN match_teams mt ON mt.match_id = m.id WHERE m.event_id = ? AND mt.team = ? ${matchOrder.replace(/(level|start_time|series|num)/g, 'm.$1')}`).all(id, n);
    return { id: e.id, name: e.name, startDate: e.start_date, timezone: e.timezone, matches: shapeMatches(id, rows) };
  }).sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
  const tags = db.prepare(`SELECT tf.id, tf.feature_id AS featureId, f.label, f.kind, tf.match_id AS matchId, tf.note, tf.created_at AS created, tf.user_id AS userId,
    u.display_name AS author, m.level, m.series, m.num FROM team_features tf JOIN features f ON f.id = tf.feature_id LEFT JOIN users u ON u.id = tf.user_id
    LEFT JOIN matches m ON m.id = tf.match_id WHERE tf.team = ? ORDER BY f.sort, tf.created_at`).all(n)
    .map((t) => ({ ...t, matchLabel: t.level ? E.matchLabel(t) : null, level: undefined, series: undefined, num: undefined }));
  send(res, 200, { team: { number: n, name: tn.name, city: tn.city }, events, tags, features: features(),
    notes: noteRows('(n.team = ? OR (n.team IS NULL AND n.match_id IN (SELECT match_id FROM match_teams WHERE team = ?)))', n, n) });
});

const APP_VERSION = (() => { try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
route('GET', '/api/health', null, (req, res) => send(res, 200, { ok: true, version: APP_VERSION }));
route('GET', '/api/features', 'scout', (req, res) => send(res, 200, features()));

// ---------- routes: notes and team features ----------
const NOTE_CATEGORIES = ['Auto', 'TeleOp', 'Endgame', 'Scoring', 'Defense', 'Penalty', 'Breakdown', 'Driving', 'Strategy', 'Other'];
function checkNoteInput(body, matchId) {
  const text = str(body.text, 4000);
  if (!text) throw E.httpError(400, 'Write something first.');
  const team = intOrNull(body.team);
  if (team !== null && !db.prepare('SELECT 1 FROM match_teams WHERE match_id = ? AND team = ?').get(matchId, team)) throw E.httpError(400, 'That team is not in this match.');
  const category = NOTE_CATEGORIES.includes(body.category) ? body.category : null;
  return { text, team, category };
}
route('POST', '/api/matches/:id/notes', 'scout', (req, res, { params, body, user }) => {
  const matchId = +params.id;
  if (!db.prepare('SELECT 1 FROM matches WHERE id = ?').get(matchId)) return send(res, 404, { error: 'No such match.' });
  const { text, team, category } = checkNoteInput(body, matchId);
  const kind = body.kind === 'timed' ? 'timed' : 'match';
  let t = null, vt = null, videoId = null;
  if (kind === 'timed') {
    t = Number(body.t); vt = body.vt === undefined || body.vt === null ? null : Number(body.vt); videoId = intOrNull(body.videoId);
    if (!Number.isFinite(t) || t < -60 || t > 600) return send(res, 400, { error: 'Timestamp is outside the match.' });
  }
  const r = db.prepare('INSERT INTO notes (match_id, user_id, team, kind, t, video_id, vt, category, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(matchId, user.id, team, kind, t, videoId, Number.isFinite(vt) ? vt : null, category, text);
  changesSinceBackup++;
  send(res, 201, noteRows('n.id = ?', r.lastInsertRowid)[0]);
});
route('PATCH', '/api/notes/:id', 'scout', (req, res, { params, body, user }) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(+params.id);
  if (!n) return send(res, 404, { error: 'No such note.' });
  if (n.user_id !== user.id && !A.atLeast(user, 'admin')) return send(res, 403, { error: 'You can only edit your own notes.' });
  const { text, team, category } = checkNoteInput({ text: body.text ?? n.text, team: 'team' in body ? body.team : n.team, category: 'category' in body ? body.category : n.category }, n.match_id);
  db.prepare('UPDATE notes SET text = ?, team = ?, category = ?, updated_at = ? WHERE id = ?').run(text, team, category, new Date().toISOString(), n.id);
  changesSinceBackup++;
  send(res, 200, noteRows('n.id = ?', n.id)[0]);
});
route('DELETE', '/api/notes/:id', 'scout', (req, res, { params, user }) => {
  const n = db.prepare('SELECT * FROM notes WHERE id = ?').get(+params.id);
  if (!n) return send(res, 404, { error: 'No such note.' });
  if (n.user_id !== user.id && !A.atLeast(user, 'admin')) return send(res, 403, { error: 'You can only delete your own notes.' });
  db.prepare('DELETE FROM notes WHERE id = ?').run(n.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('POST', '/api/teams/:number/features', 'scout', (req, res, { params, body, user }) => {
  const team = +params.number, featureId = intOrNull(body.featureId), matchId = intOrNull(body.matchId);
  if (!db.prepare('SELECT 1 FROM teams WHERE number = ?').get(team)) return send(res, 404, { error: 'Unknown team.' });
  if (!db.prepare('SELECT 1 FROM features WHERE id = ? AND archived = 0').get(featureId)) return send(res, 400, { error: 'Pick a feature.' });
  if (db.prepare('SELECT 1 FROM team_features WHERE team = ? AND feature_id = ? AND user_id = ? AND COALESCE(match_id, 0) = COALESCE(?, 0)').get(team, featureId, user.id, matchId)) {
    return send(res, 409, { error: 'You already tagged that.' });
  }
  db.prepare('INSERT INTO team_features (team, feature_id, match_id, user_id, note) VALUES (?, ?, ?, ?, ?)').run(team, featureId, matchId, user.id, str(body.note, 500) || null);
  changesSinceBackup++;
  send(res, 201, { ok: true });
});
route('DELETE', '/api/team-features/:id', 'scout', (req, res, { params, user }) => {
  const tf = db.prepare('SELECT * FROM team_features WHERE id = ?').get(+params.id);
  if (!tf) return send(res, 404, { error: 'Not found.' });
  if (tf.user_id !== user.id && !A.atLeast(user, 'lead')) return send(res, 403, { error: 'You can only remove your own tags.' });
  db.prepare('DELETE FROM team_features WHERE id = ?').run(tf.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});

// ---------- routes: video sync (leads and admins) ----------
route('PUT', '/api/matches/:id/sync', 'lead', (req, res, { params, body, user }) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(+params.id);
  if (!m) return send(res, 404, { error: 'No such match.' });
  const v = db.prepare('SELECT id FROM videos WHERE id = ? AND event_id = ?').get(intOrNull(body.videoId), m.event_id);
  const secs = Number(body.seconds);
  if (!v || !Number.isFinite(secs) || secs < 0) return send(res, 400, { error: 'Need a video and a time.' });
  db.prepare(`INSERT INTO anchors (match_id, video_id, video_seconds, user_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(match_id) DO UPDATE SET video_id = excluded.video_id, video_seconds = excluded.video_seconds, user_id = excluded.user_id, created_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .run(m.id, v.id, secs, user.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('DELETE', '/api/matches/:id/sync', 'lead', (req, res, { params }) => {
  db.prepare('DELETE FROM anchors WHERE match_id = ?').run(+params.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});

// ---------- routes: admin ----------
route('GET', '/api/admin/users', 'admin', (req, res) => send(res, 200, db.prepare('SELECT id, username, display_name AS displayName, role, disabled, must_change AS mustChange, created_at AS created FROM users ORDER BY role, username').all()));
route('POST', '/api/admin/users', 'admin', (req, res, { body }) => {
  const username = str(body.username, 40).toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(username)) return send(res, 400, { error: 'Usernames use letters, numbers, dots, dashes or underscores.' });
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return send(res, 409, { error: 'That username is taken.' });
  const role = ['admin', 'lead', 'scout'].includes(body.role) ? body.role : 'scout';
  const pw = A.randomPassword();
  db.prepare('INSERT INTO users (username, display_name, role, pw_hash, must_change) VALUES (?, ?, ?, ?, 1)').run(username, str(body.displayName, 60) || username, role, A.hashPassword(pw));
  changesSinceBackup++;
  send(res, 201, { username, tempPassword: pw });
});
route('PATCH', '/api/admin/users/:id', 'admin', (req, res, { params, body, user }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(+params.id);
  if (!u) return send(res, 404, { error: 'No such user.' });
  const out = { ok: true };
  if (body.role && ['admin', 'lead', 'scout'].includes(body.role)) {
    if (u.id === user.id && body.role !== 'admin') return send(res, 400, { error: "You can't remove your own admin role." });
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(body.role, u.id);
  }
  if ('disabled' in body) {
    if (u.id === user.id) return send(res, 400, { error: "You can't disable yourself." });
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(body.disabled ? 1 : 0, u.id);
    if (body.disabled) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  }
  if (body.displayName) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(str(body.displayName, 60), u.id);
  if (body.resetPassword) {
    const pw = A.randomPassword();
    db.prepare('UPDATE users SET pw_hash = ?, must_change = 1 WHERE id = ?').run(A.hashPassword(pw), u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    out.tempPassword = pw;
  }
  changesSinceBackup++;
  send(res, 200, out);
});
route('PUT', '/api/admin/settings', 'admin', (req, res, { body }) => {
  if (body.ourTeam !== undefined) DB.setSetting(db, 'our_team', intOrNull(body.ourTeam) || '');
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('POST', '/api/admin/events/ftcscout', 'admin', async (req, res, { body }) => {
  const season = intOrNull(body.season), code = str(body.code, 16).toUpperCase();
  if (!season || !/^[A-Z0-9]{2,16}$/.test(code)) return send(res, 400, { error: 'Enter a season like 2026 and an event code like USMINOQ.' });
  const ev = await E.fetchFromFtcScout(season, code);
  const r = E.importEvent(db, ev);
  changesSinceBackup++;
  send(res, 200, { ...r, videosFound: ev.videos.length });
});
route('POST', '/api/admin/events/json', 'admin', (req, res, { body }) => { const r = E.importEvent(db, body); changesSinceBackup++; send(res, 200, r); });
route('POST', '/api/admin/events/:id/refresh', 'admin', async (req, res, { params }) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(+params.id);
  if (!e) return send(res, 404, { error: 'No such event.' });
  const r = E.importEvent(db, await E.fetchFromFtcScout(e.season, e.code));
  changesSinceBackup++;
  send(res, 200, r);
});
route('PATCH', '/api/admin/events/:id', 'admin', (req, res, { params, body }) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(+params.id);
  if (!e) return send(res, 404, { error: 'No such event.' });
  if ('live' in body) db.prepare('UPDATE events SET live = ? WHERE id = ?').run(body.live ? 1 : 0, e.id);
  if (body.name) db.prepare('UPDATE events SET name = ? WHERE id = ?').run(str(body.name, 120), e.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('DELETE', '/api/admin/events/:id', 'admin', (req, res, { params }) => {
  B.snapshot(db, BACKUP_DIR, 'before-delete');
  db.prepare('DELETE FROM events WHERE id = ?').run(+params.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('POST', '/api/admin/events/:id/videos', 'admin', (req, res, { params, body }) => {
  const id = E.youtubeIdFrom(body.url);
  if (!id) return send(res, 400, { error: 'Paste a YouTube link (watch, live or youtu.be).' });
  const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM videos WHERE event_id = ?').get(+params.id).s;
  db.prepare('INSERT INTO videos (event_id, youtube_id, label, date, sort) VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, youtube_id) DO UPDATE SET label = excluded.label, date = excluded.date')
    .run(+params.id, id, str(body.label, 80) || 'Stream video', /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null, sort);
  changesSinceBackup++;
  send(res, 201, { ok: true });
});
route('PATCH', '/api/admin/videos/:id', 'admin', (req, res, { params, body }) => {
  if (body.label) db.prepare('UPDATE videos SET label = ? WHERE id = ?').run(str(body.label, 80), +params.id);
  if ('date' in body) db.prepare('UPDATE videos SET date = ? WHERE id = ?').run(/^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : null, +params.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('DELETE', '/api/admin/videos/:id', 'admin', (req, res, { params }) => { db.prepare('DELETE FROM videos WHERE id = ?').run(+params.id); changesSinceBackup++; send(res, 200, { ok: true }); });
route('POST', '/api/admin/features', 'lead', (req, res, { body }) => {
  const label = str(body.label, 40);
  if (!label) return send(res, 400, { error: 'Name the feature.' });
  if (db.prepare('SELECT 1 FROM features WHERE label = ?').get(label)) return send(res, 409, { error: 'That feature already exists.' });
  const kind = ['strength', 'weakness', 'info'].includes(body.kind) ? body.kind : 'strength';
  const sort = db.prepare('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM features').get().s;
  db.prepare('INSERT INTO features (label, kind, sort) VALUES (?, ?, ?)').run(label, kind, sort);
  changesSinceBackup++;
  send(res, 201, { ok: true });
});
route('PATCH', '/api/admin/features/:id', 'lead', (req, res, { params, body }) => {
  if (body.label) db.prepare('UPDATE features SET label = ? WHERE id = ?').run(str(body.label, 40), +params.id);
  if (['strength', 'weakness', 'info'].includes(body.kind)) db.prepare('UPDATE features SET kind = ? WHERE id = ?').run(body.kind, +params.id);
  if ('archived' in body) db.prepare('UPDATE features SET archived = ? WHERE id = ?').run(body.archived ? 1 : 0, +params.id);
  changesSinceBackup++;
  send(res, 200, { ok: true });
});
route('GET', '/api/admin/backups', 'admin', (req, res) => send(res, 200, { dir: BACKUP_DIR, everyHours: BACKUP_HOURS, keep: BACKUP_KEEP, backups: B.list(BACKUP_DIR) }));
route('POST', '/api/admin/backups', 'admin', (req, res) => { const name = B.snapshot(db, BACKUP_DIR, 'manual'); changesSinceBackup = 0; send(res, 201, { name }); });
route('GET', '/api/admin/backups/:name', 'admin', (req, res, { params }) => {
  const name = decodeURIComponent(params.name);
  if (!/^filmroom-[\w-]+\.db$/.test(name) || !fs.existsSync(path.join(BACKUP_DIR, name))) return send(res, 404, { error: 'No such backup.' });
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
  fs.createReadStream(path.join(BACKUP_DIR, name)).pipe(res);
});
route('GET', '/api/admin/export', 'admin', (req, res) => {
  const name = `filmroom-export-${new Date().toISOString().slice(0, 10)}.json`;
  send(res, 200, JSON.stringify(B.exportJson(db)), { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${name}"` });
});
route('POST', '/api/admin/restore', 'admin', (req, res, { body }) => {
  B.validate(body);
  B.snapshot(db, BACKUP_DIR, 'before-restore');
  B.restoreJson(db, body);
  changesSinceBackup++;
  send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
});

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'", "script-src 'self' https://www.youtube.com https://s.ytimg.com",
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com", "img-src 'self' data: https://i.ytimg.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src https://fonts.gstatic.com", "connect-src 'self'",
    "object-src 'none'", "base-uri 'self'", "frame-ancestors 'none'",
  ].join('; '),
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
};

const server = http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  const ip = (process.env.TRUST_PROXY === '1' && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;
  try {
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    // Cross-site form posts can't set custom headers, so this header blocks CSRF.
    if (req.method !== 'GET' && req.headers['x-film-room'] !== '1') return send(res, 403, { error: 'Missing request header.' });
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Not found.' });
    const params = Object.fromEntries(r.keys.map((k, i) => [k, url.pathname.match(r.re)[i + 1]]));
    const token = cookies(req).fr_session;
    const user = A.userForToken(db, token);
    if (r.minRole && !user) return send(res, 401, { error: 'Please sign in.' });
    if (r.minRole && !A.atLeast(user, r.minRole)) return send(res, 403, { error: 'Your account cannot do that.' });
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    await r.handler(req, res, { params, body, user, token, ip, query: url.searchParams });
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
  }
});

// ---------- timers: backups and live refresh ----------
function autoBackup() {
  try {
    if (changesSinceBackup === 0 && B.list(BACKUP_DIR).length) return;
    const name = B.snapshot(db, BACKUP_DIR, 'auto');
    changesSinceBackup = 0;
    B.prune(BACKUP_DIR, BACKUP_KEEP);
    console.log(`  Backup written: ${name}`);
  } catch (e) { console.error('  Backup failed:', e.message); }
}
async function refreshLive() {
  for (const e of db.prepare('SELECT * FROM events WHERE live = 1').all()) {
    try { E.importEvent(db, await E.fetchFromFtcScout(e.season, e.code)); changesSinceBackup++; }
    catch (err) { console.error(`  Live refresh of ${e.code} failed: ${err.message}`); }
  }
}

if (require.main === module) {
  firstRun();
  autoBackup();
  setInterval(autoBackup, BACKUP_HOURS * 3600e3).unref();
  setInterval(refreshLive, 3 * 60e3).unref();
  setInterval(() => A.purgeSessions(db), 3600e3).unref();
  server.listen(PORT, HOST, () => console.log(`  FTC Film Room running at http://localhost:${PORT}\n  Data: ${DATA_DIR}\n  Backups: ${BACKUP_DIR} (every ${BACKUP_HOURS}h, keeping ${BACKUP_KEEP})`));
  const stop = () => { try { autoBackup(); } finally { process.exit(0); } };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { server, db, firstRun };
