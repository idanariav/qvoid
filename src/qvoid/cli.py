from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .classifier import Classifier
from .config import (
    list_collections,
    load_collection,
    register_collection,
    remove_collection,
    resolve_collection,
    update_collection_config,
)
from .indexer import build_index, read_jsonl, write_jsonl
from .paths import collection_config_path


def cmd_init(args: argparse.Namespace) -> int:
    path = Path(args.path).expanduser().resolve()
    if not path.is_dir():
        print(f"Path does not exist or is not a directory: {path}", file=sys.stderr)
        return 1
    register_collection(args.name, path)
    cfg_path = collection_config_path(args.name)
    print(f"Registered collection {args.name!r} → {path}")
    print(f"Config: {cfg_path}")
    print("Edit the config or use `qvoid collection` to tune origin_folders, annotations, etc.")
    return 0


def cmd_collections(args: argparse.Namespace) -> int:
    if args.remove:
        if remove_collection(args.remove):
            print(f"Removed collection {args.remove!r}")
            return 0
        print(f"No collection named {args.remove!r}", file=sys.stderr)
        return 1

    cols = list_collections()
    if not cols:
        print("No collections registered. Run `qvoid init --name <n> --path <vault>`.")
        return 0
    width = max(len(n) for n in cols)
    for name, entry in cols.items():
        print(f"  {name:<{width}}  {entry['path']}")
    return 0


def cmd_index(args: argparse.Namespace) -> int:
    col = resolve_collection(args.collection)
    classifier = Classifier(col.config)

    print(f"Indexing collection {col.name!r} at {col.path}", file=sys.stderr)
    col.data_dir.mkdir(parents=True, exist_ok=True)
    links = build_index(
        col.path,
        col.config,
        classifier,
        existing_jsonl=col.jsonl_path,
        scan_manifest_path=col.scan_manifest_path,
    )
    write_jsonl(links, col.jsonl_path)
    print(f"Wrote {len(links)} records → {col.jsonl_path}", file=sys.stderr)
    return 0


def cmd_collection(args: argparse.Namespace) -> int:
    try:
        col = load_collection(args.name)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.origin_folders is not None:
        folders = args.origin_folders
        update_collection_config(args.name, "source", {"origin_folders": folders})
        if folders:
            print(f"origin_folders for {args.name!r} set to: {folders}")
        else:
            print(f"origin_folders for {args.name!r} cleared (all folders indexed).")
        return 0

    # No action flag — show current settings
    src = col.config.get("source", {})
    clf = col.config.get("classifier", {})
    print(f"Collection:       {col.name}")
    print(f"Vault path:       {col.path}")
    print(f"origin_folders:   {src.get('origin_folders', []) or '(all folders)'}")
    print(f"citation_folders: {clf.get('citation_folders', []) or '(none)'}")
    print(f"person_prefix:    {clf.get('person_prefix', '@')!r}")
    print(f"annotation_pattern: {src.get('annotation_pattern', '')!r}")
    return 0


def cmd_embed(args: argparse.Namespace) -> int:
    col = resolve_collection(args.collection)
    if not col.jsonl_path.exists():
        print(f"No index found for collection {col.name!r}. Run `qvoid index` first.", file=sys.stderr)
        return 1

    from .embeddings import build_vectors

    links = read_jsonl(col.jsonl_path)
    model_name = col.config["embeddings"]["model"]
    print(f"Embedding {len(links)} records with {model_name}...", file=sys.stderr)
    build_vectors(iter(links), col.vectors_path, col.manifest_path, model_name)
    print(f"Wrote vectors → {col.vectors_path}", file=sys.stderr)
    return 0


def _match_origin(link: dict, origin: str) -> bool:
    return any(occ["source"].startswith(origin) for occ in link["occurrences"])


def _match_semantic(link: dict, semantic: str) -> bool:
    return any(occ.get("semantic_type") == semantic for occ in link["occurrences"])


def _match_search(link: dict, q: str) -> bool:
    q = q.lower()
    if q in link["normalized"]:
        return True
    for occ in link["occurrences"]:
        if q in occ["context_before"].lower() or q in occ["context_after"].lower():
            return True
    return False


def cmd_query(args: argparse.Namespace) -> int:
    col = resolve_collection(args.collection)
    if not col.jsonl_path.exists():
        print(f"No index found for collection {col.name!r}. Run `qvoid index` first.", file=sys.stderr)
        return 1

    links = read_jsonl(col.jsonl_path)

    def keep(link: dict) -> bool:
        if args.origin and not _match_origin(link, args.origin):
            return False
        if args.destination and link["expected_destination"] != args.destination:
            return False
        if args.semantic_type and not _match_semantic(link, args.semantic_type):
            return False
        if args.min_occurrences and link["stats"]["total_occurrences"] < args.min_occurrences:
            return False
        if args.search and not _match_search(link, args.search):
            return False
        return True

    filtered = [link for link in links if keep(link)]
    filtered.sort(key=lambda link: (-link["stats"]["total_occurrences"], link["target"]))
    if args.limit:
        filtered = filtered[:args.limit]

    if args.format == "json":
        for link in filtered:
            print(json.dumps(link, ensure_ascii=False))
        return 0

    if args.format == "summary":
        print(f"{'count':>5}  {'class':<10}  {'conf':<7}  target")
        print("-" * 80)
        for link in filtered:
            print(f"{link['stats']['total_occurrences']:>5}  "
                  f"{link['expected_destination']:<10}  "
                  f"{link['classification_confidence']:<7}  "
                  f"{link['target']}")
        print(f"\n{len(filtered)} of {len(links)} targets match.", file=sys.stderr)
        return 0

    # detailed
    for link in filtered:
        print(f"\n=== {link['target']}  ({link['expected_destination']}, "
              f"{link['classification_confidence']} confidence, "
              f"{link['stats']['total_occurrences']}x)")
        for occ in link["occurrences"]:
            loc = f"{occ['source']}:{occ['line']}"
            tag = f" [{occ['semantic_type']}]" if occ.get("semantic_type") else ""
            alias = f" |{occ['alias']}" if occ.get("alias") else ""
            print(f"  {loc}{tag}{alias}")
            ctx = f"    …{occ['context_before']} [[{link['target']}{alias}]] {occ['context_after']}…"
            print(ctx)
    print(f"\n{len(filtered)} of {len(links)} targets match.", file=sys.stderr)
    return 0


