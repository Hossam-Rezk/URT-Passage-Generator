// Originality check (PLAN.md §6.3, check 4): a draft fails if ANY of these fires. The Phase 1
// calibration found that each signal catches reprints the other misses (one reprint: Jaccard 0.83
// but cosine 0.80; another: cosine 0.88 but Jaccard 0.33).
//   exact      normalised text identical to a source passage
//   jaccard    MinHash Jaccard against any source passage > maxCorpusJaccard
//   cosine     embedding cosine against any source passage > maxCorpusCosine
//   pool       embedding cosine against this subject's stored passages > maxPoolCosine
import { cosine } from './embeddingIndex.js';
import { contentHash, jaccardEstimate, minhash } from './minhash.js';

/**
 * @param {object} p
 * @param {string} p.text              the draft's passage text
 * @param {Float32Array|number[]} p.embedding  the draft's embedding (already computed)
 * @param {object} p.fingerprints      loadFingerprints(...) for the subject
 * @param {Array<{id: number, embedding: Float32Array}>} [p.pool]  stored passages of the subject
 * @param {{maxCorpusJaccard: number, maxCorpusCosine: number, maxPoolCosine: number}} p.thresholds
 */
export function checkOriginality({ text, embedding, fingerprints, pool = [], thresholds }) {
  const hash = contentHash(text);
  const sig = minhash(text, fingerprints.a, fingerprints.b, fingerprints.shingleWords);
  let best = { jaccard: 0, jaccardId: null, cosine: 0, cosineId: null, poolCosine: 0, poolId: null };
  let exact = null;
  for (const p of fingerprints.passages) {
    if (p.contentHash === hash) exact = p.id;
    const j = jaccardEstimate(sig, p.signature);
    if (j > best.jaccard) best = { ...best, jaccard: j, jaccardId: p.id };
    const c = cosine(embedding, p.embedding);
    if (c > best.cosine) best = { ...best, cosine: c, cosineId: p.id };
  }
  for (const p of pool) {
    const c = cosine(embedding, p.embedding);
    if (c > best.poolCosine) best = { ...best, poolCosine: c, poolId: p.id };
  }
  const reasons = [];
  if (exact) reasons.push(`originality_exact_copy: identical to source passage ${exact}`);
  if (best.jaccard > thresholds.maxCorpusJaccard) {
    reasons.push(`originality_corpus_jaccard: ${best.jaccard.toFixed(3)} > ${thresholds.maxCorpusJaccard} (source ${best.jaccardId})`);
  }
  if (best.cosine > thresholds.maxCorpusCosine) {
    reasons.push(`originality_corpus_cosine: ${best.cosine.toFixed(3)} > ${thresholds.maxCorpusCosine} (source ${best.cosineId})`);
  }
  if (best.poolCosine > thresholds.maxPoolCosine) {
    reasons.push(`originality_pool_cosine: ${best.poolCosine.toFixed(3)} > ${thresholds.maxPoolCosine} (passage ${best.poolId})`);
  }
  return { passed: reasons.length === 0, reasons, contentHash: hash, scores: {
    jaccard: +best.jaccard.toFixed(4), cosine: +best.cosine.toFixed(4), poolCosine: +best.poolCosine.toFixed(4) } };
}
