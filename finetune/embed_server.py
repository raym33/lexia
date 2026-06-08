#!/usr/bin/env python3
"""
Lexia — microservidor de embeddings OpenAI-compatible para el modelo AFINADO.
Sirve finetune/out/bge-m3-lexia (sentence-transformers + LoRA) en :1236, endpoint
/v1/embeddings, para que embed.mjs y server.mjs lo usen igual que a LM Studio.

Uso:
    finetune/.venv/bin/python finetune/embed_server.py
    # luego:  EMBED_BASE=http://127.0.0.1:1236/v1 EMBED_MODEL=bge-m3-lexia node embed.mjs
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL_DIR = str(Path(__file__).parent / "out" / "bge-m3-lexia")
PORT = 1236

print(f"Cargando modelo afinado: {MODEL_DIR} …")
from sentence_transformers import SentenceTransformer
import torch
DEV = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
MODEL = SentenceTransformer(MODEL_DIR, device=DEV)
print(f"✓ Modelo cargado en {DEV}. Sirviendo en http://127.0.0.1:{PORT}/v1/embeddings")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith("/models"):
            self._json(200, {"data": [{"id": "bge-m3-lexia", "object": "model"}]})
        else:
            self._json(200, {"status": "ok"})

    def do_POST(self):
        n = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        inp = body.get("input", [])
        if isinstance(inp, str):
            inp = [inp]
        embs = MODEL.encode(inp, normalize_embeddings=True, batch_size=64, convert_to_numpy=True)
        data = [{"object": "embedding", "index": i, "embedding": e.tolist()} for i, e in enumerate(embs)]
        self._json(200, {"object": "list", "data": data, "model": "bge-m3-lexia"})

    def _json(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
