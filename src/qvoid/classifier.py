from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Iterable

from .models import Occurrence, TitleFeatures

DATE_RE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$|^\d{4}-W\d{2}$|^\d{4}-Q[1-4]$")
YEAR_IN_PARENS_RE = re.compile(r"\(\d{4}\)")
TEMPLATE_SYNTAX_RE = re.compile(r"<%|%>|\{\{|\}\}")
CAMELCASE_RE = re.compile(r"^[A-Z][a-z]+([A-Z][a-z]+)+$")
ET_AL_RE = re.compile(r"\bet\s+al\.?", re.IGNORECASE)
FILE_EXT_RE = re.compile(r"\.\w+$")

TYPES = frozenset(["person", "date", "idea", "file", "template", "unknown"])


@dataclass
class Heuristics:
    date: bool = True
    person: bool = True
    file_extensions: bool = True   # targets with a file extension or "/" → file
    camelcase: bool = True         # CamelCase single word → file (medium confidence)
    template: bool = True          # template syntax → template
    capitalization: bool = True    # ALL-CAPS, (YEAR), et al. → high-confidence idea
    min_words_for_idea: int = 4    # ≥ N title-case words → medium-confidence idea; 0 = disabled


def _heuristics_from_config(cc: dict) -> Heuristics:
    h = cc.get("heuristics") or {}
    return Heuristics(
        date=h.get("date", True),
        person=h.get("person", True),
        file_extensions=h.get("file_extensions", True),
        camelcase=h.get("camelcase", True),
        template=h.get("template", True),
        capitalization=h.get("capitalization", True),
        min_words_for_idea=h.get("min_words_for_idea", 4),
    )


def title_features(target: str, person_prefix: str = "@") -> TitleFeatures:
    words = target.split()
    return TitleFeatures(
        word_count=len(words),
        has_person_prefix=bool(person_prefix) and target.startswith(person_prefix),
        is_date=bool(DATE_RE.match(target.strip())),
        is_all_caps=target.isupper() and any(c.isalpha() for c in target),
        is_short_camelcase=len(words) == 1 and bool(CAMELCASE_RE.match(target)),
        has_year_in_parens=bool(YEAR_IN_PARENS_RE.search(target)),
        has_template_syntax=bool(TEMPLATE_SYNTAX_RE.search(target)),
    )


def _heuristic_class(target: str, feats: TitleFeatures, h: Heuristics) -> tuple[str, str]:
    """Pass 1: title-only heuristics → (type, confidence)."""
    t = target.strip()

    if h.template and feats.has_template_syntax:
        return "template", "high"
    if h.file_extensions and (FILE_EXT_RE.search(t) or "/" in t):
        return "file", "high"
    if h.person and feats.has_person_prefix:
        return "person", "high"
    if h.date and feats.is_date:
        return "date", "high"
    if h.capitalization and (feats.is_all_caps or feats.has_year_in_parens or ET_AL_RE.search(t)):
        return "idea", "high"
    if h.camelcase and feats.is_short_camelcase:
        return "file", "medium"
    if h.min_words_for_idea > 0 and feats.word_count >= h.min_words_for_idea and t[:1].isupper() and not t.isupper():
        return "idea", "medium"
    if feats.word_count >= 1:
        return "idea", "low"
    return "unknown", "low"


class Classifier:
    def __init__(self, config: dict):
        cc = config.get("classifier", {}) if config else {}
        self.citation_folders: tuple[str, ...] = tuple(cc.get("citation_folders", []))
        self.claim_annotations: frozenset[str] = frozenset(cc.get("claim_annotations", []))
        self.idea_annotations: frozenset[str] = frozenset(cc.get("claim_or_concept_annotations", []))
        self.person_prefix: str = cc.get("person_prefix", "@")
        self.heuristics: Heuristics = _heuristics_from_config(cc)

    def _context_boost(self, occurrences: Iterable[Occurrence]) -> int:
        """Score how strongly context signals suggest this is an idea worth capturing."""
        score = 0
        for occ in occurrences:
            if occ.semantic_type in self.claim_annotations:
                score += 3
            elif occ.semantic_type in self.idea_annotations:
                score += 1
            if (
                self.citation_folders
                and any(occ.source_folder.startswith(sf) for sf in self.citation_folders)
                and not occ.semantic_type
            ):
                score += 1
        return score

    def classify(self, target: str, occurrences: list[Occurrence]) -> tuple[str, str, TitleFeatures]:
        feats = title_features(target, self.person_prefix)
        base_class, base_conf = _heuristic_class(target, feats, self.heuristics)

        if base_conf == "high":
            return base_class, base_conf, feats

        boost = self._context_boost(occurrences)
        if boost == 0:
            return base_class, base_conf, feats

        # Context signals always upgrade toward "idea"
        if boost >= 3:
            return "idea", "high", feats
        return "idea", "medium", feats
