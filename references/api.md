# Lexia Agent API

Base URL:

```text
http://localhost:5174
```

Authentication:

```http
Authorization: Bearer $LEXIA_AGENT_TOKEN
```

If `LEXIA_AGENT_TOKEN` is not configured, agent endpoints accept localhost callers only.

## Health

```bash
curl http://localhost:5174/api/agent/health
```

Returns service status, index size, embedding dimension, models, and retrieval toggles.

## Retrieve Sources

Use this before answering when the agent wants to inspect source text.

```bash
curl -s http://localhost:5174/api/agent/retrieve \
  -H 'content-type: application/json' \
  -d '{"query":"¿Qué regula el artículo 54 del Estatuto de los Trabajadores?","k":6}'
```

Request fields:

- `query` string, required.
- `k` number, optional, capped at 20.
- `include_text` boolean, optional, default `true`.

Response shape:

```json
{
  "query": "...",
  "sources": [
    {
      "n": 1,
      "id": "...",
      "cita": "Art. 54 ET",
      "fuente": "Estatuto de los Trabajadores",
      "materia": "ET",
      "rango": "Real Decreto Legislativo",
      "url": "https://www.boe.es/...",
      "score": 0.941,
      "contexto": "...",
      "texto": "..."
    }
  ],
  "ms": 123
}
```

## Answer With Citations

Use when Lexia should generate the final cited legal answer.

```bash
curl -s http://localhost:5174/api/agent/answer \
  -H 'content-type: application/json' \
  -d '{"query":"¿Cuándo cabe el despido disciplinario?","k":6}'
```

Response fields:

- `answer`: Spanish legal answer with `[n]` citations.
- `sources`: source objects including `texto`.
- `model`: chat model used.
- `ms`: elapsed time.

## Draft Legal Document

Use for lawyer-reviewed drafts.

```bash
curl -s http://localhost:5174/api/agent/draft \
  -H 'content-type: application/json' \
  -d '{
    "tipo":"requerimiento",
    "hechos":"El arrendatario adeuda tres mensualidades...",
    "instrucciones":"Tono firme y plazo de pago de 10 días",
    "k":6
  }'
```

Request fields:

- `tipo`: `demanda`, `contrato`, `recurso`, `requerimiento`, `clausula`, `dictamen`, or free text.
- `hechos`: facts/context, required.
- `instrucciones`: optional drafting instructions.
- `k`: optional source count.

Response fields:

- `draft`: cited draft with placeholders such as `{{nombre del cliente}}`.
- `sources`: source objects including `texto`.
- `model`: chat model used.
- `ms`: elapsed time.

## Existing UI API

The browser app also exposes cookie-authenticated endpoints:

- `POST /api/consulta`
- `POST /api/buscar`
- `POST /api/redactar`
- `GET /api/fuentes`
- `POST /api/register`
- `POST /api/login`
- `POST /api/logout`
- `GET /api/me`
