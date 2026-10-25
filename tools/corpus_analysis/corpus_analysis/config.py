"""Settings for the one-time corpus analysis, read from environment variables only.

See the repository ``.env.example`` for the documented list. No secrets are ever
written to disk by this tool; credentials are only read from the paths/vars below.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, field_validator

SUBJECTS: tuple[str, ...] = ("physics", "chemistry", "geology", "biology", "english")


class Settings(BaseModel):
    """Validated runtime settings for the corpus-analysis CLI."""

    drive_folder_id: str | None = Field(default=None, description="Google Drive folder holding the source PDFs.")
    google_credentials: Path | None = Field(default=None, description="Service-account JSON key path.")
    gemini_api_key: str | None = Field(default=None, repr=False)

    # "gemini" calls Google directly; "openai" calls any OpenAI-compatible gateway (chat completions).
    llm_provider: Literal["gemini", "openai"] = "gemini"
    openai_base_url: str | None = None
    openai_api_key: str | None = Field(default=None, repr=False)

    data_dir: Path = Path("data/corpus_analysis")
    prices_file: Path = Path(__file__).resolve().parent.parent / "prices.yaml"

    model_extract: str = "gemini-3.8-flash"
    model_synthesis: str = "gemini-4-argon"
    model_embedding: str = "text-embedding-3-small"  # must match the runtime's URT_MODEL_EMBEDDING

    thinking_level: str | None = "low"  # Gemini 3+ thinking level; empty string disables the setting
    max_cost_usd: float = 5.0
    requests_per_minute: int = 30
    concurrency: int = 2
    max_llm_retries: int = 3
    request_timeout_s: float = 180.0

    ocr_min_chars_per_page: int = 120
    image_tokens_estimate: int = 1100
    segment_confidence_threshold: float = 0.7
    llm_segmentation_window_pages: int = 6

    @field_validator("max_cost_usd")
    @classmethod
    def _positive_budget(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("URT_CA_MAX_COST_USD must be > 0")
        return v

    # Derived paths -----------------------------------------------------------------
    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def extracted_dir(self) -> Path:
        return self.data_dir / "extracted"

    @property
    def pages_dir(self) -> Path:
        return self.data_dir / "pages"

    @property
    def segments_dir(self) -> Path:
        return self.data_dir / "segments"

    @property
    def analysis_file(self) -> Path:
        return self.data_dir / "analysis" / "per_passage.jsonl"

    @property
    def manifest_file(self) -> Path:
        return self.data_dir / "manifest.json"

    @property
    def dead_letter_file(self) -> Path:
        return self.data_dir / "dead_letter.jsonl"

    @property
    def ledger_file(self) -> Path:
        return self.data_dir / "cost_ledger.jsonl"

    @property
    def reports_dir(self) -> Path:
        return self.data_dir / "reports"

    @property
    def log_file(self) -> Path:
        return self.data_dir / "logs" / "run.jsonl"


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def load_settings() -> Settings:
    """Build :class:`Settings` from the environment (fails loudly on invalid values)."""
    raw: dict[str, object] = {
        "drive_folder_id": _env("URT_DRIVE_FOLDER_ID"),
        "google_credentials": _env("GOOGLE_APPLICATION_CREDENTIALS"),
        "gemini_api_key": _env("GEMINI_API_KEY"),
        "openai_api_key": _env("URT_CA_OPENAI_API_KEY"),
    }
    optional = {
        "llm_provider": "URT_CA_LLM_PROVIDER",
        "openai_base_url": "URT_CA_OPENAI_BASE_URL",
        "data_dir": "URT_CA_DATA_DIR",
        "prices_file": "URT_CA_PRICES_FILE",
        "model_extract": "URT_CA_MODEL_EXTRACT",
        "model_synthesis": "URT_CA_MODEL_SYNTHESIS",
        "model_embedding": "URT_CA_MODEL_EMBEDDING",
        "max_cost_usd": "URT_CA_MAX_COST_USD",
        "requests_per_minute": "URT_CA_RPM",
        "concurrency": "URT_CA_CONCURRENCY",
        "max_llm_retries": "URT_CA_MAX_LLM_RETRIES",
        "request_timeout_s": "URT_CA_REQUEST_TIMEOUT_S",
        "ocr_min_chars_per_page": "URT_CA_OCR_MIN_CHARS",
        "image_tokens_estimate": "URT_CA_IMAGE_TOKENS",
        "segment_confidence_threshold": "URT_CA_SEGMENT_CONFIDENCE",
        "llm_segmentation_window_pages": "URT_CA_SEGMENT_WINDOW_PAGES",
    }
    for field, var in optional.items():
        value = _env(var)
        if value is not None:
            raw[field] = value
    if "URT_CA_THINKING_LEVEL" in os.environ:
        raw["thinking_level"] = os.environ["URT_CA_THINKING_LEVEL"] or None
    return Settings(**raw)
