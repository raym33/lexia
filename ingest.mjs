// Lexia — ingestor del BOE (datos abiertos), dirigido por catálogo, resumible.
// Objetivo: cubrir TODAS las leyes estatales (Ley, Ley Orgánica, Real Decreto
// Legislativo) del BOE consolidado, por lotes, sin rehacer lo ya ingerido.
//
// Uso:
//   node ingest.mjs --index           # (re)construye el catálogo de leyes
//   node ingest.mjs [--batch N]       # ingiere el siguiente lote (def. 100 leyes)
//   node ingest.mjs --all [--batch N] # sigue ingiriendo lotes hasta acabar
//
// Ficheros (todos en corpus/, regenerables, fuera de git):
//   _index_leyes.json   catálogo de leyes objetivo {id, abrev, num, titulo, rango}
//   _ingested.json      manifiesto de ids de leyes ya procesadas
//   boe.json            corpus de artículos acumulado (lo que consume el server)

import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const C = (f) => join(__dirname, 'corpus', f);
const API = 'https://www.boe.es/datosabiertos/api/legislacion-consolidada';

const RANGOS = { '1290': 'LO', '1300': 'Ley', '1310': 'RDLeg' }; // leyes objetivo
// Abreviaturas "bonitas" para los códigos más usados (por id del BOE)
const ABREV = {
  'BOE-A-1978-31229': 'CE', 'BOE-A-1889-4763': 'CC', 'BOE-A-2015-11430': 'ET',
  'BOE-A-1994-26003': 'LAU', 'BOE-A-2000-323': 'LEC', 'BOE-A-1995-25444': 'CP',
  'BOE-A-1885-6627': 'CCom', 'BOE-A-2003-23186': 'LGT', 'BOE-A-2015-11724': 'LGSS',
  'BOE-A-2015-10565': 'LPACAP', 'BOE-A-2015-10566': 'LRJSP', 'BOE-A-1998-16718': 'LJCA',
  'BOE-A-2011-15936': 'LRJS', 'BOE-A-1978-31229b': 'CE',
};

// Códigos fundamentales cuyo rango NO es Ley/LO/RDLeg (se perderían en el filtro).
// Se ingieren SIEMPRE y van primero.
const SEEDS = [
  { id: 'BOE-A-1978-31229', abrev: 'CE',   num: '', titulo: 'Constitución Española',  rango: 'Constitución' },
  { id: 'BOE-A-1889-4763',  abrev: 'CC',   num: '', titulo: 'Código Civil',           rango: 'Real Decreto' },
  { id: 'BOE-A-1885-6627',  abrev: 'CCom', num: '', titulo: 'Código de Comercio',      rango: 'Real Decreto' },
];

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const _bi = args.indexOf('--batch');
const BATCH = _bi >= 0 ? Number(args[_bi + 1]) : 100;

