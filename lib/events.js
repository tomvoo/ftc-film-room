// Events, matches and the "slicing": working out where each match sits inside the stream video.
'use strict';
const { tx } = require('./db');

const FTCSCOUT = 'https://api.ftcscout.org/rest/v1';
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function matchLabel(m) {
  if (m.level === 'qual') return `Q${m.num}`;
  return m.num > 1 ? `P${m.series}-${m.num}` : `P${m.series}`;
}
function matchTitle(m) {
  if (m.level === 'qual') return `Qualification ${m.num}`;
  return m.num > 1 ? `Playoff match ${m.series} (game ${m.num})` : `Playoff match ${m.series}`;
}

function youtubeIdFrom(input) {
  const s = String(input || '').trim();
  if (YT_ID.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|live\/|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ---------- importing ----------

// Normalized event format (also the seed and JSON-import format):
// { season, code, name, venue, startDate, endDate, timezone, teams:[{number,name,city}],
//   videos:[{youtubeId,label,date}], matches:[{ftcId,level,series,num,start,red:[..],blue:[..],redScore,blueScore}] }
function importEvent(db, ev) {
  if (!ev || !Number.isInteger(+ev.season) || !/^[A-Za-z0-9]{2,16}$/.test(String(ev.code || ''))) {
    throw httpError(400, 'Event needs a season (e.g. 2026) and an event code (e.g. USMINOQ).');
  }
  const code = String(ev.code).toUpperCase();
  return tx(db, () => {
    db.prepare(`INSERT INTO events (season, code, name, venue, start_date, end_date, timezone, last_refresh)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(season, code) DO UPDATE SET name = excluded.name, venue = COALESCE(excluded.venue, venue),
        start_date = COALESCE(excluded.start_date, start_date), end_date = COALESCE(excluded.end_date, end_date),
        timezone = excluded.timezone, last_refresh = excluded.last_refresh`)
      .run(+ev.season, code, String(ev.name || code), ev.venue || null, ev.startDate || null, ev.endDate || null,
        ev.timezone || 'America/Detroit', new Date().toISOString());
    const eventId = db.prepare('SELECT id FROM events WHERE season = ? AND code = ?').get(+ev.season, code).id;

    const upTeam = db.prepare(`INSERT INTO teams (number, name, city) VALUES (?, ?, ?)
      ON CONFLICT(number) DO UPDATE SET name = COALESCE(excluded.name, name), city = COALESCE(excluded.city, city)`);
    const linkTeam = db.prepare('INSERT OR IGNORE INTO event_teams (event_id, team) VALUES (?, ?)');
    for (const t of ev.teams || []) {
      if (!Number.isInteger(+t.number)) continue;
      upTeam.run(+t.number, t.name || null, t.city || null);
      linkTeam.run(eventId, +t.number);
    }

    const upMatch = db.prepare(`INSERT INTO matches (event_id, ftc_id, level, series, num, start_time, red_score, blue_score)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id, ftc_id) DO UPDATE SET level = excluded.level, series = excluded.series, num = excluded.num,
        start_time = COALESCE(excluded.start_time, start_time), red_score = excluded.red_score, blue_score = excluded.blue_score`);
    const getMatch = db.prepare('SELECT id FROM matches WHERE event_id = ? AND ftc_id = ?');
    const clearTeams = db.prepare('DELETE FROM match_teams WHERE match_id = ?');
    const addTeam = db.prepare('INSERT OR REPLACE INTO match_teams (match_id, team, alliance, slot) VALUES (?, ?, ?, ?)');
    let n = 0;
    for (const m of ev.matches || []) {
      if (!Number.isInteger(+m.ftcId) || !['qual', 'playoff'].includes(m.level)) continue;
      const score = (v) => (v === null || v === undefined || v === '' ? null : +v);
      upMatch.run(eventId, +m.ftcId, m.level, +m.series || 0, +m.num || 0, m.start || null, score(m.redScore), score(m.blueScore));
      const matchId = getMatch.get(eventId, +m.ftcId).id;
      clearTeams.run(matchId);
      (m.red || []).forEach((t, i) => { addTeam.run(matchId, +t, 'red', i + 1); linkTeam.run(eventId, +t); upTeam.run(+t, null, null); });
      (m.blue || []).forEach((t, i) => { addTeam.run(matchId, +t, 'blue', i + 1); linkTeam.run(eventId, +t); upTeam.run(+t, null, null); });
      n++;
    }

    const addVideo = db.prepare(`INSERT INTO videos (event_id, youtube_id, label, date, sort) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(event_id, youtube_id) DO NOTHING`);
    (ev.videos || []).forEach((v, i) => {
      const id = youtubeIdFrom(v.youtubeId || v.url);
      if (id) addVideo.run(eventId, id, String(v.label || `Stream video ${i + 1}`), v.date || null, i);
    });
    return { eventId, matches: n };
  });
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ftc-film-room' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw httpError(502, `FTCScout answered ${res.status} for ${url}`);
  return res.json();
}

// Fetch an event from FTCScout's public API (no key needed) and convert it to the normalized format.
async function fetchFromFtcScout(season, code) {
  code = String(code).toUpperCase();
  const base = `${FTCSCOUT}/events/${encodeURIComponent(season)}/${encodeURIComponent(code)}`;
  const info = await getJson(base);
  const rawMatches = await getJson(`${base}/matches`);
  let teamList = [];
  try { teamList = await getJson(`${base}/teams`); } catch { /* names are optional */ }

  const matches = [];
  for (const m of rawMatches || []) {
    const lvl = String(m.tournamentLevel || '');
    if (!m.teams || !m.teams.length) continue;
    const level = /qual/i.test(lvl) ? 'qual' : (/practice/i.test(lvl) ? null : 'playoff');
    if (!level) continue;
    const series = +m.series || 0;
    const num = level === 'qual' ? (+m.matchNum || +m.id) : (+m.matchNum || (+m.id % 1000) || 1);
    const side = (a) => m.teams.filter((t) => String(t.alliance).toLowerCase() === a)
      .sort((x, y) => String(x.station).localeCompare(String(y.station))).map((t) => +t.teamNumber);
    const sc = m.scores || {};
    matches.push({
      ftcId: +m.id, level, series, num, start: m.actualStartTime || m.scheduledStartTime || null,
      red: side('red'), blue: side('blue'),
      redScore: sc.red?.totalPoints ?? m.redTotalPoints ?? null, blueScore: sc.blue?.totalPoints ?? m.blueTotalPoints ?? null,
    });
  }

  const numbers = [...new Set([...(teamList || []).map((t) => +t.teamNumber), ...matches.flatMap((m) => [...m.red, ...m.blue])])].filter(Boolean);
  const teams = [];
  for (let i = 0; i < numbers.length; i += 6) {
    const batch = await Promise.all(numbers.slice(i, i + 6).map(async (n) => {
      try {
        const t = await getJson(`${FTCSCOUT}/teams/${n}`);
        return { number: n, name: t.name || null, city: [t.city, t.stateProv].filter(Boolean).join(', ') || null };
      } catch { return { number: n }; }
    }));
    teams.push(...batch);
  }

  const videos = [];
  const urls = [info.liveStreamURL, ...(info.webcasts || [])].filter(Boolean);
  for (const u of urls) { const id = youtubeIdFrom(u); if (id) videos.push({ youtubeId: id, label: 'Stream' }); }
  // FIRST in Michigan publishes each event's stream videos on fimav.us.
  try {
    const res = await fetch(`https://fimav.us/live/${season}/${code}`, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const html = await res.text();
      const seen = new Set(videos.map((v) => v.youtubeId));
      for (const mm of html.matchAll(/(?:youtube\.com\/(?:watch\?v=|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/g)) {
        if (!seen.has(mm[1])) { seen.add(mm[1]); videos.push({ youtubeId: mm[1], label: `Stream video ${videos.length + 1}` }); }
      }
    }
  } catch { /* the admin can paste video links by hand */ }

  return {
    season: +season, code, name: info.name || code,
    venue: [info.venue, info.city, info.stateProv].filter(Boolean).join(', ') || null,
    startDate: (info.start || '').slice(0, 10) || null, endDate: (info.end || '').slice(0, 10) || null,
    timezone: info.timezone || 'America/Detroit', teams, videos, matches,
  };
}

// ---------- slicing ----------

const epoch = (iso) => (iso ? Date.parse(iso) / 1000 : NaN);

function localDate(iso, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
  catch { return String(iso).slice(0, 10); }
}

// Returns, for every match of the event, which video to play and where the match starts in it.
function placeMatches(db, eventId) {
  const ev = db.prepare('SELECT timezone FROM events WHERE id = ?').get(eventId);
  const matches = db.prepare('SELECT id, start_time FROM matches WHERE event_id = ?').all(eventId);
  const videos = db.prepare('SELECT id, youtube_id, label, date FROM videos WHERE event_id = ? ORDER BY sort, id').all(eventId);
  const anchors = db.prepare(`SELECT a.match_id, a.video_id, a.video_seconds, m.start_time FROM anchors a
    JOIN matches m ON m.id = a.match_id WHERE m.event_id = ?`).all(eventId)
    .map((a) => ({ ...a, e: epoch(a.start_time) })).filter((a) => !Number.isNaN(a.e)).sort((x, y) => x.e - y.e);
  const vById = new Map(videos.map((v) => [v.id, v]));
  const out = new Map();
  for (const m of matches) {
    const e = epoch(m.start_time);
    const own = anchors.find((a) => a.match_id === m.id);
    let place = null;
    if (own) place = { videoId: own.video_id, start: own.video_seconds, status: 'synced', fromMatchId: m.id };
    else if (anchors.length && !Number.isNaN(e)) {
      let a = null;
      for (const x of anchors) if (x.e <= e) a = x;       // nearest anchor at or before this match
      if (!a) a = anchors[0];                              // otherwise the first one after it
      const start = a.video_seconds + (e - a.e);
      if (start >= 0) place = { videoId: a.video_id, start, status: 'estimated', fromMatchId: a.match_id };
    }
    if (!place) {
      const day = m.start_time ? localDate(m.start_time, ev.timezone) : null;
      const v = videos.find((x) => x.date && x.date === day) || videos[0];
      place = v ? { videoId: v.id, start: null, status: 'unsynced', fromMatchId: null } : { videoId: null, start: null, status: 'novideo', fromMatchId: null };
    }
    const v = vById.get(place.videoId);
    out.set(m.id, { ...place, youtubeId: v ? v.youtube_id : null, videoLabel: v ? v.label : null });
  }
  return out;
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = { importEvent, fetchFromFtcScout, placeMatches, matchLabel, matchTitle, youtubeIdFrom, httpError, localDate };
