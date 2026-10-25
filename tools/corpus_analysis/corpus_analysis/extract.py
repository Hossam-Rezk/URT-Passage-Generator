"""Text extraction with pdfplumber, page rendering with pypdfium2, and OCR fallback for scanned pages.

PyMuPDF is intentionally not used (AGPL). pdfplumber is MIT; pypdfium2 is Apache-2.0/BSD-3.
"""

from __future__ import annotations

import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .schemas import ExtractedDocument, OCRPage, PageInfo
from .storage import atomic_write_bytes

log = logging.getLogger(__name__)

OcrFn = Callable[[bytes, str], OCRPage | None]  # (png bytes, ref) -> OCR result (None in dry-run)


@dataclass(frozen=True)
class PageStats:
    char_count: int
    image_count: int
    image_area_ratio: float
    vector_object_count: int
    table_count: int


def needs_ocr(stats: PageStats, min_chars: int) -> bool:
    """A page is treated as scanned when it has almost no text layer but does carry images."""
    if stats.char_count >= min_chars:
        return False
    return stats.image_count > 0 or stats.char_count < 20


def has_figure(stats: PageStats) -> bool:
    """Heuristic: a sizeable raster image, many vector objects (charts) or a detected table."""
    return (stats.image_count > 0 and stats.image_area_ratio >= 0.05) or stats.vector_object_count >= 12 \
        or stats.table_count > 0


def render_page_png(pdf_path: Path, page_index: int, scale: float = 2.0) -> bytes:
    import pypdfium2 as pdfium  # noqa: PLC0415

    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_index]
        image = page.render(scale=scale).to_pil()
        buf = io.BytesIO()
        image.save(buf, format="PNG", optimize=True)
        return buf.getvalue()
    finally:
        pdf.close()


def column_gutter(page) -> float | None:
    """The x of a clear vertical gutter on a two-column page, or ``None`` for a single-column page.

    A gutter is a vertical line near the middle that almost no word crosses, with at least 30% of
    the words on each side. Ordinary prose crosses the middle on every line, so it never qualifies.
    """
    words = page.extract_words()
    if len(words) < 60:
        return None
    width = float(page.width)
    mid = width / 2
    best: tuple[int, float] | None = None
    for k in range(-15, 16):
        x = mid + k * width / 100
        crossing = sum(1 for w in words if w["x0"] < x < w["x1"])
        left = sum(1 for w in words if w["x1"] <= x)
        right = len(words) - left - crossing
        if crossing <= 0.02 * len(words) and min(left, right) >= 0.3 * len(words):
            if best is None or (crossing, abs(x - mid)) < (best[0], abs(best[1] - mid)):
                best = (crossing, x)
    return None if best is None else best[1]


def page_text(page) -> str:
    """Text in reading order: the left column, then the right one, when the page has two."""
    x = column_gutter(page)
    if x is None:
        return page.extract_text() or ""
    is_left = lambda o: (o["x0"] + o["x1"]) / 2 < x  # noqa: E731
    left = page.filter(lambda o: o.get("object_type") != "char" or is_left(o))
    right = page.filter(lambda o: o.get("object_type") != "char" or not is_left(o))
    return "\n".join(t for t in (left.extract_text() or "", right.extract_text() or "") if t)


def _page_stats(page) -> tuple[str, PageStats]:
    page = page.dedupe_chars()  # faux-bold text is printed twice ("PPaassssaaggee")
    text = page_text(page)
    page_area = float(page.width * page.height) or 1.0
    image_area = sum(abs((im["x1"] - im["x0"]) * (im["bottom"] - im["top"])) for im in page.images)
    try:
        tables = len(page.find_tables())
    except Exception:  # pdfplumber table finder can fail on odd layouts; non-fatal
        tables = 0
    stats = PageStats(
        char_count=len(text.strip()),
        image_count=len(page.images),
        image_area_ratio=min(1.0, image_area / page_area),
        vector_object_count=len(page.curves) + len(page.rects) + len(page.lines),
        table_count=tables,
    )
    return text, stats


def extract_document(pdf_path: Path, *, sha256: str, source_name: str, pages_dir: Path, min_chars: int,
                     ocr: OcrFn | None) -> ExtractedDocument:
    """Extract every page; OCR scanned pages; render figure pages to PNG for the analysis step."""
    import pdfplumber  # noqa: PLC0415

    pages: list[PageInfo] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for i, page in enumerate(pdf.pages):
            text, stats = _page_stats(page)
            figure = has_figure(stats)
            method = "text"
            image_path: str | None = None
            scanned = needs_ocr(stats, min_chars)
            if scanned or figure:
                png = render_page_png(pdf_path, i)
                out = pages_dir / sha256 / f"p{i + 1:03d}.png"
                atomic_write_bytes(out, png)
                image_path = str(out)
                if scanned:
                    if ocr is None:
                        method = "ocr_skipped"
                    else:
                        result = ocr(png, f"{sha256[:12]}:p{i + 1}")
                        if result is None:  # dry-run
                            method = "ocr_skipped"
                        else:
                            method = "ocr"
                            text = result.text + "".join(f"\n[FIGURE: {d}]" for d in result.figures)
                            figure = figure or bool(result.figures) or "|" in result.text
            pages.append(PageInfo(
                index=i, text=text, method=method, char_count=len(text.strip()), image_count=stats.image_count,
                vector_object_count=stats.vector_object_count, table_count=stats.table_count,
                has_figure=figure, image_path=image_path,
            ))
    doc = ExtractedDocument(sha256=sha256, source_name=source_name, page_count=len(pages), pages=pages)
    log.info("extracted", extra={"file": source_name, "pages": doc.page_count, "ocr_pages": doc.ocr_pages,
                                 "figure_pages": [p.index for p in pages if p.has_figure]})
    return doc
