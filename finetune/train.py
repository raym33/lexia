#!/usr/bin/env python3
"""
Lexia — fine-tuning de bge-m3 con pares pregunta->artículo (formato FlagEmbedding).

Pensado para ejecutarse en una GPU (cloud A100/4090). En Mac (MPS) funciona pero
lento/inestable. NO requiere nada del resto del proyecto salvo el dataset generado.

Preparación (en la máquina de entrenamiento):
    pip install -U FlagEmbedding "sentence-transformers>=3" accelerate datasets
    # dataset: finetune/data/train.jsonl  ({"query","pos":[...],"neg":[...]})

Entrenamiento (FlagEmbedding, recomendado para bge-m3):
    torchrun --nproc_per_node 1 -m FlagEmbedding.finetune.embedder.encoder_only.m3 \
        --model_name_or_path BAAI/bge-m3 \
        --train_data finetune/data/train.jsonl \
        --output_dir finetune/out/bge-m3-lexia \
        --learning_rate 1e-5 --num_train_epochs 2 \
        --per_device_train_batch_size 4 --gradient_accumulation_steps 4 \
        --query_max_len 64 --passage_max_len 512 \
        --train_group_size 6 --negatives_cross_device \
        --temperature 0.02 --sentence_pooling_method cls \
        --normalize_embeddings True --use_inbatch_neg True

Despliegue:
    1) Convertir a GGUF para LM Studio:
       python llama.cpp/convert_hf_to_gguf.py finetune/out/bge-m3-lexia --outfile bge-m3-lexia.gguf
       (o servir el modelo HF con un endpoint /embeddings compatible)
    2) En Lexia:  EMBED_MODEL=bge-m3-lexia  y  `node embed.mjs`  (re-embeber 216k)
    3) Medir:  npm run eval   (y un test set de 200+ preguntas nuevo)

Alternativa mínima con sentence-transformers (si no usas FlagEmbedding): ver más abajo.
"""

# --- Alternativa autocontenida con sentence-transformers (MultipleNegativesRankingLoss) ---
# Útil si prefieres no usar la CLI de FlagEmbedding. Requiere GPU para ir rápido.
import json
import sys
from pathlib import Path

def main():
    from sentence_transformers import SentenceTransformer, InputExample, losses
    from torch.utils.data import DataLoader

    data_path = Path(__file__).parent / "data" / "train.jsonl"
    if not data_path.exists():
        sys.exit("No existe finetune/data/train.jsonl — genera el dataset primero (gen_dataset.mjs).")

    examples = []
    with open(data_path, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            pos = r["pos"][0]
            # MNR usa (anchor, positive) + negativos in-batch; añadimos 1 hard-neg si hay
            neg = r.get("neg") or []
            if neg:
                examples.append(InputExample(texts=[r["query"], pos, neg[0]]))
            else:
                examples.append(InputExample(texts=[r["query"], pos]))

    print(f"Ejemplos: {len(examples)}")
    model = SentenceTransformer("BAAI/bge-m3")
    loader = DataLoader(examples, shuffle=True, batch_size=16)
    loss = losses.MultipleNegativesRankingLoss(model)
    model.fit(
        train_objectives=[(loader, loss)],
        epochs=2,
        warmup_steps=int(0.1 * len(loader)),
        show_progress_bar=True,
        output_path=str(Path(__file__).parent / "out" / "bge-m3-lexia"),
    )
    print("✓ Modelo afinado en finetune/out/bge-m3-lexia")

if __name__ == "__main__":
    main()
