"""Extraction and segmentation quality report (Markdown), used to review the 5–10 file sample.

The report quotes short excerpts of source passages so a human can spot-check segmentation.
It is written into the gitignored data directory and must not be committed.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .manifest import Manifest
from .pipeline import RunState
from .storage import atomic_write_text, iter_jsonl


def build_report(state: RunState, manifest: Manifest, ledger_summary: dict, *, dry_run: bool,
                 dead_letter_file: Path) -> str:
    lines = [f"# Corpus analysis report: {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC",
             "", f"Mode: {'DRY RUN (no LLM calls; OCR/fallback/analysis skipped)' if dry_run else 'live'}", ""]
    totals = Counter()
    rows = []
    for drive_id, doc in state.extracted.items():
        entry = manifest.files[drive_id]
        seg = state.segmented.get(drive_id)
        ocr = sum(p.method == "ocr" for p in doc.pages)
        ocr_needed = sum(p.method in ("ocr", "ocr_skipped") for p in doc.pages)
        figs = sum(p.has_figure for p in doc.pages)
        n_seg = len(seg.segments) if seg else 0
        n_q = sum(len(s.questions) for s in seg.segments) if seg else 0
        answered = sum(q.answer is not None for s in seg.segments for q in s.questions) if seg else 0
        totals.update(files=1, pages=doc.page_count, ocr_needed=ocr_needed, ocr=ocr, figure_pages=figs,
                      segments=n_seg, questions=n_q, answered=answered)
        rows.append(f"| {entry.name} | {entry.subject_hint or '?'} | {doc.page_count} | {ocr_needed} | {figs} | "
                    f"{n_seg} | {n_q} | {answered}/{n_q} | {seg.method if seg else '-'} | "
                    f"{seg.file_confidence:.2f} |" if seg else
                    f"| {entry.name} | {entry.subject_hint or '?'} | {doc.page_count} | {ocr_needed} | {figs} "
                    f"| - | - | - | - | - |")
    lines += ["## Summary", "",
              f"- Files: {totals['files']}, pages: {totals['pages']}, pages needing OCR: {totals['ocr_needed']} "
              f"(OCR done: {totals['ocr']}), pages with figures/tables: {totals['figure_pages']}",
              f"- Passages: {totals['segments']}, questions: {totals['questions']}, "
              f"answers found in documents: {totals['answered']}/{totals['questions']}",
              f"- Analyzed this run: {state.analyzed}; dead-lettered: {len(state.failed)}",
              f"- Cost: {ledger_summary}", "",
              "## Per file", "",
              "| File | Subject hint | Pages | OCR pages | Figure pages | Passages | Questions | Answers | Method | Confidence |",
              "|---|---|---|---|---|---|---|---|---|---|", *rows, ""]
    errors = [(e.name, err) for e in manifest.files.values() for err in e.errors]
    if errors:
        lines += ["## Errors", "", *[f"- **{n}** [{e['stage']}] {e['error'][:300]}" for n, e in errors], ""]
    dead = list(iter_jsonl(dead_letter_file))
    if dead:
        lines += ["## Dead letter", "", *[f"- {d['stage']} {d['ref']}: {d['error'][:200]}" for d in dead[-20:]], ""]
    lines += ["## Segments (spot-check: compare with the PDF)", ""]
    for drive_id, seg in state.segmented.items():
        name = manifest.files[drive_id].name
        for s in seg.segments:
            excerpt = " ".join(s.passage_text.split())[:220]
            lines += [f"### {name}: pages {s.page_start + 1}-{s.page_end + 1}, `{s.segment_id}` "
                      f"({s.method}, confidence {s.confidence:.2f})",
                      f"- Passage ({len(s.passage_text.split())} words): {excerpt}…",
                      f"- Questions: {[q.number for q in s.questions]}, options per question: "
                      f"{[len(q.options) for q in s.questions]}, answers: {[q.answer for q in s.questions]}",
                      f"- Figure pages: {[p + 1 for p in s.figure_pages]}",
                      *([f"- Warnings: {'; '.join(s.warnings)}"] if s.warnings else []), ""]
        for w in seg.warnings:
            lines.append(f"- File warning ({name}): {w}")
    return "\n".join(lines) + "\n"


def write_report(path: Path, content: str) -> Path:
    atomic_write_text(path, content)
    return path
