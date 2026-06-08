# Fine-tuning del embedder jurídico (proyecto aparte)

Objetivo: subir el **recall** de Lexia más allá del techo actual (recall@40 = 45/50;
Hit@8 90%) afinando el modelo de embeddings (`bge-m3`) con **pares pregunta→artículo
en español jurídico**. Esto cierra las "brechas de vocabulario" donde el nombre
doctrinal no aparece en el texto de la ley (p. ej. "despido disciplinario" → Art. 54 ET,
"legítima defensa" → Art. 20 CP).

> Es un proyecto SEPARADO del motor en producción. El motor actual queda dado por bueno.

## Pipeline (3 pasos)

1. **Generar dataset** (local, este repo): `finetune/gen_dataset.mjs`
   - Para una muestra de artículos del corpus, un LLM genera N preguntas en lenguaje
     natural (registro lego y técnico) cuya respuesta es ese artículo.
   - Para cada pregunta, se minan **negativos difíciles** con el propio buscador
     (artículos recuperados que NO son el correcto).
   - Salida: `finetune/data/train.jsonl` en formato FlagEmbedding:
     `{"query": str, "pos": [str], "neg": [str, ...]}`
   - Resumible (manifiesto de artículos hechos). Lento en local (LLM por artículo):
     ~5.000-20.000 artículos × 3 preguntas. Correr en background.

2a. **Entrenar LOCAL con LoRA** (sin nube, en tu Mac): `finetune/train_lora.py`
   - LoRA entrena solo adaptadores → cabe en 16 GB y va razonable en MPS.
   - `python3 -m venv finetune/.venv && source finetune/.venv/bin/activate`
   - `pip install -r finetune/requirements.txt`
   - `python finetune/train_lora.py`  (entrena de noche; guarda modelo fusionado en `out/`)

2b. **Entrenar en GPU cloud** (más rápido, one-off): `finetune/train.py`
   - Fine-tune de `BAAI/bge-m3` con `FlagEmbedding`/`sentence-transformers`
     (contrastive / in-batch negatives + hard negatives).
   - En Mac (MPS) es lento/inestable; en una GPU (A100, ~1-2 €/h) son ~1-4 h.
   - Salida: modelo afinado `finetune/out/bge-m3-lexia`.

3. **Desplegar y medir**:
   - Convertir a GGUF (llama.cpp `convert_hf_to_gguf.py`) y cargar en LM Studio,
     o servir el modelo HF directamente.
   - `EMBED_MODEL=<nuevo>` y re-embeber los 216k (`node embed.mjs`, ~varias horas).
   - Remedir con `npm run eval` (y, idealmente, un test set de 200+ preguntas nuevo,
     para evitar overfitting al de 50).

## Coste/tiempo realista
- Dataset: 1-2 días (sobre todo generación + validación).
- Entrenamiento: horas en GPU cloud (días en Mac).
- Re-embed + eval: ~medio día.

## Criterio de éxito
- Mejorar recall@40 (que hoy es el techo) en el test set AMPLIO (no en el de 50).
- No degradar los casos que ya funcionan (medir antes/después).

## Estado
- [x] `gen_dataset.mjs` (generador resumible) — este commit
- [x] `train.py` (script de entrenamiento para GPU) — este commit
- [ ] Generar dataset completo (pendiente: lanzar en background / GPU)
- [ ] Entrenar (pendiente: GPU)
- [ ] Re-embed + eval

## Despliegue del modelo afinado (lo que se hizo)
1. Entrenar LoRA: `python finetune/train_lora.py` → `finetune/out/bge-m3-lexia` (adaptador).
2. Fusionar LoRA en el base (PEFT `merge_and_unload`) → `finetune/out/bge-m3-lexia-merged` (HF).
3. Convertir a GGUF: `python /ruta/llama.cpp/convert_hf_to_gguf.py finetune/out/bge-m3-lexia-merged --outfile bge-m3-lexia-f16.gguf --outtype f16`.
4. Colocar en `~/.lmstudio/models/lexia/bge-m3-lexia/` y `lms load text-embedding-bge-m3-lexia --identifier bge-m3-lexia`.
5. Re-embeber: `EMBED_MODEL=bge-m3-lexia node embed.mjs` (vía LM Studio, ~25/s ≈ 2,3 h).
6. Servir: arrancar Lexia con `EMBED_MODEL=bge-m3-lexia` (las consultas se embeben con el afinado).
