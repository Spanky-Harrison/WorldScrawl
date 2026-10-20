"""Loads and validates the static world map (worlds/<id>/world.json + worlds/<id>/regions/*.json).

Region file layout:
  {name, notes?, start: "sub/loc",
   subregions: {sub_id: {name, notes?, inherit_notes?: bool (default true),
                         locations: {loc_id: {name, description, inherit_region_notes?: bool,
                                              inherit_subregion_notes?: bool, exits: [...]}}}}}
Full address: "region:sub/loc". Exit "to": "loc" (same subregion), "sub/loc" (same region) or "region:sub/loc".
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
VIEWS = ("open", "closed", "none")  # optional exit "view": what can be seen through it (default: closed if hidden/obscured, else open)
EXIT_FLAGS = ("hidden", "obscured")  # optional booleans on an exit (today both mean "obscured"; see README)
log = logging.getLogger("uvicorn.error")


class WorldError(Exception):
    """Raised when the world files are invalid. The message says which file and what is wrong."""


def _no_duplicate_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise WorldError(f"duplicate key {key!r}")
        obj[key] = value
    return obj


def _load_json(path: Path):
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f, object_pairs_hook=_no_duplicate_keys)
    except WorldError as e:
        raise WorldError(f"{path.name}: {e}") from None
    except json.JSONDecodeError as e:
        raise WorldError(f"{path.name}: invalid JSON at line {e.lineno}, column {e.colno}: {e.msg}") from None


@dataclass
class Exit:
    direction: str
    to: str  # full address region:sub/loc after loading
    description: str | None = None
    flags: dict = field(default_factory=dict)
    door: str | None = None  # opaque id shared by a flagged/closed exit and its return exit (derived at load)
    view: str | None = None  # as written ("open" | "closed" | "none"), None = default
    stays_open: bool | None = None  # as written; None = follow the subregion / region (default false)

    @property
    def flagged(self) -> bool:
        return bool(self.flags.get("hidden") or self.flags.get("obscured"))

    @property
    def effective_view(self) -> str:
        return self.view or ("closed" if self.flagged else "open")


@dataclass
class Region:
    id: str
    name: str
    notes: str | None
    entrance: str = ""  # full address of the way in (default: the region's start room)
    stays_open: bool | None = None  # opened doors here stay open (default: they shut themselves)


@dataclass
class Subregion:
    id: str
    name: str
    notes: str | None
    inherit_notes: bool = True
    entrance: str = ""  # full address of the entrance room (default: first room)
    label_rooms: bool = False  # streets/outdoor groups: exits into it name the room, not the group
    stays_open: bool | None = None


@dataclass
class Location:
    address: str
    region: str
    subregion: str
    id: str
    name: str
    description: str
    exits: list[Exit] = field(default_factory=list)
    inherit_region_notes: bool | None = None  # None = follow the subregion
    inherit_subregion_notes: bool | None = None  # None = included
    views: list[str] = field(default_factory=list)  # hand-written "views": rooms visible from here with no exit (windows)


@dataclass
class World:
    start: str
    regions: dict[str, Region]
    subregions: dict[str, Subregion]  # "region:sub" -> Subregion
    locations: dict[str, Location]
    doors: dict = field(default_factory=dict)  # door id -> {"rooms": [a, b], "stays_open": bool} (derived at load)

    def get(self, address: str) -> Location | None:
        return self.locations.get(address)

    def sub_of(self, loc: Location) -> Subregion:
        return self.subregions[f"{loc.region}:{loc.subregion}"]

    def effective_notes(self, loc: Location) -> dict:
        region, sub = self.regions[loc.region], self.sub_of(loc)
        use_region = sub.inherit_notes if loc.inherit_region_notes is None else loc.inherit_region_notes
        use_sub = True if loc.inherit_subregion_notes is None else loc.inherit_subregion_notes
        return {"region": region.notes if use_region else None, "subregion": sub.notes if use_sub else None}

    @staticmethod
    def place_label(name: str, sub_name: str | None) -> str:
        """"Name (Subregion)", or just the name when the subregion has the same name (same rule as the extension)."""
        return f"{name} ({sub_name})" if sub_name and sub_name != name else name

    def inherited_stays_open(self, loc: Location) -> bool:
        """A room's own setting: its subregion's stays_open, else its region's; default false."""
        for v in (self.sub_of(loc).stays_open, self.regions[loc.region].stays_open):
            if v is not None:
                return v
        return False

    def stays_open(self, e: Exit, src: Location) -> bool:
        """Per door (the same from both sides): an explicit exit-level stays_open on either side wins (if they
        conflict, false wins); otherwise the door stays open only if both rooms' inherited settings are true."""
        if e.door and e.door in self.doors:
            return self.doors[e.door]["stays_open"]
        return e.stays_open if e.stays_open is not None else self.inherited_stays_open(src)

    @staticmethod
    def summary(loc: Location) -> str:
        """First sentence of a room's description (glimpses, view lists, nearby rooms)."""
        return re.split(r"(?<=[.!?])\s", loc.description.strip(), maxsplit=1)[0][:160]

    def view_dict(self, address: str) -> dict:
        t = self.locations[address]
        return {"address": address, "name": t.name, "display_name": self.place_label(t.name, self.sub_of(t).name), "summary": self.summary(t)}

    def to_dict(self, loc: Location) -> dict:
        region, sub = self.regions[loc.region], self.sub_of(loc)
        return {
            "address": loc.address,
            "room_token": room_token(loc.address),
            "region": {"id": region.id, "name": region.name, "notes": region.notes, "entrance": region.entrance},
            "subregion": {"id": sub.id, "name": sub.name, "notes": sub.notes, "entrance": sub.entrance,
                          "entrance_name": self.locations[sub.entrance].name, "label_rooms": sub.label_rooms},
            "name": loc.name,
            "display_name": self.place_label(loc.name, sub.name),
            "description": loc.description,
            "effective_notes": self.effective_notes(loc),
            "exits": [self._exit_dict(e, loc) for e in loc.exits],
            "views": [self.view_dict(a) for a in loc.views],
        }

    @staticmethod
    def reveals_destination(e: Exit) -> bool:
        """Same rule as the extension's revealsDestination: hidden/obscured exits don't say where they lead."""
        return not (e.flags.get("hidden") or e.flags.get("obscured"))

    def door_reveals(self, doors) -> list[dict]:
        """Destinations behind flagged exits whose door the client says it has passed through (either side).
        [{from, direction, door, to, to_name, ...}]. The client derives passed doors from its message stamps."""
        want, out = set(doors), []
        for loc in self.locations.values():
            for e in loc.exits:
                if e.flagged and e.door in want:
                    out.append({"from": loc.address, **self.destination_dict(e, loc, {"direction": e.direction, **e.flags, "door": e.door})})
        return out

    def exit_label(self, src: Location, target: Location) -> str:
        """What an exit's destination is called from `src`: the room name within the same building; the building
        name when entering another building at its entrance; "Building, Room" for another room of that building;
        plus ", Region" when the exit crosses into another region."""
        tsub = self.sub_of(target)
        if target.region == src.region and target.subregion == src.subregion:
            return target.name
        if tsub.label_rooms or target.name == tsub.name:  # streets etc.: the room is the place ("Village Square")
            label = target.name
        elif tsub.entrance == target.address:
            label = tsub.name
        else:
            label = f"{tsub.name}, {target.name}"
        if target.region != src.region:
            label += f", {self.regions[target.region].name}"
        return label

    def _exit_dict(self, e: Exit, src: Location | None = None) -> dict:
        """An exit plus everything about its destination the client needs (name, area, region, label), so the
        client never has to fetch a neighbouring room just to name it. Hidden/obscured exits reveal nothing
        about the destination: only the direction, description and flags."""
        out = {"direction": e.direction, **({"description": e.description} if e.description else {}), **e.flags,
               **({"door": e.door, "door_rooms": [room_token(a) for a in self.doors[e.door]["rooms"]]} if e.door and e.door in self.doors else {}), "view": e.effective_view,
               **({"stays_open": self.stays_open(e, src)} if src is not None else {})}
        if not self.reveals_destination(e):
            return out
        return self.destination_dict(e, src, out)

    def destination_dict(self, e: Exit, src: Location | None, out: dict) -> dict:
        target = self.locations[e.to]
        tsub, treg = self.sub_of(target), self.regions[target.region]
        return {
            "direction": e.direction,
            "to": e.to,
            "to_name": target.name,
            "to_display_name": self.place_label(target.name, tsub.name),
            "to_summary": self.summary(target),
            "to_label": self.exit_label(src, target) if src is not None else target.name,
            "to_subregion": {"id": tsub.id, "name": tsub.name, "entrance": tsub.entrance, "label_rooms": tsub.label_rooms},
            "to_region": {"id": treg.id, "name": treg.name, "entrance": treg.entrance},
            **out,
        }


