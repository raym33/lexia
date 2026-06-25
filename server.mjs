// Lexia — IA jurídico-administrativa open source para España.
// MVP: RAG sobre legislación con citas verificables.
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
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './config.mjs';
import { register, login, currentUser, signSession, sessionCookie, clearCookie } from './auth.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CORPUS_DIR = join(__dirname, 'corpus');
const BIN_PATH = join(__dirname, 'data', 'embeddings.bin');
const IDS_PATH = join(__dirname, 'data', 'embeddings.ids.txt');
const META_PATH = join(__dirname, 'data', 'embeddings.meta.json');

const PORT = process.env.PORT || 5174;
const LM_BASE = process.env.LM_BASE || 'http://127.0.0.1:1234/v1';
const EMBED_BASE = process.env.EMBED_BASE || LM_BASE;  // embedder afinado (:1236) si se indica; chat sigue en LM_BASE
const CHAT_MODEL = process.env.CHAT_MODEL || 'gemma-3-12b-it';
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
// Modelo rápido para expansión de consulta y reranking (puente lego->legal + precisión)
const FAST_MODEL = process.env.FAST_MODEL || 'qwen3-8b-instruct';
const TOP_K = Number(process.env.TOP_K || 6);
const RECALL_N = Number(process.env.RECALL_N || 40); // candidatos antes de rerank
// Reranker cross-encoder determinista (llama.cpp server con --reranking). Sustituye
// al reranker-LLM (que tenía ruido). Endpoint /v1/rerank.
const RERANK_URL = process.env.RERANK_URL || 'http://127.0.0.1:1235/v1/rerank';
// Por defecto ON con bge-m3: con buen embedder los candidatos mejoran y el
// rerank/expansión SUMAN en evaluación amplia (50 consultas: Hit@8 41->44, Hit@3 33->35).
// Desactivables con USE_EXPAND=0 / USE_RERANK=0 (p.ej. para latencia mínima).
// Expansión OFF por defecto: con bge-m3 la expansión LLM degradaba el recall
// (metía términos amplios que enterraban el artículo correcto). Rerank ON.
const USE_EXPAND = process.env.USE_EXPAND === '1';
const USE_RERANK = process.env.USE_RERANK !== '0';
const AGENT_TOKEN = process.env.LEXIA_AGENT_TOKEN || '';

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
  const res = await fetch(`${EMBED_BASE}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data.map((d) => d.embedding);
}

async function chat(messages, { temperature = 0.1, model = CHAT_MODEL, max_tokens } = {}) {
  const res = await fetch(`${LM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature, stream: false, ...(max_tokens ? { max_tokens } : {}) }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.choices[0].message.content;
}

