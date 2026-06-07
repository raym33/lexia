#!/usr/bin/env python3
"""
Lexia — fine-tuning LOCAL de bge-m3 con LoRA (PEFT) sobre Mac (MPS).

LoRA entrena solo unos pocos adaptadores (no los 567M), así que cabe en 16 GB y va
razonable en Apple Silicon. 100% local, sin nube.

Instalación (una vez):
    python3 -m venv finetune/.venv && source finetune/.venv/bin/activate
    pip install -U "sentence-transformers>=3.3" "peft>=0.11" "datasets>=2" accelerate
    # torch para Apple Silicon ya trae soporte MPS

Datos: finetune/data/train.jsonl  ({"query","pos":[...],"neg":[...]})  (de gen_dataset.mjs)

Ejecutar:
    source finetune/.venv/bin/activate
    python finetune/train_lora.py            # entrena de noche; guarda en finetune/out/

Despliegue tras entrenar:
    - El script guarda el modelo FUSIONADO (base + LoRA) en finetune/out/bge-m3-lexia.
    - Convertir a GGUF para LM Studio:
        python llama.cpp/convert_hf_to_gguf.py finetune/out/bge-m3-lexia --outfile bge-m3-lexia.gguf
      (o servir el modelo HF con un endpoint /embeddings)
    - En Lexia:  EMBED_MODEL=bge-m3-lexia  +  node embed.mjs (re-embeber)  +  npm run eval
"""
import json
import os
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE / "data" / "train.jsonl"
OUT = HERE / "out" / "bge-m3-lexia"

# Hiperparámetros (conservadores para MPS/16 GB)
BASE_MODEL = os.environ.get("BASE_MODEL", "BAAI/bge-m3")
EPOCHS = int(os.environ.get("EPOCHS", 1))
BATCH = int(os.environ.get("BATCH", 8))           # sube a 16 si la memoria aguanta
LR = float(os.environ.get("LR", 2e-4))            # LoRA admite LR más alto que full-FT
LORA_R = int(os.environ.get("LORA_R", 16))
MAX_SAMPLES = int(os.environ.get("MAX_SAMPLES", 0))  # 0 = todos


def device():
    import torch
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def main():
    import torch
    from sentence_transformers import SentenceTransformer, InputExample, losses
    from torch.utils.data import DataLoader
    from peft import LoraConfig

    if not DATA.exists():
        raise SystemExit("Falta finetune/data/train.jsonl — genera el dataset antes (gen_dataset.mjs).")

    # Carga de pares; usamos (query, positivo, 1 negativo difícil) + negativos in-batch
    examples = []
    with open(DATA, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if not r.get("pos"):
                continue
            negs = r.get("neg") or []
            if negs:
                examples.append(InputExample(texts=[r["query"], r["pos"][0], negs[0]]))
            else:
                examples.append(InputExample(texts=[r["query"], r["pos"][0]]))
    if MAX_SAMPLES:
        examples = examples[:MAX_SAMPLES]
    print(f"Ejemplos de entrenamiento: {len(examples)}")

    dev = device()
    print(f"Dispositivo: {dev}")
    model = SentenceTransformer(BASE_MODEL, device=dev)

    # LoRA sobre las proyecciones de atención del transformer base
    peft_config = LoraConfig(
        r=LORA_R, lora_alpha=LORA_R * 2, lora_dropout=0.05, bias="none",
        target_modules=["query", "key", "value", "dense"],
    )
    model.add_adapter(peft_config)  # sentence-transformers >= 3.3
    try:
        model[0].auto_model.print_trainable_parameters()
    except Exception:
        pass

    loader = DataLoader(examples, shuffle=True, batch_size=BATCH)
    loss = losses.MultipleNegativesRankingLoss(model)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    model.fit(
        train_objectives=[(loader, loss)],
        epochs=EPOCHS,
        optimizer_params={"lr": LR},
        warmup_steps=int(0.1 * len(loader)),
        use_amp=False,            # AMP en MPS es inestable; fp32
        show_progress_bar=True,
        checkpoint_path=str(HERE / "out" / "ckpt"),
        checkpoint_save_steps=2000,
    )

    # Fusiona LoRA en el base y guarda un modelo desplegable
    try:
        model[0].auto_model = model[0].auto_model.merge_and_unload()
    except Exception as e:
        print(f"(aviso) no se pudo fusionar LoRA automáticamente: {e}")
    model.save(str(OUT))
    print(f"✓ Modelo afinado guardado en {OUT}")


if __name__ == "__main__":
    main()
