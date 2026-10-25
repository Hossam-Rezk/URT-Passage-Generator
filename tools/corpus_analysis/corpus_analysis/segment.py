"""Split an extracted PDF into passages with their questions, options and answers.

Strategy:
1. **Rule-based** state machine over cleaned lines (headers/footers removed). Passage headers,
   numbered question stems confirmed by a following option "A", lettered options (one per
   line or several on one line), inline "Answer: B" lines, and answer-key sections.
2. Each segment gets a **confidence** score from structural checks. If the file's lowest
   segment confidence is under the threshold, the file is re-segmented by Gemini, which
   returns *line ranges* (cheap output, verbatim text) instead of rewritten text.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Callable

from .schemas import ExtractedDocument, LLMSegmentation, Option, Question, Segment
from .storage import sha256_text

PASSAGE_HEADER = re.compile(
    r"^\s*(passage\s+([ivxlc]+|\d+)\b|questions?\s+\d+\s*(?:-|–|—|to|through)\s*\d+\b"
    r"|read\s+the\s+(?:following|passage)\b|directions?\s*:)",
    re.IGNORECASE,
)
QUESTION_START = re.compile(r"^\s*(?:Q(?:uestion)?\.?\s*)?(\d{1,3})\s*[.)\-–]\s+(\S.*)$")  # 1. / 1) / 1-
# Options are A-E, or F-K (ACT labels even-numbered questions F, G, H, J, K; there is no I).
# Lowercase a-e count only when followed by ")" ("a) 2 m/s"), so "a." in prose is left alone.
_LABEL = r"([A-HJK]|[a-e](?=\s*\)))"
OPTION_MARK = re.compile(rf"(?:(?<=\s)|^)\(?{_LABEL}\s*[).]\s+")
OPTION_LINE = re.compile(rf"^\s*\(?{_LABEL}\s*[).]\s*(\S.*)?$")
LABEL_SERIES = ("ABCDE", "FGHJK")
FIRST_LABELS = ("A", "F")
INLINE_ANSWER = re.compile(r"^\s*(?:correct\s+)?answer\s*[:\-–]\s*\(?([A-E])\)?\b", re.IGNORECASE)
KEY_HEADER = re.compile(r"^\s*(answer\s*key|answers|key\s+to\s+questions|correct\s+answers)\b\s*:?\s*$",
                        re.IGNORECASE)
KEY_PAIR = re.compile(r"(?<!\d)(\d{1,3})\s*[.):\-–]?\s*\(?([A-E])\)?(?![A-Za-z])")
PAGE_NUMBER = re.compile(r"^\s*(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?\s*$", re.IGNORECASE)

NEW_PASSAGE_MIN_WORDS = 40


@dataclass
class Line:
    page: int
    text: str


@dataclass
class _Q:
    number: int
    stem: list[str]
    options: list[list[str]] = field(default_factory=list)  # [label, text...]
    answer: str | None = None


@dataclass
class _Seg:
    passage: list[Line] = field(default_factory=list)
    questions: list[_Q] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)
    has_header: bool = False


# ------------------------------------------------------------------------------------ cleaning
def clean_lines(doc: ExtractedDocument) -> list[Line]:
    """Flatten pages to lines, dropping running headers/footers and bare page numbers."""
    per_page = [[ln.rstrip() for ln in p.text.splitlines()] for p in doc.pages]
    norm = lambda s: re.sub(r"\d+", "#", s.strip().lower())  # noqa: E731
    counts: Counter[str] = Counter()
    for lines in per_page:
        counts.update({norm(ln) for ln in lines if ln.strip()})
    repeat_threshold = max(3, int(0.5 * len(per_page)) + 1)
    out: list[Line] = []
    for page_idx, lines in enumerate(per_page):
        for ln in lines:
            if not ln.strip() or PAGE_NUMBER.match(ln):
                continue
            if len(per_page) >= 3 and counts[norm(ln)] >= repeat_threshold and len(ln.split()) <= 12:
                continue
            out.append(Line(page_idx, ln))
    return out


def next_label(label: str) -> str | None:
    for series in LABEL_SERIES:
        k = series.find(label)
        if k != -1:
            return series[k + 1] if k + 1 < len(series) else None
    return None


def normalize_label(label: str) -> str:
    """Map ACT labels F-K onto A-E so every subject stores options the same way."""
    k = LABEL_SERIES[1].find(label)
    return LABEL_SERIES[0][k] if k != -1 else label


def split_options(text: str) -> list[tuple[str, str]]:
    """Split ``"(A) 2 m/s (B) 4 m/s"`` or ``"A. foo"`` into ``[(label, text), ...]``."""
    marks: list[re.Match] = []
    for m in OPTION_MARK.finditer(text):
        # Labels must run in sequence (A, B, C… or F, G, H, J…), so "Vitamin C. deficiency" is not split.
        if not marks or m.group(1).upper() == next_label(marks[-1].group(1).upper()):
            marks.append(m)
    if not marks:
        return []
    parts: list[tuple[str, str]] = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        parts.append((m.group(1).upper(), text[m.end():end].strip()))
    return parts


# ------------------------------------------------------------------------------------ rule-based
def _is_question_start(lines: list[Line], i: int) -> re.Match | None:
    """A numbered line is a question only if an option ``A`` follows before the next numbered line."""
    m = QUESTION_START.match(lines[i].text)
    if not m or OPTION_LINE.match(lines[i].text):
        return None
    if re.search(r"\(A\)\s", m.group(2)):  # stem and options on one line
        return m
    for j in range(i + 1, min(len(lines), i + 12)):
        t = lines[j].text
        if OPTION_LINE.match(t):
            return m if OPTION_LINE.match(t).group(1).upper() in FIRST_LABELS else None
        if QUESTION_START.match(t) or PASSAGE_HEADER.match(t):
            return None
    return None


def _option_fits(q: _Q, text: str) -> bool:
    """F-K lines count as options only in sequence, so prose like "H. pylori…" stays text.

    A-E lines are always accepted; out-of-order A-E labels are kept so scoring can flag them.
    """
    label = OPTION_LINE.match(text).group(1).upper()
    if label in LABEL_SERIES[0]:
        return True
    return label == (next_label(q.options[-1][0]) if q.options else "F")


def _plain_run_words(lines: list[Line], i: int) -> int:
    """Words in the run of plain lines starting at ``i`` (stops at a question/option/header/key)."""
    words = 0
    for j in range(i, len(lines)):
        t = lines[j].text
        if (PASSAGE_HEADER.match(t) or KEY_HEADER.match(t) or OPTION_LINE.match(t)
                or INLINE_ANSWER.match(t) or _is_question_start(lines, j)):
            break
        words += len(t.split())
    return words


def rule_segment(lines: list[Line]) -> tuple[list[_Seg], list[str]]:
    """Run the state machine. Returns raw segments and file-level warnings."""
    segs: list[_Seg] = []
    warnings: list[str] = []
    cur = _Seg()
    mode = "passage"  # passage | stem | options | key
    since_key: list[_Seg] = []  # segments not yet covered by an answer key section

    def close() -> None:
        nonlocal cur
        if cur.questions or cur.passage:
            segs.append(cur)
            since_key.append(cur)
        cur = _Seg()

    def apply_key(pairs: list[tuple[int, str]]) -> None:
        targets = [q for s in since_key + [cur] for q in s.questions]
        by_num: dict[int, list[_Q]] = {}
        for q in targets:
            by_num.setdefault(q.number, []).append(q)
        for num, label in pairs:
            qs = [q for q in by_num.get(num, []) if q.answer is None]
            if len(qs) == 1:
                qs[0].answer = label
            elif len(qs) > 1:
                warnings.append(f"answer key number {num} matches {len(qs)} questions (numbering restarts)")

    key_pairs: list[tuple[int, str]] = []
    for i, ln in enumerate(lines):
        t = ln.text
        if mode == "key":
            if PASSAGE_HEADER.match(t) or (_is_question_start(lines, i) and not KEY_PAIR.fullmatch(t.strip())):
                apply_key(key_pairs)
                key_pairs, since_key = [], []
                mode = "passage"
            else:
                key_pairs.extend((int(n), a) for n, a in KEY_PAIR.findall(t))
                continue
        if KEY_HEADER.match(t):
            close()
            mode, key_pairs = "key", []
            continue
        if PASSAGE_HEADER.match(t):
            if cur.questions:
                close()
            cur.has_header = True
            cur.pages.add(ln.page)
            mode = "passage"
            continue
        qm = _is_question_start(lines, i)
        if qm:
            stem = qm.group(2)
            inline = split_options(stem) if re.search(r"\(A\)\s", stem) else []
            q = _Q(number=int(qm.group(1)), stem=[stem[: stem.find("(A)")].strip() if inline else stem])
            for label, text in inline:
                q.options.append([label, text])
            cur.questions.append(q)
            cur.pages.add(ln.page)
            mode = "options" if inline else "stem"
            continue
        if mode in ("stem", "options") and OPTION_LINE.match(t) and _option_fits(cur.questions[-1], t):
            q = cur.questions[-1]
            for label, text in split_options(t):
                q.options.append([label, text])
            cur.pages.add(ln.page)
            mode = "options"
            continue
        am = INLINE_ANSWER.match(t)
        if am and cur.questions:
            cur.questions[-1].answer = am.group(1).upper()
            continue
        # Plain text line.
        if mode == "passage":
            cur.passage.append(ln)
            cur.pages.add(ln.page)
        elif mode == "stem":
            cur.questions[-1].stem.append(t.strip())
        else:  # after options: continuation of the last option, or the start of a new passage
            q = cur.questions[-1]
            if len(q.options) >= 4 and _plain_run_words(lines, i) >= NEW_PASSAGE_MIN_WORDS:
                close()
                cur.passage.append(ln)
                cur.pages.add(ln.page)
                mode = "passage"
            elif q.options:
                q.options[-1].append(t.strip())
            else:
                q.stem.append(t.strip())
    if mode == "key":
        apply_key(key_pairs)
    close()
    return segs, warnings


def score_segment(seg: _Seg) -> tuple[float, list[str]]:
    """Structural confidence in [0, 1] plus human-readable warnings."""
    warnings: list[str] = []
    if not seg.questions:
        return 0.0, ["passage text with no questions"]
    score = 1.0
    words = sum(len(ln.text.split()) for ln in seg.passage)
    if words < 60:
        score -= 0.3
        warnings.append(f"short passage ({words} words)")
    counts = [len(q.options) for q in seg.questions]
    bad = [q.number for q in seg.questions if len(q.options) not in (4, 5)]
    if bad:
        # Fewer than 3 options almost always means a missed split; 3 or 6+ is merely unusual.
        score -= min(0.6, sum(0.35 if len(q.options) < 3 else 0.2
                              for q in seg.questions if q.number in bad))
        warnings.append(f"questions without 4-5 options: {bad}")
    if len(set(counts)) > 1:
        score -= 0.1
        warnings.append(f"inconsistent option counts {counts}")
    for q in seg.questions:
        labels = [normalize_label(o[0]) for o in q.options]
        if labels != [chr(ord("A") + k) for k in range(len(labels))]:
            score -= 0.1
            warnings.append(f"Q{q.number} option labels out of order {labels}")
            break
    nums = [q.number for q in seg.questions]
    if nums != list(range(nums[0], nums[0] + len(nums))):
        score -= 0.2
        warnings.append(f"non-consecutive question numbers {nums}")
    missing = [q.number for q in seg.questions if q.answer is None]
    if missing:
        score -= 0.05
        warnings.append(f"no answer found for {missing}")
    return max(0.0, round(score, 3)), warnings


def _to_segment(seg: _Seg, idx: int, doc: ExtractedDocument, subject_hint: str | None, method: str,
                confidence: float, warnings: list[str]) -> Segment:
    passage_text = "\n".join(ln.text for ln in seg.passage).strip()
    pages = sorted(seg.pages) or [0]
    figure_pages = [p.index for p in doc.pages if pages[0] <= p.index <= pages[-1] and p.has_figure]
    questions = [
        Question(number=q.number, stem=" ".join(q.stem).strip(),
                 options=[Option(label=normalize_label(o[0]), text=" ".join(o[1:]).strip()) for o in q.options],
                 answer=normalize_label(q.answer) if q.answer else None)
        for q in seg.questions
    ]
    seg_id = sha256_text(f"{doc.sha256}:{idx}:{passage_text[:200]}")[:16]
    return Segment(segment_id=seg_id, file_sha256=doc.sha256, source_name=doc.source_name,
                   subject_hint=subject_hint, page_start=pages[0], page_end=pages[-1], passage_text=passage_text,
                   questions=questions, method=method, confidence=confidence, warnings=warnings,
                   figure_pages=figure_pages)


# ------------------------------------------------------------------------------------ LLM fallback
LlmSegmentFn = Callable[[str, str], LLMSegmentation | None]  # (numbered text, ref) -> result


def numbered_text(lines: list[Line], first_page: int, last_page: int) -> str:
    """Render lines as ``L0001| text`` with page markers, for the LLM fallback prompt."""
    out: list[str] = []
    page = None
    for n, ln in enumerate(lines, start=1):
        if not first_page <= ln.page <= last_page:
            continue
        if ln.page != page:
            page = ln.page
            out.append(f"=== PAGE {page + 1} ===")
        out.append(f"L{n:04d}| {ln.text}")
    return "\n".join(out)


def _take(lines: list[Line], start: int, end: int) -> list[Line]:
    lo, hi = max(1, start), min(len(lines), end)
    return lines[lo - 1:hi] if lo <= hi else []


def llm_segment(lines: list[Line], doc: ExtractedDocument, fn: LlmSegmentFn, window_pages: int) -> list[_Seg] | None:
    """Segment with the LLM over overlapping page windows; merge overlapping duplicates."""
    if not lines:
        return []
    last = max(ln.page for ln in lines)
    step = max(1, window_pages - 1)
    candidates: list[tuple[int, int, _Seg]] = []
    dry = False
    for start in range(0, last + 1, step):
        end = min(last, start + window_pages - 1)
        result = fn(numbered_text(lines, start, end), f"{doc.sha256[:12]}:p{start + 1}-{end + 1}")
        if result is None:
            dry = True
        else:
            for p in result.passages:
                seg = _Seg()
                for r in p.passage_lines:
                    seg.passage.extend(_take(lines, r.start, r.end))
                for lq in p.questions:
                    stem_lines = _take(lines, lq.stem_lines.start, lq.stem_lines.end)
                    stem = " ".join(x.text.strip() for x in stem_lines)
                    stem = QUESTION_START.sub(lambda m: m.group(2), stem, count=1)
                    q = _Q(number=lq.number, stem=[stem], answer=(lq.answer_label or None))
                    for opt in lq.options:
                        text = " ".join(x.text.strip() for x in _take(lines, opt.lines.start, opt.lines.end))
                        text = re.sub(rf"^\(?{re.escape(opt.label)}\s*[).]\s*", "", text)
                        q.options.append([opt.label.strip().upper()[:1], text])
                    seg.questions.append(q)
                    seg.pages.update(x.page for x in stem_lines)
                seg.pages.update(ln.page for ln in seg.passage)
                spans = [r.start for r in p.passage_lines] + [q.stem_lines.start for q in p.questions]
                ends = [r.end for r in p.passage_lines] + [o.lines.end for q in p.questions for o in q.options]
                if spans and ends:
                    candidates.append((min(spans), max(ends), seg))
        if end >= last:
            break
    if dry:
        return None
    candidates.sort(key=lambda c: (c[0], -len(c[2].questions)))
    merged: list[tuple[int, int, _Seg]] = []
    for s, e, seg in candidates:
        if merged:
            ps, pe, pseg = merged[-1]
            overlap = max(0, min(pe, e) - max(ps, s) + 1)
            if overlap > 0.5 * min(pe - ps + 1, e - s + 1):
                if len(seg.questions) > len(pseg.questions):
                    merged[-1] = (s, e, seg)
                continue
        merged.append((s, e, seg))
    return [m[2] for m in merged]


# ------------------------------------------------------------------------------------ entry point
@dataclass
class SegmentationResult:
    segments: list[Segment]
    method: str
    file_confidence: float
    warnings: list[str]
    dropped_orphans: int


def segment_document(doc: ExtractedDocument, *, subject_hint: str | None, threshold: float,
                     llm_fn: LlmSegmentFn | None, window_pages: int = 6) -> SegmentationResult:
    """Rule-based first; LLM fallback when the weakest segment scores under ``threshold``."""
    lines = clean_lines(doc)
    raw, file_warnings = rule_segment(lines)
    scored = [(s, *score_segment(s)) for s in raw]
    kept = [(s, c, w) for s, c, w in scored if s.questions]
    orphans = len(scored) - len(kept)
    file_conf = min((c for _, c, _ in kept), default=0.0)
    method = "rule"
    if file_conf < threshold and llm_fn is not None:
        llm_raw = llm_segment(lines, doc, llm_fn, window_pages)
        if llm_raw is not None:  # None = dry-run: keep rule result for the report
            method = "llm"
            file_warnings = [*file_warnings, f"rule-based confidence {file_conf:.2f} < {threshold}; used LLM"]
            scored = [(s, *score_segment(s)) for s in llm_raw]
            kept = [(s, c, w) for s, c, w in scored if s.questions]
            orphans = len(scored) - len(kept)
            file_conf = min((c for _, c, _ in kept), default=0.0)
    segments = [_to_segment(s, i, doc, subject_hint, method, c, w) for i, (s, c, w) in enumerate(kept)]
    return SegmentationResult(segments=segments, method=method, file_confidence=file_conf,
                              warnings=file_warnings, dropped_orphans=orphans)