def cmd_find_similar(args: argparse.Namespace) -> int:
    col = resolve_collection(args.collection)
    if not col.vectors_path.exists() or not col.manifest_path.exists():
        print(f"No vector index for collection {col.name!r}. Run `qvoid index` first.", file=sys.stderr)
        return 1

    from .embeddings import cluster_duplicates, find_similar

    if args.cluster:
        groups = cluster_duplicates(col.vectors_path, col.manifest_path, threshold=args.threshold)
        groups.sort(key=lambda g: -len(g))
        for g in groups:
            print(f"\n--- cluster ({len(g)} targets)")
            for t in g:
                print(f"  {t}")
        print(f"\n{len(groups)} clusters at threshold {args.threshold}.", file=sys.stderr)
        return 0

    if not args.query:
        print("Provide a query target or free-text string, or pass --cluster.", file=sys.stderr)
        return 1

    results = find_similar(
        args.query, col.vectors_path, col.manifest_path,
        top_k=args.top_k, min_score=args.min_score,
    )
    if not results:
        print("No matches above threshold.", file=sys.stderr)
        return 0
    print(f"Top {len(results)} similar targets to: {args.query!r}")
    for target, score in results:
        print(f"  {score:.3f}  {target}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="qvoid",
        description="Index, query, and dedup unresolved wikilinks in Obsidian-style vaults.",
    )
    sub = p.add_subparsers(dest="subcommand", required=True)

    pi = sub.add_parser("init", help="Register a new collection.")
    pi.add_argument("--name", required=True, help="Short identifier for this collection.")
    pi.add_argument("--path", required=True, help="Absolute path to the vault root.")
    pi.set_defaults(func=cmd_init)

    pc = sub.add_parser("collections", help="List or remove registered collections.")
    pc.add_argument("--remove", metavar="NAME", help="Remove a registered collection.")
    pc.set_defaults(func=cmd_collections)

    pcol = sub.add_parser("collection", help="Show or configure a specific collection.")
    pcol.add_argument("name", help="Collection name.")
    pcol.add_argument(
        "--origin-folders",
        nargs="*",
        metavar="FOLDER",
        dest="origin_folders",
        help=(
            "Set which vault folders are scanned for unresolved links. "
            "Pass one or more folder prefixes (relative to vault root). "
            "Pass no folders to clear the filter and index everything."
        ),
    )
    pcol.set_defaults(func=cmd_collection)

    pidx = sub.add_parser("index", help="Build/refresh the index for a collection.")
    pidx.add_argument("--collection", help="Collection name (default: CWD-detected or single registered).")
    pidx.set_defaults(func=cmd_index)

    pe = sub.add_parser("embed", help="Build/refresh embeddings from an existing index.")
    pe.add_argument("--collection", help="Collection name (default: CWD-detected or single registered).")
    pe.set_defaults(func=cmd_embed)

    pq = sub.add_parser("query", help="Filter the index by origin, destination, semantic type, etc.")
    pq.add_argument("--collection")
    pq.add_argument("--origin", help="Source path prefix (e.g. Content/Claims).")
    pq.add_argument("--destination", choices=["person", "date", "idea", "file", "template", "unknown"])
    pq.add_argument("--semantic-type", help="Match inline annotation (Supports, Related, Jump, …).")
    pq.add_argument("--min-occurrences", type=int)
    pq.add_argument("--search", help="Substring match on target or surrounding context.")
    pq.add_argument("--limit", type=int)
    pq.add_argument("--format", choices=["summary", "detailed", "json"], default="summary")
    pq.set_defaults(func=cmd_query)

    pf = sub.add_parser("find-similar", help="Find semantically similar unresolved targets.")
    pf.add_argument("query", nargs="?", help="Existing target or free-text description.")
    pf.add_argument("--collection")
    pf.add_argument("--top-k", type=int, default=10)
    pf.add_argument("--min-score", type=float, default=0.5)
    pf.add_argument("--cluster", action="store_true", help="Emit all suspected-duplicate groups.")
    pf.add_argument("--threshold", type=float, default=0.82, help="Cosine-similarity threshold for clustering.")
    pf.set_defaults(func=cmd_find_similar)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
