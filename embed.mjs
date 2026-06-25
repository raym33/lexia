// Lexia — embedder masivo a store BINARIO (float32), resumible y consistente.
// El JSON no escala. El store binario ocupa aprox. docs × dimension × 4 bytes.
//
// Store (en data/):
//   embeddings.bin        float32 contiguos, fila i = ids[i], DIM floats
//   embeddings.ids.txt    un id de fragmento por línea (append-only, en lockstep con .bin)
//   embeddings.meta.json  { model, dim }
//
// Consistencia: .bin e .ids.txt se anexan EN EL MISMO PASO cada lote. Al reanudar,
// si difieren (corte a media escritura) se recortan al mínimo común. Así nunca se
// desalinean fila<->id.
//
// Uso:  node embed.mjs [--batch N]   (def. 96). Resumible: continúa por donde iba.

import { readFile, writeFile, readdir, appendFile, stat, truncate } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './config.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const CORPUS_DIR = join(__dirname, 'corpus');
const BIN = join(__dirname, 'data', 'embeddings.bin');
const IDS = join(__dirname, 'data', 'embeddings.ids.txt');
const META = join(__dirname, 'data', 'embeddings.meta.json');

const LM_BASE = process.env.LM_BASE || 'http://127.0.0.1:1234/v1';
const EMBED_BASE = process.env.EMBED_BASE || LM_BASE;
const EMBED_MODEL = process.env.EMBED_MODEL || 'bge-m3';
const args = process.argv.slice(2);
const bi = args.indexOf('--batch');
const BATCH = bi >= 0 ? Number(args[bi + 1]) : 96;

async function embed(texts) {
  const r = await fetch(`${EMBED_BASE}/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`embeddings ${r.status}: ${await r.text()}`);
  return (await r.json()).data.map((d) => d.embedding);
}

async function loadCorpus() {
  const files = (await readdir(CORPUS_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_')).sort();
  const docs = [];
  for (const f of files) { for (const d of JSON.parse(await readFile(join(CORPUS_DIR, f), 'utf-8'))) docs.push(d); }
  return docs;
}

const corpus = await loadCorpus();

// Estado previo
let dim = 0;
if (existsSync(META)) { const m = JSON.parse(await readFile(META, 'utf-8')); if (m.model === EMBED_MODEL) dim = m.dim; }
let ids = existsSync(IDS) ? (await readFile(IDS, 'utf-8')).split('\n').filter(Boolean) : [];

// Realineado .bin <-> .ids tras un corte
if (dim && existsSync(BIN)) {
  const binRows = Math.floor((await stat(BIN)).size / (dim * 4));
  if (binRows < ids.length) { ids = ids.slice(0, binRows); await writeFile(IDS, ids.length ? ids.join('\n') + '\n' : ''); }
  else if (binRows > ids.length) { await truncate(BIN, ids.length * dim * 4); }
}

const done = new Set(ids);
const pending = corpus.filter((d) => !done.has(d.id));
console.log(`Corpus ${corpus.length} · ya embebidos ${ids.length} · pendientes ${pending.length}`);
if (!pending.length) { console.log('✓ Nada que embeber.'); process.exit(0); }

for (let i = 0; i < pending.length; i += BATCH) {
  const batch = pending.slice(i, i + BATCH);
  let vecs;
  try {
    vecs = await embed(batch.map((d) => `${d.cita} — ${d.materia}\n${d.texto}`));
  } catch (e) {
    console.error(`\n⚠ fallo lote ${i}: ${e.message}. Reintento en 3s…`);
    await new Promise((r) => setTimeout(r, 3000)); i -= BATCH; continue;
  }
  if (!dim) { dim = vecs[0].length; await writeFile(META, JSON.stringify({ model: EMBED_MODEL, dim })); }
  const flat = new Float32Array(batch.length * dim);
  vecs.forEach((v, k) => flat.set(v, k * dim));
  // Lockstep: primero el binario, luego los ids
  await appendFile(BIN, Buffer.from(flat.buffer));
  await appendFile(IDS, batch.map((d) => d.id).join('\n') + '\n');
  process.stdout.write(`\r  embebidos ${Math.min(i + BATCH, pending.length)}/${pending.length}`);
}
console.log(`\n✓ Store binario completo: ${done.size + pending.length} vectores, dim ${dim}.`);
