"""Per-chat world changes, applied to the plain JSON of a world (the hand-written format).

A change is a dict with a "type". Known types:
  {"type": "add_exit", "from": "region:sub/loc", "direction": "north", "to": "region:sub/loc", "description"?: str}
  {"type": "remove_exit", "from": "region:sub/loc", "direction": "north"}
The extension stamps changes on chat messages; the server applies them per request (/move, /travel) and when
rendering a new world folder. Anything else is rejected, so new types must be added here deliberately.
"""
from __future__ import annotations

import copy

from .world import WorldError

CHANGE_TYPES = ("add_exit", "remove_exit")


def _room(raw: dict, address: str, where: str) -> dict:
    try:
        rid, rest = address.split(":", 1)
        sid, lid = rest.split("/", 1)
        return raw[rid]["subregions"][sid]["locations"][lid]
    except (ValueError, KeyError, TypeError, AttributeError):
        raise WorldError(f"{where}: room {address!r} does not exist") from None


def _text(ch: dict, key: str, where: str) -> str:
    v = ch.get(key)
    if not isinstance(v, str) or not v.strip():
        raise WorldError(f"{where}: \"{key}\" must be a non-empty string")
    return v.strip()


def apply_changes(world_json: dict, raw: dict[str, dict], changes: list) -> tuple[dict, dict[str, dict]]:
    """Copies of world.json and the region files with `changes` applied in order. Raises WorldError if invalid."""
    world_json, raw = copy.deepcopy(world_json), copy.deepcopy(raw)
    if not isinstance(changes, list):
        raise WorldError("changes must be a list")
    for i, ch in enumerate(changes):
        where = f"change #{i + 1}"
        if not isinstance(ch, dict) or ch.get("type") not in CHANGE_TYPES:
            raise WorldError(f"{where}: unknown change type {ch.get('type') if isinstance(ch, dict) else ch!r} (known: {', '.join(CHANGE_TYPES)})")
        room = _room(raw, _text(ch, "from", where), where)
        direction = _text(ch, "direction", where)
        exits = room.setdefault("exits", [])
        same = [e for e in exits if str(e.get("direction", "")).lower() == direction.lower()]
        if ch["type"] == "add_exit":
            to = _text(ch, "to", where)
            _room(raw, to, where)
            if same:
                raise WorldError(f"{where}: {ch['from']} already has an exit {direction!r}")
            exits.append({"direction": direction, "to": to, **({"description": ch["description"].strip()} if isinstance(ch.get("description"), str) and ch["description"].strip() else {})})
        else:
            if not same:
                raise WorldError(f"{where}: {ch['from']} has no exit {direction!r}")
            room["exits"] = [e for e in exits if e not in same]
    return world_json, raw
