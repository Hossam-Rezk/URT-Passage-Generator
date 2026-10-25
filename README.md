# URT Passage Generator

This service generates passages for the URT exam (physics, chemistry, geology, biology,
english) for the ElRokh Academy platform. It is built here and handed to the platform
developers, who merge it into the monorepo. The paths mirror the monorepo (`server/…`,
`docs/…`).

Status: **Phase 1, Step A** (one-time corpus analysis) is implemented. The generation rules
(Step B) and the runtime agents come after the rules are reviewed.

- Plan and decisions: [`docs/urt-passage-generator/PLAN.md`](docs/urt-passage-generator/PLAN.md)
- Corpus analysis tool: [`tools/corpus_analysis/README.md`](tools/corpus_analysis/README.md)
- Configuration: [`.env.example`](.env.example)

Never commit PDFs, credentials, `.env`, the `data/` directory or student data.

The full README (architecture, how the rules were produced and how to regenerate them) and
`INTEGRATION.md` (the API contract) will be written with the runtime phase.
