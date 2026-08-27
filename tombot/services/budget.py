"""A hard ceiling on requests to a metered API.

The tcggo plan allows 100 requests a day and bills the card for every request
beyond that. So this is not a politeness limiter that can be tuned later: going
over costs real money, and a loop over 1,104 cards would do it in seconds.

Three decisions follow from that:

* The count is **persisted**. An in-memory counter resets on every restart, and
  a container that restarts four times would quietly spend four times the cap.
* A request is **reserved before it is sent**, not counted after. If the process
  dies mid-flight the reservation still stands: over-counting wastes a request,
  under-counting spends money.
* The default cap sits **below** the real plan limit, so an off-by-one, a retry
  or a clock-skewed day boundary lands in the headroom rather than on the bill.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


class BudgetExhausted(RuntimeError):
    """Raised instead of sending a request that would exceed the daily cap."""

    def __init__(self, provider: str, used: int, limit: int):
        self.provider, self.used, self.limit = provider, used, limit
        super().__init__(
            f"{provider}: daily request budget spent ({used}/{limit}). "
            f"It resets at 00:00 UTC; nothing was sent."
        )


def _today() -> str:
    # UTC, so the boundary does not move with the host's timezone.
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class RequestBudget:
    def __init__(self, repo, provider: str, limit: int):
        self.repo = repo
        self.provider = provider
        self.limit = max(0, int(limit))

    def used(self, day: str | None = None) -> int:
        """Requests spent in the last 24 hours, not since midnight.

        The window is rolling because the plan's own reset is not visible to
        us. A calendar-day counter permits twice the cap across a midnight —
        obediently, and on the card.
        """
        return self.repo.budget_used_in_window(self.provider)

    def remaining(self) -> int:
        return max(0, self.limit - self.used())

    def reserve(self, n: int = 1) -> int:
        """Claim n requests up front, or raise without sending anything.

        The check and the increment happen in one transaction so two threads
        cannot both see the last slot as free.
        """
        if n <= 0:
            return self.used()
        used = self.repo.budget_reserve_window(self.provider, n, self.limit)
        if used is None:
            raise BudgetExhausted(self.provider, self.used(), self.limit)
        if self.limit and used >= self.limit * 0.8:
            log.warning("%s: %d of %d daily requests used", self.provider,
                        used, self.limit)
        return used

    def can_afford(self, n: int) -> bool:
        return self.remaining() >= n