const jget = async (url) => {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
const xget = async (url) => {
  const r = await fetch(url, { headers: { Accept: 'application/xml' } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.text();
};
const readJSON = async (f, def) => (existsSync(C(f)) ? JSON.parse(await readFile(C(f), 'utf-8')) : def);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1) Catálogo de leyes
// ---------------------------------------------------------------------------
async function buildCatalogue() {
  const leyes = [];
  let off = 0, total = 0;
  for (;;) {
    const data = (await jget(`${API}?limit=500&offset=${off}`)).data;
    if (!data || !data.length) break;
    total += data.length;
    for (const i of data) {
      const rc = i.rango.codigo;
      if (RANGOS[rc] && i.vigencia_agotada !== 'S') {
        leyes.push({ id: i.identificador, abrev: RANGOS[rc], num: i.numero_oficial || '', titulo: i.titulo, rango: i.rango.texto });
      }
    }
    off += 500;
    process.stdout.write(`\r  catálogo: ${off} normas, ${leyes.length} leyes vigentes`);
    await sleep(250);
  }
  await writeFile(C('_index_leyes.json'), JSON.stringify(leyes, null, 0));
  console.log(`\n✓ Catálogo: ${leyes.length} leyes (de ${total} normas) → corpus/_index_leyes.json`);
  return leyes;
}

// ---------------------------------------------------------------------------
// 2) Parseo de una ley a artículos
// ---------------------------------------------------------------------------
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENT[m])
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
const strip = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

function etiqueta(ley) {
  if (ABREV[ley.id]) return ABREV[ley.id];
  if (ley.num) return `${ley.abrev} ${ley.num}`;
  return ley.titulo.slice(0, 40);
}

const LEVELS = { parte: 0, libro: 1, titulo: 2, capitulo: 3, seccion: 4, subseccion: 5 };

function parseLaw(xml, ley) {
  const et = etiqueta(ley);
  const out = [];
  const stack = {}; // nivel -> rúbrica vigente (jerarquía: Libro > Título > Capítulo > Sección…)
  // Iteramos TODOS los bloques en orden para arrastrar la jerarquía de rúbricas.
  const re = /<bloque id="([^"]*)" tipo="([^"]*)"(?: titulo="([^"]*)")?>([\s\S]*?)<\/bloque>/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, bid, tipo, titulo, body] = m;
    const vers = [...body.matchAll(/<version\b[^>]*>([\s\S]*?)<\/version>/g)];
    const ver = vers.length ? vers[vers.length - 1][1] : body;
    const paras = [...ver.matchAll(/<p class="([^"]*)">([\s\S]*?)<\/p>/g)];

    if (tipo === 'encabezado') {
      // Detecta nivel y rúbrica (clases libro_tit, titulo_tit, capitulo_tit, seccion_tit…)
      let level = null, num = '', tit = '';
      for (const [, cls, raw] of paras) {
        const mm = cls.match(/^(parte|libro|titulo|capitulo|seccion|subseccion)_(num|tit)$/);
        if (!mm) continue;
        const t = strip(raw); if (!t) continue;
        level = mm[1];
        if (mm[2] === 'tit') tit = t; else num = t;
      }
      if (level != null) {
        const lv = LEVELS[level];
        stack[lv] = tit || num;
        for (const k of Object.keys(stack)) if (+k > lv) delete stack[k];
      }
      continue;
    }
    if (tipo !== 'precepto') continue;

    let articulo = ''; const parts = [];
    for (const [, cls, raw] of paras) {
      const t = strip(raw); if (!t) continue;
      if (cls === 'articulo') articulo = t; else parts.push(t);
    }
    const texto = parts.join('\n');
    if (!texto || /\(suprimid|\(derogad/i.test(texto)) continue;
    const lab = (titulo || articulo).replace(/\.$/, '').trim();
    const num = lab.replace(/^art(?:[íi]culo)?\b\.?\s*/i, '').trim();
    const cita = /^\d/.test(num) ? `Art. ${num} ${et}` : `${lab} ${et}`;
    const contexto = Object.keys(stack).sort((a, b) => a - b).map((k) => stack[k]).join(' · ');
    out.push({
      id: `${ley.id}#${bid}`,
      fuente: ley.titulo,
      cita,
      rango: ley.rango,
      materia: et,
      contexto,                  // rúbricas de Libro/Título/Capítulo/Sección (mejora la búsqueda léxica)
      url: `https://www.boe.es/buscar/act.php?id=${ley.id}`,
      texto: texto.slice(0, 3000),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3) Ingesta por lotes (resumible)
// ---------------------------------------------------------------------------
async function ingestBatch() {
  let index = await readJSON('_index_leyes.json', null);
  if (!index) index = await buildCatalogue();
  // Semillas primero, sin duplicar las que ya estén en el catálogo
  const ids = new Set(index.map((l) => l.id));
  index = [...SEEDS.filter((s) => !ids.has(s.id)), ...index];
  const done = new Set(await readJSON('_ingested.json', []));
  const corpus = await readJSON('boe.json', []);

  const pending = index.filter((l) => !done.has(l.id));
  if (!pending.length) { console.log(`✓ Nada pendiente: ${done.size}/${index.length} leyes ya ingeridas, ${corpus.length} artículos.`); return false; }

  const lote = pending.slice(0, BATCH);
  console.log(`Ingiriendo lote de ${lote.length} leyes (pendientes: ${pending.length}, hechas: ${done.size}/${index.length})`);
  let added = 0, fail = 0;
  for (const ley of lote) {
    try {
      const xml = await xget(`${API}/id/${ley.id}/texto`);
      const arts = parseLaw(xml, ley);
      corpus.push(...arts); added += arts.length;
    } catch (e) { fail++; }
    done.add(ley.id);
    await sleep(150);
  }
  await writeFile(C('boe.json'), JSON.stringify(corpus));
  await writeFile(C('_ingested.json'), JSON.stringify([...done]));
  console.log(`✓ Lote hecho: +${added} artículos (${fail} leyes fallidas). Total: ${corpus.length} artículos, ${done.size}/${index.length} leyes.`);
  return pending.length > lote.length; // ¿queda más?
}

// ---------------------------------------------------------------------------
if (flag('--index')) {
  await buildCatalogue();
} else if (flag('--all')) {
  let more = true;
  while (more) more = await ingestBatch();
  console.log('✓ Ingesta completa.');
} else {
  await ingestBatch();
}
