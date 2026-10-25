"""End-to-end Step A over a local folder with a fake LLM: run, interrupt, resume, dry-run."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from corpus_analysis import cli
from corpus_analysis.llm import LLMResponse
from corpus_analysis.storage import iter_jsonl, read_json

from tests.fixtures import GOOD_DOCUMENT_PAGES
from tests.pdf_builder import build_pdf


def _analysis_json(n_questions: int) -> str:
    return json.dumps({
        "subject": "physics", "topic": "t", "subtopic": "s", "style": "experiment report", "structure": "x",
        "reading_level_grade": 10.5, "reading_level_reason": "r", "overall_difficulty": "medium",
        "difficulty_justification": "j", "skills_scope": ["data reading"], "figures": [],
        "questions": [{"number": i + 1, "question_type": "detail", "skill": "k", "difficulty": "easy",
                       "difficulty_reason": "r", "uses_figure": False, "requires_outside_knowledge": False,
                       "answer_label": "B", "answer_from_key": True, "distractor_patterns": []}
                      for i in range(n_questions)],
        "distractor_conventions": [], "answer_conventions": [], "notable_features": [], "extraction_issues": [],
    })


class FakeGemini:
    instances = []

    def __init__(self, *a, **k):
        self.calls = 0
        FakeGemini.instances.append(self)

    def generate(self, *, model, parts, response_schema, temperature, max_output_tokens):
        self.calls += 1
        return LLMResponse(text=_analysis_json(3), input_tokens=2000, output_tokens=800)


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.pdfs = root / "pdfs" / "Physics"
        self.pdfs.mkdir(parents=True)
        for i in range(3):
            pages = [[f"Practice set {i}: read each passage carefully before answering."] + GOOD_DOCUMENT_PAGES[0],
                     GOOD_DOCUMENT_PAGES[1]]
            build_pdf(self.pdfs / f"booklet_{i}.pdf", pages)
        self.data = root / "data"
        self.env = mock.patch.dict(os.environ, {"URT_CA_DATA_DIR": str(self.data), "GEMINI_API_KEY": "test",
                                                "URT_CA_RPM": "100000", "URT_CA_CONCURRENCY": "2"}, clear=False)
        self.env.start()
        FakeGemini.instances.clear()

    def tearDown(self):
        self.env.stop()
        self._tmp.cleanup()

    def run_cli(self, *args):
        with mock.patch.object(cli, "GeminiClient", FakeGemini):
            return cli.main(["run", "--local-dir", str(self.pdfs.parent), *args])

    def test_dry_run_makes_no_calls(self):
        self.assertEqual(self.run_cli("--dry-run", "--limit", "2"), 0)
        self.assertEqual(FakeGemini.instances, [])
        self.assertFalse((self.data / "analysis" / "per_passage.jsonl").exists())
        report = next((self.data / "reports").glob("report_dryrun_*.md")).read_text()
        self.assertIn("DRY RUN", report)
        self.assertIn("dry_run_estimated_usd", report)

    def test_full_run_limit_then_resume(self):
        self.assertEqual(self.run_cli("--limit", "2"), 0)
        records = list(iter_jsonl(self.data / "analysis" / "per_passage.jsonl"))
        self.assertEqual(len(records), 4)  # 2 files x 2 passages
        self.assertEqual({r["analysis"]["subject"] for r in records}, {"physics"})
        self.assertEqual(records[0]["prompt_version"], "analyze_passage.v1")
        manifest = read_json(self.data / "manifest.json")
        self.assertEqual({e["subject_hint"] for e in manifest["files"].values()}, {"physics"})

        self.assertEqual(self.run_cli("--limit", "2"), 1)  # existing run without --resume is refused

        self.assertEqual(self.run_cli("--resume"), 0)  # picks up the third file only
        records = list(iter_jsonl(self.data / "analysis" / "per_passage.jsonl"))
        self.assertEqual(len(records), 6)
        self.assertEqual(len({r["segment_id"] for r in records}), 6)
        self.assertEqual(sum(f.calls for f in FakeGemini.instances), 6)

    def test_budget_stop_exit_code_and_resume(self):
        with mock.patch.dict(os.environ, {"URT_CA_MAX_COST_USD": "0.03", "URT_CA_CONCURRENCY": "1"}):
            self.assertEqual(self.run_cli(), 2)
        done = len(list(iter_jsonl(self.data / "analysis" / "per_passage.jsonl")))
        self.assertLess(done, 6)
        self.assertEqual(self.run_cli("--resume"), 0)
        self.assertEqual(len(list(iter_jsonl(self.data / "analysis" / "per_passage.jsonl"))), 6)


if __name__ == "__main__":
    unittest.main()
