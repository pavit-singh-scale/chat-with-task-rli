import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { writeJsonAtomic } from './fixes.js';
import { httpError } from './workspace.js';

const USERS_PATH = path.join(config.dataDir, 'users.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Seeded on first boot; passwords are scrypt-hashed, change them in data/users.json
// by replacing the hash with {"password": "newpass"} — it re-hashes on next login check.
// The suffix is env-driven so a deploy can randomize it (deploy/sandbox.mjs does) —
// a committed default on a public URL is an open door. Unset, local dev seeds the
// same <name>-cwt26 logins as always.
const SEED_SUFFIX = process.env.CWT_SEED_SUFFIX || 'cwt26';
// RLI / PKJA team (#rli-pkja-pt + the QM Follow-Up Tracker, 2026-09-25):
// leads are admins, QMs are reviewers. Username = first name, lower-case.
const RLI_ADMINS = ['pavit', 'luis', 'ernesto', 'donnahue', 'lynn', 'guadalupe', 'george'];
const RLI_REVIEWERS = [
  // leads / DRIs / ops
  'erfan', 'gilberto', 'martin', 'valentina', 'feyza',
  // PKJA QMs
  'burak', 'frida', 'gabriela', 'garrett', 'jose', 'lenny', 'nevena', 'sandra', 'shafin', 'timothee', 'alberto', 'juan',
];
const DEFAULT_USERS = [
  { username: 'admin', password: `admin-${SEED_SUFFIX}`, role: 'admin' },
  ...RLI_ADMINS.map((u) => ({ username: u, password: `${u}-${SEED_SUFFIX}`, role: 'admin' })),
  ...RLI_REVIEWERS.map((u) => ({ username: u, password: `${u}-${SEED_SUFFIX}`, role: 'reviewer' })),
];

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

function loadUsers() {
  if (!fs.existsSync(USERS_PATH)) {
    fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
    const seeded = DEFAULT_USERS.map((u) => {
      const salt = crypto.randomBytes(8).toString('hex');
      return { username: u.username, role: u.role, salt, hash: hash(u.password, salt) };
    });
    writeJsonAtomic(USERS_PATH, seeded);
  }
  return JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
}

// Add any DEFAULT_USERS missing from an existing users.json (never touches an
// account that already exists, so changed passwords survive). Returns names added.
export function syncDefaultUsers({ drop = [] } = {}) {
  const users = loadUsers().filter((u) => !drop.includes(u.username));
  const have = new Set(users.map((u) => u.username));
  const added = [];
  for (const u of DEFAULT_USERS) {
    if (have.has(u.username)) continue;
    const salt = crypto.randomBytes(8).toString('hex');
    users.push({ username: u.username, role: u.role, salt, hash: hash(u.password, salt) });
    added.push(u.username);
  }
  for (const u of users) { const d = DEFAULT_USERS.find((x) => x.username === u.username); if (d) u.role = d.role; }
  writeJsonAtomic(USERS_PATH, users);
  return added;
}

export function verifyLogin(username, password) {
  const users = loadUsers();
  const u = users.find((x) => x.username === username);
  if (!u) return null;
  // plaintext "password" field supported so admins can reset by hand-editing
  if (u.password != null) {
    if (u.password !== password) return null;
    u.salt = crypto.randomBytes(8).toString('hex');
    u.hash = hash(password, u.salt);
    delete u.password;
    // A torn write here would brick every login — temp-then-rename only.
    writeJsonAtomic(USERS_PATH, users);
    return { username: u.username, role: u.role };
  }
  const computed = hash(password, u.salt);
  const ok = computed.length === u.hash.length &&
    crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(u.hash));
  return ok ? { username: u.username, role: u.role } : null;
}

// In-memory sessions: fine for a single-process internal tool; a restart just
// asks everyone to log in again.
const sessions = new Map();

export function createSession(user) {
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { user, expires: Date.now() + SESSION_TTL_MS });
  return sid;
}

export function destroySession(sid) {
  sessions.delete(sid);
}

export function sessionUser(req) {
  const sid = (req.headers.cookie || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('cwt_sid='))
    ?.slice(8);
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s || s.expires < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  req.sid = sid;
  return s.user;
}

export function requireAuth(req, res, next) {
  const user = sessionUser(req);
  if (!user) return next(httpError(401, 'login required'));
  req.user = user;
  next();
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (req.user.role !== 'admin') return next(httpError(403, 'admin only'));
    next();
  });
}
