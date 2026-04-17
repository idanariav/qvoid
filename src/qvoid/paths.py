from __future__ import annotations

import os
from pathlib import Path


def config_dir() -> Path:
    xdg = os.environ.get("XDG_CONFIG_HOME")
    base = Path(xdg) if xdg else Path.home() / ".config"
    return base / "qvoid"


def data_dir() -> Path:
    xdg = os.environ.get("XDG_DATA_HOME")
    base = Path(xdg) if xdg else Path.home() / ".local" / "share"
    return base / "qvoid"


def registry_path() -> Path:
    return config_dir() / "collections.toml"


def collection_config_path(name: str) -> Path:
    return config_dir() / "collections" / f"{name}.toml"


def collection_data_dir(name: str) -> Path:
    return data_dir() / name
