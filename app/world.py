"""Loads and validates the static world map (world/world.json + world/regions/*.json).

Region file layout:
  {name, notes?, start: "sub/loc",
   subregions: {sub_id: {name, notes?, inherit_notes?: bool (default true),
                         locations: {loc_id: {name, description, inherit_region_notes?: bool,
                                              inherit_subregion_notes?: bool, exits: [...]}}}}}
Full address: "region:sub/loc". Exit "to": "loc" (same subregion), "sub/loc" (same region) or "region:sub/loc".
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")
EXIT_FLAGS = ("hidden", "obscured")  # optional booleans on an exit


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


@dataclass
class Region:
    id: str
    name: str
    notes: str | None
    entrance: str = ""  # full address of the way in (default: the region's start room)


@dataclass
class Subregion:
    id: str
    name: str
    notes: str | None
    inherit_notes: bool = True
    entrance: str = ""  # full address of the entrance room (default: first room)
    label_rooms: bool = False  # streets/outdoor groups: exits into it name the room, not the group


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


@dataclass
class World:
    start: str
    regions: dict[str, Region]
    subregions: dict[str, Subregion]  # "region:sub" -> Subregion
    locations: dict[str, Location]

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

    def to_dict(self, loc: Location) -> dict:
        region, sub = self.regions[loc.region], self.sub_of(loc)
        return {
            "address": loc.address,
            "region": {"id": region.id, "name": region.name, "notes": region.notes, "entrance": region.entrance},
            "subregion": {"id": sub.id, "name": sub.name, "notes": sub.notes, "entrance": sub.entrance,
                          "entrance_name": self.locations[sub.entrance].name, "label_rooms": sub.label_rooms},
            "name": loc.name,
            "display_name": self.place_label(loc.name, sub.name),
            "description": loc.description,
            "effective_notes": self.effective_notes(loc),
            "exits": [self._exit_dict(e, loc) for e in loc.exits],
        }

    @staticmethod
    def reveals_destination(e: Exit) -> bool:
        """Same rule as the extension's revealsDestination: hidden/obscured exits don't say where they lead."""
        return not (e.flags.get("hidden") or e.flags.get("obscured"))

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
        out = {"direction": e.direction, **({"description": e.description} if e.description else {}), **e.flags}
        if not self.reveals_destination(e):
            return out
        target = self.locations[e.to]
        tsub, treg = self.sub_of(target), self.regions[target.region]
        return {
            "direction": e.direction,
            "to": e.to,
            "to_name": target.name,
            "to_display_name": self.place_label(target.name, tsub.name),
            "to_label": self.exit_label(src, target) if src is not None else target.name,
            "to_subregion": {"id": tsub.id, "name": tsub.name, "entrance": tsub.entrance, "label_rooms": tsub.label_rooms},
            "to_region": {"id": treg.id, "name": treg.name, "entrance": treg.entrance},
            **out,
        }


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


def load_world(root: str | Path) -> World:
    root = Path(root)
    world_file = root / "world.json"
    if not world_file.is_file():
        raise WorldError(f"{world_file} not found")
    world_json = _load_json(world_file)
    if not isinstance(world_json, dict):
        raise WorldError("world.json: must be a JSON object")
    start_region = _require_str(world_json, "start_region", "world.json")

    region_dir = root / "regions"
    files = sorted(region_dir.glob("*.json")) if region_dir.is_dir() else []
    if not files:
        raise WorldError(f"no region files found in {region_dir}")

    regions: dict[str, Region] = {}
    subregions: dict[str, Subregion] = {}
    region_starts: dict[str, str] = {}
    locations: dict[str, Location] = {}
    raw_exits: list[tuple[str, str, str, Exit]] = []

    for path in files:
        fname = path.name
        data = _load_json(path)
        if not isinstance(data, dict):
            raise WorldError(f"{fname}: must be a JSON object")
        rid = path.stem
        _check_slug(rid, f"{fname}: region id (file name)")
        if "id" in data and data["id"] != rid:
            raise WorldError(f"{fname}: region id {data['id']!r} must match the file name ({rid!r})")
        regions[rid] = Region(rid, _require_str(data, "name", fname), _require_str(data, "notes", fname, optional=True))
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
                                                   bool(_optional_bool(sub, "label_rooms", swhere)))
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
                    e = Exit(direction, _require_str(ex, "to", ewhere).strip(),
                             _require_str(ex, "description", ewhere, optional=True), flags)
                    exits.append(e)
                    raw_exits.append((ewhere, rid, sid, e))
                address = f"{rid}:{sid}/{lid}"
                locations[address] = Location(
                    address, rid, sid, lid, _require_str(loc, "name", where), _require_str(loc, "description", where), exits,
                    _optional_bool(loc, "inherit_region_notes", where), _optional_bool(loc, "inherit_subregion_notes", where))

    for where, rid, sid, e in raw_exits:
        target = resolve_address(e.to, rid, sid)
        if target not in locations:
            raise WorldError(f"{where}: exit target {e.to!r} does not exist (looked for {target!r})")
        e.to = target

    for rid, start in region_starts.items():
        if f"{rid}:{start}" not in locations:
            raise WorldError(f"{rid}.json: start location {start!r} does not exist in region {rid!r}")
        if regions[rid].entrance not in locations:
            raise WorldError(f"{rid}.json: entrance {regions[rid].entrance.split(':', 1)[1]!r} does not exist in region {rid!r}")
    if start_region not in regions:
        raise WorldError(f"world.json: start_region {start_region!r} has no matching file in regions/")

    return World(start=f"{start_region}:{region_starts[start_region]}", regions=regions, subregions=subregions, locations=locations)
