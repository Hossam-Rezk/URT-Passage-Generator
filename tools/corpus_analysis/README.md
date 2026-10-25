# Corpus analysis (Phase 1, one-time)

This tool reads the URT source PDFs from Google Drive and produces one structured analysis per
passage. That analysis is the input for the generation rules (`server/urt/rules/<subject>.yaml`,
built in Step B). It runs once. It has no scheduler and no incremental ingestion, and the
platform never imports it at runtime.

## Setup (Windows PowerShell, from the repo root)

```powershell
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r tools/corpus_analysis/requirements-dev.txt
copy .env.example .env      # then fill in the three required values
```

The tool reads configuration from environment variables only. To load `.env` into the
current PowerShell session:

```powershell
Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=.' } | ForEach-Object { $k,$v = $_ -split '=',2; Set-Item "env:$k" $v }
```

Drive access: create a service account in Google Cloud and enable the Drive API. Then share
the PDF folder with the service account's email as **Viewer**, and point
`GOOGLE_APPLICATION_CREDENTIALS` at its JSON key. Keep the key outside the repo.

## Run

Run these from `tools/corpus_analysis/`, or add that folder to `PYTHONPATH`.

```powershell
cd tools/corpus_analysis
$env:URT_CA_DATA_DIR = "..\..\data\corpus_analysis"

python -m corpus_analysis run --limit 10 --dry-run   # free: download + parse, estimate cost
python -m corpus_analysis run --limit 10             # sample run, then read the report
python -m corpus_analysis run --resume               # full run, continuing the same manifest
```

| Flag | Effect |
|---|---|
| `--limit N` | Only the first N files, in a stable order (folder path, then name). |
| `--subject S` | Only files whose folder or file name indicates the subject (e.g. `Physics/…`). |
| `--dry-run` | Downloads and parses locally and estimates tokens and cost. Makes no LLM calls (OCR, segmentation fallback and analysis are skipped). |
| `--resume` | Continue an existing run. Without it, the tool refuses to touch an existing manifest. |
| `--local-dir P` | Read PDFs from a local folder instead of Drive. |

Exit codes: `0` ok, `1` configuration error, `2` **budget stop**. Progress is saved, so you
can re-run with `--resume`.

## What happens

1. **fetch**: lists the Drive folder recursively and downloads the PDFs into `data/…/raw/`.
   The subject hint comes from folder and file names. Each file is tracked in `manifest.json`;
   a changed checksum resets that file's progress.
2. **extract**: pdfplumber reads the text layer. A page with almost no text but with
   images is treated as scanned and transcribed by Gemini (tables as Markdown, graphs as
   descriptions). Pages with figures or tables are rendered to PNG for the analysis step.
   OCR'd pages are listed in the manifest and the report.
3. **segment**: a rule-based splitter finds passage headers, numbered questions confirmed by
   an "A" option, options, inline answers and answer-key sections. Every passage gets a
   structural confidence score. If a file's weakest passage scores under `0.7`, Gemini
   re-segments that file and returns line ranges, so the text stays verbatim and the output
   is cheap.
4. **analyze**: one Gemini call per passage with a strict schema
   (`schemas.PassageAnalysis`), validated by pydantic. Malformed output is retried with the
   validation errors included, then written to `dead_letter.jsonl`. Results are appended to
   `analysis/per_passage.jsonl`, so Step B never repeats LLM calls.

**Cost control.** Every call reserves its worst-case cost before it is sent. The run stops
*before* it could exceed `URT_CA_MAX_COST_USD`. Actual usage, including thinking tokens, goes
to `cost_ledger.jsonl`, which persists across `--resume`. Prices are in `prices.yaml`.
**Verify them before the full run.**

**Outputs** (all in the gitignored data directory, none committed): `manifest.json`,
`extracted/`, `pages/`, `segments/`, `analysis/per_passage.jsonl`, `dead_letter.jsonl`,
`cost_ledger.jsonl`, `reports/report_*.md`, `logs/run.jsonl`.

## Step B: generation rules and style guides

```powershell
python -m corpus_analysis.synthesis aggregate   # statistics per subject → data/…/synthesis/<subject>.aggregates.json
python -m corpus_analysis.synthesis schema      # export server/urt/rules/rules.schema.json
python -m corpus_analysis.synthesis check       # validate server/urt/rules/*.yaml, render the style guides
```

The aggregates are computed in code from `per_passage.jsonl` (labels, counts, the analysis model's
descriptions; no source text). The rules files `server/urt/rules/<subject>.yaml` are written from them
and reviewed by hand; they are the source of truth for the generation agent, sampler and validator.
`check` renders a readable guide per subject into `docs/urt-passage-generator/style-guides/`. Edit
the YAML, never the guide, bump `rules_version`, and set `status: approved` once reviewed. The contract
itself is defined in `corpus_analysis/rules_schema.py`.

Fingerprints for the runtime originality check (no source text is written):

```powershell
python -m corpus_analysis.fingerprint build --dry-run   # passages per subject, token and cost estimate
python -m corpus_analysis.fingerprint build             # server/urt/rules/fingerprints/<subject>.json + calibration.json
```

Each file stores the exact MinHash scheme (normalization, hash, permutation constants) so the Node
runtime can reproduce it; see the module docstring of `corpus_analysis/fingerprint.py`.
`calibration.json` lists reprinted duplicates, the similarity distribution of distinct passages and
the recommended `URT_MAX_*` thresholds.

To use an OpenAI-compatible gateway instead of Gemini directly, set `URT_CA_LLM_PROVIDER=openai`,
`URT_CA_OPENAI_BASE_URL` and `URT_CA_OPENAI_API_KEY` (see `.env.example`), and add the model's
price to `prices.yaml`.

## Tests

```powershell
cd tools/corpus_analysis
python -m pytest -q          # or: python -m unittest discover -s tests -t .
```

The tests build synthetic PDFs and use a fake LLM. They need no network, credentials or real
exam content.
