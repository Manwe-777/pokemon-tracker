"""Probe TCGdex for Cardmarket product collisions between printings.

Vintage WOTC sets print the same Pokemon as a holo rare and a non-holo rare
with different numbers. Those are separate Cardmarket products. If TCGdex
reports one product id for both, every non-holo of such a pair carries the
holo's price.

Run from CI: api.tcgdex.net refuses connections from some networks.
"""
import json
import os
import pathlib
import sys
import urllib.request

BASE = "https://api.tcgdex.net/v2/en/cards/"

# Holo / non-holo pairs in the same set, by card id.
PAIRS = [
    ("base2-3", "base2-19", "Flareon (Jungle)"),
    ("base2-1", "base2-17", "Clefable (Jungle)"),
    ("base2-4", "base2-20", "Jolteon (Jungle)"),
    ("base3-1", "base3-17", "Aerodactyl (Fossil)"),
    ("base3-2", "base3-18", "Articuno (Fossil)"),
    ("base5-1", "base5-16", "Dark Alakazam (Team Rocket)"),
]

out_dir = pathlib.Path("tcgdex-probe")
out_dir.mkdir(exist_ok=True)


def fetch(card_id):
    req = urllib.request.Request(
        BASE + card_id, headers={"User-Agent": "tombot-probe"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def products(payload):
    """Every (printing key, Cardmarket product id, main price) in the payload."""
    rows = []
    top = ((payload.get("pricing") or {}).get("cardmarket") or {})
    if top:
        rows.append({"type": "<card-level pricing>", "stamp": "-",
                     "idProduct": top.get("idProduct"), "avg": top.get("avg"),
                     "trend": top.get("trend"), "avg30": top.get("avg30")})
    for v in payload.get("variants_detailed") or []:
        cm = ((v.get("pricing") or {}).get("cardmarket") or {})
        stamps = "+".join(v.get("stamp") or []) or "-"
        rows.append({
            "type": v.get("type"), "stamp": stamps,
            "idProduct": cm.get("idProduct"),
            "avg": cm.get("avg"), "trend": cm.get("trend"),
            "avg30": cm.get("avg30"),
        })
    return rows


collisions, checked = [], 0
for holo_id, plain_id, label in PAIRS:
    try:
        a, b = fetch(holo_id), fetch(plain_id)
    except Exception as e:                                   # noqa: BLE001
        print(f"!! {label}: fetch failed: {e}")
        continue
    checked += 1
    (out_dir / f"{holo_id}.json").write_text(json.dumps(a, indent=2))
    (out_dir / f"{plain_id}.json").write_text(json.dumps(b, indent=2))

    pa, pb = products(a), products(b)
    print(f"\n=== {label} ===")
    print(f"  {holo_id:10} {a.get('rarity','?'):12} {pa}")
    print(f"  {plain_id:10} {b.get('rarity','?'):12} {pb}")

    ids_a = {r["idProduct"] for r in pa if r["idProduct"]}
    ids_b = {r["idProduct"] for r in pb if r["idProduct"]}
    shared = ids_a & ids_b
    if shared:
        print(f"  ** COLLISION: both cards share product id(s) {sorted(shared)}")
        collisions.append({"label": label, "holo": holo_id, "plain": plain_id,
                           "shared": sorted(shared),
                           "holo_rows": pa, "plain_rows": pb})
    else:
        print("  ok: distinct products")

(out_dir / "summary.json").write_text(json.dumps(
    {"checked": checked, "collisions": collisions}, indent=2))
print(f"\nchecked {checked} pairs, {len(collisions)} collided")
