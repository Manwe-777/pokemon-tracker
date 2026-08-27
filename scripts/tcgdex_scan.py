"""Find every Cardmarket product that TCGdex maps to more than one card.

Two cards sharing a product id means one of them carries the other's price.
In WOTC sets that is systematic: the non-holo print of a rare inherits the
holo's product, so it prices several times too high.
"""
import json
import pathlib
import urllib.request
from concurrent.futures import ThreadPoolExecutor

SETS = ["base1", "base2", "base3", "base5", "gym1", "gym2", "basep",
        "neo1", "neo2", "neo3", "neo4", "ex7"]
BASE = "https://api.tcgdex.net/v2/en"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tombot-scan"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


CORPUS = pathlib.Path("tcgdex-scan/corpus")


def card_products(card_id):
    """Every distinct Cardmarket product id this card claims."""
    try:
        d = get(f"{BASE}/cards/{card_id}")
    except Exception as e:                                   # noqa: BLE001
        return card_id, None, None, f"error: {e}"
    CORPUS.mkdir(parents=True, exist_ok=True)
    (CORPUS / f"{card_id}.json").write_text(json.dumps(d))
    ids = set()
    top = ((d.get("pricing") or {}).get("cardmarket") or {})
    if top.get("idProduct"):
        ids.add(top["idProduct"])
    for v in d.get("variants_detailed") or []:
        cm = ((v.get("pricing") or {}).get("cardmarket") or {})
        if cm.get("idProduct"):
            ids.add(cm["idProduct"])
    return card_id, d.get("name"), d.get("rarity"), sorted(ids)


rows, errors = [], []
for set_id in SETS:
    try:
        s = get(f"{BASE}/sets/{set_id}")
    except Exception as e:                                   # noqa: BLE001
        errors.append(f"{set_id}: {e}")
        continue
    ids = [c["id"] for c in (s.get("cards") or [])]
    print(f"{set_id}: {len(ids)} cards", flush=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for cid, name, rarity, prods in pool.map(card_products, ids):
            if isinstance(prods, str):
                errors.append(f"{cid}: {prods}")
                continue
            rows.append({"set": set_id, "card_id": cid, "name": name,
                         "rarity": rarity, "products": prods})

by_product = {}
for r in rows:
    for p in r["products"]:
        by_product.setdefault(p, []).append(r)

collisions = {p: cs for p, cs in by_product.items() if len(cs) > 1}
affected = sorted({c["card_id"] for cs in collisions.values() for c in cs})

print(f"\nscanned {len(rows)} cards across {len(SETS)} sets")
print(f"products claimed by more than one card: {len(collisions)}")
print(f"cards involved in a collision: {len(affected)}")
per_set = {}
for cid in affected:
    per_set[cid.split("-")[0]] = per_set.get(cid.split("-")[0], 0) + 1
for s in SETS:
    total = sum(1 for r in rows if r["set"] == s)
    print(f"  {s:8} {per_set.get(s, 0):4} / {total}")
if errors:
    print(f"\n{len(errors)} errors (first 5): {errors[:5]}")

out = pathlib.Path("tcgdex-scan"); out.mkdir(exist_ok=True)
(out / "collisions.json").write_text(json.dumps(
    {"scanned": len(rows), "collisions": len(collisions),
     "affected_cards": affected,
     "detail": {str(p): [{"card_id": c["card_id"], "name": c["name"],
                          "rarity": c["rarity"]} for c in cs]
                for p, cs in collisions.items()}}, indent=2))
(out / "all_cards.json").write_text(json.dumps(rows, indent=2))
