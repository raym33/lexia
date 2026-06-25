# Lexia

IA jurídico-administrativa local para España, con recuperación sobre fuentes oficiales del BOE y respuestas citadas.

Lexia es una demo open source pensada para evaluar, en entornos jurídicos y de administración pública, cómo un asistente RAG puede ayudar a localizar normativa, preparar borradores y reducir trabajo repetitivo sin enviar datos sensibles a servicios externos.

## Principios

- **Local primero:** la aplicación, el corpus, los embeddings y los modelos pueden ejecutarse en infraestructura propia.
- **Fuentes verificables:** las respuestas y borradores citan las fuentes recuperadas con referencias `[1]`, `[2]`, etc.
- **Revisión humana:** Lexia no sustituye criterio jurídico, acto administrativo ni responsabilidad profesional.
- **Sin datos personales en el repositorio:** corpus, embeddings, usuarios locales, sesiones y cualquier dato operativo se generan fuera de Git.
- **Licencia MIT:** el código se publica con licencia MIT. Las licencias de los modelos usados son independientes y deben revisarse antes de producción.

## Qué incluye

- Landing estática de presentación.
- App web con login local, consulta normativa, redacción asistida, biblioteca y historial local.
- Ingestor de legislación consolidada del BOE.
- Generador de embeddings local y store binario.
- Recuperación híbrida: BM25, embeddings, peso de autoridad y reranker opcional.
- API para otros agentes o sistemas internos.
- Evaluación básica de recuperación con `Hit@k` y `MRR`.

## Qué no incluye

- Modelos LLM, modelos de embeddings ni rerankers.
- Corpus BOE generado.
- Embeddings generados.
- Datos de usuarios, sesiones o expedientes.
- Jurisprudencia CENDOJ lista para producción.

## Estructura

```text
public/          interfaz web
server.mjs       servidor HTTP, RAG y API
ingest.mjs       ingesta resumible del BOE
embed.mjs        generación local de embeddings
auth.mjs         autenticación local con scrypt y cookie firmada
config.mjs       carga opcional de variables desde .env, sin dependencias
eval/            evaluación de recuperación
references/      contrato de API para agentes
docs/            documentación operativa
finetune/        scripts opcionales para experimentar con embeddings afinados
```

## Software necesario

Obligatorio:

- Node.js 18 o superior.
- Un servidor local compatible con la API de OpenAI para chat, por ejemplo LM Studio, llama.cpp server, Ollama con compatibilidad OpenAI, vLLM o SGLang.
- Un endpoint local de embeddings compatible con `/v1/embeddings`.
- Un modelo LLM instructivo que responda bien en español.
- Un modelo de embeddings multilingüe.

Opcional:

- Un reranker local compatible con `/v1/rerank`.
- Python 3.10+ solo si se usa la carpeta `finetune/`.

## Modelos recomendados

Los nombres exactos dependen del runtime local. Si usas LM Studio, puedes cargar un modelo y asignarle un identificador como `gemma-3-12b-it` o `bge-m3`.

### Chat LLM

| Perfil | Modelos orientativos | Uso recomendado |
|---|---|---|
| Mínimo | `Qwen/Qwen3-8B`, `google/gemma-3-12b-it` cuantizados Q4/Q5 | Demo local y pruebas internas |
| Recomendado | `google/gemma-3-12b-it`, `Qwen/Qwen3-14B` o equivalente | Mejor equilibrio entre calidad, latencia y coste |
| Alta calidad | `mistralai/Mistral-Small-3.2-24B-Instruct-2506`, modelos 24B-32B instructivos | Pilotos con respuestas más exigentes |

### Embeddings

| Modelo | Motivo |
|---|---|
| `BAAI/bge-m3` | Buen punto de partida multilingüe para RAG en español |
| `bge-m3-lexia` | Nombre sugerido si se entrena o sirve un embedding afinado propio |

### Reranker opcional

| Modelo | Motivo |
|---|---|
| `BAAI/bge-reranker-v2-m3` | Reranker multilingüe ligero para reordenar candidatos |

Antes de una implantación pública, revisa la licencia y condiciones de cada modelo, especialmente si habrá redistribución, uso comercial, datos sensibles o despliegue en terceros.

## Hardware orientativo

| Escenario | Hardware razonable | Comentario |
|---|---|---|
| Prueba funcional | CPU moderna, 16 GB RAM, SSD | Funciona con modelos 7B/8B cuantizados, pero puede ser lento |
| Demo fluida local | Apple Silicon con 32 GB RAM, o GPU NVIDIA con 12-16 GB VRAM | Adecuado para 8B/12B cuantizados y corpus moderado |
| Piloto serio | 64 GB RAM, NVMe, GPU NVIDIA 24 GB VRAM o Mac con 64 GB de memoria unificada | Mejor para 12B/24B, embeddings y reranker |
| Producción interna | 64-128 GB RAM, NVMe, GPU 24-48 GB VRAM por nodo | Dimensionar según concurrencia, corpus, latencia y auditoría |

