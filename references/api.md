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
  -d '{"query":"¿Cuándo debe concederse trámite de audiencia en un procedimiento administrativo?","k":6}'
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
      "cita": "Art. 82 LPACAP",
      "fuente": "Ley del Procedimiento Administrativo Común de las Administraciones Públicas",
      "materia": "LPACAP",
      "rango": "Ley",
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

Use when Lexia should generate a cited legal or administrative-law answer.

```bash
curl -s http://localhost:5174/api/agent/answer \
  -H 'content-type: application/json' \
  -d '{"query":"¿Qué requisitos debe cumplir la motivación de un acto administrativo?","k":6}'
```

Response fields:

- `answer`: Spanish legal answer with `[n]` citations.
- `sources`: source objects including `texto`.
- `model`: chat model used.
- `ms`: elapsed time.

## Draft Legal or Administrative Document

Use for professional-reviewed drafts, including legal, administrative and public-sector documents.

```bash
curl -s http://localhost:5174/api/agent/draft \
  -H 'content-type: application/json' \
  -d '{
    "tipo":"subsanacion",
    "hechos":"La solicitud no aporta documentación obligatoria para acreditar la representación...",
    "instrucciones":"Tono claro, plazo de 10 días y advertencia de desistimiento",
    "k":6
  }'
```

Request fields:

- `tipo`: `resolucion`, `informe_admin`, `subsanacion`, `contratacion`, `demanda`, `contrato`, `recurso`, `requerimiento`, `clausula`, `dictamen`, or free text.
- `hechos`: facts/context, required.
- `instrucciones`: optional drafting instructions.
- `k`: optional source count.

Response fields:

- `draft`: cited draft with placeholders such as `{{órgano}}`, `{{número de expediente}}` or `{{interesado}}`.
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
