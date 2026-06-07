// Lexia — IA jurídica open source para abogados (España)
// MVP: RAG sobre legislación/jurisprudencia con citas verificables.
// 100% local: LLM + embeddings servidos por LM Studio. Cero datos a terceros.
//
// Flujo:
//   1) Al arrancar, embebe el corpus (corpus/leyes.json) y cachea en data/embeddings.json
//   2) /api/consulta: embebe la pregunta -> recupera top-k por coseno ->
//      construye prompt que OBLIGA a citar -> LLM responde con [n] -> devolvemos fuentes.
//
// El objetivo de diseño nº1 es NO ALUCINAR: el modelo solo puede afirmar
// lo que esté en los fragmentos recuperados, y cada afirmación lleva su cita.

import { createServer } from 'node:http';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { register, login, currentUser, signSession, sessionCookie, clearCookie } from './auth.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CORPUS_DIR = join(__dirname, 'corpus');
const BIN_PATH = join(__dirname, 'data', 'embeddings.bin');
const IDS_PATH = join(__dirname, 'data', 'embeddings.ids.txt');
const META_PATH = join(__dirname, 'data', 'embeddings.meta.json');

const PORT = process.env.PORT || 5174;
const LM_BASE = process.env.LM_BASE || 'http://127.0.0.1:1234/v1';
const CHAT_MODEL = process.env.CHAT_MODEL || 'gemma-3-12b-it-qat';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-nomic-embed-text-v1.5';
const TOP_K = Number(process.env.TOP_K || 6);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// LM Studio helpers (API compatible con OpenAI)
// ---------------------------------------------------------------------------
async function embed(texts) {
  const res = await fetch(`${LM_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

async function chat(messages, { temperature = 0.1 } = {}) {
  const res = await fetch(`${LM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: CHAT_MODEL, messages, temperature, stream: false }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices[0].message.content;
}

// ---------------------------------------------------------------------------
// Índice: corpus en memoria + embeddings en store BINARIO (data/embeddings.bin)
// El embedding lo produce `node embed.mjs` (offline, resumible). El servidor
// solo CARGA. Escala a cientos de miles de artículos (el JSON no escalaba).
// ---------------------------------------------------------------------------
let INDEX = [];      // [{ ...doc, row }]  fila en VEC
let VEC = null;      // Float32Array con todos los vectores contiguos
let DIM = 0;

async function loadCorpus() {
  // Ficheros con prefijo "_" son de trabajo del ingestor (índice, manifiesto), no corpus.
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const docs = [];
  for (const f of files) { for (const d of JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf-8'))) docs.push(d); }
  return docs;
}

async function buildIndex() {
  const corpus = await loadCorpus();
  if (!existsSync(META_PATH) || !existsSync(BIN_PATH) || !existsSync(IDS_PATH)) {
    console.warn('⚠ Sin store de embeddings (data/embeddings.bin). Ejecuta: node embed.mjs');
    INDEX = []; return;
  }
  const meta = JSON.parse(await readFile(META_PATH, 'utf-8'));
  DIM = meta.dim;
  const buf = await readFile(BIN_PATH);
  // Copia alineada a 4 bytes para la vista Float32
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  VEC = new Float32Array(ab);
  const ids = (await readFile(IDS_PATH, 'utf-8')).split('\n').filter(Boolean);
  const binRows = Math.floor(VEC.length / DIM);
  const usable = Math.min(ids.length, binRows); // por si se lee a media escritura
  const rowOf = new Map();
  for (let i = 0; i < usable; i++) rowOf.set(ids[i], i);
  INDEX = [];
  for (const d of corpus) {
    const r = rowOf.get(d.id);
    if (r !== undefined && (r + 1) * DIM <= VEC.length) INDEX.push({ ...d, row: r });
  }
  console.log(`✓ Índice: ${INDEX.length}/${corpus.length} fragmentos con embedding (dim ${DIM})`);
}

function cosineRow(q, row) {
  const base = row * DIM;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIM; i++) { const a = q[i], b = VEC[base + i]; dot += a * b; na += a * a; nb += b * b; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ---------------------------------------------------------------------------
// Recuperación HÍBRIDA: BM25 (índice invertido) + semántica (vectorial).
// En derecho los términos exactos importan tanto como el significado.
// ---------------------------------------------------------------------------
const STOP = new Set(('de la el en y a los las del que se un una por con no para es su al lo como mas o pero sus le ya este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto entonces entre cual sea cualquier').split(' '));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokenize = (s) => norm(s).match(/[a-z0-9ñ]{3,}/g)?.filter((t) => !STOP.has(t)) || [];

let LEX = null; // { inv: Map(term -> [docIdx, tf, ...]), idf, len: Float64Array, avgdl }
function buildLexical() {
  const N = INDEX.length;
  if (!N) { LEX = null; return; }
  const inv = new Map();
  const df = new Map();
  const len = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const toks = tokenize(`${INDEX[i].cita} ${INDEX[i].texto}`);
    len[i] = toks.length;
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let a = inv.get(t); if (!a) { a = []; inv.set(t, a); }
      a.push(i, f);
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  let tot = 0; for (let i = 0; i < N; i++) tot += len[i];
  LEX = { inv, idf, len, avgdl: tot / N || 1 };
  console.log(`✓ BM25 (índice invertido): ${idf.size} términos`);
}

function bm25Map(query) {
  const sc = new Map();
  if (!LEX) return sc;
  const { inv, idf, len, avgdl } = LEX;
  const k1 = 1.5, b = 0.75;
  for (const t of new Set(tokenize(query))) {
    const a = inv.get(t); if (!a) continue;
    const w = idf.get(t) || 0;
    for (let j = 0; j < a.length; j += 2) {
      const di = a[j], f = a[j + 1];
      const s = w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * len[di] / avgdl));
      sc.set(di, (sc.get(di) || 0) + s);
    }
  }
  return sc;
}

async function retrieve(query, k = TOP_K) {
  if (!INDEX.length) return [];
  const [qv] = await embed([query]);
  const n = INDEX.length;
  // Vectorial: coseno sobre todo el índice
  const vraw = new Float64Array(n);
  let vmn = Infinity, vmx = -Infinity;
  for (let i = 0; i < n; i++) { const v = cosineRow(qv, INDEX[i].row); vraw[i] = v; if (v < vmn) vmn = v; if (v > vmx) vmx = v; }
  const vr = (vmx - vmn) || 1;
  // Léxico: BM25 disperso
  const bm = bm25Map(query);
  let bmx = 0; for (const v of bm.values()) if (v > bmx) bmx = v; bmx = bmx || 1;
  // Combinación 50/50 normalizada
  const scored = new Array(n);
  for (let i = 0; i < n; i++) {
    const vN = (vraw[i] - vmn) / vr;
    const lN = (bm.get(i) || 0) / bmx;
    scored[i] = { doc: INDEX[i], score: 0.5 * lN + 0.5 * vN };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

// ---------------------------------------------------------------------------
// Prompt jurídico: obliga a citar y prohíbe inventar
// ---------------------------------------------------------------------------
function buildMessages(query, hits) {
  const contexto = hits
    .map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente}) — ${h.doc.materia}\n${h.doc.texto}`)
    .join('\n\n');

  const system = `Eres Lexia, un asistente jurídico para abogados en España. Respondes en español, con rigor técnico-jurídico y tono profesional.

REGLAS INNEGOCIABLES:
1. Responde ÚNICAMENTE con la información contenida en las FUENTES proporcionadas. No uses conocimiento externo ni inventes artículos, números o sentencias.
2. Cada afirmación jurídica debe ir acompañada de su cita entre corchetes, p. ej. [1], [2], según el número de la fuente usada.
3. Si las fuentes no contienen información suficiente para responder, dilo claramente: "Las fuentes disponibles no permiten responder con seguridad" y sugiere qué norma habría que consultar. NUNCA rellenes el hueco inventando.
4. No des asesoramiento que sustituya el criterio del letrado: aporta la base normativa y deja la decisión al profesional.
5. Sé conciso y estructurado. Si procede, distingue régimen general y excepciones.`;

  const user = `FUENTES:\n${contexto}\n\nCONSULTA DEL ABOGADO:\n${query}\n\nResponde citando las fuentes con [n].`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function handleConsulta(req, res) {
  let body = '';
  for await (const chunk of req) body += chunk;
  const { query } = JSON.parse(body || '{}');
  if (!query || !query.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Falta la consulta' }));
  }

  const t0 = Date.now();
  const hits = await retrieve(query);
  const messages = buildMessages(query, hits);
  const answer = await chat(messages);
  const ms = Date.now() - t0;

  const fuentes = hits.map((h, i) => ({
    n: i + 1,
    cita: h.doc.cita,
    fuente: h.doc.fuente,
    materia: h.doc.materia,
    rango: h.doc.rango,
    url: h.doc.url,
    score: Number(h.score.toFixed(3)),
  }));

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ answer, fuentes, ms, model: CHAT_MODEL }));
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// ---------------------------------------------------------------------------
// Autenticación (cuentas de despachos)
// ---------------------------------------------------------------------------
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
};

async function handleRegister(req, res) {
  try {
    const user = await register(await readBody(req));
    json(res, 200, { user }, { 'set-cookie': sessionCookie(signSession(user)) });
  } catch (e) { json(res, 400, { error: e.message }); }
}

async function handleLogin(req, res) {
  try {
    const user = await login(await readBody(req));
    json(res, 200, { user }, { 'set-cookie': sessionCookie(signSession(user)) });
  } catch (e) { json(res, 401, { error: e.message }); }
}

function handleLogout(req, res) {
  json(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
}

function handleMe(req, res) {
  const u = currentUser(req);
  if (!u) return json(res, 401, { error: 'No autenticado' });
  json(res, 200, { user: { id: u.id, email: u.email, despacho: u.despacho, role: u.role } });
}

// Guard: exige sesión válida; si no, 401.
function requireAuth(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: 'Inicia sesión para usar Lexia' }); return null; }
  return u;
}

const TIPOS_ESCRITO = {
  demanda: 'Demanda civil',
  contrato: 'Contrato',
  recurso: 'Recurso',
  requerimiento: 'Requerimiento / burofax',
  clausula: 'Cláusula contractual',
  dictamen: 'Dictamen / informe jurídico',
};

async function handleRedactar(req, res) {
  const { tipo = 'escrito', hechos = '', instrucciones = '' } = await readBody(req);
  if (!hechos.trim()) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Faltan los hechos / contexto' }));
  }
  const t0 = Date.now();
  const tipoNombre = TIPOS_ESCRITO[tipo] || tipo;
  // Recuperamos normas relevantes a partir de los hechos + el tipo de escrito
  const hits = await retrieve(`${tipoNombre}. ${hechos} ${instrucciones}`, TOP_K);
  const contexto = hits
    .map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente})\n${h.doc.texto}`)
    .join('\n\n');

  const system = `Eres Lexia, un asistente de redacción jurídica para abogados en España. Generas borradores de escritos profesionales en español jurídico formal.

REGLAS:
1. Redacta un BORRADOR del documento solicitado, listo para que el letrado lo revise y adapte.
2. Apóyate en la normativa de las FUENTES y cita los preceptos relevantes con [n] en el cuerpo del texto.
3. No inventes artículos, números ni jurisprudencia que no estén en las FUENTES. Si falta una base legal, indícalo con un marcador entre llaves, p. ej. {{verificar precepto aplicable}}.
4. Usa marcadores entre llaves para los datos que el abogado debe completar, p. ej. {{nombre del cliente}}, {{cuantía}}, {{juzgado}}.
5. Estructura el documento según los usos forenses (encabezamiento, hechos, fundamentos de derecho, súplico/petición, fecha y firma) cuando proceda.
6. Es un borrador asistido; el criterio y la responsabilidad final son del letrado.`;

  const user = `FUENTES NORMATIVAS:\n${contexto}\n\nTIPO DE DOCUMENTO: ${tipoNombre}\n\nHECHOS / CONTEXTO:\n${hechos}\n\nINSTRUCCIONES ADICIONALES:\n${instrucciones || '(ninguna)'}\n\nRedacta el borrador citando las fuentes con [n].`;

  const draft = await chat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { temperature: 0.2 });

  const fuentes = hits.map((h, i) => ({
    n: i + 1, cita: h.doc.cita, fuente: h.doc.fuente, materia: h.doc.materia,
    rango: h.doc.rango, url: h.doc.url, score: Number(h.score.toFixed(3)),
  }));

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ draft, fuentes, ms: Date.now() - t0, model: CHAT_MODEL }));
}

