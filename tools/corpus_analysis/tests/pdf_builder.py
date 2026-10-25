"""Builds tiny synthetic PDFs for tests (no third-party writer, no real exam content)."""

from __future__ import annotations

from pathlib import Path


def _escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_pdf(path: Path, pages: list[list[str]], *, blank_pages: set[int] | None = None,
              right_columns: dict[int, list[str]] | None = None, doubled_pages: set[int] | None = None) -> Path:
    """Write a PDF where each page shows the given lines (Helvetica 10pt). Pages listed in
    ``blank_pages`` get no text (they simulate a scanned page with no text layer).
    ``right_columns`` adds a second column of lines at x=320 on that page; ``doubled_pages``
    prints each line twice at the same spot (faux bold)."""
    blank_pages = blank_pages or set()
    right_columns = right_columns or {}
    doubled_pages = doubled_pages or set()
    objects: list[bytes] = []

    def add(obj: bytes) -> int:
        objects.append(obj)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    pages_id_placeholder = len(objects) + 1
    add(b"")  # Pages object, filled in below
    kids = []
    for i, lines in enumerate(pages):
        if i in blank_pages:
            stream = b""
        else:
            ops = ["BT", "/F1 10 Tf"]
            for x, col in [(50, lines), (320, right_columns.get(i, []))]:
                for n, ln in enumerate(col):
                    for dx in ((0, 0.3) if i in doubled_pages else (0,)):
                        ops.append(f"1 0 0 1 {x + dx} {800 - 12 * n} Tm ({_escape(ln)}) Tj")
            ops.append("ET")
            stream = "\n".join(ops).encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        page = add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Contents %d 0 R "
            b"/Resources << /Font << /F1 %d 0 R >> >> >>" % (pages_id_placeholder, content, font)
        )
        kids.append(page)
    objects[pages_id_placeholder - 1] = (
        b"<< /Type /Pages /Kids [" + b" ".join(b"%d 0 R" % k for k in kids) + b"] /Count %d >>" % len(kids)
    )
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_id_placeholder)

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for n, obj in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % n + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog, xref)
    path.write_bytes(bytes(out))
    return path
