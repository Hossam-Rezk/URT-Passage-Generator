"""Step B: source-passage fingerprints for the runtime originality check (PLAN.md §5.2.5, §6.3 check 4).

    python -m corpus_analysis.fingerprint build --dry-run   # count passages and estimate embedding cost
    python -m corpus_analysis.fingerprint build             # write server/urt/rules/fingerprints/*.json

Each source passage gets an exact content hash, a MinHash signature and an embedding. No source
text is written. The MinHash scheme is fully specified in each file (including the permutation
constants), so the Node runtime can reproduce it exactly:

1. normalize: Unicode NFKC, lowercase, every run of characters outside [a-z0-9] becomes one space, trim
2. shingles: the set of 5 consecutive words joined by single spaces (the whole text if shorter)
3. base hash: first 8 bytes of SHA-256(UTF-8 shingle) as a big-endian unsigned integer, mod P = 2^61 - 1
4. signature[i] = min over shingles of (a[i] * h + b[i]) mod P, for i in 0..127
5. uint64 arrays are stored little-endian, base64-encoded; embeddings are float32 little-endian, base64

Estimated Jaccard similarity = share of equal signature positions. ``calibration.json`` holds the
similarity distribution between distinct corpus passages and the recommended thresholds.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import re
import struct
import sys
import unicodedata
from collections import defaultdict
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path
from typing import Iterable, Protocol, Sequence

from .storage import atomic_write_json, iter_jsonl, read_json
from .synthesis import REPO_ROOT, percentiles

PRIME = (1 << 61) - 1
NUM_PERM = 128
SHINGLE_WORDS = 5
FORMAT_VERSION = 1
FINGERPRINTS_DIR = REPO_ROOT / "server" / "urt" / "rules" / "fingerprints"
MIN_WORDS_FOR_CALIBRATION = 40   # fragments are fingerprinted but kept out of the threshold statistics
# Pairs at or above this are one passage reprinted (possibly in part, or once via OCR), not distinct
# passages. Distinct corpus passages share almost no 5-word shingles (max ~0.07); a partial reprint
# with OCR noise scored 0.33, which a 0.5 cutoff missed and which then inflated the thresholds.
DUPLICATE_JACCARD = 0.25
EMBED_BATCH = 16


# ------------------------------------------------------------------------------------ MinHash
def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def shingles(text: str, k: int = SHINGLE_WORDS) -> set[str]:
    words = normalize(text).split()
    if not words:
        return set()
    if len(words) < k:
        return {" ".join(words)}
    return {" ".join(words[i:i + k]) for i in range(len(words) - k + 1)}


def base_hash(shingle: str) -> int:
    return int.from_bytes(hashlib.sha256(shingle.encode("utf-8")).digest()[:8], "big") % PRIME


def permutation_params(n: int = NUM_PERM) -> tuple[list[int], list[int]]:
    """Deterministic (a, b) pairs; a in [1, P-1], b in [0, P-1]."""
    def h(label: str) -> int:
        return int.from_bytes(hashlib.sha256(label.encode("ascii")).digest()[:8], "big")

    a = [h(f"urt-minhash-a-{i}") % (PRIME - 1) + 1 for i in range(n)]
    b = [h(f"urt-minhash-b-{i}") % PRIME for i in range(n)]
    return a, b


def minhash(text: str, a: Sequence[int], b: Sequence[int]) -> list[int]:
    hashes = [base_hash(s) for s in shingles(text)]
    if not hashes:
        return [PRIME] * len(a)
    return [min((ai * h + bi) % PRIME for h in hashes) for ai, bi in zip(a, b)]


def jaccard_estimate(s1: Sequence[int], s2: Sequence[int]) -> float:
    return sum(x == y for x, y in zip(s1, s2)) / len(s1)


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize(text).encode("utf-8")).hexdigest()


# ------------------------------------------------------------------------------------ packing
def pack_u64(values: Iterable[int]) -> str:
    vals = list(values)
    return base64.b64encode(struct.pack(f"<{len(vals)}Q", *vals)).decode("ascii")


def unpack_u64(data: str) -> list[int]:
    raw = base64.b64decode(data)
    return list(struct.unpack(f"<{len(raw) // 8}Q", raw))


def pack_f32(values: Iterable[float]) -> str:
    vals = list(values)
    return base64.b64encode(struct.pack(f"<{len(vals)}f", *vals)).decode("ascii")


def unpack_f32(data: str) -> list[float]:
    raw = base64.b64decode(data)
    return list(struct.unpack(f"<{len(raw) // 4}f", raw))


def cosine(u: Sequence[float], v: Sequence[float]) -> float:
    dot = sum(x * y for x, y in zip(u, v))
    nu, nv = math.sqrt(sum(x * x for x in u)), math.sqrt(sum(y * y for y in v))
    return dot / (nu * nv) if nu and nv else 0.0


# ------------------------------------------------------------------------------------ sources
def load_source_passages(data_dir: Path) -> dict[str, list[dict]]:
    """Analyzed passages grouped by the subject the analysis assigned, with their verbatim text."""
    meta: dict[str, tuple[str, str]] = {}
    for r in iter_jsonl(data_dir / "analysis" / "per_passage.jsonl"):
        meta.setdefault(r["segment_id"], (r["analysis"]["subject"], r["source_name"]))
    by_subject: dict[str, list[dict]] = defaultdict(list)
    seen: set[str] = set()
    for path in sorted((data_dir / "segments").glob("*.json")):
        for seg in read_json(path)["segments"]:
            sid = seg["segment_id"]
            if sid in meta and sid not in seen and seg["passage_text"].strip():
                seen.add(sid)
                subject, source = meta[sid]
                by_subject[subject].append({"id": sid, "source": source, "text": seg["passage_text"]})
    return dict(sorted(by_subject.items()))


# ------------------------------------------------------------------------------------ build
class Embedder(Protocol):
    def embed(self, *, model: str, texts: Sequence[str]) -> tuple[list[list[float]], int]: ...


def estimate_tokens(texts: Iterable[str]) -> int:
    return sum(len(t) // 4 + 1 for t in texts)


def embed_all(texts: list[str], client: Embedder, model: str, ledger) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        reserved = ledger.reserve(model, estimate_tokens(batch), 0, stage="embed")
        try:
            vectors, tokens = client.embed(model=model, texts=batch)
        except Exception:
            ledger.release(reserved)
            raise
        if len(vectors) != len(batch):
            ledger.release(reserved)
            raise RuntimeError(f"embedding API returned {len(vectors)} vectors for {len(batch)} texts")
        ledger.commit(model=model, stage="embed", reserved=reserved, input_tokens=tokens or estimate_tokens(batch),
                      output_tokens=0, ref=f"fingerprint:{i}")
        out.extend(vectors)
    return out


def calibrate(entries: list[dict]) -> dict:
    """Similarity between distinct corpus passages (reprinted duplicates are reported, then excluded)."""
    usable = [e for e in entries if e["words"] >= MIN_WORDS_FOR_CALIBRATION]
    jac, cos, dupes = [], [], []
    for x, y in combinations(usable, 2):
        j = jaccard_estimate(x["_sig"], y["_sig"])
        c = cosine(x["_emb"], y["_emb"])
        if j >= DUPLICATE_JACCARD:
            dupes.append({"a": x["id"], "a_source": x["source"], "b": y["id"], "b_source": y["source"],
                          "jaccard": round(j, 3), "cosine": round(c, 3)})
            continue
        jac.append(j)
        cos.append(c)
    return {"passages": len(usable), "pairs": len(jac), "duplicate_pairs": dupes,
            "jaccard": percentiles([round(v, 4) for v in jac]), "cosine": percentiles([round(v, 4) for v in cos])}


def recommend(cal: dict) -> dict[str, float]:
    """Thresholds just above the most similar distinct corpus pair, inside sane bounds.

    A generated passage closer to a source than any two distinct source passages are to each other
    is treated as too close; the bounds keep the checks meaningful on a small corpus.
    """
    jmax = cal["jaccard"].get("max", 0.0)
    cmax = cal["cosine"].get("max", 0.0)
    corpus_cos = min(0.95, max(0.85, round(cmax + 0.03, 2)))
    return {
        "URT_MAX_CORPUS_JACCARD": min(0.5, max(0.2, round(jmax + 0.1, 2))),
        "URT_MAX_CORPUS_COSINE": corpus_cos,
        "URT_MAX_POOL_COSINE": corpus_cos,
    }


def build(data_dir: Path, out_dir: Path, client: Embedder | None, model: str, ledger, *, dry_run: bool) -> dict:
    sources = load_source_passages(data_dir)
    texts = [p["text"] for ps in sources.values() for p in ps]
    est = estimate_tokens(texts)
    summary = {"subjects": {s: len(ps) for s, ps in sources.items()}, "passages": len(texts),
               "estimated_tokens": est, "estimated_usd": round(ledger.price(model).cost(est, 0), 6)}
    if dry_run:
        return summary
    assert client is not None
    vectors = iter(embed_all(texts, client, model, ledger))
    a, b = permutation_params()
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out_dir.mkdir(parents=True, exist_ok=True)
    all_entries: list[dict] = []
    dims = None
    for subject, passages in sources.items():
        entries = []
        for p in passages:
            emb = next(vectors)
            dims = dims or len(emb)
            sig = minhash(p["text"], a, b)
            entries.append({"id": p["id"], "source": p["source"], "words": len(normalize(p["text"]).split()),
                            "content_hash": content_hash(p["text"]), "minhash_b64": pack_u64(sig),
                            "embedding_b64": pack_f32(emb), "_sig": sig, "_emb": emb})
        all_entries += entries
        atomic_write_json(out_dir / f"{subject}.json", {
            "format_version": FORMAT_VERSION,
            "subject": subject,
            "created_at": now,
            "minhash": {"num_perm": NUM_PERM, "shingle_words": SHINGLE_WORDS, "prime": str(PRIME),
                        "normalization": "NFKC, lowercase, [^a-z0-9]+ -> ' ', trim",
                        "base_hash": "sha256(utf8 shingle)[0:8] big-endian mod prime",
                        "a_b64": pack_u64(a), "b_b64": pack_u64(b), "encoding": "uint64 little-endian, base64"},
            "embedding": {"model": model, "dims": dims, "encoding": "float32 little-endian, base64"},
            "passages": [{k: v for k, v in e.items() if not k.startswith("_")} for e in entries],
        })
    cal = calibrate(all_entries)
    cal_by_subject = {s: calibrate([e for e in all_entries if e["id"] in {p["id"] for p in ps}])
                      for s, ps in sources.items()}
    atomic_write_json(out_dir / "calibration.json", {
        "format_version": FORMAT_VERSION, "created_at": now, "embedding_model": model, "embedding_dims": dims,
        "min_words": MIN_WORDS_FOR_CALIBRATION, "duplicate_jaccard": DUPLICATE_JACCARD,
        "all_subjects": cal, "by_subject": cal_by_subject, "recommended_env": recommend(cal),
    })
    summary.update(recommended_env=recommend(cal), duplicate_pairs=len(cal["duplicate_pairs"]),
                   jaccard_max=cal["jaccard"].get("max"), cosine_max=cal["cosine"].get("max"))
    return summary


# ------------------------------------------------------------------------------------ CLI
def main(argv: Sequence[str] | None = None) -> int:
    from .config import load_settings  # noqa: PLC0415
    from .cost import CostLedger, load_prices  # noqa: PLC0415
    from .llm import GeminiClient, OpenAICompatibleClient  # noqa: PLC0415

    p = argparse.ArgumentParser(prog="corpus_analysis.fingerprint", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=("build",))
    p.add_argument("--dry-run", action="store_true", help="count passages and estimate cost; no API calls")
    p.add_argument("--out-dir", type=Path, default=FINGERPRINTS_DIR)
    args = p.parse_args(argv)

    s = load_settings()
    ledger = CostLedger(s.ledger_file, load_prices(s.prices_file), s.max_cost_usd)
    client = None
    if not args.dry_run:
        client = (OpenAICompatibleClient(s.openai_base_url or "", s.openai_api_key or "", timeout_s=s.request_timeout_s)
                  if s.llm_provider == "openai" else GeminiClient(s.gemini_api_key or "", timeout_s=s.request_timeout_s))
    print(f"budget: spent ${ledger.spent_usd:.4f} of ${ledger.max_cost_usd:.2f}")
    summary = build(s.data_dir, args.out_dir, client, s.model_embedding, ledger, dry_run=args.dry_run)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
