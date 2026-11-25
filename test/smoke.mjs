// End-to-end check against a running server: node test/smoke.mjs http://localhost:3999 coach password
const [base = 'http://localhost:3000', user = 'coach', pass] = process.argv.slice(2);
let cookie = '';
async function call(method, path, body, { expect = [200, 201], raw = false } = {}) {
  const res = await fetch(base + path, { method, headers: { 'x-film-room': '1', cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const data = raw ? await res.text() : await res.json().catch(() => null);
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('  ok -', msg); };

await call('GET', '/api/events', null, { expect: [401] }); ok(true, 'events need a login');
await call('POST', '/api/login', { username: user, password: 'wrong' }, { expect: [401] }); ok(true, 'wrong password refused');
const noHeader = await fetch(base + '/api/login', { method: 'POST', body: '{}' }); ok(noHeader.status === 403, 'POST without CSRF header refused');
await call('POST', '/api/login', { username: user, password: pass });
const events = await call('GET', '/api/events'); ok(events.length === 1 && events[0].code === 'USMINOQ', 'Novi qualifier seeded');
const ev = await call('GET', `/api/events/${events[0].id}`);
ok(ev.matches.length === 57, '57 matches');
ok(ev.teams.length === 36, '36 teams');
const ours = ev.matches.filter((m) => m.red.includes(10137) || m.blue.includes(10137));
ok(ours.length === 11, 'team 10137 has 11 matches: ' + ours.map((m) => m.label).join(' '));
ok(ours.every((m) => m.video.status === 'unsynced' && m.video.youtubeId === 'O_tqi3z2pgU'), 'unsynced matches default to the Day 1 video');
const t10137 = ev.teams.find((t) => t.number === 10137); ok(t10137.wins === 4 && t10137.losses === 1, `10137 qual record ${t10137.wins}-${t10137.losses}-${t10137.ties}`);

// sync one match, everything else gets placed
const q1 = ev.matches.find((m) => m.label === 'Q1'); const q5 = ev.matches.find((m) => m.label === 'Q5');
const vid = ev.videos.find((v) => v.youtubeId === 'O_tqi3z2pgU').id;
await call('PUT', `/api/matches/${q1.id}/sync`, { videoId: vid, seconds: 3600 });
const ev2 = await call('GET', `/api/events/${events[0].id}`);
const q5b = ev2.matches.find((m) => m.id === q5.id);
const expected = 3600 + (Date.parse(q5.start) - Date.parse(q1.start)) / 1000;
ok(q5b.video.status === 'estimated' && Math.abs(q5b.video.start - expected) < 0.01, `Q5 placed at ${q5b.video.start.toFixed(1)}s (expected ${expected.toFixed(1)}s)`);
// a second anchor later in the day corrects drift for matches after it
const q27 = ev2.matches.find((m) => m.label === 'Q27'); const q33 = ev2.matches.find((m) => m.label === 'Q33');
await call('PUT', `/api/matches/${q27.id}/sync`, { videoId: vid, seconds: q27.video.start + 20 });
const ev3 = await call('GET', `/api/events/${events[0].id}`);
ok(Math.abs(ev3.matches.find((m) => m.id === q33.id).video.start - (q33.video.start + 20)) < 0.01, 'later anchor shifts later matches (stream gap)');
ok(Math.abs(ev3.matches.find((m) => m.id === q5.id).video.start - expected) < 0.01, 'earlier matches keep the earlier anchor');

// notes
const n1 = await call('POST', `/api/matches/${q5.id}/notes`, { kind: 'timed', t: 12.5, vt: expected + 12.5, videoId: vid, team: 10137, category: 'Auto', text: 'Scored 2 pollen in auto <script>' });
ok(n1.kind === 'timed' && n1.t === 12.5 && n1.team === 10137, 'timed note saved');
await call('POST', `/api/matches/${q5.id}/notes`, { kind: 'match', text: 'Partner drove well' });
await call('POST', `/api/matches/${q5.id}/notes`, { kind: 'match', team: 11129, text: 'not in this match' }, { expect: [400] }); ok(true, 'note for a team not in the match refused');
const md = await call('GET', `/api/matches/${q5.id}`); ok(md.notes.length === 2, 'match shows 2 notes');
await call('PATCH', `/api/notes/${n1.id}`, { text: 'Scored 3 pollen in auto' });

// tags
const feats = await call('GET', '/api/features'); ok(feats.length >= 10, 'feature catalog seeded');
await call('POST', '/api/teams/10137/features', { featureId: feats[0].id, matchId: q5.id, note: 'clean cycles' });
await call('POST', '/api/teams/10137/features', { featureId: feats[0].id, matchId: q5.id }, { expect: [409] }); ok(true, 'duplicate tag refused');
const team = await call('GET', '/api/teams/10137');
ok(team.tags.length === 1 && team.notes.length === 2 && team.events[0].matches.length === 11, 'team page has tag, notes, 11 matches');

// people and roles
const created = await call('POST', '/api/admin/users', { username: 'student1', displayName: 'Student One', role: 'scout' });
ok(/^[a-z2-9]{5}-[a-z2-9]{5}$/.test(created.tempPassword), 'student created with temp password');
const adminCookie = cookie; cookie = '';
await call('POST', '/api/login', { username: 'student1', password: created.tempPassword });
const me = await call('GET', '/api/me'); ok(me.user.mustChange && me.user.role === 'scout', 'student must change password');
await call('PUT', `/api/matches/${q5.id}/sync`, { videoId: vid, seconds: 1 }, { expect: [403] }); ok(true, 'scouts cannot sync video');
await call('GET', '/api/admin/users', null, { expect: [403] }); ok(true, 'scouts cannot open admin');
await call('PATCH', `/api/notes/${n1.id}`, { text: 'hijack' }, { expect: [403] }); ok(true, "scouts cannot edit someone else's note");
await call('POST', '/api/me/password', { current: created.tempPassword, next: 'eagles-rule-2026' });
cookie = adminCookie;

// backups
const before = await call('GET', '/api/admin/backups');
await call('POST', '/api/admin/backups');
const after = await call('GET', '/api/admin/backups'); ok(after.backups.length === before.backups.length + 1, 'manual backup written');
const dbFile = await fetch(base + `/api/admin/backups/${after.backups[0].name}`, { headers: { cookie } });
const bytes = Buffer.from(await dbFile.arrayBuffer()); ok(bytes.subarray(0, 15).toString() === 'SQLite format 3', 'backup downloads as a SQLite file');
const dump = JSON.parse(await call('GET', '/api/admin/export', null, { raw: true }));
ok(dump.tables.notes.length === 2 && dump.tables.users.length === 2, 'JSON export has notes and users');
await call('DELETE', `/api/notes/${n1.id}`);
await call('POST', '/api/admin/restore', dump); cookie = '';
await call('POST', '/api/login', { username: user, password: pass });
const restored = await call('GET', `/api/matches/${q5.id}`); ok(restored.notes.length === 2, 'restore brought the deleted note back');
const bad = await call('POST', '/api/admin/restore', { format: 'nope' }, { expect: [400] }); ok(true, 'bad restore file refused');
console.log('\nAll checks passed.');
