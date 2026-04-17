from __future__ import annotations

import contextlib
import io
import json
import logging
import os
from pathlib import Path
from typing import Iterable

# The embedding model is a frozen dependency — never hit the Hub after first
# download. Skips the staleness-check HEAD request (and its warning).
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
# Silence the HF/transformers progress bars and advisory messages.
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")


def _load_model(model_name: str):
    """Load a SentenceTransformer model with the verbose load-report suppressed."""
    from sentence_transformers import SentenceTransformer

    # sentence-transformers / its BertModel wrapper prints a load report to
    # stdout on every load. It's diagnostic noise for a stable frozen model.
    for name in ("sentence_transformers", "transformers", "huggingface_hub"):
        logging.getLogger(name).setLevel(logging.ERROR)
    with contextlib.redirect_stdout(io.StringIO()):
        return SentenceTransformer(model_name)


def _document_text(link: dict) -> str:
    parts = [link["target"]]
    for occ in link["occurrences"][:5]:
        snippet = f"{occ['context_before']} [[...]] {occ['context_after']}".strip()
        if snippet:
            parts.append(snippet)
        if occ.get("semantic_type"):
            parts.append(f"({occ['semantic_type']})")
    return " | ".join(parts)


def build_vectors(links: Iterable[dict], vectors_path: Path, manifest_path: Path, model_name: str) -> None:
    import numpy as np

    links_list = list(links)
    model = _load_model(model_name)
    texts = [_document_text(link) for link in links_list]
    vectors = model.encode(texts, batch_size=64, show_progress_bar=True, normalize_embeddings=True)

    vectors_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(vectors_path, np.asarray(vectors, dtype="float32"))

    manifest = {
        "model": model_name,
        "dim": int(vectors.shape[1]),
        "count": int(vectors.shape[0]),
        "order": [link["target"] for link in links_list],
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))


def find_similar(query: str, vectors_path: Path, manifest_path: Path,
                 top_k: int = 10, min_score: float = 0.0) -> list[tuple[str, float]]:
    import numpy as np

    manifest = json.loads(manifest_path.read_text())
    vectors = np.load(vectors_path)
    order: list[str] = manifest["order"]

    if query in order:
        q_vec = vectors[order.index(query)]
    else:
        model = _load_model(manifest["model"])
        q_vec = model.encode([query], normalize_embeddings=True)[0]

    scores = vectors @ q_vec
    ranked = sorted(enumerate(scores), key=lambda iv: -iv[1])
    results = []
    for idx, score in ranked:
        target = order[idx]
        if target == query:
            continue
        if score < min_score:
            break
        results.append((target, float(score)))
        if len(results) >= top_k:
            break
    return results


def cluster_duplicates(vectors_path: Path, manifest_path: Path, threshold: float = 0.82) -> list[list[str]]:
    """Greedy single-link clustering on cosine similarity. Returns near-duplicate groups."""
    import numpy as np

    manifest = json.loads(manifest_path.read_text())
    vectors = np.load(vectors_path)
    order: list[str] = manifest["order"]

    n = vectors.shape[0]
    parent = list(range(n))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    chunk = 256
    for start in range(0, n, chunk):
        end = min(start + chunk, n)
        sims = vectors[start:end] @ vectors.T
        for i, row in enumerate(sims):
            row[start + i] = -1.0
            above = np.where(row >= threshold)[0]
            for j in above:
                union(start + i, int(j))

    groups: dict[int, list[str]] = {}
    for i in range(n):
        r = find(i)
        groups.setdefault(r, []).append(order[i])
    return [sorted(g) for g in groups.values() if len(g) > 1]