def room_token(address: str) -> str:
    """Opaque id of a room: lets the client tell "is the party in one of this door's rooms?" without being told
    where an obscured door leads."""
    return "room_" + hashlib.sha1(f"room|{address}".encode()).hexdigest()[:12]


def _require_str(obj: dict, key: str, where: str, optional: bool = False):
    if key not in obj:
        if optional:
            return None
        raise WorldError(f"{where}: missing \"{key}\"")
    value = obj[key]
    if not isinstance(value, str) or not value.strip():
        raise WorldError(f"{where}: \"{key}\" must be a non-empty string")
    return value


def _optional_bool(obj: dict, key: str, where: str):
    if key not in obj:
        return None
    if not isinstance(obj[key], bool):
        raise WorldError(f"{where}: \"{key}\" must be true or false")
    return obj[key]


def _check_slug(value: str, where: str):
    if not SLUG.match(value):
        raise WorldError(f"{where}: {value!r} is not a valid id (use lowercase letters, digits and single underscores, e.g. \"old_mill\")")


def resolve_address(ref: str, region: str, sub: str) -> str:
    if ":" in ref:
        return ref
    if "/" in ref:
        return f"{region}:{ref}"
    return f"{region}:{sub}/{ref}"


def read_world_raw(root: str | Path) -> tuple[dict, dict[str, dict]]:
    """The hand-written files as plain JSON: (world.json, {region_id: region file})."""
    root = Path(root)
    world_file = root / "world.json"
    if not world_file.is_file():
        raise WorldError(f"{world_file} not found")
    world_json = _load_json(world_file)
    if not isinstance(world_json, dict):
        raise WorldError("world.json: must be a JSON object")
    region_dir = root / "regions"
    files = sorted(region_dir.glob("*.json")) if region_dir.is_dir() else []
    if not files:
        raise WorldError(f"no region files found in {region_dir}")
    return world_json, {p.stem: _load_json(p) for p in files}


