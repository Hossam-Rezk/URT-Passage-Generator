# ADR 005: URT passage generator

- Status: proposed (for review with the platform team)
- Date: 2026-10-25
- Details: [PLAN.md](../../urt-passage-generator/PLAN.md)

## Context

Students need an unlimited supply of URT-style passages (physics, chemistry, geology, biology,
English) with multiple-choice questions and explanations for wrong answers. Reusing the exam PDFs
directly would exhaust them quickly and raise copyright problems; writing passages by hand does not
scale. The only input a student gives is the subject.

## Decision

1. **Generate original passages with an LLM from reviewed rules, never from source text.** A one-time
   offline analysis (Python, `tools/corpus_analysis/`) turned the source PDFs into per-subject rules
   (`server/urt/rules/<subject>.yaml`, reviewed and approved by hand) and text-free fingerprints. At
   runtime the generator sees only the rules excerpt for a sampled combination.
2. **Validate before storing or serving.** A different model from the generator runs a blind solve
   without the key and a review; free deterministic checks (format, length, figures, markup) and an
   originality check (exact hash, MinHash Jaccard, embedding cosine against the corpus and the pool)
   run first. Only passing drafts are stored.
3. **Share a pool, never repeat for a student.** Passages are stored and reused across students; a
   student never sees the same passage twice (unique key plus code check). Every third request or so
   needs a fresh passage (rule: after two reused servings), so a pre-seeded fresh buffer is kept per
   subject and refilled in the background; when it is empty the API answers `202` and the client polls.
4. **Explanations are cached** per (question, chosen answer, prompt version), and only wrong or
   unanswered questions are explained.
5. **New `urt_*` tables only**; no existing table is altered. Deleted users are anonymised
   (`userId` set to NULL) and passages stay in the pool.
6. **Model access through an OpenAI-compatible gateway**, with model names, prices and thresholds in
   environment variables so models can be swapped without code changes.

## Consequences

- Running cost scales with fresh passages (measured ≈ US$0.065 per passage in M6 at list prices, which
  undercounted real billing; budget with a margin) and is capped per day for background refills.
- Quality depends on the validator; an evaluation set of deliberately flawed passages (target catch rate
  ≥ 95%) must pass before launch, and admins can retire a passage.
- The rules and fingerprints must be rebuilt (and the version bumped) if the exam style changes or the
  embedding model changes; fingerprints made with another embedding model are refused.

## Open items

See PLAN.md §18 (OPEN-1…5) and the merge points in `INTEGRATION.md`.
