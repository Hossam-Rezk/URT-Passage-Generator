"""Manifest of processed files so the single run can be interrupted and resumed safely.

Each file moves through ordered stages: ``downloaded → extracted → segmented → analyzed``.
A stage is recorded only after its output has been written atomically, so a crash
mid-stage simply re-runs that stage on ``--resume``.
"""

from __future__ import annotations

import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from .storage import atomic_write_json, read_json

STAGES: tuple[str, ...] = ("downloaded", "extracted", "segmented", "analyzed")


class ManifestError(RuntimeError):
    """Raised when the manifest state does not allow the requested operation."""


class FileEntry(BaseModel):
    """One source PDF and its progress through the pipeline."""

    drive_id: str
    name: str
    drive_path: str = ""
    md5: str | None = None
    sha256: str | None = None
    local_path: str | None = None
    subject_hint: str | None = None
    stages: dict[str, dict[str, Any]] = Field(default_factory=dict)
    errors: list[dict[str, Any]] = Field(default_factory=list)

    def done(self, stage: str) -> bool:
        return stage in self.stages


class Manifest:
    """Thread-safe JSON manifest persisted after every mutation."""

    VERSION = 1

    def __init__(self, path: Path, files: dict[str, FileEntry] | None = None) -> None:
        self.path = path
        self.files: dict[str, FileEntry] = files or {}
        self._lock = threading.RLock()

    # Construction ------------------------------------------------------------------
    @classmethod
    def open(cls, path: Path, *, resume: bool) -> "Manifest":
        """Open the manifest. Refuses to silently continue an existing run without ``--resume``."""
        if path.exists():
            data = read_json(path)
            if data.get("version") != cls.VERSION:
                raise ManifestError(f"Unsupported manifest version in {path}: {data.get('version')}")
            files = {k: FileEntry(**v) for k, v in data.get("files", {}).items()}
            if files and not resume:
                raise ManifestError(
                    f"{path} already tracks {len(files)} files. Re-run with --resume to continue, "
                    "or move the data directory away to start over."
                )
            return cls(path, files)
        return cls(path)

    def save(self) -> None:
        with self._lock:
            atomic_write_json(
                self.path,
                {"version": self.VERSION, "files": {k: v.model_dump() for k, v in self.files.items()}},
            )

    # Mutation ----------------------------------------------------------------------
    def upsert(self, entry: FileEntry) -> FileEntry:
        """Add a file, or refresh its metadata; a changed checksum resets its progress."""
        with self._lock:
            existing = self.files.get(entry.drive_id)
            if existing is None:
                self.files[entry.drive_id] = entry
            else:
                if entry.md5 and existing.md5 and entry.md5 != existing.md5:
                    existing.stages.clear()
                    existing.sha256 = None
                existing.name, existing.drive_path, existing.md5 = entry.name, entry.drive_path, entry.md5
                existing.subject_hint = entry.subject_hint
            self.save()
            return self.files[entry.drive_id]

    def mark(self, drive_id: str, stage: str, **info: Any) -> None:
        if stage not in STAGES:
            raise ValueError(f"Unknown stage {stage!r}")
        with self._lock:
            entry = self.files[drive_id]
            entry.stages[stage] = {"at": datetime.now(timezone.utc).isoformat(), **info}
            # Invalidate later stages: their inputs just changed.
            for later in STAGES[STAGES.index(stage) + 1 :]:
                entry.stages.pop(later, None)
            self.save()

    def record_error(self, drive_id: str, stage: str, error: str) -> None:
        with self._lock:
            self.files[drive_id].errors.append(
                {"at": datetime.now(timezone.utc).isoformat(), "stage": stage, "error": error[:2000]}
            )
            self.save()

    # Queries -----------------------------------------------------------------------
    def pending(self, stage: str, *, subject: str | None = None, limit: int | None = None) -> list[FileEntry]:
        """Files whose previous stage is done but ``stage`` is not, in stable name order."""
        idx = STAGES.index(stage)
        out: list[FileEntry] = []
        for entry in sorted(self.files.values(), key=lambda e: (e.drive_path, e.name)):
            if subject and entry.subject_hint != subject:
                continue
            if idx > 0 and not entry.done(STAGES[idx - 1]):
                continue
            if entry.done(stage):
                continue
            out.append(entry)
        return out[:limit] if limit else out

    def selected(self, *, subject: str | None = None, limit: int | None = None) -> list[FileEntry]:
        """The deterministic working set for this run (used to keep ``--limit`` stable across stages)."""
        entries = [e for e in sorted(self.files.values(), key=lambda e: (e.drive_path, e.name))
                   if not subject or e.subject_hint == subject]
        return entries[:limit] if limit else entries
