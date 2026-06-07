#!/bin/sh
# Lexia — reranker cross-encoder (bge-reranker-v2-m3) vía llama.cpp en :1235.
# Requisito del reranking determinista. Arráncalo antes de `npm start` (o ponlo como servicio).
#   brew install llama.cpp   # si no está
#   sh scripts/reranker.sh
GGUF="$HOME/.lmstudio/models/gpustack/bge-reranker-v2-m3-GGUF/bge-reranker-v2-m3-Q8_0.gguf"
exec llama-server -m "$GGUF" --reranking --host 127.0.0.1 --port 1235
