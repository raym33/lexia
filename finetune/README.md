# Fine-tuning opcional de embeddings

Esta carpeta contiene scripts experimentales para entrenar o adaptar un modelo de embeddings al dominio jurídico español. No es necesario usarla para ejecutar Lexia.

## Objetivo

Mejorar la recuperación cuando existe distancia entre el lenguaje de la consulta y el lenguaje literal de la norma. Ejemplos típicos:

- La consulta usa una denominación doctrinal.
- El artículo usa una redacción técnica distinta.
- La rúbrica de una sección contiene información relevante que no aparece en el cuerpo del artículo.

## Flujo propuesto

1. Generar un dataset local de pares pregunta-artículo:

```bash
node finetune/gen_dataset.mjs
```

2. Crear un entorno Python:

```bash
python3 -m venv finetune/.venv
source finetune/.venv/bin/activate
pip install -r finetune/requirements.txt
```

3. Entrenar adaptadores LoRA en local:

```bash
python finetune/train_lora.py
```

O entrenar en GPU con:

```bash
python finetune/train.py
```

4. Servir el modelo resultante como endpoint local de embeddings y regenerar el store:

```bash
EMBED_MODEL=bge-m3-lexia npm run embed
```

## Datos generados

No deben subirse a Git:

- `finetune/data/`
- `finetune/out/`
- modelos `.gguf`, `.safetensors` o `.bin`
- métricas internas con consultas reales

## Evaluación

Después de cambiar embeddings:

```bash
npm run eval
```

Usa un conjunto de evaluación separado de las preguntas usadas para entrenar. Evita optimizar solo para ejemplos conocidos.
