from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterator

from .classifier import Classifier
from .models import Occurrence, UnresolvedLink

WIKILINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")
ANNOTATION_RE = re.compile(r"\(([A-Za-z]+)::\s*$")

CONTEXT_CHAR_WINDOW = 200
SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")


def _normalize(target: str) -> str:
    return re.sub(r"\s+", " ", target.strip().lower())


def _parse_wikilink(raw: str) -> tuple[str, str | None]:
    """Split [[target|alias]] / [[target#section]] / [[target^block]] into (target, alias)."""
    target = raw
    alias: str | None = None
    if "|" in target:
        target, alias = target.split("|", 1)
        alias = alias.strip()
    for sep in ("#", "^"):
        if sep in target:
            target = target.split(sep, 1)[0]
    return target.strip(), alias


def _extract_context(line: str, link_start: int, link_end: int) -> tuple[str, str]:
    before_raw = line[:link_start].rstrip()
    after_raw = line[link_end:].lstrip()

    before = before_raw[-CONTEXT_CHAR_WINDOW:]
    sentences_before = SENTENCE_BOUNDARY_RE.split(before)
    if len(sentences_before) > 1:
        before = sentences_before[-1]

    after = after_raw[:CONTEXT_CHAR_WINDOW]
    sentences_after = SENTENCE_BOUNDARY_RE.split(after)
    if len(sentences_after) > 1:
        after = sentences_after[0]

    return before.strip(), after.strip()


def _extract_semantic_type(line: str, link_start: int) -> str | None:
    segment = line[max(0, link_start - 40):link_start]
    m = ANNOTATION_RE.search(segment)
    return m.group(1) if m else None


def _source_folder(source_path: str) -> str:
    parts = source_path.split("/", 2)
    if len(parts) >= 2:
        return "/".join(parts[:2])
    return parts[0]


def run_source(vault_root: Path, config: dict) -> list[dict]:
    """Invoke the configured link source and return [{link, sources}] records.

    Currently only `obsidian` is supported. The source runs against the vault
    that's actively focused in Obsidian — we rely on that rather than passing
    vault=<name>, which would require users to register a name.
    """
    src = (config.get("source") or {}).get("type", "obsidian")
    if src != "obsidian":
        raise RuntimeError(f"Unsupported source type: {src!r}. Only 'obsidian' is implemented.")
    result = subprocess.run(
        ["obsidian", "unresolved", "verbose", "format=json"],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(vault_root),
    )
    return json.loads(result.stdout)


def _build_source_to_targets(records: list[dict]) -> dict[str, set[str]]:
    mapping: dict[str, set[str]] = defaultdict(set)
    for rec in records:
        sources = [s.strip() for s in rec["sources"].split(",") if s.strip()]
        for src in sources:
            mapping[src].add(rec["link"])
    return mapping


def _scan_file(vault_root: Path, rel_path: str, expected_targets: set[str]) -> Iterator[tuple[str, Occurrence]]:
    abs_path = vault_root / rel_path
    try:
        with abs_path.open("r", encoding="utf-8", errors="replace") as fh:
            for line_no, line in enumerate(fh, start=1):
                for match in WIKILINK_RE.finditer(line):
                    raw = match.group(1)
                    target, alias = _parse_wikilink(raw)
                    if target not in expected_targets:
                        continue
                    ctx_before, ctx_after = _extract_context(line, match.start(), match.end())
                    sem = _extract_semantic_type(line, match.start())
                    yield target, Occurrence(
                        source=rel_path,
                        source_folder=_source_folder(rel_path),
                        line=line_no,
                        alias=alias,
                        semantic_type=sem,
                        context_before=ctx_before,
                        context_after=ctx_after,
                    )
    except FileNotFoundError:
        return


def build_index(vault_root: Path, config: dict, classifier: Classifier) -> list[UnresolvedLink]:
    records = run_source(vault_root, config)
    source_to_targets = _build_source_to_targets(records)

    occurrences_by_target: dict[str, list[Occurrence]] = defaultdict(list)
    total_files = len(source_to_targets)
    for i, (source, targets) in enumerate(source_to_targets.items(), start=1):
        if i % 500 == 0:
            print(f"  scanning files: {i}/{total_files}", file=sys.stderr)
        for target, occ in _scan_file(vault_root, source, targets):
            occurrences_by_target[target].append(occ)

    all_targets = {rec["link"] for rec in records}
    links: list[UnresolvedLink] = []
    for target in sorted(all_targets):
        occs = occurrences_by_target.get(target, [])
        cls, conf, feats = classifier.classify(target, occs)
        links.append(UnresolvedLink(
            target=target,
            normalized=_normalize(target),
            expected_destination=cls,
            classification_confidence=conf,
            title_features=feats,
            occurrences=occs,
        ))
    return links


def write_jsonl(links: list[UnresolvedLink], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for link in links:
            fh.write(json.dumps(link.to_dict(), ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]
