"""Orchestrates the Step A stages over the manifest: fetch → extract → segment → analyze."""

from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Sequence

from .analyze import analyze_segment
from .config import Settings
from .cost import BudgetExceeded
from .drive import DriveFile, DriveSource, subject_hint
from .extract import extract_document
from .llm import ImagePart, StructuredCaller, StructuredOutputFailed
from .manifest import FileEntry, Manifest
from .prompts import load_prompt
from .schemas import ExtractedDocument, LLMSegmentation, OCRPage, Segment
from .segment import SegmentationResult, segment_document
from .storage import append_jsonl, atomic_write_json, iter_jsonl, read_json, sha256_file

log = logging.getLogger(__name__)


@dataclass
class RunState:
    """In-memory results, used for the dry-run report and the sample quality report."""

    extracted: dict[str, ExtractedDocument] = field(default_factory=dict)
    segmented: dict[str, SegmentationResult] = field(default_factory=dict)
    analyzed: int = 0
    failed: list[str] = field(default_factory=list)


class Pipeline:
    def __init__(self, settings: Settings, manifest: Manifest, caller: StructuredCaller | None, *,
                 source: DriveSource | None, dry_run: bool, subject: str | None, limit: int | None,
                 exclude: Sequence[str] = ()) -> None:
        self.s = settings
        self.manifest = manifest
        self.caller = caller
        self.source = source
        self.dry_run = dry_run
        self.subject = subject
        self.limit = limit
        self.exclude = [p.lower() for p in exclude]
        self.state = RunState()
        self.p_ocr = load_prompt("ocr_page")
        self.p_segment = load_prompt("segment")
        self.p_analyze = load_prompt("analyze_passage")

    # ------------------------------------------------------------------------- helpers
    def _working_set(self) -> list[FileEntry]:
        entries = self.manifest.selected(subject=self.subject, limit=None)
        if self.exclude:
            entries = [e for e in entries
                       if not any(fnmatch(f"{e.drive_path}/{e.name}".strip("/").lower(), p) for p in self.exclude)]
        return entries[: self.limit] if self.limit else entries

    def _extracted_path(self, sha: str) -> Path:
        return self.s.extracted_dir / f"{sha}.json"

    def _segments_path(self, sha: str) -> Path:
        return self.s.segments_dir / f"{sha}.json"

    def _ocr(self, png: bytes, ref: str) -> OCRPage | None:
        assert self.caller is not None
        try:
            return self.caller.call(schema=OCRPage, model=self.s.model_extract,
                                    parts=[self.p_ocr.template, ImagePart(png)], stage="ocr", ref=ref,
                                    temperature=0.0, max_output_tokens=8192)
        except StructuredOutputFailed as exc:
            log.error("ocr_failed", extra={"ref": ref, "error": str(exc)})
            return OCRPage(text="[OCR FAILED]", figures=[])

    def _llm_segment(self, numbered: str, ref: str) -> LLMSegmentation | None:
        assert self.caller is not None
        return self.caller.call(schema=LLMSegmentation, model=self.s.model_extract,
                                parts=[self.p_segment.template + numbered], stage="segment", ref=ref,
                                temperature=0.0, max_output_tokens=8192)

    # ------------------------------------------------------------------------- stages
    def fetch(self) -> None:
        if self.source is None:
            raise RuntimeError("No source configured (set URT_DRIVE_FOLDER_ID or pass --local-dir)")
        listed = 0
        for f in self.source.list_pdfs():
            self.manifest.upsert(FileEntry(drive_id=f.id, name=f.name, drive_path=f.path, md5=f.md5,
                                           subject_hint=subject_hint(f.path, f.name)))
            listed += 1
        log.info("listed", extra={"files": listed})
        for entry in self._working_set():
            if entry.done("downloaded") and entry.local_path and Path(entry.local_path).is_file():
                continue
            safe = re.sub(r"[^A-Za-z0-9._-]+", "_", entry.drive_id)
            dest = self.s.raw_dir / f"{safe}.pdf"
            try:
                self.source.download(_as_drive_file(entry), dest)
            except Exception as exc:  # one bad file must not stop the run
                self.manifest.record_error(entry.drive_id, "downloaded", repr(exc))
                log.error("download_failed", extra={"file": entry.name, "error": repr(exc)})
                continue
            entry.local_path = str(dest)
            entry.sha256 = sha256_file(dest)
            self.manifest.mark(entry.drive_id, "downloaded", bytes=dest.stat().st_size)

    def extract(self) -> None:
        for entry in self._working_set():
            if not entry.done("downloaded"):
                continue
            if entry.done("extracted") and self._extracted_path(entry.sha256).is_file():
                self.state.extracted[entry.drive_id] = ExtractedDocument(**read_json(self._extracted_path(entry.sha256)))
                continue
            ocr = None if self.caller is None else self._ocr
            try:
                doc = extract_document(Path(entry.local_path), sha256=entry.sha256, source_name=entry.name,
                                       pages_dir=self.s.pages_dir, min_chars=self.s.ocr_min_chars_per_page, ocr=ocr)
            except BudgetExceeded:
                raise
            except Exception as exc:
                self.manifest.record_error(entry.drive_id, "extracted", repr(exc))
                log.error("extract_failed", extra={"file": entry.name, "error": repr(exc)})
                continue
            self.state.extracted[entry.drive_id] = doc
            if self.dry_run:
                continue  # OCR was skipped; do not persist an incomplete extraction
            atomic_write_json(self._extracted_path(doc.sha256), doc.model_dump())
            self.manifest.mark(entry.drive_id, "extracted", pages=doc.page_count, ocr_pages=doc.ocr_pages)

    def segment(self) -> None:
        for entry in self._working_set():
            doc = self.state.extracted.get(entry.drive_id)
            if doc is None:
                continue
            if entry.done("segmented") and self._segments_path(doc.sha256).is_file():
                data = read_json(self._segments_path(doc.sha256))
                self.state.segmented[entry.drive_id] = SegmentationResult(
                    segments=[Segment(**s) for s in data["segments"]], method=data["method"],
                    file_confidence=data["file_confidence"], warnings=data["warnings"],
                    dropped_orphans=data["dropped_orphans"])
                continue
            llm_fn = None if self.caller is None else self._llm_segment
            try:
                result = segment_document(doc, subject_hint=entry.subject_hint,
                                          threshold=self.s.segment_confidence_threshold, llm_fn=llm_fn,
                                          window_pages=self.s.llm_segmentation_window_pages)
            except BudgetExceeded:
                raise
            except Exception as exc:
                self.manifest.record_error(entry.drive_id, "segmented", repr(exc))
                log.error("segment_failed", extra={"file": entry.name, "error": repr(exc)})
                continue
            self.state.segmented[entry.drive_id] = result
            if self.dry_run:
                continue
            atomic_write_json(self._segments_path(doc.sha256), {
                "segments": [s.model_dump() for s in result.segments], "method": result.method,
                "file_confidence": result.file_confidence, "warnings": result.warnings,
                "dropped_orphans": result.dropped_orphans})
            self.manifest.mark(entry.drive_id, "segmented", segments=len(result.segments), method=result.method,
                               confidence=result.file_confidence)

    def analyze(self) -> None:
        if self.caller is None:
            raise RuntimeError("analyze needs an LLM client (or --dry-run)")
        done_ids = {r["segment_id"] for r in iter_jsonl(self.s.analysis_file)}
        jobs: list[tuple[FileEntry, Segment, ExtractedDocument]] = []
        for entry in self._working_set():
            result = self.state.segmented.get(entry.drive_id)
            doc = self.state.extracted.get(entry.drive_id)
            if result is None or doc is None or entry.done("analyzed"):
                continue
            jobs.extend((entry, seg, doc) for seg in result.segments if seg.segment_id not in done_ids)

        failures: dict[str, list[str]] = {}
        budget_error: BudgetExceeded | None = None
        with ThreadPoolExecutor(max_workers=max(1, self.s.concurrency)) as pool:
            futures = {pool.submit(analyze_segment, seg, doc, caller=self.caller, model=self.s.model_extract,
                                   prompt=self.p_analyze): (entry, seg) for entry, seg, doc in jobs}
            for fut in as_completed(futures):
                entry, seg = futures[fut]
                try:
                    record = fut.result()
                except BudgetExceeded as exc:
                    budget_error = budget_error or exc
                    for f in futures:
                        f.cancel()
                    continue
                except StructuredOutputFailed:
                    failures.setdefault(entry.drive_id, []).append(seg.segment_id)
                    self.state.failed.append(seg.segment_id)
                    continue
                if record is not None:
                    append_jsonl(self.s.analysis_file, record.model_dump())
                    self.state.analyzed += 1
        if budget_error is not None:
            raise budget_error
        if self.dry_run:
            return
        done_ids = {r["segment_id"] for r in iter_jsonl(self.s.analysis_file)}
        for entry in self._working_set():
            result = self.state.segmented.get(entry.drive_id)
            if result is None or entry.done("analyzed"):
                continue
            if all(s.segment_id in done_ids or s.segment_id in failures.get(entry.drive_id, [])
                   for s in result.segments):
                self.manifest.mark(entry.drive_id, "analyzed", analyzed=sum(
                    s.segment_id in done_ids for s in result.segments),
                    dead_lettered=failures.get(entry.drive_id, []))


def _as_drive_file(entry: FileEntry) -> DriveFile:
    return DriveFile(id=entry.drive_id, name=entry.name, path=entry.drive_path, md5=entry.md5, size=None)