// Expansión de consulta: traduce el lenguaje del usuario a la terminología jurídica
// con la que se redacta la ley (mejora el recall del BM25). Devuelve palabras clave.
const EXPAND_SYS = `Eres un jurista español. Reescribe la consulta añadiendo los TÉRMINOS JURÍDICOS y sinónimos legales con los que la ley española realmente se redacta (sustantivos clave y verbos del articulado). Devuelve SOLO una línea de palabras clave separadas por espacios, sin explicaciones ni puntuación.`;
async function expandQuery(query) {
  try {
    const out = await chat(
      [{ role: 'system', content: EXPAND_SYS }, { role: 'user', content: query }],
      { model: FAST_MODEL, temperature: 0, max_tokens: 80 },
    );
    return out.replace(/\n/g, ' ').slice(0, 300);
  } catch { return ''; }
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
// Stemmer ligero ES: normaliza plurales y algunas flexiones para mejorar el recall
// (p. ej. "hurtos"->"hurto", "muebles"->"mueble", "ajenas"->"ajena", "acciones"->"accion").
function stem(t) {
  if (t.length > 6 && t.endsWith('ciones')) return t.slice(0, -5) + 'on';
  if (t.length > 5 && (t.endsWith('es') && /[lrndj]es$/.test(t))) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}
// Equivalencias jurídicas deterministas: puente entre el lenguaje del usuario y el de
// la ley, SIN el ruido de la expansión LLM. Se aplican igual a índice y consulta, así
// que cualquier variante casa con la otra (p. ej. "compraventa" <-> "compra y venta").
const SYN = {
  compraventa: ['compra', 'venta'],
  nulidad: ['nulo'], nulo: ['nulidad'],
  mayoria: ['mayor'],
  arrendamiento: ['alquiler'], alquiler: ['arrendamiento'],
  arrendatario: ['inquilino'], inquilino: ['arrendatario'],
  desistimiento: ['desistir'], desistir: ['desistimiento'],
  apropiacion: ['apropiar', 'apropiaren'],
  // Nombres doctrinales que NO aparecen literalmente en el articulado (van en la
  // rúbrica/margen): se mapean a las palabras con que la ley realmente los redacta.
  disciplinario: ['incumplimiento', 'culpable'],   // despido disciplinario -> Art. 54 ET
  eximente: ['exento'], eximentes: ['exento'],      // eximentes -> "exentos de responsabilidad" (Art. 20 CP)
};
const tokenize = (s) => {
  const base = (norm(s).match(/[a-z0-9ñ]{3,}/g) || []).filter((t) => !STOP.has(t)).map(stem);
  const out = [];
  for (const t of base) { out.push(t); if (Object.hasOwn(SYN, t)) for (const e of SYN[t]) out.push(e); }
  return out;
};

let LEX = null; // { inv: Map(term -> [docIdx, tf, ...]), idf, len: Float64Array, avgdl }
function buildLexical() {
  const N = INDEX.length;
  if (!N) { LEX = null; return; }
  const inv = new Map();
  const df = new Map();
  const len = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const toks = tokenize(`${INDEX[i].cita} ${INDEX[i].contexto || ''} ${INDEX[i].texto}`);
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
  buildAuthority();
  console.log(`✓ BM25 (índice invertido): ${idf.size} términos`);
}

// Peso de AUTORIDAD por fuente: con 4.000+ leyes, los códigos fundamentales y los
// artículos sustantivos deben pesar más que normas menores/forales y que
// disposiciones (transitorias, adicionales, "bases"…). Mitiga que lo canónico
// quede sepultado.
const CANON = new Set([
  'CE', 'CC', 'CP', 'CCom', 'ET', 'LEC', 'LAU', 'LGT', 'LGSS', 'LPACAP', 'LRJSP', 'LJCA', 'LRJS',
  'LO 3/2018',     // Protección de datos (LOPDGDD)
  'RDLeg 1/2007',  // Defensa de consumidores y usuarios (TRLGDCU)
]);
let AUTH = null;
function buildAuthority() {
  AUTH = new Float64Array(INDEX.length);
  for (let i = 0; i < INDEX.length; i++) {
    const d = INDEX[i];
    let w = 1;
    if (CANON.has(d.materia)) w *= 1.8;                       // códigos fundamentales
    else if (d.rango === 'Ley Orgánica') w *= 1.15;
    else if (d.rango === 'Real Decreto Legislativo') w *= 1.1;
    w *= /^Art\.\s*\d/.test(d.cita) ? 1.2 : 0.6;             // artículo numerado vs disposición/base/foral
    AUTH[i] = w;
  }
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

async function retrieve(query, k = TOP_K, lexExtra = '', reserveCanon = false) {
  if (!INDEX.length) return [];
  const [qv] = await embed([query]);             // vector: consulta original (semántica limpia)
  const lexQuery = lexExtra ? `${query} ${lexExtra}` : query; // léxico: + expansión jurídica
  const n = INDEX.length;
  // Vectorial: coseno sobre todo el índice
  const vraw = new Float64Array(n);
  let vmn = Infinity, vmx = -Infinity;
  for (let i = 0; i < n; i++) { const v = cosineRow(qv, INDEX[i].row); vraw[i] = v; if (v < vmn) vmn = v; if (v > vmx) vmx = v; }
  const vr = (vmx - vmn) || 1;
  // Léxico: BM25 disperso
  const bm = bm25Map(lexQuery);
  let bmx = 0; for (const v of bm.values()) if (v > bmx) bmx = v; bmx = bmx || 1;
  // Combinación 50/50 normalizada
  const scored = new Array(n);
  for (let i = 0; i < n; i++) {
    const vN = (vraw[i] - vmn) / vr;
    const lN = (bm.get(i) || 0) / bmx;
    scored[i] = { doc: INDEX[i], score: (0.62 * lN + 0.38 * vN) * (AUTH ? AUTH[i] : 1) };
  }
  scored.sort((a, b) => b.score - a.score);
  const general = scored.slice(0, k);
  // Reserva de plazas para fuentes canónicas: garantiza que los mejores artículos de
  // códigos/CE entren al pool del reranker aunque el ruido sectorial los baje (mejora
  // el recall de artículos fundamentales como 24 CE, 20 CP, 54 ET).
  if (reserveCanon) {
    const have = new Set(general.map((s) => s.doc.id));
    const canon = scored.filter((s) => CANON.has(s.doc.materia) && !have.has(s.doc.id)).slice(0, 15);
    return [...general, ...canon];
  }
  return general;
}

// Re-ranker: un LLM jurista reordena los candidatos por relevancia real a la consulta.
// Corrige los casos "el artículo correcto estaba, pero mal posicionado".
const RERANK_SYS = `Eres un jurista español experto. Te doy una CONSULTA y una lista numerada de artículos candidatos. Ordena los que responden de forma MÁS DIRECTA y precisa, priorizando el artículo que REGULA O DEFINE la institución jurídica concreta por la que se pregunta (la regla general de la materia), por encima de artículos que solo la mencionan de pasada. Devuelve SOLO los números, del más relevante al menos, separados por comas (máximo 8). Sin explicaciones.`;
async function rerankLLM(query, hits, k = TOP_K) {
  if (hits.length <= 1) return hits.slice(0, k);
  const list = hits.map((h, i) => {
    const ctx = h.doc.contexto ? ` (${h.doc.contexto})` : '';
    return `[${i + 1}] ${h.doc.cita}${ctx}: ${h.doc.texto.slice(0, 300).replace(/\n/g, ' ')}`;
  }).join('\n');
  let out;
  try {
    out = await chat(
      [{ role: 'system', content: RERANK_SYS }, { role: 'user', content: `CONSULTA: ${query}\n\nCANDIDATOS:\n${list}` }],
      { model: FAST_MODEL, temperature: 0, max_tokens: 60 },
    );
  } catch { return hits.slice(0, k); }
  const order = (out.match(/\d+/g) || []).map(Number).filter((x) => x >= 1 && x <= hits.length);
  const seen = new Set(); const ranked = [];
  for (const idx of order) if (!seen.has(idx)) { seen.add(idx); ranked.push(hits[idx - 1]); }
  hits.forEach((h, i) => { if (!seen.has(i + 1)) ranked.push(h); }); // no mencionados, al final
  return ranked.slice(0, k);
}

// Reranker cross-encoder DETERMINISTA (bge-reranker-v2-m3 vía llama.cpp).
// Juzga query+documento conjuntamente; mucho más preciso y sin ruido que el LLM-juez.
async function rerankCE(query, hits, k = TOP_K) {
  const documents = hits.map((h) => `${h.doc.cita}. ${h.doc.contexto || ''}. ${h.doc.texto.slice(0, 500)}`);
  let results;
  try {
    const r = await fetch(RERANK_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, documents }),
    });
    if (!r.ok) throw new Error(`rerank ${r.status}`);
    results = (await r.json()).results;
  } catch (e) {
    console.error(`rerank fallo (${e.message}); uso orden híbrido`);
    return hits.slice(0, k);
  }
  // ENSEMBLE: combina cross-encoder + puntuación HÍBRIDA + bonus de autoridad.
  // No dejes que el cross-encoder mande solo: a veces degrada aciertos que el híbrido
  // clava (24 CE, 28 CE, 379 CP estaban en el puesto 1 del híbrido). El bonus prioriza
  // el artículo fundamental (CE/códigos) sobre leyes sectoriales.
  const ce = new Float64Array(hits.length).fill(-Infinity);
  for (const r of results) ce[r.index] = r.relevance_score;
  const finite = [...ce].filter((x) => Number.isFinite(x));
  const cmin = Math.min(...finite), cmax = Math.max(...finite), cr = (cmax - cmin) || 1;
  const hy = hits.map((h) => h.score);
  const hmin = Math.min(...hy), hmax = Math.max(...hy), hr = (hmax - hmin) || 1;
  const authBonus = (d) => (CANON.has(d.materia) ? 0.25 : d.rango === 'Ley Orgánica' ? 0.05 : 0);
  const ranked = hits.map((h, i) => {
    const ceN = Number.isFinite(ce[i]) ? (ce[i] - cmin) / cr : 0;
    const hyN = (h.score - hmin) / hr;
    return { h, s: 0.65 * ceN + 0.35 * hyN + authBonus(h.doc) };
  });
  ranked.sort((a, b) => b.s - a.s);
  return ranked.map((r) => r.h).slice(0, k);
}

