"""Step B helpers: corpus statistics, the rules JSON Schema, rules validation and style guides.

    python -m corpus_analysis.synthesis aggregate   # per_passage.jsonl → data/…/synthesis/<subject>.aggregates.json
    python -m corpus_analysis.synthesis schema      # write server/urt/rules/rules.schema.json
    python -m corpus_analysis.synthesis check       # validate server/urt/rules/*.yaml, render the style guides

The aggregates are computed in code (no LLM). They hold labels, counts and the analysis
model's descriptions, never source passage text. The qualitative rule sections are written
from them by hand (or by a reviewer) into the YAML, which stays the source of truth; the
Markdown style guides are rendered from the YAML and must not be edited directly.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable, Sequence

import yaml
from pydantic import ValidationError

from .rules_schema import Rules, json_schema
from .storage import iter_jsonl

REPO_ROOT = Path(__file__).resolve().parents[3]
RULES_DIR = REPO_ROOT / "server" / "urt" / "rules"
GUIDES_DIR = REPO_ROOT / "docs" / "urt-passage-generator" / "style-guides"
DEFAULT_DATA_DIR = REPO_ROOT / "data" / "corpus_analysis"


# ------------------------------------------------------------------------------------ statistics
def percentiles(values: Sequence[float]) -> dict[str, float]:
    if not values:
        return {}
    xs = sorted(values)

    def q(p: float) -> float:
        k = (len(xs) - 1) * p
        lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
        return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 2)

    return {"n": len(xs), "min": xs[0], "p10": q(0.1), "p25": q(0.25), "p50": q(0.5), "p75": q(0.75),
            "p90": q(0.9), "max": xs[-1]}


def _top(counter: Counter, n: int | None = None) -> list[list[object]]:
    return [[k, v] for k, v in counter.most_common(n)]


def _norm(s: str) -> str:
    return " ".join(s.lower().split())


def aggregate_subject(records: list[dict]) -> dict:
    """Statistics for one subject's analysis records."""
    a = [r["analysis"] for r in records]
    qs = [q for x in a for q in x["questions"]]
    figs = [f for x in a for f in x["figures"]]

    qtypes: dict[str, dict] = {}
    by_type: dict[str, list[dict]] = defaultdict(list)
    for q in qs:
        by_type[q["question_type"]].append(q)
    for t, items in sorted(by_type.items(), key=lambda kv: -len(kv[1])):
        qtypes[t] = {
            "count": len(items),
            "share": round(len(items) / len(qs), 3),
            "uses_figure_share": round(sum(q["uses_figure"] for q in items) / len(items), 2),
            "difficulty": dict(Counter(q["difficulty"] for q in items)),
            "skills": _top(Counter(_norm(q["skill"]) for q in items), 12),
        }

    kinds: dict[str, dict] = {}
    for kind in sorted({f["kind"] for f in figs}):
        items = [f for f in figs if f["kind"] == kind]
        kinds[kind] = {
            "count": len(items),
            "approx_data_points": percentiles([f["approx_data_points"] for f in items]),
            "roles": _top(Counter(_norm(f["role"]) for f in items), 10),
            "descriptions": [f["description"] for f in items],
        }

    justifications: dict[str, list[str]] = defaultdict(list)
    for x in a:
        if len(justifications[x["overall_difficulty"]]) < 10:
            justifications[x["overall_difficulty"]].append(x["difficulty_justification"])

    return {
        "passages": len(records),
        "questions": len(qs),
        "sources": dict(Counter(r["source_name"] for r in records)),
        "models": dict(Counter(r["model"] for r in records)),
        "word_count": percentiles([r["word_count"] for r in records]),
        "reading_level_grade": percentiles([x["reading_level_grade"] for x in a]),
        "difficulty": dict(Counter(x["overall_difficulty"] for x in a)),
        "question_difficulty": dict(Counter(q["difficulty"] for q in qs)),
        "topics": _top(Counter(_norm(x["topic"]) for x in a)),
        "subtopics": _top(Counter(f"{_norm(x['topic'])} / {_norm(x['subtopic'])}" for x in a)),
        "styles": _top(Counter(_norm(x["style"]) for x in a)),
        "style_x_difficulty": _top(Counter(f"{_norm(x['style'])} | {x['overall_difficulty']}" for x in a)),
        "structures": [[_norm(x["style"]), x["structure"]] for x in a],
        "question_count": percentiles([len(x["questions"]) for x in a]),
        "question_count_hist": dict(sorted(Counter(len(x["questions"]) for x in a).items())),
        "option_counts": dict(Counter(n for r in records for n in r["option_counts"])),
        "question_types": qtypes,
        "answer_labels": dict(sorted(Counter(q.get("answer_label") or "?" for q in qs).items())),
        "answers_from_key_share": round(sum(bool(q.get("answer_from_key")) for q in qs) / max(1, len(qs)), 2),
        "outside_knowledge_share": round(sum(q["requires_outside_knowledge"] for q in qs) / max(1, len(qs)), 2),
        "skills_scope": _top(Counter(_norm(s) for x in a for s in x["skills_scope"]), 30),
        "figures": {
            "passages_with_figure_share": round(sum(bool(x["figures"]) for x in a) / max(1, len(a)), 2),
            "figures_per_passage": dict(sorted(Counter(len(x["figures"]) for x in a).items())),
            "kinds": kinds,
        },
        "distractor_patterns": _top(Counter(_norm(p) for q in qs for p in q["distractor_patterns"]), 40),
        "distractor_conventions": _top(Counter(_norm(c) for x in a for c in x["distractor_conventions"]), 40),
        "answer_conventions": _top(Counter(_norm(c) for x in a for c in x["answer_conventions"]), 30),
        "notable_features": _top(Counter(_norm(c) for x in a for c in x["notable_features"]), 40),
        "difficulty_justifications": dict(justifications),
        "passages_with_extraction_issues": sum(bool(x["extraction_issues"]) for x in a),
    }


