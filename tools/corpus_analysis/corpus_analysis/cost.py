"""Token/cost ledger with a hard budget stop."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .storage import append_jsonl, iter_jsonl


class BudgetExceeded(RuntimeError):
    """Raised *before* a call that could push spend past the configured ceiling."""


class UnknownModelPrice(RuntimeError):
    """Raised when a model has no entry in prices.yaml (the budget could not be enforced)."""


@dataclass(frozen=True)
class Price:
    input_per_m: float
    output_per_m: float

    def cost(self, input_tokens: int, output_tokens: int) -> float:
        return (input_tokens * self.input_per_m + output_tokens * self.output_per_m) / 1_000_000


def load_prices(path: Path) -> dict[str, Price]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    models = data.get("models") or {}
    if not isinstance(models, dict) or not models:
        raise ValueError(f"{path}: expected a non-empty 'models' mapping")
    return {name: Price(float(v["input"]), float(v["output"])) for name, v in models.items()}


class CostLedger:
    """Accumulates spend across the run (persisted, so ``--resume`` keeps counting)."""

    def __init__(self, ledger_file: Path, prices: dict[str, Price], max_cost_usd: float, *, dry_run: bool = False):
        self.ledger_file = ledger_file
        self.prices = prices
        self.max_cost_usd = max_cost_usd
        self.dry_run = dry_run
        self._lock = threading.Lock()
        self.spent_usd = 0.0
        self.reserved_usd = 0.0
        self.input_tokens = 0
        self.output_tokens = 0
        self.calls = 0
        self.estimated_usd = 0.0  # dry-run projection
        self.estimated_by_stage: dict[str, dict[str, float]] = {}  # dry-run tokens per stage
        if not dry_run:
            for rec in iter_jsonl(ledger_file):
                self.spent_usd += float(rec.get("cost_usd", 0.0))
                self.input_tokens += int(rec.get("input_tokens", 0))
                self.output_tokens += int(rec.get("output_tokens", 0))
                self.calls += 1

    def price(self, model: str) -> Price:
        try:
            return self.prices[model]
        except KeyError as exc:
            raise UnknownModelPrice(
                f"No price for model {model!r} in prices file; add it before running (budget enforcement)."
            ) from exc

    def reserve(self, model: str, est_input: int, est_output: int, stage: str = "other") -> float:
        """Reserve the worst-case cost of a call; raise if it would exceed the ceiling."""
        est = self.price(model).cost(est_input, est_output)
        with self._lock:
            if self.dry_run:
                self.estimated_usd += est
                m = self.estimated_by_stage.setdefault(
                    stage, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "usd": 0.0})
                m["calls"] += 1
                m["input_tokens"] += est_input
                m["output_tokens"] += est_output
                m["usd"] = round(m["usd"] + est, 4)
                return est
            if self.spent_usd + self.reserved_usd + est > self.max_cost_usd:
                raise BudgetExceeded(
                    f"Budget stop: spent ${self.spent_usd:.4f} + reserved ${self.reserved_usd:.4f} + next call "
                    f"~${est:.4f} > ceiling ${self.max_cost_usd:.2f}"
                )
            self.reserved_usd += est
            return est

    def commit(self, *, model: str, stage: str, reserved: float, input_tokens: int, output_tokens: int,
               ref: str | None = None) -> float:
        """Release the reservation and record actual usage."""
        cost = self.price(model).cost(input_tokens, output_tokens)
        with self._lock:
            self.reserved_usd = max(0.0, self.reserved_usd - reserved)
            self.spent_usd += cost
            self.input_tokens += input_tokens
            self.output_tokens += output_tokens
            self.calls += 1
        append_jsonl(self.ledger_file, {
            "at": datetime.now(timezone.utc).isoformat(), "model": model, "stage": stage, "ref": ref,
            "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": round(cost, 6),
        })
        return cost

    def release(self, reserved: float) -> None:
        with self._lock:
            self.reserved_usd = max(0.0, self.reserved_usd - reserved)

    def summary(self) -> dict[str, object]:
        return {
            "calls": self.calls, "input_tokens": self.input_tokens, "output_tokens": self.output_tokens,
            "spent_usd": round(self.spent_usd, 4), "max_cost_usd": self.max_cost_usd,
            **({"dry_run_estimated_usd": round(self.estimated_usd, 4),
                "dry_run_estimated_by_stage": self.estimated_by_stage} if self.dry_run else {}),
        }
