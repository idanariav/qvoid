from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class Occurrence:
    source: str
    source_folder: str
    line: int
    alias: Optional[str]
    semantic_type: Optional[str]
    context_before: str
    context_after: str

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TitleFeatures:
    word_count: int
    has_person_prefix: bool
    is_date: bool
    is_all_caps: bool
    is_short_camelcase: bool
    has_year_in_parens: bool
    has_template_syntax: bool

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class UnresolvedLink:
    target: str
    normalized: str
    expected_destination: str
    classification_confidence: str
    title_features: TitleFeatures
    occurrences: list[Occurrence] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["stats"] = {
            "total_occurrences": len(self.occurrences),
            "unique_source_folders": len({o.source_folder for o in self.occurrences}),
            "semantic_types": sorted({o.semantic_type for o in self.occurrences if o.semantic_type}),
        }
        return d