def aggregate(data_dir: Path) -> dict[str, dict]:
    records = list(iter_jsonl(data_dir / "analysis" / "per_passage.jsonl"))
    by_subject: dict[str, list[dict]] = defaultdict(list)
    seen: set[str] = set()
    for r in records:
        if r["segment_id"] in seen:  # a resumed run never re-analyzes, but stay safe
            continue
        seen.add(r["segment_id"])
        by_subject[r["analysis"]["subject"]].append(r)
    return {s: aggregate_subject(rs) for s, rs in sorted(by_subject.items())}


# ------------------------------------------------------------------------------------ rules files
def load_rules(path: Path) -> Rules:
    with path.open(encoding="utf-8") as fh:
        return Rules.model_validate(yaml.safe_load(fh))


def _pct(w: float, total: float) -> str:
    return f"{100 * w / total:.0f}%" if total else "-"


def _bullets(items: Iterable[str]) -> list[str]:
    return [f"- {i}" for i in items]


def _range(r) -> str:
    return f"{r.min}–{r.max}"


def render_guide(rules: Rules) -> str:
    """Human-readable style guide for one subject, rendered from its rules file."""
    r = rules
    out: list[str] = [
        f"# URT {r.subject.capitalize()} passage style guide",
        "",
        f"> Rendered from `server/urt/rules/{r.subject}.yaml` ({r.rules_version}, status **{r.status}**). "
        "Edit the YAML, then re-run `python -m corpus_analysis.synthesis check`; do not edit this file.",
        "",
        f"**Based on:** {r.generated_from.corpus_passages} analyzed passages from "
        f"{', '.join(r.generated_from.sources)}.",
        "",
        f"**Provenance:** {r.generated_from.provenance}",
        "",
        "## Passage shape",
        "",
        f"- Length: {r.length_words.min:.0f}–{r.length_words.max:.0f} words"
        + (f" (typical {r.length_words.p50:.0f})" if r.length_words.p50 else ""),
        f"- Reading level: US grade {r.reading_level_grade.min:g}–{r.reading_level_grade.max:g}"
        + (f" (typical {r.reading_level_grade.p50:g})" if r.reading_level_grade.p50 else ""),
        f"- Questions per passage: {r.question_set.count.min}–{r.question_set.count.max} "
        f"(typical {r.question_set.count.typical}), {r.question_set.options_per_question} options each",
        f"- Figures: {r.figures.probability:.0%} of passages, at most {r.figures.max_per_passage} per passage",
        "",
        "## Topics",
        "",
        "| Topic | Share | Subtopics |",
        "|---|---|---|",
    ]
    tw = sum(t.weight for t in r.topics)
    for t in sorted(r.topics, key=lambda t: -t.weight):
        sw = sum(s.weight for s in t.subtopics)
        subs = ", ".join(f"{s.label} ({_pct(s.weight, sw)})" for s in sorted(t.subtopics, key=lambda s: -s.weight))
        out.append(f"| {t.label} (`{t.id}`) | {_pct(t.weight, tw)} | {subs} |")

    out += ["", "## Styles", ""]
    sw = sum(s.weight for s in r.styles)
    for s in sorted(r.styles, key=lambda s: -s.weight):
        out += [f"### {s.label} (`{s.id}`, {_pct(s.weight, sw)})", "", s.description, "",
                "Structure: " + " → ".join(s.structure), ""]

    out += ["## Difficulty levels", ""]
    dw = sum(d.weight for d in r.difficulty_levels.values())
    for name in ("easy", "medium", "hard"):
        d = r.difficulty_levels[name]
        out += [f"### {name.capitalize()} ({_pct(d.weight, dw)})", "", d.definition, "", "Passage markers:",
                *_bullets(d.passage_markers), "", "Question markers:", *_bullets(d.question_markers), ""]

    out += ["## Allowed style × difficulty combinations", "", "| Style | Difficulty | Share |", "|---|---|---|"]
    cw = sum(c.weight for c in r.allowed_combinations)
    labels = {s.id: s.label for s in r.styles}
    for c in sorted(r.allowed_combinations, key=lambda c: -c.weight):
        out.append(f"| {labels.get(c.style, c.style)} | {c.difficulty} | {_pct(c.weight, cw)} |")

    out += ["", "## Figures", ""]
    if not r.figures.kinds:
        out += ["No figures or tables: passages are text only.", ""]
    kw = sum(k.weight for k in r.figures.kinds)
    for k in sorted(r.figures.kinds, key=lambda k: -k.weight):
        shape = (f"{_range(k.rows)} rows × {_range(k.columns)} columns" if k.kind == "table"
                 else f"{_range(k.series)} series × {_range(k.points)} points")
        out += [f"### {k.kind.replace('_', ' ').capitalize()} ({_pct(k.weight, kw)}): {shape}", "",
                *_bullets(k.conventions), ""]

    out += ["## Question types", "", "| Type | Share | Uses figure | Skills |", "|---|---|---|---|"]
    qw = sum(q.share for q in r.question_set.types)
    for q in sorted(r.question_set.types, key=lambda q: -q.share):
        out.append(f"| {q.label} (`{q.id}`) | {_pct(q.share, qw)} | {'yes' if q.uses_figure else 'no'} | "
                   f"{'; '.join(q.skills)} |")
    out += [""]
    for q in sorted(r.question_set.types, key=lambda q: -q.share):
        out.append(f"- **{q.label}:** {q.description}")
    if r.question_set.stem_conventions:
        out += ["", "### Question stems", "", *_bullets(r.question_set.stem_conventions)]

    out += ["", "## Distractors", "", *_bullets(r.distractor_conventions),
            "", "## Answer key", "",
            *_bullets(r.answer_conventions
                      + (["Correct-answer positions are balanced across A–D."]
                         if r.question_set.answer_position_balance else [])),
            "", "## Never do this", "", *_bullets(r.anti_patterns), ""]
    return "\n".join(out)


