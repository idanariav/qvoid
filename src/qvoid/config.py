from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

import tomli_w

from .paths import (
    collection_config_path,
    collection_data_dir,
    registry_path,
)

DEFAULT_COLLECTION_CONFIG: dict = {
    "source": {
        "type": "obsidian",
    },
    "classifier": {
        # Folders whose unresolved links are overwhelmingly citations (not claims).
        # Occurrences here without a semantic annotation get biased toward `source`.
        # Sources/Books is intentionally omitted — books are a legitimate origin
        # for claim-shaped unresolved links in this workflow.
        "citation_folders": [
            "Sources/Articles",
            "Sources/Journals",
            "Sources/Lectures",
            "Sources/Courses",
        ],
        # Annotations that strongly imply the target is a claim.
        "claim_annotations": ["Supports", "Opposes", "Weakens", "Reminds"],
        # Annotations that could be either claim or concept (title heuristic decides).
        "claim_or_concept_annotations": ["Jump", "Related", "Aka"],
    },
    "embeddings": {
        "model": "sentence-transformers/all-MiniLM-L6-v2",
    },
}


@dataclass
class Collection:
    name: str
    path: Path
    config: dict

    @property
    def data_dir(self) -> Path:
        return collection_data_dir(self.name)

    @property
    def jsonl_path(self) -> Path:
        return self.data_dir / "unresolved_links.jsonl"

    @property
    def vectors_path(self) -> Path:
        return self.data_dir / "vectors.npy"

    @property
    def manifest_path(self) -> Path:
        return self.data_dir / "manifest.json"


def _read_toml(path: Path) -> dict:
    with path.open("rb") as fh:
        return tomllib.load(fh)


def _write_toml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        tomli_w.dump(data, fh)


def _merge_defaults(cfg: dict) -> dict:
    merged = {}
    for section, defaults in DEFAULT_COLLECTION_CONFIG.items():
        merged[section] = {**defaults, **(cfg.get(section) or {})}
    # Carry over any unknown sections untouched so forward-compat configs don't get dropped.
    for section, value in cfg.items():
        if section not in merged:
            merged[section] = value
    return merged


def load_registry() -> dict:
    if not registry_path().exists():
        return {"collections": {}}
    data = _read_toml(registry_path())
    data.setdefault("collections", {})
    return data


def save_registry(registry: dict) -> None:
    _write_toml(registry_path(), registry)


def register_collection(name: str, path: Path) -> None:
    registry = load_registry()
    registry["collections"][name] = {"path": str(path.resolve())}
    save_registry(registry)
    cfg_path = collection_config_path(name)
    if not cfg_path.exists():
        _write_toml(cfg_path, DEFAULT_COLLECTION_CONFIG)


def remove_collection(name: str) -> bool:
    registry = load_registry()
    if name not in registry["collections"]:
        return False
    del registry["collections"][name]
    save_registry(registry)
    return True


def list_collections() -> dict:
    return load_registry()["collections"]


def load_collection(name: str) -> Collection:
    registry = load_registry()
    if name not in registry["collections"]:
        raise RuntimeError(
            f"Unknown collection: {name!r}. Run `qvoid collections` to list, "
            f"or `qvoid init --name <n> --path <vault>` to register."
        )
    path = Path(registry["collections"][name]["path"])
    cfg_path = collection_config_path(name)
    cfg = _read_toml(cfg_path) if cfg_path.exists() else {}
    return Collection(name=name, path=path, config=_merge_defaults(cfg))


def resolve_collection(name: str | None = None) -> Collection:
    """Pick a collection by explicit name, env var, CWD containment, or single-registration fallback."""
    if name is None:
        name = os.environ.get("QVOID_COLLECTION")
    collections = list_collections()
    if not collections:
        raise RuntimeError("No collections registered. Run `qvoid init --name <n> --path <vault>`.")
    if name:
        return load_collection(name)

    cwd = Path.cwd().resolve()
    for cname, entry in collections.items():
        cpath = Path(entry["path"]).resolve()
        try:
            cwd.relative_to(cpath)
            return load_collection(cname)
        except ValueError:
            continue

    if len(collections) == 1:
        return load_collection(next(iter(collections)))

    raise RuntimeError(
        "Multiple collections registered and CWD is outside all of them. "
        "Pass --collection <name> or set QVOID_COLLECTION."
    )
