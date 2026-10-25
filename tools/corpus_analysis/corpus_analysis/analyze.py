"""Per-passage Gemini analysis: builds the prompt and parts, then validates the result."""

from __future__ import annotations

import re
from pathlib import Path

from .llm import ImagePart, Part, StructuredCaller
from .prompts import Prompt
from .schemas import AnalysisRecord, ExtractedDocument, PassageAnalysis, Segment

MAX_FIGURE_IMAGES = 4


def word_count(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text))


def format_questions(seg: Segment) -> str:
    blocks = []
    for q in seg.questions:
        opts = "\n".join(f"  ({o.label}) {o.text}" for o in q.options)
        key = f"\n  [Answer key: {q.answer}]" if q.answer else ""
        blocks.append(f"{q.number}. {q.stem}\n{opts}{key}")
    return "\n\n".join(blocks)


def build_parts(seg: Segment, doc: ExtractedDocument, prompt: Prompt) -> list[Part]:
    parts: list[Part] = [prompt.render(subject_hint=seg.subject_hint or "none", passage=seg.passage_text,
                                       questions=format_questions(seg))]
    by_index = {p.index: p for p in doc.pages}
    for idx in seg.figure_pages[:MAX_FIGURE_IMAGES]:
        page = by_index.get(idx)
        if page and page.image_path and Path(page.image_path).is_file():
            parts.append(ImagePart(Path(page.image_path).read_bytes()))
    return parts


def analyze_segment(seg: Segment, doc: ExtractedDocument, *, caller: StructuredCaller, model: str,
                    prompt: Prompt) -> AnalysisRecord | None:
    """Return the JSONL record for one segment (``None`` in dry-run)."""
    analysis = caller.call(schema=PassageAnalysis, model=model, parts=build_parts(seg, doc, prompt),
                           stage="analyze", ref=seg.segment_id, temperature=0.2, max_output_tokens=6144)
    if analysis is None:
        return None
    return AnalysisRecord(
        segment_id=seg.segment_id, file_sha256=seg.file_sha256, source_name=seg.source_name,
        subject_hint=seg.subject_hint, word_count=word_count(seg.passage_text),
        question_count=len(seg.questions), option_counts=[len(q.options) for q in seg.questions],
        segmentation_method=seg.method, segmentation_confidence=seg.confidence, model=model,
        prompt_version=prompt.id, analysis=analysis,
    )
