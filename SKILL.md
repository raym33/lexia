---
name: lexia
description: Spanish legal RAG over BOE legislation with verifiable citations. Use when an agent needs to answer questions about Spanish law, retrieve official BOE legal sources, draft Spanish legal documents with cited statutory support, or integrate a local legal research service into an agent OS through HTTP endpoints.
---

# Lexia

Lexia is a local-first Spanish legal research skill. It retrieves BOE legal sources, generates cited answers, and drafts legal documents for lawyer review. Treat it as a source-grounded assistant, not as final legal advice.

## Operating Rules

- Use Lexia for Spanish-law questions where official legislative citations matter.
- Prefer retrieval-first workflows: call retrieve, inspect sources, then answer or draft.
- Do not invent statutes, article numbers, cases, or URLs. If the returned sources are insufficient, say so and name the missing source type.
- Keep the professional responsible for final legal judgment. Lexia provides cited legal basis and drafts for review.
- Preserve source numbers exactly as returned when citing: `[1]`, `[2]`, etc.

## Local Service

Start the service from the repository root:

```bash
npm start
```

Default URL:

```text
http://localhost:5174
```

Lexia expects local model services:

- `LM_BASE`: OpenAI-compatible chat endpoint, default `http://127.0.0.1:1234/v1`.
- `EMBED_BASE`: OpenAI-compatible embeddings endpoint, defaults to `LM_BASE`.
- `RERANK_URL`: optional reranker endpoint, default `http://127.0.0.1:1235/v1/rerank`.

If `LEXIA_AGENT_TOKEN` is set, call agent endpoints with `Authorization: Bearer <token>`. If it is unset, agent endpoints accept localhost calls only.

## Agent Workflow

1. Check service health with `GET /api/agent/health`.
2. Retrieve sources with `POST /api/agent/retrieve`.
3. If sources are sufficient, either compose the answer yourself from sources or call `POST /api/agent/answer`.
4. For document drafting, call `POST /api/agent/draft` with facts and optional instructions.
5. Return both the answer/draft and the cited source list to the user.

For endpoint contracts and examples, read `references/api.md`.

## Data Expectations

- The BOE corpus is generated locally with `npm run ingest`.
- Embeddings are generated locally with `npm run embed`.
- Large artifacts such as full corpora, embeddings, model checkpoints, and session data are intentionally not part of the skill payload.

## Limits

- Lexia currently focuses on BOE legislation. Jurisprudence/CENDOJ coverage is not guaranteed unless the local corpus has been extended.
- Answers are only as complete as the local corpus and embedding store.
- If health reports `index: 0`, ingest and embed the corpus before relying on retrieval.
