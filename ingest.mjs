// Lexia — ingestor del BOE (datos abiertos)
// Descarga el texto CONSOLIDADO de leyes españolas desde la API de datos abiertos
// del BOE y lo trocea por artículos en corpus/boe.json (un fragmento por artículo,
// con su cita y enlace a la fuente oficial).
//
// Uso:  node ingest.mjs
// API:  https://www.boe.es/datosabiertos/api/legislacion-consolidada/id/{id}/texto

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(__dirname, 'corpus', 'boe.json');
const API = 'https://www.boe.es/datosabiertos/api/legislacion-consolidada/id';

// Leyes a ingestar (id consolidado del BOE + metadatos para la cita)
const LEYES = [
  { id: 'BOE-A-1978-31229', abrev: 'CE',  fuente: 'Constitución Española',                         rango: 'Constitucional', materia: 'Derecho constitucional' },
  { id: 'BOE-A-1889-4763',  abrev: 'CC',  fuente: 'Código Civil',                                  rango: 'Ley',            materia: 'Derecho civil' },
  { id: 'BOE-A-2015-11430', abrev: 'ET',  fuente: 'Estatuto de los Trabajadores (RDL 2/2015)',     rango: 'Ley',            materia: 'Derecho laboral' },
  { id: 'BOE-A-1994-26003', abrev: 'LAU', fuente: 'Ley de Arrendamientos Urbanos (Ley 29/1994)',   rango: 'Ley',            materia: 'Arrendamientos urbanos' },
  { id: 'BOE-A-2000-323',   abrev: 'LEC', fuente: 'Ley de Enjuiciamiento Civil (Ley 1/2000)',      rango: 'Ley',            materia: 'Derecho procesal civil' },
  { id: 'BOE-A-1995-25444', abrev: 'CP',  fuente: 'Código Penal (LO 10/1995)',                     rango: 'Ley Orgánica',   materia: 'Derecho penal' },
];

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
function decode(s) {
  return s
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

async function fetchTexto(id) {
  const res = await fetch(`${API}/${id}/texto`, { headers: { Accept: 'application/xml' } });
  if (!res.ok) throw new Error(`${id} texto ${res.status}`);
  return res.text();
}

function parseLaw(xml, ley) {
  const chunks = [];
  const blockRe = /<bloque id="([^"]*)" tipo="precepto"(?: titulo="([^"]*)")?>([\s\S]*?)<\/bloque>/g;
  let m;
  while ((m = blockRe.exec(xml))) {
    const [, bid, titulo, body] = m;
    // Quedarnos con la ÚLTIMA versión (texto consolidado vigente)
    const versions = [...body.matchAll(/<version\b[^>]*>([\s\S]*?)<\/version>/g)];
    const ver = versions.length ? versions[versions.length - 1][1] : body;
    const paras = [...ver.matchAll(/<p class="([^"]*)">([\s\S]*?)<\/p>/g)];
    let articulo = '';
    const parts = [];
    for (const [, cls, raw] of paras) {
      const txt = stripTags(raw);
      if (!txt) continue;
      if (cls === 'articulo') articulo = txt; else parts.push(txt);
    }
    const texto = parts.join('\n');
    if (!texto || /\(suprimid|\(derogad/i.test(texto)) continue; // saltar artículos suprimidos/derogados
    const etiqueta = (titulo || articulo).replace(/\.$/, '').trim();
    const num = etiqueta.replace(/^art(?:[íi]culo)?\b\.?\s*/i, '').trim();
    // "Art. 1902 CC" para artículos numerados; "Disposición transitoria… CC" para el resto
    const cita = /^\d/.test(num) ? `Art. ${num} ${ley.abrev}` : `${etiqueta} ${ley.abrev}`;
    chunks.push({
      id: `${ley.abrev}-${bid}`,
      fuente: ley.fuente,
      cita,
      rango: ley.rango,
      materia: ley.materia,
      url: `https://www.boe.es/buscar/act.php?id=${ley.id}`,
      texto: texto.slice(0, 3000), // recorte de seguridad para artículos muy largos
    });
  }
  return chunks;
}

const all = [];
for (const ley of LEYES) {
  process.stdout.write(`Descargando ${ley.abrev} (${ley.fuente})… `);
  try {
    const xml = await fetchTexto(ley.id);
    const chunks = parseLaw(xml, ley);
    all.push(...chunks);
    console.log(`${chunks.length} artículos`);
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}
await writeFile(OUT, JSON.stringify(all, null, 1));
console.log(`\n✓ ${all.length} fragmentos escritos en corpus/boe.json`);
