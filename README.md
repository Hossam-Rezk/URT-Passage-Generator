# URT Passage Generator

Generates original URT exam passages (physics, chemistry, geology, biology, English) with
multiple-choice questions and explanations for wrong answers, for the ElRokh Academy platform. It is
built here and merged into the platform monorepo; the paths mirror it (`server/…`, `docs/…`).

- Plan and decisions: [`docs/urt-passage-generator/PLAN.md`](docs/urt-passage-generator/PLAN.md)
- Integration guide (merge points, wiring, client): [`INTEGRATION.md`](INTEGRATION.md)
- API: [`docs/api/urt-passages.md`](docs/api/urt-passages.md) · ADR: [`docs/architecture/decisions/005-urt-passage-generator.md`](docs/architecture/decisions/005-urt-passage-generator.md)
- Database: [`docs/database_system.urt.md`](docs/database_system.urt.md) · Configuration: [`.env.example`](.env.example)

## How it works

```
POST /api/urt/passages/next {subject}
  └─ servingService: fresh or reused passage for this student (never the same one twice)
       └─ none available → generation job (202 + polling)
            sampler (rules) → generation agent → validation agent → store → serve
                                                   format · length · figures · markup (free)
                                                   originality: hash · MinHash · embeddings
                                                   blind solve (no key) · review (another model)
POST /api/urt/servings/:id/submission → grading → feedback agent (cached) for wrong answers
```

The generator never sees source passages. It works from per-subject **rules**
(`server/urt/rules/<subject>.yaml`) produced once from the exam PDFs and reviewed by hand, and the
originality check compares drafts with text-free **fingerprints** of the sources.

## How the rules were produced (Phase 1, one-time)

1. `tools/corpus_analysis` (Python) extracted, split and analysed every source passage with an LLM
   (`python -m corpus_analysis run`), see [its README](tools/corpus_analysis/README.md).
2. `python -m corpus_analysis.synthesis aggregate` computed per-subject statistics; the rules YAML was
   written from them and reviewed; `… synthesis check` validates the files and renders the
   [style guides](docs/urt-passage-generator/style-guides/).
3. `python -m corpus_analysis.fingerprint build` wrote the fingerprints and the originality thresholds.

To change the rules: edit the YAML, bump `rules_version`, run `synthesis check`, set `status: approved`.
Older passages stay servable unless their version is retired.

## Development

```bash
cd server && npm install && npm test        # 107 node:test tests, no network or database needed
```

The tests run the whole module on an in-memory repository with a scripted LLM. Scripts in
`server/scripts/urt/` call the real models and always take a `--max-usd` cap (`--dry-run` is free):
`samplePassages.js`, `evalValidator.js`, `renderSamples.js`, `seedPool.js`.

## Status

| Milestone | State |
|---|---|
| M1–M4 Phase 1 analysis, rules (approved), fingerprints | done |
| M5 migration + models | drafted; checked against the models, not yet run on MySQL |
| M6 LLM client, rules loader, sampler, agents, evaluation set | done; 3/3 samples passed (~US$0.065 each); evaluation re-run with v2 prompts pending (needs API credit) |
| M7 serving, jobs, fresh buffer, API routes | done, tested on the memory repository; the MySQL repository is untested |
| M8 feedback agent and cache | done, tested with a scripted LLM; explanation samples not yet reviewed |
| M9 docs | done |
| M10 pre-seed | script ready (`seedPool.js`); not run |

Never commit PDFs, credentials, `.env`, the `data/` directory or student data.
