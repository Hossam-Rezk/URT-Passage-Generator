import copy
import tempfile
import unittest
from pathlib import Path

import yaml
from pydantic import ValidationError

from corpus_analysis.rules_schema import Rules, json_schema
from corpus_analysis.synthesis import aggregate_subject, check, percentiles, render_guide

VALID = {
    "schema_version": 1,
    "rules_version": "physics-2026.11.0",
    "status": "draft",
    "subject": "physics",
    "generated_from": {"corpus_passages": 3, "analysis_prompt": "analyze_passage.v1",
                       "synthesized_at": "2026-10-25", "sources": ["a.pdf"], "provenance": "synthetic test"},
    "sampling": {"variety_alpha": 0.6, "recent_topic_window": 5, "recent_topic_penalty": 0.5,
                 "pool_balance_weight": 0.3},
    "topics": [{"id": "mechanics.fluids", "label": "Fluids", "weight": 1,
                "subtopics": [{"id": "drag", "label": "Drag", "weight": 1}]}],
    "styles": [{"id": "experiment_report", "label": "Experiment report", "weight": 1,
                "structure": ["context", "table", "claim"], "description": "An experiment."}],
    "difficulty_levels": {d: {"weight": 1, "definition": d, "passage_markers": ["m"], "question_markers": ["q"]}
                          for d in ("easy", "medium", "hard")},
    "allowed_combinations": [{"style": "experiment_report", "difficulty": "medium", "weight": 1}],
    "length_words": {"min": 150, "max": 450, "p50": 300},
    "reading_level_grade": {"min": 9, "max": 12},
    "figures": {"probability": 0.8, "max_per_passage": 2, "kinds": [
        {"kind": "table", "weight": 1, "rows": {"min": 3, "max": 8}, "columns": {"min": 2, "max": 5}},
        {"kind": "line_chart", "weight": 1, "series": {"min": 1, "max": 3}, "points": {"min": 4, "max": 10}}]},
    "question_set": {"count": {"min": 3, "max": 7, "typical": 5}, "options_per_question": 4,
                     "types": [{"id": "data_reading", "label": "Data reading", "share": 1, "skills": ["read"],
                                "uses_figure": True, "description": "Read a value."}],
                     "answer_position_balance": True},
    "distractor_conventions": ["d"],
    "answer_conventions": ["a"],
    "anti_patterns": ["x"],
}


class RulesSchemaTest(unittest.TestCase):
    def test_valid_rules(self):
        Rules.model_validate(VALID)

    def _invalid(self, mutate, needle):
        data = copy.deepcopy(VALID)
        mutate(data)
        with self.assertRaises(ValidationError) as ctx:
            Rules.model_validate(data)
        self.assertIn(needle, str(ctx.exception))

    def test_unknown_style_in_combination(self):
        self._invalid(lambda d: d["allowed_combinations"].append(
            {"style": "essay", "difficulty": "hard", "weight": 1}), "unknown style 'essay'")

    def test_table_needs_rows_and_columns(self):
        self._invalid(lambda d: d["figures"]["kinds"][0].pop("rows"), "rows and columns")

    def test_zero_weights(self):
        self._invalid(lambda d: d["topics"][0].update(weight=0), "topics: weights must sum to > 0")

    def test_missing_difficulty(self):
        self._invalid(lambda d: d["difficulty_levels"].pop("hard"), "easy, medium and hard")

    def test_unknown_field_rejected(self):
        self._invalid(lambda d: d.update(extra_field=1), "extra_field")

    def test_version_must_match_subject(self):
        self._invalid(lambda d: d.update(rules_version="biology-2026.11.0"), "must start with 'physics-'")

    def test_json_schema_export(self):
        schema = json_schema()
        self.assertEqual(schema["title"], "URT generation rules")
        self.assertIn("topics", schema["properties"])


class GuideAndCheckTest(unittest.TestCase):
    def test_render_guide_sections(self):
        md = render_guide(Rules.model_validate(VALID))
        for heading in ("## Topics", "## Styles", "## Difficulty levels", "## Figures", "## Question types",
                        "## Distractors", "## Never do this"):
            self.assertIn(heading, md)
        self.assertIn("3–8 rows × 2–5 columns", md)
        self.assertIn("context → table → claim", md)

    def test_check_writes_guides_and_rejects_bad_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            rules, guides = Path(tmp) / "rules", Path(tmp) / "guides"
            rules.mkdir()
            (rules / "physics.yaml").write_text(yaml.safe_dump(VALID), encoding="utf-8")
            self.assertEqual(check(rules, guides), 0)
            self.assertTrue((guides / "physics.md").is_file())
            (rules / "biology.yaml").write_text(yaml.safe_dump(VALID), encoding="utf-8")  # subject mismatch
            self.assertEqual(check(rules, guides), 1)


class AggregateTest(unittest.TestCase):
    def test_percentiles(self):
        p = percentiles([1, 2, 3, 4, 5])
        self.assertEqual((p["min"], p["p50"], p["max"]), (1, 3, 5))

    def test_aggregate_subject(self):
        q = {"number": 1, "question_type": "data_reading", "skill": "Read a value", "difficulty": "easy",
             "difficulty_reason": "", "uses_figure": True, "requires_outside_knowledge": False,
             "answer_label": "B", "answer_from_key": False, "distractor_patterns": ["adjacent row"]}
        analysis = {"subject": "physics", "topic": "Fluids", "subtopic": "Drag", "style": "Experiment Report",
                    "structure": "a → b", "reading_level_grade": 10, "reading_level_reason": "",
                    "overall_difficulty": "medium", "difficulty_justification": "j", "skills_scope": ["s"],
                    "figures": [{"kind": "table", "description": "4 rows", "approx_data_points": 12,
                                 "role": "read a value"}],
                    "questions": [q, {**q, "answer_label": "C", "uses_figure": False}],
                    "distractor_conventions": ["c"], "answer_conventions": ["4 options"],
                    "notable_features": [], "extraction_issues": []}
        rec = {"segment_id": "s1", "source_name": "a.pdf", "model": "m", "word_count": 300, "option_counts": [4, 4],
               "analysis": analysis}
        agg = aggregate_subject([rec, {**rec, "segment_id": "s2", "word_count": 200}])
        self.assertEqual(agg["passages"], 2)
        self.assertEqual(agg["styles"], [["experiment report", 2]])
        self.assertEqual(agg["question_types"]["data_reading"]["uses_figure_share"], 0.5)
        self.assertEqual(agg["answer_labels"], {"B": 2, "C": 2})
        self.assertEqual(agg["figures"]["kinds"]["table"]["count"], 2)
        self.assertEqual(agg["word_count"]["p50"], 250)
