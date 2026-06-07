// Lexia — autenticación multi-tenant, sin dependencias (crypto nativo).
// - Contraseñas: scrypt + salt aleatorio (nunca en claro).
// - Sesiones: cookie firmada con HMAC-SHA256 (stateless; sobrevive a reinicios).
// - Usuarios y despachos: store JSON en data/ (privado, fuera de git).
//
// Para el MVP: registro abierto; el primer usuario de un despacho es su admin.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DATA_DIR = join(__dirname, 'data');
const USERS_PATH = join(DATA_DIR, 'users.json');
const SECRET_PATH = join(DATA_DIR, '.session_secret');
const COOKIE = 'lexia_session';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 días

// Secreto de firma persistente (se genera la primera vez)
function getSecret() {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf-8').trim();
  const s = randomBytes(32).toString('hex');
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  return s;
}
const SECRET = getSecret();

// ---------- Store de usuarios ----------
async function loadUsers() {
  if (!existsSync(USERS_PATH)) return [];
  return JSON.parse(await readFile(USERS_PATH, 'utf-8'));
}
async function saveUsers(users) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_PATH, JSON.stringify(users, null, 2), { mode: 0o600 });
}

// ---------- Hash de contraseña ----------
function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(pw, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  const h = scryptSync(pw, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return h.length === stored.length && timingSafeEqual(h, stored);
}

// ---------- Cookies de sesión firmadas ----------
const b64u = (s) => Buffer.from(s).toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf-8');

function signSession(payload) {
  const data = b64u(JSON.stringify({ ...payload, exp: Date.now() + MAX_AGE * 1000 }));
  const sig = createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifySession(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = createHmac('sha256', SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(unb64u(data));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${MAX_AGE}`;
}
function clearCookie() {
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

// Usuario actual a partir de la cookie (o null)
function currentUser(req) {
  return verifySession(parseCookies(req)[COOKIE]);
}

// ---------- Operaciones de cuenta ----------
const normEmail = (e) => String(e || '').trim().toLowerCase();

async function register({ email, password, despacho }) {
  email = normEmail(email);
  if (!email.includes('@')) throw new Error('Email no válido');
  if (!password || password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
  if (!despacho || !despacho.trim()) throw new Error('Indica el nombre del despacho');
  const users = await loadUsers();
  if (users.some((u) => u.email === email)) throw new Error('Ya existe una cuenta con ese email');
  const despachoNorm = despacho.trim();
  const esPrimeroDelDespacho = !users.some((u) => u.despacho.toLowerCase() === despachoNorm.toLowerCase());
  const { salt, hash } = hashPassword(password);
  const user = {
    id: randomBytes(8).toString('hex'),
    email, salt, hash,
    despacho: despachoNorm,
    role: esPrimeroDelDespacho ? 'admin' : 'miembro',
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await saveUsers(users);
  return publicUser(user);
}

async function login({ email, password }) {
  email = normEmail(email);
  const users = await loadUsers();
  const u = users.find((x) => x.email === email);
  if (!u || !verifyPassword(password, u.salt, u.hash)) throw new Error('Email o contraseña incorrectos');
  return publicUser(u);
}

const publicUser = (u) => ({ id: u.id, email: u.email, despacho: u.despacho, role: u.role });

export {
  register, login, currentUser, publicUser,
  signSession, sessionCookie, clearCookie,
};
