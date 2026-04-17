from __future__ import annotations

import re
from typing import Iterable

from .models import Occurrence, TitleFeatures

DATE_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$|^\d{4}-W\d{2}$|^\d{4}-Q[1-4]$")
YEAR_IN_PARENS_RE = re.compile(r"\(\d{4}\)")
TEMPLATE_SYNTAX_RE = re.compile(r"<%|%>|\{\{|\}\}")
CAMELCASE_RE = re.compile(r"^[A-Z][a-z]+([A-Z][a-z]+)+$")
ET_AL_RE = re.compile(r"\bet\s+al\.?", re.IGNORECASE)
FILE_EXT_RE = re.compile(r"\.(webp|png|jpe?g|gif|svg|excalidraw|pdf|mp4|mov|mp3|wav|zip)$", re.IGNORECASE)


def title_features(target: str) -> TitleFeatures:
    words = target.split()
    return TitleFeatures(
        word_count=len(words),
        has_person_prefix=target.startswith("@"),
        is_date=bool(DATE_RE.match(target.strip())),
        is_all_caps=target.isupper() and any(c.isalpha() for c in target),
        is_short_camelcase=len(words) == 1 and bool(CAMELCASE_RE.match(target)),
        has_year_in_parens=bool(YEAR_IN_PARENS_RE.search(target)),
        has_template_syntax=bool(TEMPLATE_SYNTAX_RE.search(target)),
    )


def _heuristic_class(target: str, feats: TitleFeatures) -> tuple[str, str]:
    """Pass 1: title-only heuristics. Returns (class, confidence)."""
    t = target.strip()

    if feats.has_template_syntax:
        return "util", "high"
    if FILE_EXT_RE.search(t) or "/" in t:
        return "util", "high"
    if feats.has_person_prefix:
        return "person", "high"
    if feats.is_date:
        return "date", "high"
    if feats.is_all_caps or feats.has_year_in_parens or ET_AL_RE.search(t):
        return "source", "high"
    if feats.is_short_camelcase:
        return "util", "medium"
    if feats.word_count >= 4 and t[:1].isupper() and not t.isupper():
        return "claim", "medium"
    if 1 <= feats.word_count <= 3:
        return "concept", "low"
    return "unknown", "low"


class Classifier:
    """Two-pass classifier. Vault-specific conventions (semantic annotations,
    citation folders) come from the collection config — nothing hardcoded here."""

    def __init__(self, config: dict):
        cc = config.get("classifier", {}) if config else {}
        self.citation_folders: tuple[str, ...] = tuple(cc.get("citation_folders", []))
        self.claim_annotations: frozenset[str] = frozenset(cc.get("claim_annotations", []))
        self.claim_or_concept_annotations: frozenset[str] = frozenset(cc.get("claim_or_concept_annotations", []))

    def _context_signals(self, occurrences: Iterable[Occurrence]) -> dict[str, int]:
        signals = {"claim": 0, "concept": 0, "source": 0}
        for occ in occurrences:
            if occ.semantic_type in self.claim_annotations:
                signals["claim"] += 3
            elif occ.semantic_type in self.claim_or_concept_annotations:
                signals["claim"] += 1
                signals["concept"] += 1
            if self.citation_folders and any(
                occ.source_folder.startswith(sf) for sf in self.citation_folders
            ) and not occ.semantic_type:
                signals["source"] += 1
        return signals

    def classify(self, target: str, occurrences: list[Occurrence]) -> tuple[str, str, TitleFeatures]:
        feats = title_features(target)
        base_class, base_conf = _heuristic_class(target, feats)

        if base_conf == "high":
            return base_class, base_conf, feats

        signals = self._context_signals(occurrences)
        if not any(signals.values()):
            return base_class, base_conf, feats

        winner = max(signals.items(), key=lambda kv: kv[1])
        if winner[1] == 0:
            return base_class, base_conf, feats

        boosted_class = winner[0]
        if boosted_class == base_class:
            return base_class, "high", feats
        if base_conf == "low":
            return boosted_class, "medium", feats
        if {base_class, boosted_class} <= {"claim", "concept"}:
            return boosted_class, "medium", feats
        return base_class, base_conf, feats
