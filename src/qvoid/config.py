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
        # Only index links found in files under these folder prefixes (relative to vault root).
        # Empty list means index all folders.
        "origin_folders": [],
        # Regex with one capture group matching the annotation name immediately before a wikilink.
        # Default matches Dataview inline-field syntax: (Key:: [[target]]
        # Set to "" to disable annotation extraction entirely.
        "annotation_pattern": r"\(([A-Za-z]+)::\s*$",
        # Links whose target ends with one of these extensions are excluded before indexing.
        "exclude_extensions": [
            ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
            ".excalidraw", ".pdf", ".mp4", ".mov", ".mp3", ".wav", ".zip",
        ],
    },
    "classifier": {
        # Links classified as these types are dropped from the index after classification.
        # Valid types: person, date, idea, file, template, unknown
        "exclude_types": [],
        # Folders whose unresolved links are overwhelmingly citations.
        # Occurrences here without a semantic annotation add +1 to the idea confidence boost.
        # Defaults to empty — set explicitly for your vault if needed.
        "citation_folders": [],
        # Annotations that strongly imply the target is an idea (boost score +3).
        "claim_annotations": ["Supports", "Opposes", "Weakens", "Reminds"],
        # Annotations that suggest the target is an idea (boost score +1).
        "claim_or_concept_annotations": ["Jump", "Related", "Aka"],
        # Link-name prefix that identifies a person note (e.g. "@Alice").
        # Set to "" to disable the person heuristic.
        "person_prefix": "@",
        # Toggle individual title heuristics on/off.
        "heuristics": {
            "date": True,
            "person": True,
            "file_extensions": True,
            "camelcase": True,
            "template": True,
            "capitalization": True,
            "min_words_for_idea": 4,
        },
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

    @property
    def scan_manifest_path(self) -> Path:
        return self.data_dir / "scan_manifest.json"


def _read_toml(path: Path) -> dict:
    with path.open("rb") as fh:
        return tomllib.load(fh)


def _write_toml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        tomli_w.dump(data, fh)


def _merge_defaults(cfg: dict) -> dict:
    merged = {}
    for section, section_defaults in DEFAULT_COLLECTION_CONFIG.items():
        user_section = cfg.get(section) or {}
        merged_section = dict(section_defaults)
        for key, user_val in user_section.items():
            default_val = section_defaults.get(key)
            if isinstance(default_val, dict) and isinstance(user_val, dict):
                merged_section[key] = {**default_val, **user_val}
            else:
                merged_section[key] = user_val
        merged[section] = merged_section
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


def update_collection_config(name: str, section: str, updates: dict) -> None:
    """Merge updates into one section of a collection's TOML config."""
    cfg_path = collection_config_path(name)
    cfg = _read_toml(cfg_path) if cfg_path.exists() else {}
    cfg.setdefault(section, {}).update(updates)
    _write_toml(cfg_path, cfg)


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