// Pipeline de búsqueda: expansión léxica -> recuperación amplia -> rerank cross-encoder.
async function search(query, k = TOP_K) {
  const ext = USE_EXPAND ? await expandQuery(query) : '';
  let hits = await retrieve(query, USE_RERANK ? RECALL_N : k, ext, USE_RERANK);
  if (USE_RERANK && hits.length) hits = await rerankCE(query, hits, k);
  return hits;
}

// ---------------------------------------------------------------------------
// Prompt jurídico: obliga a citar y prohíbe inventar
// ---------------------------------------------------------------------------
function buildMessages(query, hits) {
  const contexto = hits
    .map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente}) — ${h.doc.materia}\n${h.doc.texto}`)
    .join('\n\n');

  const system = `Eres Lexia, un asistente jurídico-administrativo para España. Respondes en español, con rigor técnico-jurídico y tono profesional.

REGLAS INNEGOCIABLES:
1. Responde ÚNICAMENTE con la información contenida en las FUENTES proporcionadas. No uses conocimiento externo ni inventes artículos, números o sentencias.
2. Cada afirmación jurídica debe ir acompañada de su cita entre corchetes, p. ej. [1], [2], según el número de la fuente usada.
3. Si las fuentes no contienen información suficiente para responder, dilo claramente: "Las fuentes disponibles no permiten responder con seguridad" y sugiere qué norma habría que consultar. NUNCA rellenes el hueco inventando.
4. No des asesoramiento que sustituya el criterio del abogado, funcionario o profesional responsable: aporta la base normativa y deja la decisión al profesional.
5. Sé conciso y estructurado. Si procede, distingue régimen general y excepciones.`;

  const user = `FUENTES:\n${contexto}\n\nCONSULTA DEL PROFESIONAL:\n${query}\n\nResponde citando las fuentes con [n].`;

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
  const hits = await search(query);
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

function sourcePayload(h, i, { includeText = false } = {}) {
  const out = {
    n: i + 1,
    id: h.doc.id,
    cita: h.doc.cita,
    fuente: h.doc.fuente,
    materia: h.doc.materia,
    rango: h.doc.rango,
    url: h.doc.url,
    score: Number(h.score.toFixed(3)),
  };
  if (h.doc.contexto) out.contexto = h.doc.contexto;
  if (includeText) out.texto = h.doc.texto;
  return out;
}

function clientIsLocal(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

function requireAgent(req, res) {
  if (!AGENT_TOKEN) {
    if (clientIsLocal(req)) return true;
    json(res, 403, { error: 'LEXIA_AGENT_TOKEN no configurado; solo se aceptan llamadas localhost' });
    return false;
  }
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const token = bearer || req.headers['x-lexia-token'] || '';
  if (token === AGENT_TOKEN) return true;
  json(res, 401, { error: 'Token de agente inválido' });
  return false;
}

function handleAgentHealth(req, res) {
  json(res, 200, {
    ok: true,
    index: INDEX.length,
    dim: DIM,
    chat_model: CHAT_MODEL,
    embed_model: EMBED_MODEL,
    top_k: TOP_K,
    rerank: USE_RERANK,
    expand: USE_EXPAND,
  });
}

async function handleAgentRetrieve(req, res) {
  const { query, k, include_text = true } = await readBody(req);
  if (!query || !query.trim()) return json(res, 400, { error: 'Falta la consulta' });
  const t0 = Date.now();
  const hits = await search(query, Math.min(Number(k) || TOP_K, 20));
  json(res, 200, {
    query,
    sources: hits.map((h, i) => sourcePayload(h, i, { includeText: include_text !== false })),
    ms: Date.now() - t0,
  });
}

async function handleAgentAnswer(req, res) {
  const { query, k } = await readBody(req);
  if (!query || !query.trim()) return json(res, 400, { error: 'Falta la consulta' });
  const t0 = Date.now();
  const hits = await search(query, Math.min(Number(k) || TOP_K, 12));
  const answer = await chat(buildMessages(query, hits));
  json(res, 200, {
    query,
    answer,
    sources: hits.map((h, i) => sourcePayload(h, i, { includeText: true })),
    ms: Date.now() - t0,
    model: CHAT_MODEL,
  });
}

// Búsqueda sin LLM: solo recuperación (rápida). Útil para la UI y para evaluar.
async function handleBuscar(req, res) {
  const { query, k } = await readBody(req);
  if (!query || !query.trim()) return json(res, 400, { error: 'Falta la consulta' });
  const t0 = Date.now();
  const hits = await search(query, Math.min(Number(k) || TOP_K, 20));
  const fuentes = hits.map((h, i) => ({
    n: i + 1, cita: h.doc.cita, fuente: h.doc.fuente, materia: h.doc.materia,
    rango: h.doc.rango, url: h.doc.url, score: Number(h.score.toFixed(3)),
  }));
  json(res, 200, { fuentes, ms: Date.now() - t0 });
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

// ---------------------------------------------------------------------------
// Autenticación (cuentas de organizaciones)
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
  json(res, 200, { user: { id: u.id, email: u.email, organizacion: u.organizacion, role: u.role } });
}

// Guard: exige sesión válida; si no, 401.
function requireAuth(req, res) {
  const u = currentUser(req);
  if (!u) { json(res, 401, { error: 'Inicia sesión para usar Lexia' }); return null; }
  return u;
}

const TIPOS_ESCRITO = {
  resolucion: 'Resolución administrativa',
  informe_admin: 'Informe jurídico-administrativo',
  subsanacion: 'Requerimiento de subsanación',
  contratacion: 'Nota sobre contratación pública',
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
  const hits = await search(`${tipoNombre}. ${hechos} ${instrucciones}`, TOP_K);
  const contexto = hits
    .map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente})\n${h.doc.texto}`)
    .join('\n\n');

  const system = `Eres Lexia, un asistente de redacción jurídico-administrativa para España. Generas borradores profesionales en español jurídico formal para revisión por abogados, funcionarios o equipos jurídico-administrativos.

REGLAS:
1. Redacta un BORRADOR del documento solicitado, listo para que el profesional responsable lo revise y adapte.
2. Apóyate en la normativa de las FUENTES y cita los preceptos relevantes con [n] en el cuerpo del texto.
3. No inventes artículos, números ni jurisprudencia que no estén en las FUENTES. Si falta una base legal, indícalo con un marcador entre llaves, p. ej. {{verificar precepto aplicable}}.
4. Usa marcadores entre llaves para los datos que el profesional debe completar, p. ej. {{órgano}}, {{número de expediente}}, {{interesado}}, {{cuantía}}.
5. Estructura el documento según los usos forenses (encabezamiento, hechos, fundamentos de derecho, súplico/petición, fecha y firma) cuando proceda.
6. Es un borrador asistido; el criterio, la competencia y la responsabilidad final son del profesional u órgano responsable.`;

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

