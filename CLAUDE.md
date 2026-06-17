# Lexia for Claude

Lexia is a local Spanish legal RAG service and reusable agent skill. Use it in projects when the user needs Spanish-law research, BOE source retrieval, or lawyer-reviewed legal drafting with verifiable citations.

## When To Use Lexia

Use Lexia for:

- Spanish legal questions that need official BOE citations.
- Retrieving statutory sources before another agent writes an answer.
- Drafting Spanish legal documents such as claims, contracts, appeals, burofax/requerimientos, clauses, or legal memos.
- Adding a local legal research capability to another app, workflow, or agent OS.

Do not use Lexia as final legal advice. It provides cited legal basis and drafts for a lawyer to review.

## Start The Service

From this repo:

```bash
npm start
```

Default service URL:

```text
http://localhost:5174
```

Lexia expects local OpenAI-compatible model endpoints:

- `LM_BASE`, default `http://127.0.0.1:1234/v1`, for chat.
- `EMBED_BASE`, default same as `LM_BASE`, for embeddings.
- `RERANK_URL`, default `http://127.0.0.1:1235/v1/rerank`, for optional reranking.

If `LEXIA_AGENT_TOKEN` is set, send:

```http
Authorization: Bearer <token>
```

If no token is configured, `/api/agent/*` accepts localhost callers only.

## Project Integration Pattern

For any project that needs Lexia:

1. Check health:

```bash
curl http://localhost:5174/api/agent/health
```

2. Retrieve sources before answering:

```bash
curl -s http://localhost:5174/api/agent/retrieve \
  -H 'content-type: application/json' \
  -d '{"query":"¿Cuándo cabe el despido disciplinario?","k":6}'
```

3. Use returned `sources` as the grounding context. Preserve source numbers exactly as `[1]`, `[2]`, etc.

4. If the project wants Lexia to generate the answer directly:

```bash
curl -s http://localhost:5174/api/agent/answer \
  -H 'content-type: application/json' \
  -d '{"query":"¿Cuándo cabe el despido disciplinario?","k":6}'
```

5. If the project wants a draft legal document:

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

## Response Rules

When using Lexia output in another project:

- Cite sources with the returned source numbers.
- Do not invent statutes, article numbers, cases, or URLs.
- If retrieved sources are weak or insufficient, say that clearly.
- Mention that the output is for lawyer review when drafting or answering legal questions.
- Prefer `/api/agent/retrieve` when another model will write the final response.
- Prefer `/api/agent/answer` when Lexia should produce the cited answer.
- Prefer `/api/agent/draft` only for drafts, not final filings.

## More Detail

- Skill instructions: `SKILL.md`
- HTTP contract: `references/api.md`
- Main server: `server.mjs`
