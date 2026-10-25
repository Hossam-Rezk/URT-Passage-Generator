"""Typed contracts for the Phase 1 artifacts and the Gemini structured outputs.

LLM-facing schemas avoid free-form mappings (``dict``) because Gemini's response
schemas support only a subset of JSON Schema; lists of objects are used instead.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Subject = Literal["physics", "chemistry", "geology", "biology", "english"]
Difficulty = Literal["easy", "medium", "hard"]
FigureKind = Literal["table", "line_chart", "bar_chart", "scatter_plot", "pie_chart", "diagram", "map",
                     "photo", "other"]


# ---------------------------------------------------------------------------------- extraction
class PageInfo(BaseModel):
    index: int
    text: str
    method: Literal["text", "ocr", "ocr_skipped"]
    char_count: int
    image_count: int
    vector_object_count: int
    table_count: int
    has_figure: bool
    image_path: str | None = None


class ExtractedDocument(BaseModel):
    sha256: str
    source_name: str
    page_count: int
    pages: list[PageInfo]

    @property
    def ocr_pages(self) -> list[int]:
        return [p.index for p in self.pages if p.method == "ocr"]


# ---------------------------------------------------------------------------------- segmentation
class Option(BaseModel):
    label: str
    text: str


class Question(BaseModel):
    number: int
    stem: str
    options: list[Option]
    answer: str | None = None


class Segment(BaseModel):
    """One passage with its questions. Text stays local (gitignored data dir)."""

    segment_id: str
    file_sha256: str
    source_name: str
    subject_hint: str | None
    page_start: int
    page_end: int
    passage_text: str
    questions: list[Question]
    method: Literal["rule", "llm"]
    confidence: float
    warnings: list[str] = Field(default_factory=list)
    figure_pages: list[int] = Field(default_factory=list)


class LineRange(BaseModel):
    start: int = Field(description="First line number (inclusive), as printed in the L#### prefix")
    end: int = Field(description="Last line number (inclusive)")


class LLMOption(BaseModel):
    label: str = Field(description="Option letter as printed, e.g. A")
    lines: LineRange


class LLMQuestion(BaseModel):
    number: int
    stem_lines: LineRange
    options: list[LLMOption]
    answer_label: str | None = Field(default=None, description="Correct option letter if the document gives it")


class LLMPassage(BaseModel):
    passage_lines: list[LineRange] = Field(description="Line ranges of the passage body, including figure/table text")
    questions: list[LLMQuestion]


class LLMSegmentation(BaseModel):
    passages: list[LLMPassage]


# ---------------------------------------------------------------------------------- OCR
class OCRPage(BaseModel):
    text: str = Field(description="Full page text in reading order. Tables as Markdown tables.")
    figures: list[str] = Field(default_factory=list,
                               description="One short description per graph/diagram on the page")


# ---------------------------------------------------------------------------------- analysis
class FigureAnalysis(BaseModel):
    kind: FigureKind
    description: str = Field(description="What it shows: variables, units, axes, number of series/rows")
    approx_data_points: int = Field(description="Approximate number of plotted points or table cells")
    role: str = Field(description="How questions use it, e.g. read a value, compare trends, infer relationship")


class QuestionAnalysis(BaseModel):
    number: int
    question_type: str = Field(description="Short snake_case label, e.g. detail, inference, main_idea, "
                                           "vocabulary_in_context, data_interpretation, calculation, "
                                           "experimental_design, hypothesis_evaluation")
    skill: str = Field(description="The specific skill tested, one sentence")
    difficulty: Difficulty
    difficulty_reason: str
    uses_figure: bool
    requires_outside_knowledge: bool
    answer_label: str | None = Field(description="Correct option letter (from the key if given, else solved)")
    answer_from_key: bool = Field(description="True if the document's key supplied the answer")
    distractor_patterns: list[str] = Field(description="How each wrong option is built, e.g. reverses "
                                                       "relationship, true but irrelevant, misreads axis")


class PassageAnalysis(BaseModel):
    """Per-passage features extracted by Gemini (Step A output, one JSONL line each)."""

    model_config = ConfigDict(extra="ignore")

    subject: Subject
    topic: str = Field(description="Broad topic, e.g. thermodynamics")
    subtopic: str = Field(description="Specific subtopic, e.g. heat transfer by conduction")
    style: str = Field(description="Genre/style, e.g. experiment report, expository, historical account, "
                                   "argumentative, data report, comparison of two viewpoints")
    structure: str = Field(description="Paragraph-level structure, e.g. context → method → results table → claim")
    reading_level_grade: float = Field(description="Estimated US grade level of the passage text")
    reading_level_reason: str
    overall_difficulty: Difficulty
    difficulty_justification: str
    skills_scope: list[str]
    figures: list[FigureAnalysis]
    questions: list[QuestionAnalysis]
    distractor_conventions: list[str] = Field(description="Patterns shared by the wrong options across questions")
    answer_conventions: list[str] = Field(description="E.g. option count, ordering of numeric options, "
                                                      "'none of the above' usage")
    notable_features: list[str]
    extraction_issues: list[str] = Field(description="Garbled text, missing options, unreadable figure, etc.")


class AnalysisRecord(BaseModel):
    """What is written to ``per_passage.jsonl`` (analysis + computed, non-LLM fields)."""

    segment_id: str
    file_sha256: str
    source_name: str
    subject_hint: str | None
    word_count: int
    question_count: int
    option_counts: list[int]
    segmentation_method: str
    segmentation_confidence: float
    model: str
    prompt_version: str
    analysis: PassageAnalysis
