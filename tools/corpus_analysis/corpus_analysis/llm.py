"""Thin LLM client interface, the Gemini implementation, and a structured-output caller.

Only :class:`GeminiClient` knows about the ``google-genai`` SDK; everything else depends
on the :class:`LLMClient` protocol, so tests use a fake and the model can be swapped
through configuration.
"""

from __future__ import annotations

import base64
import json
import logging
import random
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol, Sequence, TypeVar, Union

from pydantic import BaseModel, ValidationError

from .cost import CostLedger
from .storage import append_jsonl

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


@dataclass(frozen=True)
class ImagePart:
    data: bytes
    mime_type: str = "image/png"


Part = Union[str, ImagePart]


@dataclass
class LLMResponse:
    text: str
    input_tokens: int
    output_tokens: int


class TransientLLMError(RuntimeError):
    """Rate limits, timeouts and 5xx responses: safe to retry with backoff."""


class LLMClient(Protocol):
    """Minimal surface every provider implementation must offer."""

    def generate(self, *, model: str, parts: Sequence[Part], response_schema: type[BaseModel] | None,
                 temperature: float, max_output_tokens: int) -> LLMResponse: ...


class GeminiClient:
    """``google-genai`` implementation. Imported lazily so tests never need the SDK."""

    _TRANSIENT_CODES = {408, 429, 500, 502, 503, 504}

    def __init__(self, api_key: str, *, timeout_s: float = 180.0, thinking_level: str | None = "low") -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is not set")
        from google import genai  # noqa: PLC0415  (lazy, optional dependency)
        from google.genai import types  # noqa: PLC0415

        self._types = types
        self._client = genai.Client(api_key=api_key, http_options=types.HttpOptions(timeout=int(timeout_s * 1000)))
        self._thinking_level = thinking_level

    def generate(self, *, model: str, parts: Sequence[Part], response_schema: type[BaseModel] | None,
                 temperature: float, max_output_tokens: int) -> LLMResponse:
        types = self._types
        contents = [
            types.Part.from_bytes(data=p.data, mime_type=p.mime_type) if isinstance(p, ImagePart)
            else types.Part.from_text(text=p)
            for p in parts
        ]
        cfg: dict[str, object] = {"temperature": temperature, "max_output_tokens": max_output_tokens}
        if response_schema is not None:
            cfg.update(response_mime_type="application/json", response_schema=response_schema)
        if self._thinking_level:
            cfg["thinking_config"] = types.ThinkingConfig(thinking_level=self._thinking_level)
        try:
            resp = self._client.models.generate_content(
                model=model, contents=[types.Content(role="user", parts=contents)],
                config=types.GenerateContentConfig(**cfg),
            )
        except Exception as exc:  # SDK error types vary across versions; classify by status code
            code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
            if code in self._TRANSIENT_CODES or isinstance(exc, TimeoutError):
                raise TransientLLMError(f"{type(exc).__name__}: {exc}") from exc
            raise
        usage = getattr(resp, "usage_metadata", None)
        in_tok = int(getattr(usage, "prompt_token_count", 0) or 0)
        out_tok = int(getattr(usage, "candidates_token_count", 0) or 0) + int(
            getattr(usage, "thoughts_token_count", 0) or 0)
        return LLMResponse(text=resp.text or "", input_tokens=in_tok, output_tokens=out_tok)

    def embed(self, *, model: str, texts: Sequence[str]) -> tuple[list[list[float]], int]:
        """Return one embedding per text and an estimated input token count (the API reports none)."""
        resp = self._client.models.embed_content(model=model, contents=list(texts))
        return [list(e.values) for e in resp.embeddings], sum(len(t) // 4 + 1 for t in texts)


class OpenAICompatibleClient:
    """Chat-completions client for OpenAI-compatible gateways (stdlib HTTP, no SDK).

    Gateways often ignore ``json_schema`` response formats, so the schema goes into a system
    message and only ``json_object`` mode is requested; :class:`StructuredCaller` still validates
    the result and retries with the errors.
    """

    _TRANSIENT_CODES = {408, 409, 429, 500, 502, 503, 504}

    def __init__(self, base_url: str, api_key: str, *, timeout_s: float = 180.0) -> None:
        if not base_url or not api_key:
            raise ValueError("URT_CA_OPENAI_BASE_URL and URT_CA_OPENAI_API_KEY must both be set")
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._key = api_key
        self._timeout = timeout_s

    @staticmethod
    def _content(parts: Sequence[Part]) -> list[dict[str, object]]:
        out: list[dict[str, object]] = []
        for p in parts:
            if isinstance(p, ImagePart):
                url = f"data:{p.mime_type};base64,{base64.b64encode(p.data).decode('ascii')}"
                out.append({"type": "image_url", "image_url": {"url": url}})
            else:
                out.append({"type": "text", "text": p})
        return out

    def generate(self, *, model: str, parts: Sequence[Part], response_schema: type[BaseModel] | None,
                 temperature: float, max_output_tokens: int) -> LLMResponse:
        messages: list[dict[str, object]] = []
        body: dict[str, object] = {"model": model, "temperature": temperature, "max_tokens": max_output_tokens}
        if response_schema is not None:
            schema = json.dumps(response_schema.model_json_schema(), separators=(",", ":"))
            messages.append({"role": "system", "content": (
                "Reply with a single JSON object only (no prose, no code fences) that validates "
                f"against this JSON Schema:\n{schema}")})
            body["response_format"] = {"type": "json_object"}
        messages.append({"role": "user", "content": self._content(parts)})
        body["messages"] = messages
        req = urllib.request.Request(self._url, data=json.dumps(body).encode("utf-8"), method="POST", headers={
            "Authorization": f"Bearer {self._key}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310 (configured https URL)
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code in self._TRANSIENT_CODES:
                raise TransientLLMError(f"HTTP {exc.code}: {detail}") from exc
            raise RuntimeError(f"LLM gateway HTTP {exc.code}: {detail}") from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            raise TransientLLMError(f"{type(exc).__name__}: {exc}") from exc
        text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
        text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", text)  # tolerate fenced JSON
        usage = data.get("usage") or {}
        return LLMResponse(text=text, input_tokens=int(usage.get("prompt_tokens") or 0),
                           output_tokens=int(usage.get("completion_tokens") or 0))

    def embed(self, *, model: str, texts: Sequence[str]) -> tuple[list[list[float]], int]:
        """Return one embedding per text (in order) and the input token count."""
        url = self._url.removesuffix("/chat/completions") + "/embeddings"
        req = urllib.request.Request(url, data=json.dumps({"model": model, "input": list(texts)}).encode("utf-8"),
                                     method="POST", headers={"Authorization": f"Bearer {self._key}",
                                                             "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:  # noqa: S310
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code in self._TRANSIENT_CODES:
                raise TransientLLMError(f"HTTP {exc.code}: {detail}") from exc
            raise RuntimeError(f"Embedding gateway HTTP {exc.code}: {detail}") from exc
        rows = sorted(data["data"], key=lambda d: d.get("index", 0))
        tokens = int((data.get("usage") or {}).get("prompt_tokens") or 0)
        return [r["embedding"] for r in rows], tokens


class RateLimiter:
    """Simple thread-safe limiter: at most ``rpm`` calls per rolling minute."""

    def __init__(self, rpm: int) -> None:
        self.interval = 60.0 / max(1, rpm)
        self._lock = threading.Lock()
        self._next = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next)
            self._next = start + self.interval
        delay = start - time.monotonic()
        if delay > 0:
            time.sleep(delay)


class StructuredOutputFailed(RuntimeError):
    """All attempts returned output that did not validate against the schema."""


@dataclass
class StructuredCaller:
    """Calls the LLM for a pydantic-validated result, with retries, budget and dead-lettering."""

    client: LLMClient
    ledger: CostLedger
    limiter: RateLimiter
    dead_letter_file: Path
    max_retries: int = 3
    image_tokens_estimate: int = 1100
    sleep: Callable[[float], None] = field(default=time.sleep, repr=False)  # injectable for tests

    def estimate_input_tokens(self, parts: Sequence[Part]) -> int:
        return sum(len(p) // 4 + 1 if isinstance(p, str) else self.image_tokens_estimate for p in parts)

    def call(self, *, schema: type[T], model: str, parts: Sequence[Part], stage: str, ref: str,
             temperature: float = 0.1, max_output_tokens: int = 8192) -> T | None:
        """Return a validated ``schema`` instance, or ``None`` in dry-run mode.

        Raises :class:`StructuredOutputFailed` after ``max_retries`` malformed outputs (the failure is
        also written to the dead-letter log). :class:`~.cost.BudgetExceeded` propagates untouched.
        """
        est_in = self.estimate_input_tokens(parts)
        if self.ledger.dry_run:
            self.ledger.reserve(model, est_in, max_output_tokens // 2, stage=stage)
            return None

        attempt_parts = list(parts)
        last_error = ""
        last_text = ""
        transient_failures = 0
        attempt = 0
        while attempt < self.max_retries:
            reserved = self.ledger.reserve(model, est_in + len(last_error) // 4, max_output_tokens)
            self.limiter.wait()
            try:
                resp = self.client.generate(model=model, parts=attempt_parts, response_schema=schema,
                                            temperature=temperature, max_output_tokens=max_output_tokens)
            except TransientLLMError as exc:
                self.ledger.release(reserved)
                transient_failures += 1
                if transient_failures > 6:
                    raise
                backoff = min(60.0, 2 ** transient_failures) + random.uniform(0, 1)
                log.warning("llm_transient_error", extra={"stage": stage, "ref": ref, "error": str(exc),
                                                          "backoff_s": round(backoff, 1)})
                self.sleep(backoff)
                continue  # transient errors do not consume a schema attempt
            except BaseException:
                self.ledger.release(reserved)
                raise
            self.ledger.commit(model=model, stage=stage, reserved=reserved, input_tokens=resp.input_tokens,
                               output_tokens=resp.output_tokens, ref=ref)
            attempt += 1
            last_text = resp.text
            try:
                return schema.model_validate_json(resp.text)
            except ValidationError as exc:
                last_error = _compact_validation_error(exc)
                log.warning("llm_schema_invalid", extra={"stage": stage, "ref": ref, "attempt": attempt,
                                                         "error": last_error[:500]})
                attempt_parts = [*parts, (
                    "Your previous reply did not validate against the required JSON schema. "
                    f"Errors:\n{last_error}\nReturn ONLY corrected JSON that matches the schema."
                )]
        append_jsonl(self.dead_letter_file, {
            "at": datetime.now(timezone.utc).isoformat(), "stage": stage, "ref": ref, "model": model,
            "error": last_error[:4000], "raw_output_excerpt": last_text[:4000],
        })
        raise StructuredOutputFailed(f"{stage}:{ref}: no valid output after {self.max_retries} attempts")


def _compact_validation_error(exc: ValidationError) -> str:
    return "\n".join(f"- {'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors()[:30])
