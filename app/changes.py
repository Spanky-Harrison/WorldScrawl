"""Per-chat world changes, applied to the plain JSON of a world (the hand-written format).

A change is a dict with a "type". Known types:
  {"type": "add_exit", "from": "region:sub/loc", "direction": "north", "to": "region:sub/loc", "description"?: str}
  {"type": "remove_exit", "from": "region:sub/loc", "direction": "north"}
  {"type": "dig", "from": A, "direction": "north", "to": B, "description"?: str,
   "return_direction": "south", "return_description"?: str}   two-way: exits A->B and B->A (neither may exist yet)
  {"type": "add_room", "address": "region:sub/new_id", "name": str, "description": str, "from"?: A}
      a new room in an existing subregion (no exits of its own; dig to/from it). "from" is informational.
The extension stamps changes on chat messages; the server applies them per request (/move, /travel) and when
rendering a new world folder. Anything else is rejected, so new types must be added here deliberately.
"""
from __future__ import annotations

import copy
import re

from .world import WorldError

CHANGE_TYPES = ("add_exit", "remove_exit", "dig", "add_room")
MAX_NAME, MAX_DIRECTION, MAX_DESCRIPTION = 60, 30, 400


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
        if ch["type"] == "add_room":
            address = _text(ch, "address", where)
            try:
                rid, rest = address.split(":", 1)
                sid, lid = rest.split("/", 1)
                sub = raw[rid]["subregions"][sid]
            except (ValueError, KeyError, TypeError, AttributeError):
                raise WorldError(f"{where}: no subregion for new room {address!r}") from None
            if not re.fullmatch(r"[a-z0-9]+(_[a-z0-9]+)*", lid or ""):
                raise WorldError(f"{where}: bad room id {lid!r}")
            locs = sub.setdefault("locations", {})
            if lid in locs:
                raise WorldError(f"{where}: room {address!r} already exists")
            name, desc = _text(ch, "name", where), _text(ch, "description", where)
            if len(name) > MAX_NAME or len(desc) > MAX_DESCRIPTION:
                raise WorldError(f"{where}: name or description too long")
            locs[lid] = {"name": name, "description": desc, "exits": []}
            continue
        if ch["type"] == "dig":
            a, b = _text(ch, "from", where), _text(ch, "to", where)
            if a == b:
                raise WorldError(f"{where}: a passage must lead somewhere else")
            pairs = [(a, _text(ch, "direction", where), b, ch.get("description")),
                     (b, _text(ch, "return_direction", where), a, ch.get("return_description"))]
            for frm, d, to, _ in pairs:
                if len(d) > MAX_DIRECTION:
                    raise WorldError(f"{where}: exit name {d!r} too long")
                r = _room(raw, frm, where)
                _room(raw, to, where)
                if any(str(e.get("direction", "")).lower() == d.lower() for e in r.get("exits", [])):
                    raise WorldError(f"{where}: {frm} already has an exit {d!r}")
            for frm, d, to, desc in pairs:
                _room(raw, frm, where).setdefault("exits", []).append(
                    {"direction": d, "to": to, **({"description": desc.strip()} if isinstance(desc, str) and desc.strip() else {})})
            continue
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
