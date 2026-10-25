import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cosine, FingerprintMismatchError, loadFingerprints } from '../../services/urt/dedup/embeddingIndex.js';
import { contentHash, jaccardEstimate, minhash, normalize, packU64, PRIME, shingles, unpackU64 }
  from '../../services/urt/dedup/minhash.js';
import { checkOriginality } from '../../services/urt/dedup/originalityService.js';
import { FINGERPRINTS_DIR, PARAGRAPHS } from './helpers.js';

const fp = () => loadFingerprints({ dir: FINGERPRINTS_DIR, subject: 'physics',
  embeddingModel: 'text-embedding-3-small', embeddingDims: 1536 });

describe('minhash (must match the Python fingerprints bit for bit)', () => {
  // Expected values computed with tools/corpus_analysis/corpus_analysis/fingerprint.py for the same text.
  const TEXT = 'Sound travels as a longitudinal wave; its speed depends on the medium — and on temperature (Table 1).';

  it('reproduces the Python signature, content hash and constants', async () => {
    const { a, b } = await fp();
    const sig = minhash(TEXT, a, b);
    assert.equal(packU64(sig).slice(0, 60), 'lYsHHVHPxAIA/cYnNpV2CCMPqmbc6QwE5yz2wNaLYwBL4W+pK2o0AD0iQwA6');
    assert.deepEqual([sig[0], sig[1], sig[127]], [199512230797478805n, 609838859383405824n, 277527333828329059n]);
    assert.equal(contentHash(TEXT), '3b44610ed04b2ecf2d3dec3eef6d794a216e39e3b89f541720fb359c34e2622d');
    assert.equal(packU64(a).slice(0, 40), '+wV9e+8z2BDGWNniuNQDCNY+iIbGxWoEMVcxiIiQ');
  });

  it('normalizes and shingles like Python', () => {
    assert.equal(normalize('Hello,  WORLD—again! ①'), 'hello world again 1');
    assert.deepEqual([...shingles('a b c')], ['a b c']);
    assert.equal(shingles('one two three four five six').size, 2);
  });

  it('round-trips packing and handles empty text', async () => {
    const { a, b } = await fp();
    const sig = minhash(PARAGRAPHS[0], a, b);
    assert.deepEqual(unpackU64(packU64(sig)), sig);
    assert.ok(minhash('!!!', a, b).every((v) => v === PRIME));
  });
});

describe('fingerprints', () => {
  it('load with the runtime embedding model', async () => {
    const f = await fp();
    assert.ok(f.passages.length >= 10);
    assert.equal(f.passages[0].embedding.length, 1536);
  });

  it('refuse a different embedding model', async () => {
    await assert.rejects(loadFingerprints({ dir: FINGERPRINTS_DIR, subject: 'physics', embeddingModel: 'other',
      embeddingDims: 1536 }), FingerprintMismatchError);
  });
});

describe('originality check', () => {
  // A synthetic "corpus" so near-copies can be tested without any source text in the repository.
  async function corpus() {
    const { a, b } = await fp();
    const source = PARAGRAPHS.join('\n\n');
    return { a, b, shingleWords: 5,
      passages: [{ id: 'src1', contentHash: contentHash(source), signature: minhash(source, a, b),
        embedding: Float32Array.from([1, 0, 0]) }] };
  }
  const thresholds = { maxCorpusJaccard: 0.2, maxCorpusCosine: 0.85, maxPoolCosine: 0.85 };

  it('passes an unrelated text', async () => {
    const r = checkOriginality({ text: 'Tides rise and fall twice a day because of the pull of the Moon on the oceans.',
      embedding: [0, 1, 0], fingerprints: await corpus(), thresholds });
    assert.equal(r.passed, true, r.reasons.join('; '));
  });

  it('flags an exact copy (normalised)', async () => {
    const r = checkOriginality({ text: PARAGRAPHS.join(' ').toUpperCase(), embedding: [0, 1, 0],
      fingerprints: await corpus(), thresholds });
    assert.ok(r.reasons.some((x) => x.startsWith('originality_exact_copy')));
  });

  it('flags a near-copy by Jaccard even when the embedding is far', async () => {
    const near = [PARAGRAPHS[0], PARAGRAPHS[1].replace('stopwatch', 'timer'), PARAGRAPHS[2]].join('\n\n');
    const r = checkOriginality({ text: near, embedding: [0, 1, 0], fingerprints: await corpus(), thresholds });
    assert.equal(r.passed, false);
    assert.ok(r.reasons.some((x) => x.startsWith('originality_corpus_jaccard')), r.reasons.join('; '));
  });

  it('flags a paraphrase by cosine even when Jaccard is low', async () => {
    const r = checkOriginality({ text: 'An entirely reworded account of the same experiment.', embedding: [0.95, 0.1, 0],
      fingerprints: await corpus(), thresholds });
    assert.ok(r.reasons.some((x) => x.startsWith('originality_corpus_cosine')));
    assert.ok(!r.reasons.some((x) => x.startsWith('originality_corpus_jaccard')));
  });

  it('flags a duplicate of a stored pool passage', async () => {
    const r = checkOriginality({ text: 'Something new.', embedding: [0, 1, 0], fingerprints: await corpus(),
      pool: [{ id: 42, embedding: [0, 0.99, 0.05] }], thresholds });
    assert.ok(r.reasons.some((x) => x.includes('originality_pool_cosine') && x.includes('42')));
  });

  it('cosine and jaccard helpers', () => {
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(jaccardEstimate([1n, 2n], [1n, 3n]), 0.5);
  });
});
