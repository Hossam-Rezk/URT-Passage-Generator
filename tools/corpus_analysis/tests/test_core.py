import json
import tempfile
import unittest
from pathlib import Path

from pydantic import BaseModel

from corpus_analysis.cost import BudgetExceeded, CostLedger, Price, UnknownModelPrice, load_prices
from corpus_analysis.extract import PageStats, extract_document, has_figure, needs_ocr
from corpus_analysis.llm import LLMResponse, RateLimiter, StructuredCaller, StructuredOutputFailed, \
    TransientLLMError
from corpus_analysis.manifest import FileEntry, Manifest, ManifestError
from corpus_analysis.prompts import Prompt, load_prompt
from corpus_analysis.schemas import OCRPage
from corpus_analysis.storage import append_jsonl, iter_jsonl

from tests.fixtures import GOOD_DOCUMENT_PAGES
from tests.pdf_builder import build_pdf

PRICES = {"m": Price(1.0, 2.0)}


class Small(BaseModel):
    value: int


class ScriptedClient:
    """Returns the scripted responses in order (exceptions are raised)."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def generate(self, **kw):
        self.calls.append(kw)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return LLMResponse(text=item, input_tokens=1000, output_tokens=500)


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def caller(self, client, budget=10.0, dry=False, retries=3):
        ledger = CostLedger(self.dir / "ledger.jsonl", PRICES, budget, dry_run=dry)
        return StructuredCaller(client=client, ledger=ledger, limiter=RateLimiter(100000),
                                dead_letter_file=self.dir / "dead.jsonl", max_retries=retries,
                                sleep=lambda s: None), ledger


class ManifestTest(Tmp):
    def test_resume_required_and_stage_invalidation(self):
        path = self.dir / "manifest.json"
        m = Manifest.open(path, resume=False)
        m.upsert(FileEntry(drive_id="a", name="a.pdf", md5="1"))
        m.mark("a", "downloaded")
        m.mark("a", "extracted")
        m.mark("a", "segmented")
        with self.assertRaises(ManifestError):
            Manifest.open(path, resume=False)
        m2 = Manifest.open(path, resume=True)
        self.assertEqual([e.drive_id for e in m2.pending("analyzed")], ["a"])
        m2.mark("a", "extracted")  # re-running an earlier stage invalidates later ones
        self.assertFalse(m2.files["a"].done("segmented"))

    def test_changed_checksum_resets_progress(self):
        m = Manifest.open(self.dir / "m.json", resume=False)
        m.upsert(FileEntry(drive_id="a", name="a.pdf", md5="1"))
        m.mark("a", "downloaded")
        m.upsert(FileEntry(drive_id="a", name="a.pdf", md5="2"))
        self.assertEqual(m.files["a"].stages, {})


class CostTest(Tmp):
    def test_budget_stop_before_call(self):
        ledger = CostLedger(self.dir / "l.jsonl", PRICES, max_cost_usd=0.003)
        r = ledger.reserve("m", 1000, 500)  # 0.001 + 0.001
        ledger.commit(model="m", stage="t", reserved=r, input_tokens=1000, output_tokens=500)
        with self.assertRaises(BudgetExceeded):
            ledger.reserve("m", 1000, 500)
        # Persisted: a resumed run keeps counting spend.
        self.assertAlmostEqual(CostLedger(self.dir / "l.jsonl", PRICES, 1.0).spent_usd, 0.002)

    def test_unknown_model(self):
        with self.assertRaises(UnknownModelPrice):
            CostLedger(self.dir / "l.jsonl", PRICES, 1.0).price("nope")

    def test_prices_file_parses(self):
        prices = load_prices(Path(__file__).resolve().parent.parent / "prices.yaml")
        self.assertIn("gemini-3.8-flash", prices)


class StructuredCallerTest(Tmp):
    def test_retries_malformed_then_succeeds(self):
        client = ScriptedClient(["not json", '{"value": "x"}', '{"value": 3}'])
        caller, ledger = self.caller(client)
        self.assertEqual(caller.call(schema=Small, model="m", parts=["p"], stage="t", ref="r").value, 3)
        self.assertEqual(len(client.calls), 3)
        self.assertIn("did not validate", client.calls[1]["parts"][-1])
        self.assertEqual(ledger.calls, 3)

    def test_dead_letter_after_max_retries(self):
        caller, _ = self.caller(ScriptedClient(["bad"] * 3))
        with self.assertRaises(StructuredOutputFailed):
            caller.call(schema=Small, model="m", parts=["p"], stage="analyze", ref="seg1")
        dead = list(iter_jsonl(self.dir / "dead.jsonl"))
        self.assertEqual((dead[0]["stage"], dead[0]["ref"], dead[0]["raw_output_excerpt"]), ("analyze", "seg1", "bad"))

    def test_transient_errors_do_not_consume_attempts(self):
        client = ScriptedClient([TransientLLMError("429"), TransientLLMError("503"), '{"value": 1}'])
        caller, ledger = self.caller(client, retries=1)
        self.assertEqual(caller.call(schema=Small, model="m", parts=["p"], stage="t", ref="r").value, 1)
        self.assertEqual(ledger.reserved_usd, 0.0)

    def test_dry_run_makes_no_calls_and_estimates(self):
        client = ScriptedClient([])
        caller, ledger = self.caller(client, dry=True)
        self.assertIsNone(caller.call(schema=Small, model="m", parts=["x" * 4000], stage="t", ref="r"))
        self.assertEqual(client.calls, [])
        self.assertGreater(ledger.summary()["dry_run_estimated_usd"], 0)

    def test_budget_exceeded_propagates_without_call(self):
        client = ScriptedClient(['{"value": 1}'])
        caller, _ = self.caller(client, budget=0.0001)
        with self.assertRaises(BudgetExceeded):
            caller.call(schema=Small, model="m", parts=["p"], stage="t", ref="r")
        self.assertEqual(client.calls, [])


class PromptTest(unittest.TestCase):
    def test_render_keeps_braces_in_values_and_requires_all(self):
        p = Prompt("x", "v1", "A {passage} B {questions}")
        self.assertEqual(p.render(passage="{F = ma}", questions="q"), "A {F = ma} B q")
        with self.assertRaises(KeyError):
            p.render(passage="only")

    def test_repo_prompts_load(self):
        for name in ("ocr_page", "segment", "analyze_passage"):
            self.assertTrue(load_prompt(name).template.strip())
        load_prompt("analyze_passage").render(subject_hint="x", passage="y", questions="z")


class ExtractTest(Tmp):
    def test_ocr_and_figure_heuristics(self):
        self.assertTrue(needs_ocr(PageStats(5, 1, 0.9, 0, 0), 120))
        self.assertFalse(needs_ocr(PageStats(800, 1, 0.2, 0, 0), 120))
        self.assertTrue(has_figure(PageStats(800, 0, 0.0, 40, 0)))
        self.assertFalse(has_figure(PageStats(800, 0, 0.0, 2, 0)))

    def test_text_pdf_and_scanned_page_fallback(self):
        pdf = build_pdf(self.dir / "s.pdf", GOOD_DOCUMENT_PAGES + [["(scanned)"]], blank_pages={2})
        seen = []

        def fake_ocr(png: bytes, ref: str) -> OCRPage:
            seen.append((png[:8], ref))
            return OCRPage(text="1. OCR question", figures=["bar chart of rainfall"])

        doc = extract_document(pdf, sha256="a" * 64, source_name="s.pdf", pages_dir=self.dir / "pages",
                               min_chars=120, ocr=fake_ocr)
        self.assertEqual(doc.page_count, 3)
        self.assertIn("dissolves", doc.pages[0].text)
        self.assertEqual(doc.pages[0].method, "text")
        self.assertEqual(doc.ocr_pages, [2])
        self.assertEqual(seen[0][0], b"\x89PNG\r\n\x1a\n")
        self.assertIn("[FIGURE: bar chart of rainfall]", doc.pages[2].text)
        self.assertTrue(Path(doc.pages[2].image_path).is_file())

    def _extract(self, pdf):
        return extract_document(pdf, sha256="b" * 64, source_name="c.pdf", pages_dir=self.dir / "pages",
                                min_chars=120, ocr=None)

    def test_two_column_page_is_read_column_by_column(self):
        left = [f"Left column sentence number {n} about solubility." for n in range(20)]
        right = [f"Right column line {n} with an option." for n in range(20)]
        pdf = build_pdf(self.dir / "c.pdf", [left], right_columns={0: right})
        text = self._extract(pdf).pages[0].text
        self.assertLess(text.index("number 19"), text.index("Right column line 0"))
        self.assertNotIn("solubility. Right", text)

    def test_single_column_prose_is_not_split(self):
        prose = [f"This full width line {n} runs across the whole page from left margin to right margin."
                 for n in range(20)]
        pdf = build_pdf(self.dir / "s.pdf", [prose])
        self.assertIn("left margin to right margin", self._extract(pdf).pages[0].text)

    def test_overprinted_bold_text_is_deduplicated(self):
        pdf = build_pdf(self.dir / "d.pdf", [["Passage I bold heading"] * 3], doubled_pages={0})
        text = self._extract(pdf).pages[0].text
        self.assertIn("Passage I bold heading", text)
        self.assertNotIn("PPaa", text)


class OpenAICompatibleClientTest(unittest.TestCase):
    def _call(self, reply: str, status: int = 200):
        import io
        import urllib.error
        from unittest import mock

        from corpus_analysis.llm import ImagePart, OpenAICompatibleClient

        sent = {}

        class Resp(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake_urlopen(req, timeout):
            sent["url"], sent["body"], sent["auth"] = req.full_url, json.loads(req.data), req.headers["Authorization"]
            if status != 200:
                raise urllib.error.HTTPError(req.full_url, status, "err", {}, io.BytesIO(b"busy"))
            return Resp(json.dumps({"choices": [{"message": {"content": reply}}],
                                    "usage": {"prompt_tokens": 11, "completion_tokens": 7}}).encode())

        client = OpenAICompatibleClient("https://gw.example/v1/", "k")
        with mock.patch("urllib.request.urlopen", fake_urlopen):
            resp = client.generate(model="m", parts=["hello", ImagePart(b"\x89PNG")], response_schema=Small,
                                   temperature=0.1, max_output_tokens=100)
        return resp, sent

    def test_request_shape_and_fenced_json(self):
        resp, sent = self._call('```json\n{"value": 3}\n```')
        self.assertEqual(sent["url"], "https://gw.example/v1/chat/completions")
        self.assertEqual(sent["auth"], "Bearer k")
        self.assertEqual(sent["body"]["response_format"], {"type": "json_object"})
        self.assertIn("JSON Schema", sent["body"]["messages"][0]["content"])
        user = sent["body"]["messages"][1]["content"]
        self.assertEqual(user[0], {"type": "text", "text": "hello"})
        self.assertTrue(user[1]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertEqual(Small.model_validate_json(resp.text).value, 3)
        self.assertEqual((resp.input_tokens, resp.output_tokens), (11, 7))

    def test_rate_limit_is_transient(self):
        with self.assertRaises(TransientLLMError):
            self._call("", status=429)


class JsonlTest(Tmp):
    def test_truncated_trailing_line_is_skipped(self):
        p = self.dir / "x.jsonl"
        append_jsonl(p, {"a": 1})
        with p.open("a") as fh:
            fh.write('{"a": 2')  # crash mid-write
        self.assertEqual(list(iter_jsonl(p)), [{"a": 1}])


if __name__ == "__main__":
    unittest.main()
