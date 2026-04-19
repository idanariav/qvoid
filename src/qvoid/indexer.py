from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Iterable, Iterator

from .classifier import Classifier
from .models import Occurrence, TitleFeatures, UnresolvedLink

WIKILINK_RE = re.compile(r"\[\[([^\[\]]+?)\]\]")
CONTEXT_CHAR_WINDOW = 200
SENTENCE_BOUNDARY_RE = re.compile(r"(?<=[.!?])\s+")
DEFAULT_ANNOTATION_PATTERN = r"\(([A-Za-z]+)::\s*$"


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


def _extract_semantic_type(line: str, link_start: int, annotation_re: re.Pattern | None) -> str | None:
    if annotation_re is None:
        return None
    segment = line[max(0, link_start - 40):link_start]
    m = annotation_re.search(segment)
    return m.group(1) if m else None


def _source_folder(source_path: str) -> str:
    parts = source_path.split("/", 2)
    if len(parts) >= 2:
        return "/".join(parts[:2])
    return parts[0]


def _compile_annotation_pattern(raw_pattern: str) -> re.Pattern | None:
    if not raw_pattern:
        return None
    try:
        return re.compile(raw_pattern)
    except re.error as exc:
        raise RuntimeError(
            f"Invalid annotation_pattern {raw_pattern!r} in collection config: {exc}"
        ) from exc


def _walk_vault(vault_root: Path) -> tuple[dict[str, float], set[str]]:
    """Walk vault .md files. Returns ({rel_path: mtime}, resolved_stems)."""
    file_mtimes: dict[str, float] = {}
    resolved_stems: set[str] = set()
    for p in vault_root.rglob("*.md"):
        rel = str(p.relative_to(vault_root))
        file_mtimes[rel] = p.stat().st_mtime
        resolved_stems.add(p.stem.lower())
    return file_mtimes, resolved_stems


def _is_resolved(target: str, resolved_stems: set[str], vault_root: Path) -> bool:
    simple_name = target.split("/")[-1].lower()
    return (
        simple_name in resolved_stems
        or (vault_root / target).with_suffix(".md").exists()
    )


def _extract_unresolved_from_files(
    vault_root: Path,
    rel_paths: Iterable[str],
    resolved_stems: set[str],
    exclude_extensions: frozenset[str] = frozenset(),
) -> dict[str, set[str]]:
    """Return {target -> set(source_rel_path)} for unresolved links in the given files."""
    target_to_sources: dict[str, set[str]] = defaultdict(set)
    for rel_path in rel_paths:
        abs_path = vault_root / rel_path
        try:
            text = abs_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in WIKILINK_RE.finditer(text):
            target, _ = _parse_wikilink(match.group(1))
            if not target:
                continue
            if exclude_extensions:
                ext = Path(target).suffix.lower()
                if ext in exclude_extensions:
                    continue
            if not _is_resolved(target, resolved_stems, vault_root):
                target_to_sources[target].add(rel_path)
    return target_to_sources


def _invert_to_source_targets(target_to_sources: dict[str, set[str]]) -> dict[str, set[str]]:
    result: dict[str, set[str]] = defaultdict(set)
    for target, srcs in target_to_sources.items():
        for src in srcs:
            result[src].add(target)
    return result


def _scan_file(
    vault_root: Path,
    rel_path: str,
    expected_targets: set[str],
    annotation_re: re.Pattern | None,
) -> Iterator[tuple[str, Occurrence]]:
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
                    sem = _extract_semantic_type(line, match.start(), annotation_re)
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


def _load_scan_manifest(path: Path) -> dict[str, float]:
    if not path.exists():
        return {}
    with path.open() as f:
        return json.load(f)


