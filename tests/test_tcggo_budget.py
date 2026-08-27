"""The daily request cap, and the tcggo adapter's parsing.

The cap is the part with money behind it: the plan bills per request past the
allowance, so these tests are about it being impossible to exceed rather than
unlikely to be.
"""
import json
import pathlib
import threading

import pytest

from tombot.config import DEFAULT_MODIFIERS
from tombot.services.budget import BudgetExhausted, RequestBudget
from tombot.services.repository import PokemonRepo
from tombot.services.sources.tcggo import TcggoSource

FIX = pathlib.Path(__file__).parent / "fixtures" / "tcggo"


@pytest.fixture()
def repo(tmp_path):
    r = PokemonRepo(tmp_path / "b.db")
    r.init_db(DEFAULT_MODIFIERS)
    return r


# ------------------------------------------------------------------- budget

def test_the_cap_is_a_hard_stop(repo):
    b = RequestBudget(repo, "tcggo", limit=3)
    for _ in range(3):
        b.reserve()
    assert b.remaining() == 0
    with pytest.raises(BudgetExhausted) as e:
        b.reserve()
    assert "3/3" in str(e.value)
    assert "nothing was sent" in str(e.value)


def test_a_restart_does_not_hand_back_a_fresh_allowance(repo, tmp_path):
    """An in-memory counter would let a crash loop spend the cap many times."""
    RequestBudget(repo, "tcggo", limit=5).reserve(4)

    reopened = PokemonRepo(tmp_path / "b.db")
    reopened.init_db(DEFAULT_MODIFIERS)
    fresh = RequestBudget(reopened, "tcggo", limit=5)

    assert fresh.used() == 4
    assert fresh.remaining() == 1


def test_a_reservation_larger_than_what_is_left_is_refused_whole(repo):
    """Partial reservations would send some requests and report failure."""
    b = RequestBudget(repo, "tcggo", limit=10)
    b.reserve(8)
    with pytest.raises(BudgetExhausted):
        b.reserve(3)
    assert b.used() == 8, "the refused reservation must not have been counted"


