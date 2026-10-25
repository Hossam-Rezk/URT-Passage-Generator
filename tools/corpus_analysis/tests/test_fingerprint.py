import json
import tempfile
import unittest
from pathlib import Path

from corpus_analysis.cost import CostLedger, Price
from corpus_analysis.fingerprint import (PRIME, build, content_hash, jaccard_estimate, minhash, normalize,
                                         pack_f32, pack_u64, permutation_params, shingles, unpack_f32, unpack_u64)

A, B = permutation_params()
TEXT = ("Sound travels as a longitudinal wave in which regions of compression and rarefaction move "
        "away from the source, and its speed depends on the medium and its temperature.")
NEAR = TEXT.replace("its temperature", "the temperature of the air")
OTHER = ("Soil salinity was measured at five distances from the river at four depths, and the "
         "exchangeable sodium percentage rose with distance in every layer that was sampled.")


class MinHashTest(unittest.TestCase):
    def test_normalize_and_shingles(self):
        self.assertEqual(normalize("Hello,  WORLD—again! ①"), "hello world again 1")
        self.assertEqual(shingles("a b c"), {"a b c"})
        self.assertEqual(len(shingles("one two three four five six")), 2)

    def test_params_are_deterministic_and_in_range(self):
        a, b = permutation_params()
        self.assertEqual((a, b), (A, B))
        self.assertTrue(all(1 <= x < PRIME for x in a) and all(0 <= x < PRIME for x in b))

    def test_similarity_ordering(self):
        s, n, o = minhash(TEXT, A, B), minhash(NEAR, A, B), minhash(OTHER, A, B)
        self.assertEqual(jaccard_estimate(s, minhash(TEXT.upper(), A, B)), 1.0)
        self.assertGreater(jaccard_estimate(s, n), 0.5)
        self.assertLess(jaccard_estimate(s, o), 0.05)

    def test_empty_text_signature(self):
        self.assertEqual(minhash("!!!", A, B), [PRIME] * len(A))

    def test_packing_round_trip(self):
        sig = minhash(TEXT, A, B)
        self.assertEqual(unpack_u64(pack_u64(sig)), sig)
        vec = [0.5, -1.25, 3.0]
        self.assertEqual(unpack_f32(pack_f32(vec)), vec)

    def test_content_hash_ignores_case_and_punctuation(self):
        self.assertEqual(content_hash("Hello, World"), content_hash("hello world"))


class FakeEmbedder:
    def __init__(self):
        self.calls = 0

    def embed(self, *, model, texts):
        self.calls += 1
        return [[float(len(t) % 7 + 1), float(t.count("e") + 1), 1.0] for t in texts], 10 * len(texts)


class BuildTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        data = self.dir / "data"
        (data / "analysis").mkdir(parents=True)
        (data / "segments").mkdir()
        long_text = TEXT + " " + TEXT.replace("Sound", "Light")  # 40+ words, so calibration uses it
        distinct = ("A block slides down a ramp whose angle is raised slowly until motion begins, and the "
                    "angle at which sliding starts is recorded for granite, copper, wood and brick surfaces "
                    "at room temperature, then repeated with each face of the block in contact.")
        recs = [("s1", "physics", "p.pdf", long_text), ("s2", "physics", "q.pdf", long_text),  # reprinted
                ("s3", "physics", "p.pdf", distinct), ("s4", "geology", "g.pdf", OTHER + " " + OTHER)]
        with (data / "analysis" / "per_passage.jsonl").open("w", encoding="utf-8") as fh:
            for sid, subj, src, _ in recs:
                fh.write(json.dumps({"segment_id": sid, "source_name": src, "analysis": {"subject": subj}}) + "\n")
        (data / "segments" / "f.json").write_text(json.dumps({"segments": [
            {"segment_id": sid, "passage_text": text} for sid, _, _, text in recs]}), encoding="utf-8")
        self.data = data
        self.ledger = CostLedger(self.dir / "ledger.jsonl", {"emb": Price(0.02, 0.0)}, 1.0)

    def tearDown(self):
        self._tmp.cleanup()

    def test_dry_run_makes_no_calls(self):
        fake = FakeEmbedder()
        summary = build(self.data, self.dir / "fp", fake, "emb", self.ledger, dry_run=True)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(summary["subjects"], {"geology": 1, "physics": 3})
        self.assertFalse((self.dir / "fp").exists())

    def test_build_writes_files_without_text(self):
        fake = FakeEmbedder()
        summary = build(self.data, self.dir / "fp", fake, "emb", self.ledger, dry_run=False)
        phys = json.loads((self.dir / "fp" / "physics.json").read_text(encoding="utf-8"))
        self.assertEqual(len(phys["passages"]), 3)
        self.assertEqual(phys["embedding"], {"model": "emb", "dims": 3, "encoding": "float32 little-endian, base64"})
        self.assertEqual(unpack_u64(phys["minhash"]["a_b64"]), A)
        long_text = TEXT + " " + TEXT.replace("Sound", "Light")
        self.assertEqual(unpack_u64(phys["passages"][0]["minhash_b64"]), minhash(long_text, A, B))
        raw = (self.dir / "fp" / "physics.json").read_text(encoding="utf-8") + \
            (self.dir / "fp" / "calibration.json").read_text(encoding="utf-8")
        self.assertNotIn("longitudinal", raw)
        cal = json.loads((self.dir / "fp" / "calibration.json").read_text(encoding="utf-8"))
        self.assertEqual(len(cal["all_subjects"]["duplicate_pairs"]), 1)
        self.assertIn("URT_MAX_CORPUS_JACCARD", cal["recommended_env"])
        self.assertEqual(summary["duplicate_pairs"], 1)
        self.assertEqual(self.ledger.calls, 1)
        self.assertGreater(self.ledger.spent_usd, 0)