function handleFuentes(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').toLowerCase();
  const limit = Math.min(Number(url.searchParams.get('limit') || 80), 300);
  let docs = INDEX;
  if (q) docs = docs.filter((d) => (d.cita + d.fuente + d.materia + d.texto).toLowerCase().includes(q));
  const total = docs.length;
  const fuentes = docs.slice(0, limit).map(({ row, ...meta }) => meta);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ fuentes, total, mostrados: fuentes.length }));
}

async function handleWaitlist(req, res) {
  const { email = '', despacho = '', mensaje = '' } = await readBody(req);
  if (!email.includes('@')) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Email no válido' }));
  }
  const WAITLIST = join(__dirname, 'data', 'waitlist.json');
  let list = [];
  if (existsSync(WAITLIST)) list = JSON.parse(await readFile(WAITLIST, 'utf-8'));
  list.push({ email, despacho, mensaje, fecha: new Date().toISOString() });
  await writeFile(WAITLIST, JSON.stringify(list, null, 2));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, posicion: list.length }));
}

async function serveStatic(req, res) {
  let path = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = join(PUBLIC_DIR, path);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    // --- Auth (públicas) ---
    if (req.method === 'POST' && req.url === '/api/register') return await handleRegister(req, res);
    if (req.method === 'POST' && req.url === '/api/login') return await handleLogin(req, res);
    if (req.method === 'POST' && req.url === '/api/logout') return handleLogout(req, res);
    if (req.method === 'GET' && req.url === '/api/me') return handleMe(req, res);
    if (req.method === 'POST' && req.url === '/api/waitlist') return await handleWaitlist(req, res);

    // --- App (requieren sesión) ---
    if (req.method === 'POST' && req.url === '/api/consulta') { if (!requireAuth(req, res)) return; return await handleConsulta(req, res); }
    if (req.method === 'POST' && req.url === '/api/redactar') { if (!requireAuth(req, res)) return; return await handleRedactar(req, res); }
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/fuentes') { if (!requireAuth(req, res)) return; return handleFuentes(req, res); }

    return await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

await buildIndex();
buildLexical();
server.listen(PORT, () => {
  console.log(`\n  Lexia ⚖️  IA jurídica open source`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  LLM: ${CHAT_MODEL} · Embeddings: ${EMBED_MODEL} · top-k: ${TOP_K}\n`);
});
