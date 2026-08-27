# TomBot Pokémon Tracker

Self-hosted, single-user web app for managing a physical Pokémon card collection:
personal set definitions, completion tracking, own photos, and estimated value from
Cardmarket prices.

Built from the spec in `TOMBOT POKEMON TRACKER.pdf`. **`PLAN.md` is the authoritative
document** — it records the corrections made to that spec and why.

```
Flask + Vanilla JS SPA · SQLite (WAL) · photos on the filesystem · Docker
```

## Quick start

```bash
make install       # venv + dependencies
make bootstrap     # schema + catalog import (~1,100 cards) + 12 personal sets
make run           # http://127.0.0.1:8080
```

### On a home server (Docker)

```bash
cp .env.example .env
$EDITOR .env                 # set APP_PORT, BIND_ADDR, PUID/PGID
docker compose up -d
```

That is the whole install. The container creates the schema, imports the catalog
(~1,100 cards), builds the personal sets and resolves the Cardmarket links on first
start, then serves. Watch it with `make docker-logs`.

The upstream API returns HTTP 500 fairly often. Everything the bootstrap does is
idempotent and resumable, so a failed set is picked up on the next restart — nothing
is lost and nothing is duplicated.

**Changing the port** — one value in `.env`, nothing else:

```ini
APP_PORT=9090
```

**Reaching it from other machines on your LAN:**

```ini
BIND_ADDR=0.0.0.0
APP_TOKEN=<openssl rand -hex 24>
```

`BIND_ADDR` defaults to `127.0.0.1` deliberately. The API has no login, so anything that
can reach the port can delete your collection — set `APP_TOKEN` before opening it up. The
browser needs it once: `localStorage.setItem('app_token', '<value>')`.

**File ownership** — set `PUID`/`PGID` to your own `id -u` / `id -g`, otherwise the
database and photos end up owned by root on the host.

**Get the free API key first.** Without `POKEMONTCG_API_KEY` the upstream allowance is
1,000 requests/day; the catalog and its images use most of that, and resolving Cardmarket
links costs one request per card on top. A keyless install can run out of quota partway
and end up with sets missing. A free key from https://dev.pokemontcg.io/ raises it to
20,000/day.

If setup does hit the limit it stops and says so rather than grinding on, keeps
everything it already imported, and resumes from there when re-run:

```
STOPPED: upstream rate limit reached.
  not attempted: gym1, gym2, neo1, neo2
  No POKEMONTCG_API_KEY is set, so the limit is 1,000 requests/day.
  ...
  Nothing is lost — re-running resumes from where it stopped.
```

Cardmarket links are **not** resolved during setup for the same reason — that is ~1,100
requests for links that already work via redirect. Run `make docker-links` once the
catalog is settled.

Two containers come up: `app` (the web UI) and `scheduler` (the monthly price refresh).
Skip the scheduler with `make docker-app` and use host cron instead if you prefer.

### Running flask commands in the container

**You normally do not need to.** The container runs `init-db`, `import-catalog`,
`seed-sets` and `resolve-links` itself on first start — `docker compose up -d` is the
whole setup. Watch it happen with `make docker-logs`.

Run them by hand when you want to retry something that failed, rebuild the sets after
editing the rules, or refresh prices off-schedule:

```bash
make docker-bootstrap   # schema + catalog + sets + links, all idempotent
make docker-initdb      # schema only
make docker-sets        # rebuild personal sets from seed_sets.py
make docker-links       # resolve Cardmarket product URLs
make docker-prices      # refresh prices
make docker-shell       # a shell, for anything else
```

Every one of those is safe to re-run. `import-catalog` skips sets it already has,
`seed-sets` preserves hand-edited slots, and none of them touch your collection.

**If you are not using make**, pass the user explicitly. `docker compose exec` bypasses
the entrypoint and runs as root, which leaves root-owned WAL files beside the database:

```bash
docker compose exec --user $(id -u):$(id -g) app flask seed-sets   # correct
docker compose run  --rm app flask seed-sets                       # also correct
docker compose exec app flask seed-sets                            # runs as root — avoid
```

### Trying the UI before you own anything

A fresh install has a full catalog and 919 empty set slots, which is correct but hard to
judge. To fill the collection with sample cards:

```bash
make docker-demo         # ~180 records across 10 sets, deterministic
make docker-demo-clear   # remove them again
```

`docker-demo-clear` deletes **all** collection items and photos, so do not run it once
you have entered real cards. Neither command touches the catalog or the personal sets.

## What it does

| Feature | Where |
|---|---|
| Personal sets defined by rules (`Jungle (sin holos)`) | `tombot/services/seed_sets.py` |
| Set grid with placeholders for missing cards | `#/set/<id>` |
| Cartas: inventory, or every card in your sets | `#/cartas` |
| Card modal: variants, photos, prices, edit | `static/js/modal.js` |
| Missing-cards wishlist | `#/missing` |
| Hall of Fame ranking (0-8) | card modal · `#/cartas?rating_min=7` |
| Dashboard + value history | `#/dashboard` |
| Monthly price refresh | `flask monthly` |

## Multi-edition cards

