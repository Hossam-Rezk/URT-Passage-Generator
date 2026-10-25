"""Command-line entry point: ``python -m corpus_analysis <command> [flags]``.

Commands (each later command also runs the stages it needs, reusing finished work):
  fetch     list the Drive folder (or --local-dir) and download PDFs
  extract   text layer + OCR for scanned pages + figure page images
  segment   split into passages/questions/answers (rule-based, LLM fallback)
  analyze   per-passage Gemini analysis → data/.../analysis/per_passage.jsonl
  run       all of the above, then write the quality report

Exit codes: 0 ok, 1 configuration/usage error, 2 budget stop (resume after raising the cap).
"""

from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

from .config import SUBJECTS, load_settings
from .cost import BudgetExceeded, CostLedger, UnknownModelPrice, load_prices
from .llm import GeminiClient, LLMResponse, OpenAICompatibleClient, RateLimiter, StructuredCaller
from .logging_setup import configure_logging, shutdown_logging
from .manifest import Manifest, ManifestError
from .pipeline import Pipeline
from .report import build_report, write_report

log = logging.getLogger("corpus_analysis")

COMMANDS = ("fetch", "extract", "segment", "analyze", "run")


class _NoCallClient:
    """Used in --dry-run: any real call is a bug."""

    def generate(self, **_: object) -> LLMResponse:  # pragma: no cover
        raise AssertionError("LLM called during --dry-run")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="corpus_analysis", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=COMMANDS)
    p.add_argument("--limit", type=int, default=None, help="process only the first N files (stable order)")
    p.add_argument("--subject", choices=SUBJECTS, default=None,
                   help="only files whose folder/file name indicates this subject")
    p.add_argument("--dry-run", action="store_true",
                   help="download and parse locally, estimate tokens and cost, make no LLM calls")
    p.add_argument("--resume", action="store_true", help="continue an existing run from the manifest")
    p.add_argument("--local-dir", type=Path, default=None, help="read PDFs from a local folder instead of Drive")
    p.add_argument("--exclude", action="append", default=[], metavar="GLOB",
                   help="skip files whose 'folder/name' matches this glob (case-insensitive; repeatable)")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        settings = load_settings()
    except Exception as exc:
        print(f"Invalid configuration: {exc}", file=sys.stderr)
        return 1
    configure_logging(settings.log_file, args.log_level)
    try:
        return _run(args, settings)
    finally:
        shutdown_logging()


def _run(args: argparse.Namespace, settings) -> int:
    try:
        manifest =Manifest.open(settings.manifest_file, resume=args.resume or args.dry_run)
        prices = load_prices(settings.prices_file)
        ledger = CostLedger(settings.ledger_file, prices, settings.max_cost_usd, dry_run=args.dry_run)
        ledger.price(settings.model_extract)  # fail early if the model has no price
        if args.dry_run:
            client = _NoCallClient()
        elif args.command == "fetch":
            client = None
        elif settings.llm_provider == "openai":
            client = OpenAICompatibleClient(settings.openai_base_url or "", settings.openai_api_key or "",
                                            timeout_s=settings.request_timeout_s)
        else:
            client = GeminiClient(settings.gemini_api_key or "", timeout_s=settings.request_timeout_s,
                                  thinking_level=settings.thinking_level)
        caller = None if client is None else StructuredCaller(
            client=client, ledger=ledger, limiter=RateLimiter(settings.requests_per_minute),
            dead_letter_file=settings.dead_letter_file, max_retries=settings.max_llm_retries,
            image_tokens_estimate=settings.image_tokens_estimate)
        if args.local_dir:
            from .local_source import LocalSource  # noqa: PLC0415
            source = LocalSource(args.local_dir)
        elif settings.drive_folder_id:
            from .drive import GoogleDriveSource  # noqa: PLC0415
            source = GoogleDriveSource(settings.drive_folder_id, settings.google_credentials)
        else:
            source = None
    except (ManifestError, UnknownModelPrice, ValueError, FileNotFoundError, ImportError) as exc:
        log.error("startup_failed", extra={"error": str(exc)})
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    pipe = Pipeline(settings, manifest, caller, source=source, dry_run=args.dry_run, subject=args.subject,
                    limit=args.limit, exclude=args.exclude)
    order = COMMANDS[: COMMANDS.index(args.command) + 1] if args.command != "run" else COMMANDS[:-1]
    code = 0
    try:
        for stage in order:
            if stage == "fetch" and source is None and args.command != "fetch":
                log.info("fetch_skipped_no_source")
                continue
            log.info("stage_start", extra={"stage": stage})
            getattr(pipe, stage)()
    except BudgetExceeded as exc:
        log.error("budget_stop", extra={"error": str(exc)})
        print(f"\n{exc}\nProgress is saved. Raise URT_CA_MAX_COST_USD or keep it and re-run with --resume.",
              file=sys.stderr)
        code = 2
    except RuntimeError as exc:
        log.error("run_failed", extra={"error": str(exc)})
        print(f"Error: {exc}", file=sys.stderr)
        code = 1
    finally:
        summary = ledger.summary()
        log.info("run_summary", extra=summary)
        if args.command in ("segment", "analyze", "run") or args.dry_run:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            path = write_report(settings.reports_dir / f"report_{'dryrun_' if args.dry_run else ''}{stamp}.md",
                                build_report(pipe.state, manifest, summary, dry_run=args.dry_run,
                                             dead_letter_file=settings.dead_letter_file))
            print(f"Report: {path}")
        print(f"Cost: {summary}")
    return code


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
