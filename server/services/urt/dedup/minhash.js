// MinHash exactly as the Phase 1 fingerprints were built (tools/corpus_analysis/corpus_analysis/fingerprint.py).
// Any change here must be made there too, or signatures stop being comparable:
//   normalize: NFKC, lowercase, runs of [^a-z0-9] -> one space, trim
//   shingles:  sets of 5 consecutive words (the whole text if shorter)
//   base hash: first 8 bytes of SHA-256(UTF-8 shingle), big-endian, mod P = 2^61 - 1
//   signature: min over shingles of (a[i] * h + b[i]) mod P, with a/b read from the fingerprint file
import { createHash } from 'node:crypto';

export const PRIME = (1n << 61n) - 1n;

export function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function shingles(text, k = 5) {
  const words = normalize(text).split(' ').filter(Boolean);
  if (!words.length) return new Set();
  if (words.length < k) return new Set([words.join(' ')]);
  const out = new Set();
  for (let i = 0; i + k <= words.length; i += 1) out.add(words.slice(i, i + k).join(' '));
  return out;
}

export function baseHash(shingle) {
  return createHash('sha256').update(shingle, 'utf8').digest().readBigUInt64BE(0) % PRIME;
}

export function contentHash(text) {
  return createHash('sha256').update(normalize(text), 'utf8').digest('hex');
}

/** @param {bigint[]} a @param {bigint[]} b @returns {bigint[]} */
export function minhash(text, a, b, k = 5) {
  const hashes = [...shingles(text, k)].map(baseHash);
  if (!hashes.length) return a.map(() => PRIME);
  return a.map((ai, i) => {
    let min = PRIME;
    for (const h of hashes) {
      const v = (ai * h + b[i]) % PRIME;
      if (v < min) min = v;
    }
    return min;
  });
}

export function jaccardEstimate(s1, s2) {
  let same = 0;
  for (let i = 0; i < s1.length; i += 1) if (s1[i] === s2[i]) same += 1;
  return same / s1.length;
}

export function unpackU64(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = new Array(buf.length / 8);
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readBigUInt64LE(i * 8);
  return out;
}

export function packU64(values) {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeBigUInt64LE(v, i * 8));
  return buf.toString('base64');
}
