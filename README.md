# Lexia ⚖️ — IA jurídica open source para abogados (España)

> Ahorra tiempo a los abogados en la **búsqueda de legislación y jurisprudencia** y en la
> **redacción**, con IA **open source** que corre **100% local**: ningún dato del cliente
> sale del despacho. Cada respuesta va **citada y verificable**.

Este repositorio es la **web app completa** (demo enseñable a VC). Es un sistema **RAG jurídico**:
recupera las normas relevantes y genera una respuesta donde **cada afirmación lleva su cita**,
con el diseño orientado a **no alucinar** (la alucinación de una cita es inadmisible en derecho).

También puede instalarse como **skill para un Agent AI OS**: el archivo [`SKILL.md`](SKILL.md)
describe cuándo usar Lexia, y [`references/api.md`](references/api.md) documenta los endpoints
HTTP estables para agentes.

### La aplicación

- **Landing** (`/`) — marketing, propuesta de valor y captación de despachos piloto (waitlist).
- **App** (`/app.html`) — SPA con barra lateral y 4 módulos:
  - 🔎 **Consulta** — chat jurídico con citas clicables y panel de fuentes.
  - ✍️ **Redacción** — borradores de demandas, contratos, recursos, burofax, dictámenes y cláusulas, con fundamentos de derecho citados y `{{marcadores}}` para completar.
  - 📚 **Biblioteca** — explorar y filtrar el corpus indexado.
  - 🕘 **Historial** — consultas guardadas localmente en el navegador.

### API

| Método | Ruta | Función |
|---|---|---|
| POST | `/api/consulta` | RAG: pregunta → respuesta citada + fuentes |
| POST | `/api/redactar` | Genera borrador de escrito con base normativa citada |
| GET  | `/api/fuentes` | Lista el corpus indexado (biblioteca) |
| POST | `/api/waitlist` | Guarda leads de despachos en `data/waitlist.json` |

### API para agentes

Los endpoints `/api/agent/*` están pensados para consumo por otros agentes o runtimes:

| Método | Ruta | Función |
|---|---|---|
| GET  | `/api/agent/health` | Estado del índice, modelos y configuración |
| POST | `/api/agent/retrieve` | Recupera fuentes BOE con texto, sin generar respuesta |
| POST | `/api/agent/answer` | Responde con citas verificables |
| POST | `/api/agent/draft` | Genera borradores jurídicos con fuentes |

Si defines `LEXIA_AGENT_TOKEN`, usa `Authorization: Bearer <token>`. Sin token configurado,
los endpoints de agente solo aceptan llamadas desde localhost.

---

## Por qué open source / local es la tesis (y el moat)

- **Secreto profesional + RGPD:** los despachos no quieren mandar datos de clientes a OpenAI.
  Lexia corre on-premise o en cloud soberana europea. Nada se envía a terceros ni entrena modelos ajenos.
- **El moat no es el LLM** (es intercambiable), sino: (1) el **corpus** estructurado de legislación
  + jurisprudencia, (2) el **RAG con citas verificables**, (3) el **workflow** integrado en el despacho.
- **Coste a escala:** sin tarifa por token de un tercero.

## Arquitectura (MVP)

```
Pregunta del abogado
   │  embeddings (nomic-embed, local)
   ▼
Búsqueda por similitud coseno  ──►  top-k fragmentos del corpus (con cita y URL oficial)
   │
   ▼
LLM local (LM Studio)  ◄── prompt que OBLIGA a citar y PROHÍBE inventar
   │
   ▼
Respuesta con [1][2]… + panel de fuentes verificables
```

- **LLM y embeddings:** servidos por [LM Studio](https://lmstudio.ai) (API compatible OpenAI), modelos abiertos.
  - Chat por defecto: `gemma-3-12b-it-qat` (cámbialo a `qwen3.6-27b` para más calidad).
  - Embeddings: `text-embedding-nomic-embed-text-v1.5`.
- **Sin dependencias npm.** Node puro (`server.mjs`). Vector store en memoria + caché en `data/`.
- **Corpus real del BOE:** `corpus/boe.json` — **3.946 artículos** con el **texto consolidado
  oficial** descargado de la API de datos abiertos del BOE (CE, CC, ET, LAU, LEC, CP).
  Se regenera con `node ingest.mjs`. Falta integrar jurisprudencia del CENDOJ (sin API pública).
- **Recuperación híbrida (BM25 léxico + vectorial):** en derecho los términos exactos importan
  tanto como el significado. La búsqueda combina ambas señales, lo que mejora drásticamente el
  recall en un corpus grande (la búsqueda solo-vectorial fallaba al encontrar artículos por nombre).

## Ingesta del BOE

```bash
node ingest.mjs        # descarga y trocea el texto consolidado -> corpus/boe.json
npm start              # al arrancar reconstruye el índice si el corpus cambió
```

Añade más leyes editando el array `LEYES` en `ingest.mjs` (id consolidado del BOE + abreviatura).

## Ejecutar

Requisitos: Node 18+ y LM Studio corriendo en `http://localhost:1234` con un modelo de chat
y el de embeddings cargados.

```bash
cd lexia
npm start
# abre http://localhost:5174
```

Variables opcionales: `CHAT_MODEL`, `EMBED_MODEL`, `LM_BASE`, `PORT`, `TOP_K`.

```bash
CHAT_MODEL=qwen3.6-27b TOP_K=6 npm start
```

## Estado actual y siguiente

Hecho (MVP funcional):
- [x] Motor RAG con embeddings locales + recuperación por coseno
- [x] Prompt jurídico anti-alucinación (cita obligatoria, "no sé" honesto)
- [x] UI de chat con citas clicables y panel de fuentes con enlace a la fuente oficial
- [x] 100% local, sin datos a terceros

Roadmap para producción / pitch:
- [ ] Ingesta automática BOE (consolidado) + CENDOJ (jurisprudencia)
- [ ] Reranking y citas a nivel de párrafo; verificación de que la cita existe
- [ ] Generación asistida de escritos/contratos a partir de plantillas + cláusulas citadas
- [ ] Fine-tuning (LoRA) en lenguaje jurídico español
- [ ] Multi-despacho, control de acceso, trazabilidad/auditoría
- [ ] Despliegue on-premise / cloud soberana

## Aviso

Demo con corpus reducido. El texto de las normas está **resumido fielmente** con su cita
oficial; en producción se usa el texto consolidado oficial. Lexia **no sustituye el criterio
del letrado**: aporta base normativa citada para acelerar su trabajo.