El store de embeddings ocupa aproximadamente:

```text
número_de_fragmentos × dimensión_del_embedding × 4 bytes
```

Ejemplo: 216.000 fragmentos con dimensión 1024 ocupan unos 885 MB solo en `embeddings.bin`, más metadatos.

## Puesta en marcha rápida

```bash
git clone https://github.com/raym33/lexia.git
cd lexia
cp .env.example .env
```

Lexia carga `.env` automáticamente si existe. Las variables ya definidas en el sistema tienen prioridad.

Arranca tu runtime local de modelos. Para LM Studio:

1. Descarga y carga un modelo de chat instructivo.
2. Descarga y carga un modelo de embeddings, por ejemplo `BAAI/bge-m3`.
3. Activa el servidor local compatible OpenAI en `http://127.0.0.1:1234/v1`.
4. Verifica modelos:

```bash
curl http://127.0.0.1:1234/v1/models
```

Genera corpus y embeddings:

```bash
npm run ingest
npm run embed
```

Arranca Lexia:

```bash
npm start
```

Abre:

```text
http://localhost:5174
```

La primera vez crea una cuenta local. Ese usuario se guarda en `data/users.json`, que está ignorado por Git.

## Variables de entorno

Ver también [`.env.example`](.env.example).

| Variable | Valor por defecto | Función |
|---|---|---|
| `PORT` | `5174` | Puerto HTTP de Lexia |
| `LM_BASE` | `http://127.0.0.1:1234/v1` | Endpoint OpenAI-compatible para chat |
| `CHAT_MODEL` | `gemma-3-12b-it` | Identificador local del modelo de chat |
| `EMBED_BASE` | igual que `LM_BASE` | Endpoint OpenAI-compatible para embeddings |
| `EMBED_MODEL` | `bge-m3` | Identificador local del modelo de embeddings |
| `FAST_MODEL` | `qwen3-8b-instruct` | Modelo opcional para expansión de consulta |
| `USE_EXPAND` | `0` | Activa expansión de consulta con LLM |
| `USE_RERANK` | `1` | Activa reranking si hay endpoint disponible |
| `RERANK_URL` | `http://127.0.0.1:1235/v1/rerank` | Endpoint del reranker |
| `TOP_K` | `6` | Fuentes finales entregadas al LLM |
| `RECALL_N` | `40` | Candidatos previos al reranker |
| `LEXIA_AGENT_TOKEN` | vacío | Token opcional para `/api/agent/*` |

Si no ejecutas reranker, puedes arrancar con:

```bash
USE_RERANK=0 npm start
```

## API

Endpoints de app con sesión local:

| Método | Ruta | Función |
|---|---|---|
| `POST` | `/api/consulta` | Respuesta RAG citada |
| `POST` | `/api/redactar` | Borrador jurídico o administrativo citado |
| `POST` | `/api/buscar` | Recuperación rápida sin LLM |
| `GET` | `/api/fuentes` | Biblioteca del corpus |
| `POST` | `/api/register` | Crear cuenta local |
| `POST` | `/api/login` | Iniciar sesión |
| `POST` | `/api/logout` | Cerrar sesión |
| `GET` | `/api/me` | Usuario actual |

Endpoints para agentes:

| Método | Ruta | Función |
|---|---|---|
| `GET` | `/api/agent/health` | Estado del índice, modelos y configuración |
| `POST` | `/api/agent/retrieve` | Recupera fuentes con texto |
| `POST` | `/api/agent/answer` | Genera respuesta citada |
| `POST` | `/api/agent/draft` | Genera borrador con fuentes |

Contrato completo: [references/api.md](references/api.md).

## Evaluación

Con el servidor arrancado y una cuenta local creada:

```bash
npm run eval
```

El script mide si aparece el artículo esperado entre los primeros resultados para un conjunto de consultas conocidas.

## Datos y privacidad

No subas a Git:

- `data/users.json`
- `data/.session_secret`
- `data/embeddings.*`
- `corpus/boe.json`
- expedientes, consultas reales, logs con datos personales o documentos de ciudadanos

La ingesta consulta fuentes públicas del BOE. Las consultas de usuarios, documentos, cuentas y embeddings permanecen en la infraestructura donde se ejecute Lexia.

## Documentación adicional

- [Guía de puesta en marcha local](docs/puesta-en-marcha-local.md)
- [API para agentes](references/api.md)
- [Fine-tuning opcional de embeddings](finetune/README.md)

## Referencias de software

- [LM Studio OpenAI Compatibility](https://lmstudio.ai/docs/developer/openai-compat)
- [Ollama OpenAI Compatibility](https://docs.ollama.com/api/openai-compatibility)
- [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [BAAI/bge-m3](https://huggingface.co/BAAI/bge-m3)
- [BAAI/bge-reranker-v2-m3](https://huggingface.co/BAAI/bge-reranker-v2-m3)

## Licencia

MIT. Ver [LICENSE](LICENSE).
