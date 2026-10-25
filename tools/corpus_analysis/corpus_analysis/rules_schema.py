"""The generation-rules contract (``server/urt/rules/<subject>.yaml``, ``schema_version: 1``).

These pydantic models are the single definition of the contract: ``rules.schema.json`` is
exported from them for the Node runtime (ajv), and the Python tooling validates with them
directly. See PLAN.md §5.3.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Subject = Literal["physics", "chemistry", "geology", "biology", "english"]
Difficulty = Literal["easy", "medium", "hard"]
# Only kinds the client can render from structured data; diagrams/photos are described in anti_patterns.
FigureKind = Literal["table", "line_chart", "bar_chart", "scatter_plot"]

SCHEMA_VERSION = 1


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class IntRange(_Strict):
    min: int = Field(ge=0)
    max: int = Field(ge=0)

    @model_validator(mode="after")
    def _ordered(self) -> "IntRange":
        if self.min > self.max:
            raise ValueError(f"min {self.min} > max {self.max}")
        return self


class NumRange(_Strict):
    min: float
    max: float
    p50: float | None = None

    @model_validator(mode="after")
    def _ordered(self) -> "NumRange":
        if self.min > self.max:
            raise ValueError(f"min {self.min} > max {self.max}")
        return self


class GeneratedFrom(_Strict):
    corpus_passages: int = Field(ge=0)
    analysis_prompt: str
    synthesized_at: str
    sources: list[str] = Field(description="Source file names only; no source text")
    provenance: str = Field(description="What the sources are (official URT papers, prep books, …) and caveats")


class Sampling(_Strict):
    variety_alpha: float = Field(gt=0, le=1, description="p ∝ weight^alpha; < 1 flattens toward rarer topics")
    recent_topic_window: int = Field(ge=0)
    recent_topic_penalty: float = Field(ge=0, le=1)
    pool_balance_weight: float = Field(ge=0, le=1)


class Subtopic(_Strict):
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    label: str
    weight: float = Field(ge=0)


class Topic(_Strict):
    id: str = Field(pattern=r"^[a-z0-9_]+(\.[a-z0-9_]+)?$")
    label: str
    weight: float = Field(ge=0)
    subtopics: list[Subtopic] = Field(min_length=1)
    source_labels: list[str] = Field(default_factory=list,
                                     description="Raw analysis labels mapped to this topic (for review)")


class Style(_Strict):
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    label: str
    weight: float = Field(ge=0)
    structure: list[str] = Field(min_length=1, description="Paragraph/section order")
    description: str


class DifficultyLevel(_Strict):
    weight: float = Field(ge=0)
    definition: str
    passage_markers: list[str] = Field(min_length=1)
    question_markers: list[str] = Field(min_length=1)


class Combination(_Strict):
    style: str
    difficulty: Difficulty
    weight: float = Field(ge=0)


class FigureKindRule(_Strict):
    kind: FigureKind
    weight: float = Field(ge=0)
    rows: IntRange | None = None        # table
    columns: IntRange | None = None     # table
    series: IntRange | None = None      # charts
    points: IntRange | None = None      # charts, per series
    conventions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _shape(self) -> "FigureKindRule":
        if self.kind == "table" and (self.rows is None or self.columns is None):
            raise ValueError("table figures need rows and columns ranges")
        if self.kind != "table" and (self.series is None or self.points is None):
            raise ValueError(f"{self.kind} figures need series and points ranges")
        return self


class Figures(_Strict):
    probability: float = Field(ge=0, le=1, description="Share of passages with at least one figure")
    max_per_passage: int = Field(ge=1)
    kinds: list[FigureKindRule]


class QuestionType(_Strict):
    id: str = Field(pattern=r"^[a-z0-9_]+$")
    label: str
    share: float = Field(ge=0)
    skills: list[str] = Field(min_length=1)
    uses_figure: bool
    description: str


class QuestionCount(_Strict):
    min: int = Field(ge=1)
    max: int = Field(ge=1)
    typical: int = Field(ge=1)

    @model_validator(mode="after")
    def _ordered(self) -> "QuestionCount":
        if not self.min <= self.typical <= self.max:
            raise ValueError("question count must satisfy min <= typical <= max")
        return self


class QuestionSet(_Strict):
    count: QuestionCount
    options_per_question: int = Field(ge=2, le=6)
    types: list[QuestionType] = Field(min_length=1)
    answer_position_balance: bool
    stem_conventions: list[str] = Field(default_factory=list)


class Rules(_Strict):
    schema_version: Literal[1]
    rules_version: str = Field(pattern=r"^[a-z]+-\d{4}\.\d{2}\.\d+$")
    status: Literal["draft", "approved"]
    subject: Subject
    generated_from: GeneratedFrom
    sampling: Sampling
    topics: list[Topic] = Field(min_length=1)
    styles: list[Style] = Field(min_length=1)
    difficulty_levels: dict[Difficulty, DifficultyLevel]
    allowed_combinations: list[Combination] = Field(min_length=1)
    length_words: NumRange
    reading_level_grade: NumRange
    figures: Figures
    question_set: QuestionSet
    distractor_conventions: list[str] = Field(min_length=1)
    answer_conventions: list[str] = Field(min_length=1)
    anti_patterns: list[str] = Field(min_length=1)

    @model_validator(mode="after")
    def _consistent(self) -> "Rules":
        problems: list[str] = []
        if set(self.difficulty_levels) != {"easy", "medium", "hard"}:
            problems.append("difficulty_levels must define easy, medium and hard")
        if not self.rules_version.startswith(f"{self.subject}-"):
            problems.append(f"rules_version must start with '{self.subject}-'")
        groups = {
            "topics": [t.weight for t in self.topics],
            "styles": [s.weight for s in self.styles],
            "difficulty_levels": [d.weight for d in self.difficulty_levels.values()],
            "allowed_combinations": [c.weight for c in self.allowed_combinations],
            "question_set.types": [q.share for q in self.question_set.types],
        }
        if self.figures.probability > 0:
            groups["figures.kinds"] = [k.weight for k in self.figures.kinds]
        problems += [f"{name}: weights must sum to > 0" for name, ws in groups.items() if sum(ws) <= 0]
        problems += [f"topic {t.id}: subtopic weights must sum to > 0" for t in self.topics
                     if sum(s.weight for s in t.subtopics) <= 0]
        for kind, ids in (("topic", [t.id for t in self.topics]), ("style", [s.id for s in self.styles]),
                          ("question type", [q.id for q in self.question_set.types])):
            dupes = sorted({i for i in ids if ids.count(i) > 1})
            if dupes:
                problems.append(f"duplicate {kind} ids: {dupes}")
        style_ids = {s.id for s in self.styles}
        problems += [f"allowed_combinations references unknown style '{c.style}'"
                     for c in self.allowed_combinations if c.style not in style_ids]
        if self.question_set.count.max > 0 and self.figures.probability > 0 and not self.figures.kinds:
            problems.append("figures.probability > 0 but no figure kinds are listed")
        if problems:
            raise ValueError("; ".join(problems))
        return self


def json_schema() -> dict:
    schema = Rules.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "urt/rules.schema.json"
    schema["title"] = "URT generation rules"
    return schema
