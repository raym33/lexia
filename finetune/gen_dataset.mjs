// Lexia — generador de dataset para fine-tuning del embedder.
// Para una muestra de artículos, un LLM genera preguntas en lenguaje natural cuya
// respuesta es ese artículo; se minan negativos difíciles con el buscador de Lexia.
// Salida: finetune/data/train.jsonl  {"query","pos":[...],"neg":[...]}  (formato FlagEmbedding)
//
// Requisitos: LM Studio en :1234 y el servidor Lexia en :5174 (para negativos).
// Uso:  node finetune/gen_dataset.mjs --n 3000 --per 3
//   env: GEN_MODEL (def. gemma-3-12b-it), BASE, EVAL_EMAIL, EVAL_PASS

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../config.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS = join(__dirname, '..', 'corpus', 'boe.json');
const OUT = join(__dirname, 'data', 'train.jsonl');
const DONE = join(__dirname, 'data', '_done_ids.json');

const LM = process.env.LM_BASE || 'http://127.0.0.1:1234/v1';
const GEN_MODEL = process.env.GEN_MODEL || 'gemma-3-12b-it';
const BASE = process.env.BASE || 'http://localhost:5174';
const EMAIL = process.env.EVAL_EMAIL || 'eval@lexia.local';
const PASS = process.env.EVAL_PASS || 'contrasena123';
const args = process.argv.slice(2);
const argN = (f, d) => { const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1]) : d; };
const N = argN('--n', 2000);
const PER = argN('--per', 3);

const GEN_SYS = `Eres un jurista español. Te doy un artículo de una norma. Genera ${PER} PREGUNTAS distintas que alguien haría a un buscador legal y cuya respuesta sea ESE artículo.
REGLAS:
- Pregunta por el TEMA/situación real, como quien NO conoce el artículo.
- PROHIBIDO referirse a "este artículo", "este texto", "la norma" o citar su número.
- Varía el registro: alguna de ciudadano lego (coloquial) y alguna técnica de abogado.
- Cortas y directas.
Devuelve SOLO las preguntas, una por línea, sin numerar.`;

async function genQuestions(doc) {
  const r = await fetch(`${LM}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: GEN_MODEL, temperature: 0.4, max_tokens: 200,
      messages: [{ role: 'system', content: GEN_SYS },
        { role: 'user', content: `${doc.cita} — ${doc.contexto || ''}\n${doc.texto}` }],
    }),
  });
  if (!r.ok) throw new Error(`gen ${r.status}`);
  const txt = (await r.json()).choices[0].message.content;
  return txt.split('\n').map((l) => l.replace(/^[\s\d\.\-)·]+/, '').trim()).filter((l) => l.length > 10).slice(0, PER);
}

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!r.ok) throw new Error(`login ${r.status}: crea la cuenta o ajusta EVAL_EMAIL/EVAL_PASS`);
  return (r.headers.get('set-cookie') || '').split(';')[0];
}

async function hardNegs(query, cookie, posCita, byCita) {
  try {
    const r = await fetch(`${BASE}/api/buscar`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ query, k: 12 }),
    });
    const { fuentes = [] } = await r.json();
    const negs = [];
    for (const f of fuentes) {
      if (f.cita === posCita) continue;
      const d = byCita.get(f.cita);
      if (d) negs.push(`${d.cita}. ${d.texto.slice(0, 500)}`);
      if (negs.length >= 5) break;
    }
    return negs;
  } catch { return []; }
}

// ---------------------------------------------------------------------------
const corpus = JSON.parse(await readFile(CORPUS, 'utf-8'));
const byCita = new Map(corpus.map((d) => [d.cita, d]));
if (!existsSync(join(__dirname, 'data'))) await mkdir(join(__dirname, 'data'), { recursive: true });
const done = new Set(existsSync(DONE) ? JSON.parse(await readFile(DONE, 'utf-8')) : []);

// Muestra: artículos sustantivos (texto suficiente), barajados, deterministas por seed simple
const pool = corpus.filter((d) => d.texto && d.texto.length > 140 && !done.has(d.id));
for (let i = pool.length - 1; i > 0; i--) { const j = (i * 2654435761) % (i + 1); [pool[i], pool[j]] = [pool[j], pool[i]]; }
const sample = pool.slice(0, N);

const cookie = await login();
console.log(`Generando dataset: ${sample.length} artículos × ${PER} preguntas (hechos: ${done.size})`);
let pairs = 0, fail = 0;
for (let i = 0; i < sample.length; i++) {
  const doc = sample[i];
  try {
    const qs = await genQuestions(doc);
    const posText = `${doc.cita}. ${doc.texto.slice(0, 800)}`;
    for (const q of qs) {
      const neg = await hardNegs(q, cookie, doc.cita, byCita);
      await appendFile(OUT, JSON.stringify({ query: q, pos: [posText], neg }) + '\n');
      pairs++;
    }
  } catch (e) { fail++; }
  done.add(doc.id);
  if (i % 25 === 0 || i === sample.length - 1) {
    await writeFile(DONE, JSON.stringify([...done]));
    process.stdout.write(`\r  ${i + 1}/${sample.length} artículos · ${pairs} pares · ${fail} fallos`);
  }
}
await writeFile(DONE, JSON.stringify([...done]));
console.log(`\n✓ Dataset: ${pairs} pares en finetune/data/train.jsonl`);