def test_two_threads_cannot_both_take_the_last_slot(repo):
    """The check and the increment share a transaction, so only one wins."""
    b = RequestBudget(repo, "tcggo", limit=20)
    b.reserve(19)

    granted, refused = [], []
    barrier = threading.Barrier(8)

    def race():
        barrier.wait()
        try:
            b.reserve()
            granted.append(1)
        except BudgetExhausted:
            refused.append(1)

    threads = [threading.Thread(target=race) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(granted) == 1, f"{len(granted)} threads got the last slot"
    assert len(refused) == 7
    assert b.used() == 20


def test_providers_are_counted_separately(repo):
    a, c = RequestBudget(repo, "tcggo", 2), RequestBudget(repo, "other", 2)
    a.reserve(2)
    c.reserve(1)                       # must not be blocked by tcggo's spend
    assert a.remaining() == 0
    assert c.remaining() == 1


def test_a_zero_limit_blocks_everything(repo):
    """Turning the source off must not be one forgotten call away from billing."""
    with pytest.raises(BudgetExhausted):
        RequestBudget(repo, "tcggo", limit=0).reserve()


# ------------------------------------------------------------------ adapter

def test_no_request_is_sent_once_the_budget_is_spent(repo, monkeypatch):
    """The reservation happens before the HTTP call, not after it."""
    from tombot.config import Config

    monkeypatch.setattr(Config, "TCGGO_API_KEY", "test-key", raising=False)
    sent = []
    source = TcggoSource(Config, budget=RequestBudget(repo, "tcggo", limit=1))
    monkeypatch.setattr(source.session, "get",
                        lambda *a, **k: sent.append(a) or (_ for _ in ()).throw(
                            AssertionError("should not be reached")))

    with pytest.raises(AssertionError):
        source._get("/pokemon/cards/search")     # first one is allowed through
    with pytest.raises(BudgetExhausted):
        source._get("/pokemon/cards/search")     # second must not reach the net
    assert len(sent) == 1


def test_a_run_that_hits_the_cap_returns_what_it_has(repo, monkeypatch):
    """Partial results cost nothing; raising would throw away paid-for work."""
    from tombot.config import Config

    monkeypatch.setattr(Config, "TCGGO_API_KEY", "test-key", raising=False)
    source = TcggoSource(Config, budget=RequestBudget(repo, "tcggo", limit=2))
    payload = json.loads((FIX / "flareon-ju19.json").read_text())

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            return payload

    # Patched at the socket, not at _get: _get is where the budget is spent,
    # so replacing it would test nothing.
    monkeypatch.setattr(source.session, "get", lambda *a, **k: FakeResponse())

    out = source.fetch_prices(["base2-19", "base1-4", "base1-7", "base2-3"])

    assert len(out) == 2, "should stop at the cap, not raise"
    assert out["base2-19"]["variants"][0]["market_product_id"] == 273816


# ------------------------------------------------------------------ parsing

def test_the_two_jungle_flareons_get_different_products():
    """The collision TCGdex has: here #3 and #19 are separate products."""
    holo = json.loads((FIX / "flareon-ju3.json").read_text())["data"][0]
    plain = json.loads((FIX / "flareon-ju19.json").read_text())["data"][0]

    a, b = TcggoSource.parse_card(holo), TcggoSource.parse_card(plain)
    assert a["market_product_id"] == 273800
    assert b["market_product_id"] == 273816
    assert a["market_product_id"] != b["market_product_id"]
    assert b["price"] == pytest.approx(10.72)      # not the holo's 49.31


def test_print_runs_are_separate_cards_with_their_own_keys():
    """Shadowless and 1st Edition Shadowless are distinct here, unlike upstream."""
    shadowless = json.loads((FIX / "charizard-shadowless.json").read_text())["data"]
    first_ed = json.loads((FIX / "charizard-1st-shadowless.json").read_text())["data"]

    a, b = TcggoSource.parse_card(shadowless), TcggoSource.parse_card(first_ed)
    assert a["key"] == "shadowless"
    assert b["key"] == "1st-edition:shadowless"


def test_tcggo_has_its_own_shared_product_and_the_data_shows_it():
    """Both Charizard print runs report product 660224 with different prices.

    Recorded so the guard is not quietly dropped for this source: one of these
    two mappings is wrong, whichever it turns out to be.
    """
    a = TcggoSource.parse_card(
        json.loads((FIX / "charizard-shadowless.json").read_text())["data"])
    b = TcggoSource.parse_card(
        json.loads((FIX / "charizard-1st-shadowless.json").read_text())["data"])

    assert a["market_product_id"] == b["market_product_id"] == 660224
    assert a["price"] != b["price"]


def test_stock_and_country_prices_survive_parsing():
    """A price with nothing listed behind it is a number, not an offer."""
    card = json.loads((FIX / "flareon-ju3.json").read_text())["data"][0]
    p = TcggoSource.parse_card(card)

    assert p["available_items"] == 412
    assert p["lowest_by_country"]["es"] == 199
    assert p["lowest_by_country"]["de"] == 65
    assert p["currency"] == "EUR"


# -------------------------------------------------------------------- cache

def test_a_cached_response_costs_no_budget(repo, tmp_path, monkeypatch):
    """A request already paid for must never be paid for twice."""
    from tombot.config import Config
    from tombot.services.httpcache import HttpCache

    monkeypatch.setattr(Config, "TCGGO_API_KEY", "test-key", raising=False)
    budget = RequestBudget(repo, "tcggo", limit=10)
    cache = HttpCache(tmp_path / "cache")
    source = TcggoSource(Config, budget=budget, cache=cache)

    calls = []
    payload = json.loads((FIX / "flareon-ju19.json").read_text())

    class FakeResponse:
        status_code = 200

        @staticmethod
        def json():
            calls.append(1)
            return payload

    monkeypatch.setattr(source.session, "get", lambda *a, **k: FakeResponse())

    first = source._get("/pokemon/cards/search", {"tcg_id": "base2-19"})
    assert budget.used() == 1

    for _ in range(5):
        again = source._get("/pokemon/cards/search", {"tcg_id": "base2-19"})
        assert again == first

    assert budget.used() == 1, "cached reads must not spend the allowance"
    assert len(calls) == 1, "only the first call should reach the network"


def test_different_params_are_different_cache_entries(repo, tmp_path, monkeypatch):
    """A page number must not silently return another page's data."""
    from tombot.config import Config
    from tombot.services.httpcache import HttpCache

    monkeypatch.setattr(Config, "TCGGO_API_KEY", "test-key", raising=False)
    source = TcggoSource(Config, budget=RequestBudget(repo, "tcggo", limit=10),
                         cache=HttpCache(tmp_path / "c"))
    seq = [{"data": [{"id": 1}]}, {"data": [{"id": 2}]}]

    class FakeResponse:
        status_code = 200

        def __init__(self, body):
            self._body = body

        def json(self):
            return self._body

    monkeypatch.setattr(source.session, "get",
                        lambda *a, **k: FakeResponse(seq.pop(0)))

    p1 = source._get("/x", {"page": 1})
    p2 = source._get("/x", {"page": 2})
    assert p1 != p2
    assert source._get("/x", {"page": 1}) == p1     # served from cache


# ------------------------------------------------------ the rolling window

def test_the_window_rolls_rather_than_resetting_at_midnight(repo):
    """A calendar day lets twice the cap through across a midnight.

    80 at 23:00 and 80 at 01:00 is 160 requests in two hours. The plan's own
    reset is not visible to us, so the window has to be the conservative one.
    """
    b = RequestBudget(repo, "tcggo", limit=3)
    b.reserve(3)
    assert b.remaining() == 0

    # Requests from 23 hours ago are still inside the window.
    with repo.tx() as c:
        c.execute("""UPDATE api_requests
                        SET sent_at = datetime('now', '-23 hours')
                      WHERE provider='tcggo'""")
    assert RequestBudget(repo, "tcggo", limit=3).remaining() == 0, \
        "23 hours ago is not yesterday"

    with pytest.raises(BudgetExhausted):
        RequestBudget(repo, "tcggo", limit=3).reserve()


def test_requests_age_out_of_the_window(repo):
    """Past 24 hours they stop counting, or the cap would be permanent."""
    b = RequestBudget(repo, "tcggo", limit=3)
    b.reserve(3)

    with repo.tx() as c:
        c.execute("""UPDATE api_requests
                        SET sent_at = datetime('now', '-25 hours')
                      WHERE provider='tcggo'""")

    fresh = RequestBudget(repo, "tcggo", limit=3)
    assert fresh.used() == 0
    assert fresh.reserve() == 1


def test_the_worst_case_across_a_midnight_stays_under_the_cap(repo):
    """The number Tom actually cares about: never more than the limit in 24h."""
    limit = 80
    b = RequestBudget(repo, "tcggo", limit=limit)
    for _ in range(limit):
        b.reserve()

    # Midnight passes. Under a per-day counter this would free the whole
    # allowance again; under a rolling window it frees nothing.
    with repo.tx() as c:
        c.execute("""UPDATE api_requests
                        SET sent_at = datetime('now', '-2 hours')
                      WHERE provider='tcggo'""")

    after_midnight = RequestBudget(repo, "tcggo", limit=limit)
    assert after_midnight.remaining() == 0
    with pytest.raises(BudgetExhausted):
        after_midnight.reserve()