def load_world(root: str | Path) -> World:
    return build_world(*read_world_raw(root))


def build_world(world_json: dict, raw_regions: dict[str, dict]) -> World:
    """Validate and build a World from plain JSON (as read from a world folder, possibly with changes applied)."""
    start_region = _require_str(world_json, "start_region", "world.json")
    if "living" in world_json and not isinstance(world_json["living"], bool):
        raise WorldError('world.json: "living" must be true or false')
    files = sorted(raw_regions)

    regions: dict[str, Region] = {}
    subregions: dict[str, Subregion] = {}
    region_starts: dict[str, str] = {}
    locations: dict[str, Location] = {}
    raw_exits: list[tuple[str, str, str, Exit]] = []
    raw_views: list = []

    for rid in files:
        fname = f"{rid}.json"
        data = raw_regions[rid]
        if not isinstance(data, dict):
            raise WorldError(f"{fname}: must be a JSON object")
        _check_slug(rid, f"{fname}: region id (file name)")
        if "id" in data and data["id"] != rid:
            raise WorldError(f"{fname}: region id {data['id']!r} must match the file name ({rid!r})")
        regions[rid] = Region(rid, _require_str(data, "name", fname), _require_str(data, "notes", fname, optional=True),
                              stays_open=_optional_bool(data, "stays_open", fname))
        start = _require_str(data, "start", fname)
        if start.count("/") != 1:
            raise WorldError(f"{fname}: \"start\" must look like \"subregion/location\", got {start!r}")
        region_starts[rid] = start
        region_entrance = _require_str(data, "entrance", fname, optional=True)
        if region_entrance is not None and region_entrance.count("/") != 1:
            raise WorldError(f"{fname}: \"entrance\" must look like \"subregion/location\", got {region_entrance!r}")
        regions[rid].entrance = f"{rid}:{region_entrance or start}"
        subs = data.get("subregions")
        if not isinstance(subs, dict) or not subs:
            raise WorldError(f"{fname}: \"subregions\" must be a non-empty object keyed by subregion id")
        for sid, sub in subs.items():
            swhere = f"{fname}: subregion {sid!r}"
            _check_slug(sid, f"{fname}: subregion id")
            if not isinstance(sub, dict):
                raise WorldError(f"{swhere}: must be an object")
            inherit = _optional_bool(sub, "inherit_notes", swhere)
            locs = sub.get("locations")
            if not isinstance(locs, dict) or not locs:
                raise WorldError(f"{swhere}: \"locations\" must be a non-empty object keyed by location id")
            entrance = _require_str(sub, "entrance", swhere, optional=True) or next(iter(locs))
            if entrance not in locs:
                raise WorldError(f"{swhere}: entrance {entrance!r} is not a room in this subregion")
            subregions[f"{rid}:{sid}"] = Subregion(sid, _require_str(sub, "name", swhere),
                                                   _require_str(sub, "notes", swhere, optional=True),
                                                   True if inherit is None else inherit, f"{rid}:{sid}/{entrance}",
                                                   bool(_optional_bool(sub, "label_rooms", swhere)),
                                                   _optional_bool(sub, "stays_open", swhere))
            for lid, loc in locs.items():
                where = f"{fname}: location {sid}/{lid}"
                _check_slug(lid, f"{fname}: location id")
                if not isinstance(loc, dict):
                    raise WorldError(f"{where}: must be an object")
                exits_raw = loc.get("exits", [])
                if not isinstance(exits_raw, list):
                    raise WorldError(f"{where}: \"exits\" must be a list")
                exits, seen_dirs = [], set()
                for i, ex in enumerate(exits_raw):
                    ewhere = f"{where}, exit #{i + 1}"
                    if not isinstance(ex, dict):
                        raise WorldError(f"{ewhere}: must be an object")
                    direction = _require_str(ex, "direction", ewhere).strip()
                    if direction.lower() in seen_dirs:
                        raise WorldError(f"{ewhere}: direction {direction!r} is used twice")
                    seen_dirs.add(direction.lower())
                    flags = {}
                    for flag in EXIT_FLAGS:
                        v = _optional_bool(ex, flag, ewhere)
                        if v is not None:
                            flags[flag] = v
                    view = ex.get("view")
                    if view is not None and view not in VIEWS:
                        raise WorldError(f"{ewhere}: \"view\" must be one of {', '.join(VIEWS)}")
                    e = Exit(direction, _require_str(ex, "to", ewhere).strip(),
                             _require_str(ex, "description", ewhere, optional=True), flags,
                             view=view, stays_open=_optional_bool(ex, "stays_open", ewhere))
                    exits.append(e)
                    raw_exits.append((ewhere, rid, sid, e))
                views = loc.get("views", [])
                if not isinstance(views, list) or not all(isinstance(v, str) and v.strip() for v in views):
                    raise WorldError(f"{where}: \"views\" must be a list of room addresses")
                raw_views.append((where, rid, sid, f"{rid}:{sid}/{lid}", views))
                address = f"{rid}:{sid}/{lid}"
                locations[address] = Location(
                    address, rid, sid, lid, _require_str(loc, "name", where), _require_str(loc, "description", where), exits,
                    _optional_bool(loc, "inherit_region_notes", where), _optional_bool(loc, "inherit_subregion_notes", where))

    for where, rid, sid, e in raw_exits:
        target = resolve_address(e.to, rid, sid)
        if target not in locations:
            raise WorldError(f"{where}: exit target {e.to!r} does not exist (looked for {target!r})")
        e.to = target
    for where, rid, sid, address, views in raw_views:
        for v in views:
            target = resolve_address(v.strip(), rid, sid)
            if target not in locations:
                raise WorldError(f"{where}: view {v!r} does not exist (looked for {target!r})")
            if target not in locations[address].views:
                locations[address].views.append(target)

    for rid, start in region_starts.items():
        if f"{rid}:{start}" not in locations:
            raise WorldError(f"{rid}.json: start location {start!r} does not exist in region {rid!r}")
        if regions[rid].entrance not in locations:
            raise WorldError(f"{rid}.json: entrance {regions[rid].entrance.split(':', 1)[1]!r} does not exist in region {rid!r}")
    if start_region not in regions:
        raise WorldError(f"world.json: start_region {start_region!r} has no matching file in regions/")

    # Pair every hidden/obscured exit with its return exit (in the destination room, pointing back): passing
    # through either side reveals both. A flagged exit with no way back is allowed (one-way doors) but warned about.
    for loc in locations.values():
        for e in loc.exits:
            if not (e.flagged or e.effective_view == "closed") or e.door:
                continue
            back = next((b for b in locations[e.to].exits if b.to == loc.address), None)
            ends = sorted([f"{loc.address}|{e.direction.lower()}"] + ([f"{e.to}|{back.direction.lower()}"] if back else []))
            e.door = "door_" + hashlib.sha1("&".join(ends).encode()).hexdigest()[:10]
            if back is None:
                log.warning("world: %s exit %r is hidden/obscured but has no return exit (one-way door)", loc.address, e.direction)
            elif back.door is None:
                back.door = e.door

    w = World(start=f"{start_region}:{region_starts[start_region]}", regions=regions, subregions=subregions, locations=locations)
    for loc in locations.values():
        for e in loc.exits:
            if not e.door or e.door in w.doors:
                continue
            back = next((b for b in locations[e.to].exits if b.to == loc.address and b.door == e.door), None)
            explicit = [x.stays_open for x in (e, back) if x is not None and x.stays_open is not None]
            stays = all(explicit) if explicit else (w.inherited_stays_open(loc) and w.inherited_stays_open(locations[e.to]))
            w.doors[e.door] = {"rooms": sorted({loc.address, e.to}), "stays_open": stays}
    return w