def check(rules_dir: Path, guides_dir: Path) -> int:
    files = sorted(rules_dir.glob("*.yaml"))
    if not files:
        print(f"No rules files in {rules_dir}", file=sys.stderr)
        return 1
    failed = 0
    guides_dir.mkdir(parents=True, exist_ok=True)
    for path in files:
        try:
            rules = load_rules(path)
        except (ValidationError, yaml.YAMLError, ValueError) as exc:
            failed += 1
            print(f"INVALID {path.name}:\n{exc}\n", file=sys.stderr)
            continue
        if rules.subject != path.stem:
            failed += 1
            print(f"INVALID {path.name}: subject '{rules.subject}' does not match the file name", file=sys.stderr)
            continue
        guide = guides_dir / f"{rules.subject}.md"
        guide.write_text(render_guide(rules), encoding="utf-8")
        print(f"ok {path.name} ({rules.rules_version}, {rules.status}) -> {guide}")
    return 1 if failed else 0


# ------------------------------------------------------------------------------------ CLI
def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="corpus_analysis.synthesis", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=("aggregate", "schema", "check"))
    p.add_argument("--data-dir", type=Path, default=DEFAULT_DATA_DIR)
    p.add_argument("--rules-dir", type=Path, default=RULES_DIR)
    p.add_argument("--guides-dir", type=Path, default=GUIDES_DIR)
    args = p.parse_args(argv)

    if args.command == "aggregate":
        out_dir = args.data_dir / "synthesis"
        out_dir.mkdir(parents=True, exist_ok=True)
        for subject, agg in aggregate(args.data_dir).items():
            path = out_dir / f"{subject}.aggregates.json"
            path.write_text(json.dumps(agg, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"{subject}: {agg['passages']} passages, {agg['questions']} questions -> {path}")
        return 0
    if args.command == "schema":
        args.rules_dir.mkdir(parents=True, exist_ok=True)
        path = args.rules_dir / "rules.schema.json"
        path.write_text(json.dumps(json_schema(), indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path}")
        return 0
    return check(args.rules_dir, args.guides_dir)


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
