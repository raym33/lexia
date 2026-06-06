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

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const CORPUS_DIR = join(__dirname, 'corpus');
const CACHE_PATH = join(__dirname, 'data', 'embeddings.json');
const EMBED_BATCH = Number(process.env.EMBED_BATCH || 64);

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

// Embebe en lotes (para corpus grandes sin saturar al servidor de embeddings)
async function embedBatched(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    out.push(...(await embed(batch)));
    process.stdout.write(`\r  embeddings ${Math.min(i + EMBED_BATCH, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  return out;
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

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

// ---------------------------------------------------------------------------
// Índice: embebe el corpus una vez y lo cachea
// ---------------------------------------------------------------------------
let INDEX = []; // [{ ...doc, embedding }]

async function loadCorpus() {
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json')).sort();
  const docs = [];
  for (const f of files) {
    const arr = JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf-8'));
    docs.push(...arr);
  }
  return docs;
}

async function buildIndex() {
  const corpus = await loadCorpus();
  const sig = `${corpus.length}:${corpus[0]?.id}:${corpus[corpus.length - 1]?.id}`;

  if (existsSync(CACHE_PATH)) {
    const cache = JSON.parse(await readFile(CACHE_PATH, 'utf-8'));
    if (cache.model === EMBED_MODEL && cache.sig === sig) {
      INDEX = cache.docs;
      console.log(`✓ Índice cargado de caché (${INDEX.length} fragmentos)`);
      return;
    }
  }

  console.log(`Embebiendo corpus (${corpus.length} fragmentos) con ${EMBED_MODEL}…`);
  const inputs = corpus.map((d) => `${d.cita} — ${d.materia}\n${d.texto}`);
  const vectors = await embedBatched(inputs);
  INDEX = corpus.map((d, i) => ({ ...d, embedding: vectors[i] }));
  await writeFile(CACHE_PATH, JSON.stringify({ model: EMBED_MODEL, sig, docs: INDEX }));
  console.log(`✓ Índice construido y cacheado (${INDEX.length} fragmentos)`);
}

// ---------------------------------------------------------------------------
// Recuperación HÍBRIDA: léxica (BM25) + semántica (vectorial)
// En derecho los términos exactos importan tanto como el significado, así que
// combinamos ambas señales. Mejora drásticamente el recall en corpus grandes.
// ---------------------------------------------------------------------------
const STOP = new Set(('de la el en y a los las del que se un una por con no para es su al lo como mas o pero sus le ya este si porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno les ni contra otros ese eso ante ellos e esto entonces entre cual sea cualquier').split(' '));
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const tokenize = (s) => norm(s).match(/[a-z0-9ñ]{3,}/g)?.filter((t) => !STOP.has(t)) || [];

let LEX = null; // { df, idf, avgdl, docs: [{tf, len}] }
function buildLexical() {
  const df = new Map();
  const docs = INDEX.map((d) => {
    const toks = tokenize(`${d.cita} ${d.texto}`);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const N = docs.length;
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
  LEX = { idf, avgdl, docs };
  console.log(`✓ Índice léxico (BM25) construido (${idf.size} términos)`);
}

function bm25Scores(query) {
  const { idf, avgdl, docs } = LEX;
  const qt = [...new Set(tokenize(query))];
  const k1 = 1.5, b = 0.75;
  return docs.map((d) => {
    let s = 0;
    for (const t of qt) {
      const f = d.tf.get(t); if (!f) continue;
      const w = idf.get(t) || 0;
      s += w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.len / avgdl));
    }
    return s;
  });
}

const minmax = (arr) => {
  const mn = Math.min(...arr), mx = Math.max(...arr), r = mx - mn || 1;
  return arr.map((x) => (x - mn) / r);
};

async function retrieve(query, k = TOP_K) {
  const [qv] = await embed([query]);
  const vec = minmax(INDEX.map((d) => cosine(qv, d.embedding)));
  const lex = minmax(bm25Scores(query));
  return INDEX
    .map((d, i) => ({ doc: d, score: 0.5 * lex[i] + 0.5 * vec[i], _lex: lex[i], _vec: vec[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
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
  const fuentes = docs.slice(0, limit).map(({ embedding, ...meta }) => meta);
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
    if (req.method === 'POST' && req.url === '/api/consulta') return await handleConsulta(req, res);
    if (req.method === 'POST' && req.url === '/api/redactar') return await handleRedactar(req, res);
    if (req.method === 'GET' && req.url.split('?')[0] === '/api/fuentes') return handleFuentes(req, res);
    if (req.method === 'POST' && req.url === '/api/waitlist') return await handleWaitlist(req, res);
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