A card reprinted across sets can be recorded as the specific edition you hold. When a
card has sibling printings, the modal shows an **Edición / Set actual** selector; picking
one records that printing's catalog card, so the personal set slot is still satisfied
while the physical edition is preserved.

Groups live in `card_printings` and come from two sources, tracked in `source`:

- **`slot`** — you grouped the cards in a personal set slot. Authoritative: it is a
  direct statement that they are the same logical card.
- **`auto`** — the importer matched name + number + supertype. A hint only.
- **`manual`** — entered by hand; never touched by a rebuild.

The distinction matters because pokemontcg.io exposes **no reprint relationship**, and no
heuristic reconstructs one reliably. Matching on name alone pairs Base Set Magmar with
the EX Team Rocket Returns Magmar — different cards entirely. Even name + number pairs
Jynx #31 in Base Set with Jynx #31 in Neo Revelation, which are unrelated. The auto pass
is the best structural signal available and is still only a starting point; grouping
cards in a slot is how you state the truth.

Rebuild with `flask rebuild-printings` (also run by `import-catalog` and `bootstrap`).
## Photos

Add them from the card modal, per variant. On a phone the picker opens the **photo
library**, not the camera — most card photos already exist in the gallery, and jumping
straight to the camera hides them behind an extra tap.

In the grid a card is represented by the photo of its **best-conditioned** copy. If you
own a Near Mint and a Heavily Played Ninetales, the grid shows the Near Mint one
regardless of which row is being rendered. Without a photo the order is catalog art, then
placeholder.

## The Cartas view

Two modes over the same filter bar:

- **En colección** (default) — the physical inventory, one row per
  `(card, variant, condition, language)`.
- **Todas las del set** — every slot in your personal sets. Cards you do not own
  appear as grey hatched placeholders (`owned: false`), so a set reads as a checklist.

`?show_all=1` selects the second. Filters that describe a physical copy — condition,
variant, language, Hall of Fame rank — can only match owned rows, so using any of them
drops the placeholders. That is the intended behaviour for the rank filter and is
equally right for the others.

Sorting always falls back to a card column, because placeholders have no collection
row to sort on.

## Hall of Fame

Every card can be ranked 0-8 — 0 meaning unranked, 8 a masterpiece. Set it from the card
modal; it saves on click, since ranking is something you do repeatedly while going
through a binder.

The rank belongs to the **card**, in its own `card_ratings` table. Rank Ninetales once
and every copy you own — holo, non-holo, any condition or language — carries it. The
rank answers "how much do I like this card", which has nothing to do with which physical
copy is in hand.

It is a separate table rather than a column on `cards` so that a catalog re-import,
which overwrites everything in `cards`, cannot touch it. You can also rank a card you do
not own yet.

Filter with `?rating=`, `?rating_min=`, `?rating_max=`, or the **Top Tier ★7+** and
**Favoritas ★5+** quick filters. Sort with `?sort=rating`. The dashboard shows the
average and a gallery of the top tier.

The average deliberately ignores unranked cards: 0 means "not ranked yet", not "ranked
zero", so including them would describe how much ranking is left rather than the
collection.

## Concepts

Four things are kept deliberately separate. This is the design's spine:

- **Catalog** — which cards exist. Comes from an external source, safe to overwrite.
- **Personal set** — which cards *you* consider part of "your Base Set". Yours.
- **Collection** — which physical cards you actually own. Yours.
- **Price** — roughly what a card is worth. External, cached.

Re-importing the catalog never touches the last three.

### Slots, not cards

A personal set is a list of **slots**. A slot is completed by owning **any one** of the
catalog cards mapped to it. That is what makes a holo and a non-holo Charizard count as
one completed card while still being two physical cards and two separate values.

```
collection_sets ──< set_slots ──< set_slot_cards >── cards
```

### Set rules

Personal sets are materialised from a declarative rule, so a catalog refresh does not
mean re-curating a thousand rows:

```json
{ "include_sets": ["base2"], "exclude_rarities": ["Rare Holo"] }
```

Rebuild with `POST /api/sets/<id>/rebuild` or `flask seed-sets`. Slots you edited by
hand (`source='manual'`) survive a rebuild.

## Prices

Cardmarket's own API is application-gated and not obtainable for a personal project.
`api.pokemontcg.io` republishes Cardmarket EUR prices per card with no account, and is
used as both catalog and price source. See `PLAN.md` §2.2.

### What can and cannot be priced apart

pokemontcg.io publishes **one price per card id**. That means:

- **Editions are priced apart** when they are separate cards — Base Set Charizard
  (`base1-4`) and a Celebrations reprint are different ids with different prices.
- **Variants within one printing are not.** Shadowless, 1st Edition and Unlimited
  Charizard are all `base1-4` and share a number.
- **Reverse holo is the exception** — the upstream carries `reverseHolo*` fields.

Where a variant has no price of its own, the app reports **"sin datos"** rather than
borrowing another variant's. A reverse holo used to inherit the ordinary card's price,
which valued a €2 card at €1,500. A wrong number is worse than no number when it lands
in the dashboard total looking like fact. The dashboard reports price **coverage**
alongside the total so a low figure reads as missing data.

