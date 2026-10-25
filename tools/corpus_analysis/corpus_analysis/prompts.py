"""Versioned prompt files (``prompts/<name>.v<N>.md``). Prompts are never inline strings."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")


@dataclass(frozen=True)
class Prompt:
    name: str
    version: str
    template: str

    @property
    def id(self) -> str:
        return f"{self.name}.{self.version}"

    def render(self, **values: str) -> str:
        """Substitute ``{placeholders}``. Braces inside values are left alone, and a missing value fails loudly."""
        missing = set(_PLACEHOLDER.findall(self.template)) - values.keys()
        if missing:
            raise KeyError(f"prompt {self.id} missing values for {sorted(missing)}")
        return _PLACEHOLDER.sub(lambda m: values[m.group(1)], self.template)


def load_prompt(name: str, version: str = "v1", directory: Path = PROMPTS_DIR) -> Prompt:
    path = directory / f"{name}.{version}.md"
    if not path.is_file():
        raise FileNotFoundError(f"Prompt file not found: {path}")
    return Prompt(name=name, version=version, template=path.read_text(encoding="utf-8"))
