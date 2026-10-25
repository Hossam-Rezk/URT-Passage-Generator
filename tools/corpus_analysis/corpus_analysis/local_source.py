"""Local-folder source (same interface as Drive). Useful for testing a hand-picked sample."""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path
from typing import Iterator

from .drive import DriveFile


class LocalSource:
    def __init__(self, root: Path) -> None:
        if not root.is_dir():
            raise ValueError(f"--local-dir {root} is not a directory")
        self.root = root

    def list_pdfs(self) -> Iterator[DriveFile]:
        for path in sorted(self.root.rglob("*")):
            if path.is_file() and path.suffix.lower() == ".pdf":
                rel = path.relative_to(self.root)
                md5 = hashlib.md5(path.read_bytes()).hexdigest()  # noqa: S324 (change detection only)
                yield DriveFile(id=f"local:{rel.as_posix()}", name=path.name, path=rel.parent.as_posix().strip("."),
                                md5=md5, size=path.stat().st_size)

    def download(self, file: DriveFile, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.root / file.id.removeprefix("local:"), dest)