No public source prices by *condition* or by *printing language*, so:

```
estimate = base_price(card, variant) × condition_multiplier × language_multiplier
```

Multipliers live in the `price_modifiers` table and are editable. Cards with no price
data show `—`, never `€0`, so a low total reads as missing data rather than a cheap
collection.

Every card links out to its Cardmarket product page from the modal. Those URLs are
resolved once (`flask resolve-links`) and stored, because the slug is Cardmarket-internal
and not derivable — `Charizard-V2-BS4`, `Brocks-Rhydon-GH2`. Set `CARDMARKET_LOCALE`
(default `es`) to pick the site language.

Refresh monthly — that matches how often upstream updates Cardmarket data. The
`scheduler` container does this for you (`SCHEDULER_CRON_DAY` / `SCHEDULER_CRON_HOUR`
in `.env`). If you would rather use host cron, run `make docker-app` to skip that
container and add:

```cron
0 4 1 * *  cd /srv/tombot-pokemon-tracker && docker compose exec -T app flask monthly
```

The scheduler runs as its own container on purpose: an in-process scheduler inside
gunicorn fires once per worker, so every price run would happen `WEB_CONCURRENCY` times.

## Commands

```bash
flask init-db                        # schema + default modifiers
flask import-catalog [--sets a,b]    # catalog import, resumable
flask seed-sets [--rebuild]          # personal sets from seed_sets.py
flask resolve-links                  # Cardmarket product URLs, resumable
flask prices [--all]                 # refresh prices for owned cards
flask snapshot                       # collection snapshot for history charts
flask monthly                        # prices + snapshot (cron target)
flask bootstrap                      # all of the above, fresh install
```

## Configuration

All via environment variables — see `.env.example` and `tombot/config.py`.

Notable: `APP_TOKEN`. The app has no login by design (single user). It binds to
`127.0.0.1` by default. If you expose it beyond your LAN, set `APP_TOKEN` and every
`/api/*` call will require an `X-App-Token` header.

### The tcggo key (optional, and it costs money if you get it wrong)

`tcggo` is a second price source. It is worth having because it maps one
Cardmarket product per card, which is what TCGdex gets wrong for the non-holo
print of every WOTC rare — see PLAN.md §2.19.

**Its plan bills per request past a daily allowance.** Everything below exists
to make going over that allowance hard.

Put the key in `.env` in the same folder as `docker-compose.yml`:

```ini
TCGGO_API_KEY=your-key-here
TCGGO_DAILY_LIMIT=80
```

`.env` is gitignored, so the key stays on your machine. Never put it in
`.env.example`, in `docker-compose.yml`, or in a commit.

Then:

```bash
docker compose up -d          # picks up .env automatically
```

**`TCGGO_DAILY_LIMIT` is a hard stop, not a suggestion.** The app counts every
request in its own database and refuses to send one past the limit. Keep it
*below* the number your plan actually allows: the gap absorbs retries and the
day boundary. The default of 80 assumes a plan of 100.

Some details worth knowing before you change it:

* The count lives in the database, so restarting the container does **not**
  hand back a fresh allowance.
* The app and the scheduler share one allowance, for the same reason.
* A request is counted *before* it is sent. If something dies mid-request the
  slot is still spent — wasting a request is better than being billed for one.
* Setting `TCGGO_DAILY_LIMIT=0` blocks the source entirely.
* The allowance is a **rolling 24 hours**, not a calendar day. A day counter
  would allow the full cap twice across a midnight — 80 at 23:00 and 80 at
  01:00 is 160 requests in two hours — and we cannot see how the plan itself
  counts, so this takes the cautious reading.

To check what is left, or to test the key without touching the app:

```bash
docker compose exec tombot-tracker python scripts/tcggo_live_check.py
```

That spends exactly two requests, prints how many remain, and refuses to run
if the budget cannot cover them.

Nothing uses tcggo unless you set `PRICE_SOURCE=tcggo`. With the key absent,
the app carries on with the sources it already had.

## Layout

```
app.py                      entrypoint
tombot/
  config.py                 env config + domain vocabularies
  api/                      Flask blueprints — no SQL here
  services/
    repository.py           PokemonRepo — the only module that touches SQLite
    schema.sql
    sources/                pokemontcgio adapter (TCGdex slot open)
    importer.py setbuilder.py pricing.py images.py seed_sets.py
  cli/                      flask commands
static/ templates/          Vanilla JS SPA
data/pokemon.db             gitignored
media/{catalog,collection,thumbs}/   gitignored
tests/
```

`PokemonRepo` is a hard rule: route handlers get dicts, never cursors.

## Tests

```bash
make test
```

The suite covers the completion semantics that are easy to get wrong — variant
collapsing, quantity vs completion, the unique constraint that stops double counting,
and that foreign keys are actually enforced.

## Handover

See `HANDOVER.md`. Short version: `make bundle` produces a single file containing the
full git history that the new maintainer clones and pushes to his own remote.

## Not in scope

No OCR or card recognition (spec §9/§28). No accounts, no trading, no deck building.
Prices are estimates and are labelled as such.
