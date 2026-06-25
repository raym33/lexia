# Puesta en marcha local

Esta guía describe cómo ejecutar Lexia sin servicios cloud de IA. La única salida de red necesaria para preparar el sistema es la descarga de normativa pública desde el BOE y la descarga manual de modelos si se usan herramientas como LM Studio u Ollama.

## 1. Preparar software base

Instala:

- Node.js 18 o superior.
- Git.
- Un runtime local de modelos compatible con OpenAI.
- Espacio en disco para modelos, corpus y embeddings.

Opciones habituales de runtime:

- **LM Studio:** opción sencilla para demo, con servidor local OpenAI-compatible.
- **llama.cpp server:** opción ligera para modelos GGUF, útil también para reranking.
- **Ollama:** cómodo para modelos locales; verifica que tu versión expone los endpoints OpenAI-compatible que necesitas.
- **vLLM/SGLang:** más adecuados para servidores Linux con GPU NVIDIA y concurrencia.

## 2. Elegir modelos

Lexia usa tres piezas:

1. **Chat LLM:** redacta la respuesta o borrador con fuentes.
2. **Embeddings:** convierten corpus y consultas en vectores para recuperación semántica.
3. **Reranker opcional:** reordena candidatos recuperados para mejorar precisión.

Configuración recomendada para una demo:

```bash
CHAT_MODEL=gemma-3-12b-it
EMBED_MODEL=bge-m3
USE_RERANK=0
```

Configuración recomendada para piloto con reranker:

```bash
CHAT_MODEL=gemma-3-12b-it
EMBED_MODEL=bge-m3
RERANK_URL=http://127.0.0.1:1235/v1/rerank
USE_RERANK=1
```

Si el runtime permite asignar alias o identificadores, usa exactamente los nombres configurados en `.env`. Si no, cambia las variables para que coincidan con los nombres que devuelve:

```bash
curl http://127.0.0.1:1234/v1/models
```

## 3. Clonar y configurar

```bash
git clone https://github.com/raym33/lexia.git
cd lexia
cp .env.example .env
```

El proyecto no tiene dependencias npm externas. Usa APIs nativas de Node y carga `.env` automáticamente si existe.

## 4. Verificar el servidor de modelos

Comprueba que el endpoint local responde:

```bash
curl http://127.0.0.1:1234/v1/models
```

Prueba embeddings:

```bash
curl -s http://127.0.0.1:1234/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"bge-m3","input":["prueba de embeddings"]}'
```

Prueba chat:

```bash
curl -s http://127.0.0.1:1234/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model":"gemma-3-12b-it",
    "messages":[{"role":"user","content":"Responde en una frase: ¿qué es el BOE?"}],
    "temperature":0
  }'
```

## 5. Generar corpus BOE

```bash
npm run ingest
```

Esto genera ficheros en `corpus/`, ignorados por Git. La ingesta es resumible.

Para lotes más pequeños:

```bash
node ingest.mjs --batch 25
```

## 6. Generar embeddings

```bash
npm run embed
```

Esto genera:

```text
data/embeddings.bin
data/embeddings.ids.txt
data/embeddings.meta.json
```

Si cambias `EMBED_MODEL`, borra o aparta los embeddings anteriores y vuelve a ejecutar `npm run embed`.

## 7. Arrancar Lexia

```bash
npm start
```

Abre:

```text
http://localhost:5174
```

Crea una cuenta local. El fichero `data/users.json` queda fuera de Git.

## 8. Comprobar salud del servicio

```bash
curl http://localhost:5174/api/agent/health
```

Respuesta esperada con corpus preparado:

```json
{
  "ok": true,
  "index": 12345,
  "dim": 1024,
  "chat_model": "gemma-3-12b-it",
  "embed_model": "bge-m3"
}
```

Si `index` es `0`, falta generar corpus o embeddings.

## 9. Evaluar recuperación

Crea una cuenta local o usa credenciales propias:

```bash
npm run eval
```

Variables útiles:

```bash
BASE=http://localhost:5174 EVAL_EMAIL=eval@local EVAL_PASS=contraseña npm run eval
```

El objetivo no es demostrar perfección, sino detectar regresiones de recuperación cuando se cambia corpus, embeddings o ranking.

## 10. Recomendaciones de hardware

Para una presentación:

- 32 GB de RAM o memoria unificada.
- SSD.
- Modelo 8B/12B cuantizado.
- Reranker desactivado si se busca mínima complejidad.

Para piloto interno:

- 64 GB RAM.
- GPU NVIDIA de 24 GB VRAM o Apple Silicon con 64 GB de memoria unificada.
- Modelo 12B/24B cuantizado.
- Embeddings y reranker locales.
- Logs operativos sin datos personales o con anonimización.

Para producción:

- Separar servicios: app, chat model, embeddings/reranker y almacenamiento.
- Añadir auditoría, control de acceso, backup, observabilidad y gestión de versiones del corpus.
- Validar licencias de modelos y textos.
- Medir latencia y concurrencia con usuarios reales.

## 11. Problemas frecuentes

### `Sin store de embeddings`

Ejecuta:

```bash
npm run ingest
npm run embed
```

### Error en `/v1/embeddings`

El servidor local no tiene cargado el modelo de embeddings o el nombre no coincide con `EMBED_MODEL`.

### Error en `/v1/chat/completions`

El servidor local no tiene cargado el modelo de chat o el nombre no coincide con `CHAT_MODEL`.

### Reranker no disponible

Arranca con:

```bash
USE_RERANK=0 npm start
```

### Respuestas pobres o incompletas

Comprueba:

- Que el corpus contiene la norma necesaria.
- Que los embeddings se generaron con el mismo modelo configurado.
- Que `TOP_K` y `RECALL_N` no son demasiado bajos.
- Que el modelo de chat tiene suficiente calidad en español jurídico.

## 12. Limpieza antes de publicar o compartir

No compartas:

```text
data/users.json
data/.session_secret
data/embeddings.*
corpus/boe.json
logs/
tmp/
```

Comprueba:

```bash
git status --short
git diff --check
```