def _save_scan_manifest(path: Path, file_mtimes: dict[str, float]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        json.dump(file_mtimes, f)


def _occ_from_dict(d: dict) -> Occurrence:
    return Occurrence(
        source=d["source"],
        source_folder=d["source_folder"],
        line=d["line"],
        alias=d.get("alias"),
        semantic_type=d.get("semantic_type"),
        context_before=d["context_before"],
        context_after=d["context_after"],
    )


def _link_from_dict(d: dict) -> UnresolvedLink:
    return UnresolvedLink(
        target=d["target"],
        normalized=d["normalized"],
        expected_destination=d["expected_destination"],
        classification_confidence=d["classification_confidence"],
        title_features=TitleFeatures(**d["title_features"]),
        occurrences=[_occ_from_dict(o) for o in d["occurrences"]],
    )


def _full_build(
    vault_root: Path,
    current_files: dict[str, float],
    resolved_stems: set[str],
    annotation_re: re.Pattern | None,
    origin_folders: list[str],
    exclude_extensions: frozenset[str],
    exclude_types: frozenset[str],
    classifier: Classifier,
) -> list[UnresolvedLink]:
    files_to_scan = list(current_files.keys())
    if origin_folders:
        files_to_scan = [f for f in files_to_scan if any(f.startswith(p) for p in origin_folders)]

    target_to_sources = _extract_unresolved_from_files(vault_root, files_to_scan, resolved_stems, exclude_extensions)
    source_to_targets = _invert_to_source_targets(target_to_sources)

    occurrences_by_target: dict[str, list[Occurrence]] = defaultdict(list)
    total = len(source_to_targets)
    for i, (source, targets) in enumerate(source_to_targets.items(), start=1):
        if i % 500 == 0:
            print(f"  scanning files: {i}/{total}", file=sys.stderr)
        for target, occ in _scan_file(vault_root, source, targets, annotation_re):
            occurrences_by_target[target].append(occ)

    links: list[UnresolvedLink] = []
    for target in sorted(target_to_sources.keys()):
        occs = occurrences_by_target.get(target, [])
        cls, conf, feats = classifier.classify(target, occs)
        if cls in exclude_types:
            continue
        links.append(UnresolvedLink(
            target=target,
            normalized=_normalize(target),
            expected_destination=cls,
            classification_confidence=conf,
            title_features=feats,
            occurrences=occs,
        ))
    return links


def _incremental_build(
    vault_root: Path,
    current_files: dict[str, float],
    resolved_stems: set[str],
    old_manifest: dict[str, float],
    annotation_re: re.Pattern | None,
    origin_folders: list[str],
    exclude_extensions: frozenset[str],
    exclude_types: frozenset[str],
    classifier: Classifier,
    *,
    existing_jsonl: Path,
) -> list[UnresolvedLink]:
    changed = [p for p in current_files if p not in old_manifest or current_files[p] != old_manifest[p]]
    deleted = [p for p in old_manifest if p not in current_files]
    stale_sources = set(changed) | set(deleted)

    if not stale_sources:
        print("  index is up to date, nothing to rescan.", file=sys.stderr)
        return [_link_from_dict(d) for d in read_jsonl(existing_jsonl)]

    print(f"  {len(changed)} modified/new, {len(deleted)} deleted source files.", file=sys.stderr)

    old_links_raw = read_jsonl(existing_jsonl)

    # Rebuild occurrence map from existing data, dropping stale sources and resolved targets
    occurrences_by_target: dict[str, list[Occurrence]] = {}
    old_classification: dict[str, tuple[str, str, TitleFeatures]] = {}
    for link in old_links_raw:
        target = link["target"]
        if _is_resolved(target, resolved_stems, vault_root):
            continue
        kept = [_occ_from_dict(o) for o in link["occurrences"] if o["source"] not in stale_sources]
        occurrences_by_target[target] = kept
        old_classification[target] = (
            link["expected_destination"],
            link["classification_confidence"],
            TitleFeatures(**link["title_features"]),
        )

    # Determine which old targets were touched by stale sources (need reclassification)
    targets_stale = {
        link["target"]
        for link in old_links_raw
        for o in link["occurrences"]
        if o["source"] in stale_sources
    }

    # Rescan only changed files (not deleted — those are gone)
    files_to_rescan = changed
    if origin_folders:
        files_to_rescan = [f for f in files_to_rescan if any(f.startswith(p) for p in origin_folders)]

    new_target_to_sources = _extract_unresolved_from_files(vault_root, files_to_rescan, resolved_stems, exclude_extensions)
    targets_stale |= set(new_target_to_sources.keys())

    new_source_to_targets = _invert_to_source_targets(new_target_to_sources)
    for source, targets in new_source_to_targets.items():
        for target, occ in _scan_file(vault_root, source, targets, annotation_re):
            occurrences_by_target.setdefault(target, []).append(occ)

    links: list[UnresolvedLink] = []
    for target in sorted(occurrences_by_target.keys()):
        occs = occurrences_by_target[target]
        if target in targets_stale or target not in old_classification:
            cls, conf, feats = classifier.classify(target, occs)
        else:
            cls, conf, feats = old_classification[target]
        if cls in exclude_types:
            continue
        links.append(UnresolvedLink(
            target=target,
            normalized=_normalize(target),
            expected_destination=cls,
            classification_confidence=conf,
            title_features=feats,
            occurrences=occs,
        ))
    return links


def build_index(
    vault_root: Path,
    config: dict,
    classifier: Classifier,
    *,
    existing_jsonl: Path | None = None,
    scan_manifest_path: Path | None = None,
) -> list[UnresolvedLink]:
    source_cfg = config.get("source") or {}
    classifier_cfg = config.get("classifier") or {}
    annotation_re = _compile_annotation_pattern(
        source_cfg.get("annotation_pattern", DEFAULT_ANNOTATION_PATTERN)
    )
    origin_folders: list[str] = source_cfg.get("origin_folders", [])
    exclude_extensions: frozenset[str] = frozenset(
        e.lower() for e in source_cfg.get("exclude_extensions", [])
    )
    exclude_types: frozenset[str] = frozenset(classifier_cfg.get("exclude_types", []))

    current_files, resolved_stems = _walk_vault(vault_root)

    old_manifest: dict[str, float] = {}
    if scan_manifest_path is not None:
        old_manifest = _load_scan_manifest(scan_manifest_path)

    incremental = (
        bool(old_manifest)
        and existing_jsonl is not None
        and existing_jsonl.exists()
    )

    if incremental:
        links = _incremental_build(
            vault_root, current_files, resolved_stems, old_manifest,
            annotation_re, origin_folders, exclude_extensions, exclude_types, classifier,
            existing_jsonl=existing_jsonl,  # type: ignore[arg-type]
        )
    else:
        links = _full_build(
            vault_root, current_files, resolved_stems,
            annotation_re, origin_folders, exclude_extensions, exclude_types, classifier,
        )

    if scan_manifest_path is not None:
        _save_scan_manifest(scan_manifest_path, current_files)

    return links


def write_jsonl(links: list[UnresolvedLink], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as fh:
        for link in links:
            fh.write(json.dumps(link.to_dict(), ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]
