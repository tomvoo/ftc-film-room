// Backups: automatic SQLite snapshots on a timer, plus a full JSON export/restore for the admin page.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('./db');

const TABLES = ['users', 'settings', 'events', 'teams', 'event_teams', 'matches', 'match_teams', 'videos', 'anchors', 'notes', 'features', 'team_features'];

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-'); }

function snapshot(db, dir, reason = 'auto') {
  fs.mkdirSync(dir, { recursive: true });
  let name = `filmroom-${stamp()}-${reason}.db`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `filmroom-${stamp()}-${reason}-${i}.db`;
  const file = path.join(dir, name);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return name;
}

function list(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^filmroom-[\w-]+\.db$/.test(f))
    .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, bytes: st.size, created: st.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function prune(dir, keep) {
  const autos = list(dir).filter((b) => /-auto(-\d+)?\.db$/.test(b.name));
  for (const b of autos.slice(keep)) fs.unlinkSync(path.join(dir, b.name));
}

function exportJson(db) {
  const data = {};
  for (const t of TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all();
  return { format: 'ftc-film-room/backup@1', exportedAt: new Date().toISOString(), tables: data };
}

function validate(dump) {
  if (!dump || dump.format !== 'ftc-film-room/backup@1' || !dump.tables) throw Object.assign(new Error('That file is not a Film Room backup.'), { status: 400 });
  if (!(dump.tables.users || []).some((u) => u.role === 'admin' && !u.disabled)) {
    throw Object.assign(new Error('That backup has no active admin account, so restoring it would lock everyone out.'), { status: 400 });
  }
}

function restoreJson(db, dump) {
  validate(dump);
  tx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    db.exec('DELETE FROM sessions');
    for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM ${t}`);
    for (const t of TABLES) {
      const rows = dump.tables[t] || [];
      if (!rows.length) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
      const use = cols.filter((c) => c in rows[0]);
      const ins = db.prepare(`INSERT INTO ${t} (${use.join(',')}) VALUES (${use.map(() => '?').join(',')})`);
      for (const r of rows) ins.run(...use.map((c) => r[c] ?? null));
    }
  });
}

module.exports = { snapshot, list, prune, exportJson, restoreJson, validate };
