import json

from flask import Blueprint, jsonify, request

from . import repo, svc
from .. import ApiError

bp = Blueprint("sets", __name__, url_prefix="/api/sets")


def _with_progress(rows):
    for r in rows:
        target = r.get("target") or 0
        r["completion_pct"] = round(100.0 * (r.get("owned") or 0) / target, 1) if target else 0.0
    return rows


@bp.get("")
def list_sets():
    sets_by_id = {s["id"]: s for s in repo().list_collection_sets()}
    rows = _with_progress(repo().set_progress())
    for r in rows:
        r["description"] = (sets_by_id.get(r["id"]) or {}).get("description")
    return jsonify({"data": rows})


@bp.get("/<set_id>")
def get_set(set_id):
    cset = repo().get_collection_set(set_id)
    if not cset:
        raise ApiError("set no encontrado", "not_found", 404)
    progress = _with_progress(repo().set_progress(set_id))
    cset["progress"] = progress[0] if progress else None
    cset["slots"] = repo().get_set_slots(set_id)
    # What the rule left out, so that nothing in the set is invisible. A card
    # excluded by a rule used to look exactly like a card that did not exist.
    cset["excluded"] = repo().cards_excluded_from_set(set_id)
    return jsonify(cset)


@bp.get("/<set_id>/missing")
def missing(set_id):
    if not repo().get_collection_set(set_id):
        raise ApiError("set no encontrado", "not_found", 404)
    return jsonify({"data": repo().missing_slots(set_id, request.args.get("sort", "number"))})


@bp.post("")
def create_set():
    body = request.get_json(silent=True) or {}
    if not body.get("id") or not body.get("name"):
        raise ApiError("id y name son obligatorios")
    _save(body)
    return jsonify(repo().get_collection_set(body["id"])), 201


@bp.put("/<set_id>")
def update_set(set_id):
    if not repo().get_collection_set(set_id):
        raise ApiError("set no encontrado", "not_found", 404)
    body = request.get_json(silent=True) or {}
    body["id"] = set_id
    _save(body)
    return jsonify(repo().get_collection_set(set_id))


def _save(body):
    rules = body.get("rules")
    repo().upsert_collection_set({
        "id": body["id"],
        "name": body.get("name") or body["id"],
        "description": body.get("description"),
        "group_name": body.get("group_name"),
        "position": int(body.get("position", 0)),
        "rules_json": json.dumps(rules) if rules is not None else body.get("rules_json"),
    })


@bp.delete("/<set_id>")
def delete_set(set_id):
    repo().delete_collection_set(set_id)
    return jsonify({"deleted": set_id})


@bp.post("/<set_id>/rebuild")
def rebuild(set_id):
    """Re-materialise slots from rules_json. Manual slots survive (PLAN.md §2.10)."""
    return jsonify(svc("setbuilder").build(set_id))


@bp.post("/<set_id>/cards/<card_id>")
def pin_card(set_id, card_id):
    """Add one card to a set by hand.

    A rule cannot express "everything except the holos, but keep this one", and
    bending the rule to fit a single card makes the rule mean less. The card is
    pinned instead, and a rebuild leaves it alone.
    """
    if not repo().get_collection_set(set_id):
        raise ApiError("set no encontrado", "not_found", 404)
    if not repo().get_card(card_id):
        raise ApiError("carta no encontrada", "not_found", 404)

    added = repo().add_manual_slot(set_id, card_id)
    if added is None:
        raise ApiError("esa carta ya está en el set", "already_present", 409)
    return jsonify(added), 201


@bp.delete("/<set_id>/cards/<card_id>")
def unpin_card(set_id, card_id):
    """Remove a hand-added card. Rule-built slots are left alone."""
    if not repo().remove_manual_slot(set_id, card_id):
        raise ApiError("esa carta no fue añadida a mano a este set",
                       "not_manual", 409)
    return jsonify({"set_id": set_id, "card_id": card_id, "removed": True})
