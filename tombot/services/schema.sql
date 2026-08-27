-- TOMBOT POKEMON TRACKER — schema
-- See PLAN.md §3. Every connection must set foreign_keys=ON (SQLite defaults it OFF).

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- CATALOG  (external source of truth; safe to overwrite on re-import)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS official_sets (
    id             TEXT PRIMARY KEY,          -- 'base1'
    name           TEXT NOT NULL,             -- 'Base'
    series         TEXT,                      -- 'Base'
    printed_total  INTEGER,
    total          INTEGER,
    release_date   TEXT,                      -- 'YYYY/MM/DD' from source
    ptcgo_code     TEXT,
    logo_url       TEXT,
    symbol_url     TEXT,
    source         TEXT NOT NULL DEFAULT 'pokemontcgio',
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cards (
    id               TEXT PRIMARY KEY,        -- 'base1-4'
    official_set_id  TEXT NOT NULL REFERENCES official_sets(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    number           TEXT NOT NULL,           -- '4', 'H12', 'SH1' — string on purpose
    number_sort      REAL,                    -- derived; lexical sort puts #10 before #2
    rarity           TEXT,
    supertype        TEXT,                    -- Pokémon / Trainer / Energy
    subtypes_json    TEXT,
    types_json       TEXT,
    artist           TEXT,
    image_small_url  TEXT,
    image_large_url  TEXT,
    image_local      TEXT,                    -- cached path under media/catalog
    external_ids_json TEXT,                   -- {"pokemontcgio": "...", "cardmarket_url": "..."}
    source           TEXT NOT NULL DEFAULT 'pokemontcgio',
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_set    ON cards(official_set_id, number_sort);
CREATE INDEX IF NOT EXISTS idx_cards_name   ON cards(name);
CREATE INDEX IF NOT EXISTS idx_cards_rarity ON cards(rarity);

-- ---------------------------------------------------------------------------
-- PERSONAL SETS  (user-owned; a catalog re-import must never touch these)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_sets (
    id           TEXT PRIMARY KEY,            -- 'base-set', 'jungle-no-holos'
    name         TEXT NOT NULL,
    description  TEXT,
    group_name   TEXT,                        -- 'Gen1' / 'Gen 2' / 'Gen 3'
    position     INTEGER NOT NULL DEFAULT 0,
    rules_json   TEXT,                        -- declarative rule; see PLAN.md §2.10
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A slot is ONE completion target. Owning any member card completes it.
-- This is what lets reprints/variants collapse to a single logical card (PLAN.md §2.1).
CREATE TABLE IF NOT EXISTS set_slots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id          TEXT NOT NULL REFERENCES collection_sets(id) ON DELETE CASCADE,
    position        INTEGER NOT NULL,
    label           TEXT,                     -- display name; defaults to primary card name
    display_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
    source          TEXT NOT NULL DEFAULT 'rule',   -- 'rule' | 'manual'
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_slots_set ON set_slots(set_id, position);

CREATE TABLE IF NOT EXISTS set_slot_cards (
    slot_id  INTEGER NOT NULL REFERENCES set_slots(id) ON DELETE CASCADE,
    card_id  TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    set_id   TEXT NOT NULL REFERENCES collection_sets(id) ON DELETE CASCADE,  -- denormalised
    PRIMARY KEY (slot_id, card_id)
);

-- A catalog card may belong to at most one slot within a given personal set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_slotcards_unique ON set_slot_cards(set_id, card_id);
CREATE INDEX IF NOT EXISTS idx_slotcards_card ON set_slot_cards(card_id);

-- Catalog printings of one logical card.
--
-- pokemontcg.io exposes no reprint relationship, and no name/number heuristic
-- reconstructs one reliably: Jynx #31 exists in Base Set and Neo Revelation as
-- entirely different cards. So groups come from two sources, recorded in
-- `source` so the weaker one can be told apart and overridden:
--
--   'slot'   the user grouped these cards in a personal set slot. Authoritative
--            -- it is a direct statement that they are the same logical card.
--   'auto'   the importer matched name + number + supertype. A hint only.
--   'manual' entered by hand.
--
-- print_group is the card_id of the earliest-released member, so it is stable
-- across re-imports.
CREATE TABLE IF NOT EXISTS card_printings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    print_group     TEXT NOT NULL,
    card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    official_set_id TEXT NOT NULL REFERENCES official_sets(id) ON DELETE CASCADE,
    is_reprint      INTEGER NOT NULL DEFAULT 0,
    display_name    TEXT,
    -- Physical variants this edition can come in, as a JSON list. Derived from
    -- the set era and the card's rarity: a WOTC holo rare exists as 1st Edition,
    -- Shadowless and Unlimited, a modern card does not.
    variants_json   TEXT,
    source          TEXT NOT NULL DEFAULT 'auto',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (print_group, card_id)
);

CREATE INDEX IF NOT EXISTS idx_printings_card  ON card_printings(card_id);
CREATE INDEX IF NOT EXISTS idx_printings_group ON card_printings(print_group);

-- ---------------------------------------------------------------------------
-- COLLECTION  (user-owned; the source of truth on what is physically held)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id    TEXT NOT NULL REFERENCES cards(id) ON DELETE RESTRICT,
    variant    TEXT NOT NULL DEFAULT 'normal',   -- normal|holo|reverse|first_edition|shadowless|other
    condition  TEXT NOT NULL DEFAULT 'NM',       -- NM|LP|MP|HP|DMG
    language   TEXT NOT NULL DEFAULT 'es',       -- es|en|pt|other
    quantity   INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    -- Which catalog printing this physical card is. Nullable: most cards exist
    -- in one printing, and card_id already identifies it.
    printing_id INTEGER REFERENCES card_printings(id) ON DELETE SET NULL,
    -- The Cardmarket product this row IS. Chosen in the modal from the real
    -- version list, so pricing becomes a lookup rather than a guess: no
    -- variant to translate, no printing to resolve, no field to pick.
    market_product_id INTEGER,
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Without this, two rows of the same combination silently double the physical count.
    UNIQUE (card_id, variant, condition, language)
);

CREATE INDEX IF NOT EXISTS idx_items_card ON collection_items(card_id);

-- N photos per item (PLAN.md §2.4). The spec's single image column could not
-- satisfy "one photo per variant, swipe through them in the modal".
CREATE TABLE IF NOT EXISTS collection_photos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id        INTEGER NOT NULL REFERENCES collection_items(id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,             -- under media/collection/
    thumb_filename TEXT,                      -- under media/thumbs/
    width          INTEGER,
    height         INTEGER,
    bytes          INTEGER,
    is_primary     INTEGER NOT NULL DEFAULT 0,
    position       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_item ON collection_photos(item_id, position);

-- Hall of Fame rank, 0-8, per logical card.
--
-- Deliberately its own table rather than a column on cards: the rank is the
-- user's judgement and must survive a catalog re-import, which overwrites
-- everything in `cards`.
--
-- It is keyed by card and NOT by collection row. The rank answers "how much do I
-- like this card", which has nothing to do with which physical copy is in hand —
-- ranking the holo and the non-holo Ninetales separately is busywork that says
-- the same thing twice.
CREATE TABLE IF NOT EXISTS card_ratings (
    card_id    TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    rating     INTEGER NOT NULL CHECK (rating BETWEEN 0 AND 8),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_card_ratings_rating ON card_ratings(rating);

-- How many copies of a card count as "done".
--
-- Its own table for the same reason as card_ratings: it is the user's intent, not
-- catalog data, so a re-import must not touch it. Absent means 1, so the default
-- costs no rows and behaves exactly as before this existed.
CREATE TABLE IF NOT EXISTS card_targets (
    card_id    TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    target     INTEGER NOT NULL CHECK (target >= 1),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- PRICES
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS price_cache (
    card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    variant     TEXT NOT NULL DEFAULT 'normal',
    source      TEXT NOT NULL DEFAULT 'cardmarket',
    currency    TEXT NOT NULL DEFAULT 'EUR',
    price       REAL,                         -- the chosen basis (see config PRICE_BASIS)
    price_low   REAL,
    price_trend REAL,
    price_avg30 REAL,
    raw_json    TEXT,                         -- full upstream payload, for later re-derivation
    -- Which printing this price describes, e.g. 'holo:shadowless'. Recorded so a
    -- price can be traced back to the exact print run rather than guessed at.
    variant_key TEXT,
    market_product_id INTEGER,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (card_id, variant, source)
);

-- Every price we were quoted, from every provider and every market.
--
-- price_cache holds the ONE number a card is valued at. This holds all the
-- others, because a single number hides the thing that matters: when two
-- providers quoting the SAME market disagree by 4x, one of them is describing
-- a different card. Keeping the quotes is what makes that visible instead of
-- silently averaging into a number that is wrong in a plausible way.
-- Requests spent against a metered API, per UTC day.
--
-- Persisted rather than held in memory: a restart must not hand back a fresh
-- allowance, because the allowance is what keeps the card from being billed.
-- Which tcggo episode a set is, resolved once and kept.
--
-- Set filtering is the only reliable way to reach every printing of a card:
-- card numbers are stored inconsistently upstream ("BS 4" in Base Set, 19 in
-- Jungle), so a number filter silently drops versions. Looking the episode up
-- costs a request, so it is looked up once.
CREATE TABLE IF NOT EXISTS set_episodes (
    official_set_id TEXT PRIMARY KEY REFERENCES official_sets(id) ON DELETE CASCADE,
    episode_id      INTEGER NOT NULL,
    episode_name    TEXT,
    episode_code    TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per request actually sent, so the allowance can be counted over a
-- rolling window rather than a calendar day.
--
-- A per-day counter looks obedient and still overspends: 80 at 23:00 and 80 at
-- 01:00 is 160 requests inside two hours. If the plan counts any 24 hours —
-- and we cannot see how it counts — that is a bill.
CREATE TABLE IF NOT EXISTS api_requests (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    sent_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_api_requests_window
    ON api_requests(provider, sent_at);

CREATE TABLE IF NOT EXISTS api_budget (
    provider TEXT NOT NULL,
    day      TEXT NOT NULL,              -- YYYY-MM-DD, UTC
    count    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, day)
);

CREATE TABLE IF NOT EXISTS price_quotes (
    card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    variant     TEXT NOT NULL DEFAULT 'normal',
    provider    TEXT NOT NULL,               -- who told us: tcgdex | pokemontcgio
    market      TEXT NOT NULL,               -- which market: cardmarket | tcgplayer
    printing    TEXT NOT NULL DEFAULT '',    -- print run, e.g. 'holo:shadowless'
    currency    TEXT NOT NULL,
    price       REAL,                        -- the headline number for this quote
    price_low   REAL,
    price_mid   REAL,
    price_high  REAL,
    price_trend REAL,
    price_avg30 REAL,
    product_id  INTEGER,                     -- the market's own product id
    -- 0 when this quote cannot be trusted, with the reason in distrust_reason.
    trusted     INTEGER NOT NULL DEFAULT 1,
    distrust_reason TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (card_id, variant, provider, market, printing)
);

CREATE INDEX IF NOT EXISTS idx_price_quotes_card ON price_quotes(card_id, variant);

CREATE TABLE IF NOT EXISTS price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id     TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    variant     TEXT NOT NULL DEFAULT 'normal',
    source      TEXT NOT NULL DEFAULT 'cardmarket',
    currency    TEXT NOT NULL DEFAULT 'EUR',
    price       REAL,
    captured_on TEXT NOT NULL,                -- 'YYYY-MM-DD', one row per day max
    UNIQUE (card_id, variant, source, captured_on)
);

CREATE INDEX IF NOT EXISTS idx_pricehist_card ON price_history(card_id, captured_on);

-- Condition/language multipliers. No public source prices by condition or by
-- printing language, so these are local, editable estimates (PLAN.md §2.12).
CREATE TABLE IF NOT EXISTS price_modifiers (
    kind       TEXT NOT NULL,                 -- 'condition' | 'language' | 'variant'
    key        TEXT NOT NULL,
    multiplier REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (kind, key)
);

-- ---------------------------------------------------------------------------
-- HISTORY  (current state cannot answer "how many did I own in March" — §2.6)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collection_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    captured_on    TEXT NOT NULL UNIQUE,      -- 'YYYY-MM-DD'
    unique_cards   INTEGER NOT NULL DEFAULT 0,
    physical_cards INTEGER NOT NULL DEFAULT 0,
    sets_total     INTEGER NOT NULL DEFAULT 0,
    sets_complete  INTEGER NOT NULL DEFAULT 0,
    completion_pct REAL NOT NULL DEFAULT 0,
    value_eur      REAL NOT NULL DEFAULT 0,
    breakdown_json TEXT,                      -- per-set detail
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_meta (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
