// Database setup and small helpers. Uses Node's built-in SQLite (node:sqlite), so there is nothing to install.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','lead','scout')),
  pw_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  venue TEXT,
  start_date TEXT,
  end_date TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/Detroit',
  live INTEGER NOT NULL DEFAULT 0,
  last_refresh TEXT,
  UNIQUE (season, code)
);
CREATE TABLE IF NOT EXISTS teams (number INTEGER PRIMARY KEY, name TEXT, city TEXT);
CREATE TABLE IF NOT EXISTS event_teams (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team INTEGER NOT NULL,
  PRIMARY KEY (event_id, team)
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ftc_id INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('qual','playoff')),
  series INTEGER NOT NULL DEFAULT 0,
  num INTEGER NOT NULL,
  start_time TEXT,
  red_score INTEGER,
  blue_score INTEGER,
  UNIQUE (event_id, ftc_id)
);
CREATE TABLE IF NOT EXISTS match_teams (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  team INTEGER NOT NULL,
  alliance TEXT NOT NULL CHECK (alliance IN ('red','blue')),
  slot INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (match_id, team)
);
CREATE INDEX IF NOT EXISTS match_teams_team ON match_teams(team);
CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  youtube_id TEXT NOT NULL,
  label TEXT NOT NULL,
  date TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, youtube_id)
);
-- An anchor says "this match starts at this many seconds into this video".
-- Matches without their own anchor are placed from the nearest earlier anchor using the official start times.
CREATE TABLE IF NOT EXISTS anchors (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  video_seconds REAL NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('timed','match')),
  t REAL,              -- seconds since the match started, when the note was written
  video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
  vt REAL,             -- seconds into the video, so a later re-sync keeps the note on the same moment
  category TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_match ON notes(match_id);
CREATE INDEX IF NOT EXISTS notes_team ON notes(team);
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL UNIQUE COLLATE NOCASE,
  kind TEXT NOT NULL DEFAULT 'strength' CHECK (kind IN ('strength','weakness','info')),
  sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS team_features (
  id INTEGER PRIMARY KEY,
  team INTEGER NOT NULL,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  match_id INTEGER REFERENCES matches(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS team_features_team ON team_features(team);
`;

const DEFAULT_FEATURES = [
  ['Scores pollen', 'strength'], ['Scores nectar', 'strength'], ['Strong auto', 'strength'],
  ['Fast cycles', 'strength'], ['Accurate shooter', 'strength'], ['Auto-aim / vision', 'strength'],
  ['Good endgame', 'strength'], ['Plays defense', 'info'], ['Great driver', 'strength'],
  ['Consistent', 'strength'], ['Breakdowns / disconnects', 'weakness'], ['Penalty-prone', 'weakness'],
  ['No auto', 'weakness'], ['Slow intake', 'weakness'],
];

function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'filmroom.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const count = db.prepare('SELECT COUNT(*) AS n FROM features').get().n;
  if (count === 0) {
    const ins = db.prepare('INSERT INTO features (label, kind, sort) VALUES (?, ?, ?)');
    DEFAULT_FEATURES.forEach(([label, kind], i) => ins.run(label, kind, i));
  }
  return db;
}

function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

module.exports = { open, tx, getSetting, setSetting, SCHEMA };
