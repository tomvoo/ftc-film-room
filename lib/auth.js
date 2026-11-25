// Passwords (scrypt), sessions (random token in an HttpOnly cookie) and a simple login rate limit.
'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 30;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltB64, hashB64] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const got = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}
function randomPassword() {
  // Easy to read aloud to a student: three short words would need a word list, so use unambiguous characters instead.
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, expires);
  return { token, maxAge: SESSION_DAYS * 86400 };
}
function userForToken(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.must_change, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
  if (!row || row.disabled || row.expires_at < new Date().toISOString()) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, mustChange: !!row.must_change };
}
function destroySession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
}
function purgeSessions(db) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}

// 10 failed attempts per username+address in 15 minutes locks that pair out for the rest of the window.
const failures = new Map();
function loginBlocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(key); return false; }
  return f.count >= 10;
}
function noteFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
function clearFailures(key) { failures.delete(key); }

const ROLE_RANK = { scout: 1, lead: 2, admin: 3 };
const atLeast = (user, role) => !!user && ROLE_RANK[user.role] >= ROLE_RANK[role];

module.exports = {
  hashPassword, verifyPassword, randomPassword, createSession, userForToken, destroySession, purgeSessions,
  loginBlocked, noteFailure, clearFailures, atLeast,
};
