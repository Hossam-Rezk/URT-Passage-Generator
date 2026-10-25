"""Google Drive access (service account, read-only) for listing and downloading the source PDFs."""

from __future__ import annotations

import io
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Protocol

from .config import SUBJECTS
from .storage import atomic_write_bytes

log = logging.getLogger(__name__)

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
FOLDER_MIME = "application/vnd.google-apps.folder"
PDF_MIME = "application/pdf"


@dataclass(frozen=True)
class DriveFile:
    id: str
    name: str
    path: str  # folder path inside the root folder, e.g. "Physics/2023"
    md5: str | None
    size: int | None


class DriveSource(Protocol):
    def list_pdfs(self) -> Iterator[DriveFile]: ...
    def download(self, file: DriveFile, dest: Path) -> None: ...


def subject_hint(path: str, name: str) -> str | None:
    """Infer a subject from folder/file names (e.g. ``Physics/URT_phys_2023.pdf``); None if ambiguous."""
    haystack = f"{path}/{name}".lower()
    aliases = {
        "physics": ("physics", "phys"), "chemistry": ("chemistry", "chem"), "geology": ("geology", "geo"),
        "biology": ("biology", "bio"), "english": ("english", "eng"),
    }
    found = {s for s in SUBJECTS if any(re.search(rf"(?<![a-z]){a}", haystack) for a in aliases[s])}
    return found.pop() if len(found) == 1 else None


class GoogleDriveSource:
    """Lists PDFs recursively under one folder and downloads them. Requires the folder to be
    shared with the service account's email address."""

    def __init__(self, folder_id: str, credentials_file: Path) -> None:
        if not folder_id:
            raise ValueError("URT_DRIVE_FOLDER_ID is not set")
        if not credentials_file or not Path(credentials_file).is_file():
            raise ValueError("GOOGLE_APPLICATION_CREDENTIALS must point to a service-account JSON key file")
        from google.oauth2 import service_account  # noqa: PLC0415 (lazy optional dependency)
        from googleapiclient.discovery import build  # noqa: PLC0415

        creds = service_account.Credentials.from_service_account_file(str(credentials_file), scopes=SCOPES)
        self._svc = build("drive", "v3", credentials=creds, cache_discovery=False)
        self.folder_id = folder_id

    def _children(self, folder_id: str) -> Iterator[dict]:
        token = None
        while True:
            resp = self._svc.files().list(
                q=f"'{folder_id}' in parents and trashed = false",
                fields="nextPageToken, files(id, name, mimeType, md5Checksum, size)",
                pageSize=1000, pageToken=token, supportsAllDrives=True, includeItemsFromAllDrives=True,
            ).execute()
            yield from resp.get("files", [])
            token = resp.get("nextPageToken")
            if not token:
                return

    def list_pdfs(self) -> Iterator[DriveFile]:
        stack: list[tuple[str, str]] = [(self.folder_id, "")]
        seen: set[str] = set()
        while stack:
            folder, path = stack.pop()
            if folder in seen:  # shortcuts can create cycles
                continue
            seen.add(folder)
            for f in self._children(folder):
                if f["mimeType"] == FOLDER_MIME:
                    stack.append((f["id"], f"{path}/{f['name']}".strip("/")))
                elif f["mimeType"] == PDF_MIME or f["name"].lower().endswith(".pdf"):
                    yield DriveFile(id=f["id"], name=f["name"], path=path, md5=f.get("md5Checksum"),
                                    size=int(f["size"]) if f.get("size") else None)
                else:
                    log.info("drive_skip_non_pdf", extra={"name": f["name"], "mime": f["mimeType"]})

    def download(self, file: DriveFile, dest: Path) -> None:
        from googleapiclient.http import MediaIoBaseDownload  # noqa: PLC0415

        buf = io.BytesIO()
        req = self._svc.files().get_media(fileId=file.id, supportsAllDrives=True)
        downloader = MediaIoBaseDownload(buf, req, chunksize=8 * 1024 * 1024)
        done = False
        while not done:
            _, done = downloader.next_chunk(num_retries=5)
        atomic_write_bytes(dest, buf.getvalue())
