// Loads the Phase 1 source fingerprints (server/urt/rules/fingerprints/<subject>.json) for the
// originality check. A file made with another embedding model or size is refused: its vectors
// would not be comparable with the runtime's.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { unpackU64 } from './minhash.js';

export class FingerprintMismatchError extends Error {}

export function unpackF32(b64) {
  const buf = Buffer.from(b64, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

export function packF32(values) {
  return Buffer.from(Float32Array.from(values).buffer);
}

export function cosine(u, v) {
  let dot = 0;
  let nu = 0;
  let nv = 0;
  for (let i = 0; i < u.length; i += 1) {
    dot += u[i] * v[i];
    nu += u[i] * u[i];
    nv += v[i] * v[i];
  }
  return nu && nv ? dot / Math.sqrt(nu * nv) : 0;
}

/**
 * @returns {Promise<{subject, a: bigint[], b: bigint[], shingleWords: number, passages: Array}>}
 */
export async function loadFingerprints({ dir, subject, embeddingModel, embeddingDims }) {
  const file = path.join(dir, `${subject}.json`);
  const fp = JSON.parse(await readFile(file, 'utf8'));
  if (fp.format_version !== 1) throw new FingerprintMismatchError(`${file}: unsupported format_version ${fp.format_version}`);
  if (fp.embedding.model !== embeddingModel || fp.embedding.dims !== embeddingDims) {
    throw new FingerprintMismatchError(`${file}: built with ${fp.embedding.model} (${fp.embedding.dims} dims), `
      + `but the runtime uses ${embeddingModel} (${embeddingDims} dims); rebuild the fingerprints or change the model`);
  }
  if (BigInt(fp.minhash.prime) !== (1n << 61n) - 1n || fp.minhash.num_perm !== 128) {
    throw new FingerprintMismatchError(`${file}: unexpected MinHash parameters`);
  }
  return {
    subject,
    a: unpackU64(fp.minhash.a_b64),
    b: unpackU64(fp.minhash.b_b64),
    shingleWords: fp.minhash.shingle_words,
    passages: fp.passages.map((p) => ({ id: p.id, source: p.source, contentHash: p.content_hash,
      signature: unpackU64(p.minhash_b64), embedding: unpackF32(p.embedding_b64) })),
  };
}