async function handleAgentDraft(req, res) {
  const { tipo = 'escrito', hechos = '', instrucciones = '', k } = await readBody(req);
  if (!hechos.trim()) return json(res, 400, { error: 'Faltan los hechos / contexto' });
  const t0 = Date.now();
  const tipoNombre = TIPOS_ESCRITO[tipo] || tipo;
  const hits = await search(`${tipoNombre}. ${hechos} ${instrucciones}`, Math.min(Number(k) || TOP_K, 12));
  const contexto = hits
    .map((h, i) => `[${i + 1}] ${h.doc.cita} (${h.doc.fuente})\n${h.doc.texto}`)
    .join('\n\n');
  const system = `Eres Lexia, un asistente de redacción jurídico-administrativa para España. Generas borradores profesionales en español jurídico formal. Usa solo las FUENTES, cita con [n], no inventes preceptos y marca datos pendientes con {{marcador}}.`;
  const user = `FUENTES NORMATIVAS:\n${contexto}\n\nTIPO DE DOCUMENTO: ${tipoNombre}\n\nHECHOS / CONTEXTO:\n${hechos}\n\nINSTRUCCIONES ADICIONALES:\n${instrucciones || '(ninguna)'}\n\nRedacta el borrador citando las fuentes con [n].`;
  const draft = await chat([{ role: 'system', content: system }, { role: 'user', content: user }], { temperature: 0.2 });
  json(res, 200, {
    tipo: tipoNombre,
    draft,
    sources: hits.map((h, i) => sourcePayload(h, i, { includeText: true })),
    ms: Date.now() - t0,
    model: CHAT_MODEL,
  });
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

    // --- Agent OS API (Bearer LEXIA_AGENT_TOKEN, o localhost si no se configura) ---
    if (req.method === 'GET' && req.url === '/api/agent/health') { if (!requireAgent(req, res)) return; return handleAgentHealth(req, res); }
    if (req.method === 'POST' && req.url === '/api/agent/retrieve') { if (!requireAgent(req, res)) return; return await handleAgentRetrieve(req, res); }
    if (req.method === 'POST' && req.url === '/api/agent/answer') { if (!requireAgent(req, res)) return; return await handleAgentAnswer(req, res); }
    if (req.method === 'POST' && req.url === '/api/agent/draft') { if (!requireAgent(req, res)) return; return await handleAgentDraft(req, res); }

    // --- App (requieren sesión) ---
    if (req.method === 'POST' && req.url === '/api/consulta') { if (!requireAuth(req, res)) return; return await handleConsulta(req, res); }
    if (req.method === 'POST' && req.url === '/api/buscar') { if (!requireAuth(req, res)) return; return await handleBuscar(req, res); }
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
  console.log(`\n  Lexia ⚖️  IA jurídico-administrativa open source`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  LLM: ${CHAT_MODEL} · Embeddings: ${EMBED_MODEL} · top-k: ${TOP_K}\n`);
});
