"""Loads and validates the static world map (world/world.json + world/regions/*.json)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

SLUG = re.compile(r"^[a-z0-9]+(?:_[a-z0-9]+)*$")


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
    to: str  # full address region:location
    description: str | None = None


@dataclass
class Location:
    address: str
    region: str
    id: str
    name: str
    description: str
    exits: list[Exit] = field(default_factory=list)


@dataclass
class World:
    start: str
    regions: dict[str, str]  # region id -> region name
    locations: dict[str, Location]

    def get(self, address: str) -> Location | None:
        return self.locations.get(address)

    def to_dict(self, loc: Location) -> dict:
        return {
            "address": loc.address,
            "region": {"id": loc.region, "name": self.regions[loc.region]},
            "name": loc.name,
            "description": loc.description,
            "exits": [
                {
                    "direction": e.direction,
                    "to": e.to,
                    "to_name": self.locations[e.to].name,
                    **({"description": e.description} if e.description else {}),
                }
                for e in loc.exits
            ],
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


def _check_slug(value: str, where: str):
    if not SLUG.match(value):
        raise WorldError(f"{where}: {value!r} is not a valid id (use lowercase letters, digits and single underscores, e.g. \"old_mill\")")


def resolve_address(ref: str, region: str) -> str:
    return ref if ":" in ref else f"{region}:{ref}"


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

    regions: dict[str, str] = {}
    region_starts: dict[str, str] = {}
    locations: dict[str, Location] = {}
    raw_exits: list[tuple[str, str, Exit]] = []  # (where, region, exit with unresolved 'to')

    for path in files:
        fname = path.name
        data = _load_json(path)
        if not isinstance(data, dict):
            raise WorldError(f"{fname}: must be a JSON object")
        rid = _require_str(data, "id", fname)
        _check_slug(rid, f"{fname}: region id")
        if rid != path.stem:
            raise WorldError(f"{fname}: region id {rid!r} must match the file name ({path.stem!r})")
        regions[rid] = _require_str(data, "name", fname)
        region_starts[rid] = _require_str(data, "start", fname)
        locs = data.get("locations")
        if not isinstance(locs, dict) or not locs:
            raise WorldError(f"{fname}: \"locations\" must be a non-empty object keyed by location id")
        for lid, loc in locs.items():
            where = f"{fname}: location {lid!r}"
            _check_slug(lid, f"{fname}: location id")
            if not isinstance(loc, dict):
                raise WorldError(f"{where}: must be an object")
            address = f"{rid}:{lid}"
            exits_raw = loc.get("exits", [])
            if not isinstance(exits_raw, list):
                raise WorldError(f"{where}: \"exits\" must be a list")
            exits = []
            seen_dirs = set()
            for i, ex in enumerate(exits_raw):
                ewhere = f"{where}, exit #{i + 1}"
                if not isinstance(ex, dict):
                    raise WorldError(f"{ewhere}: must be an object")
                direction = _require_str(ex, "direction", ewhere).strip()
                if direction.lower() in seen_dirs:
                    raise WorldError(f"{ewhere}: direction {direction!r} is used twice")
                seen_dirs.add(direction.lower())
                e = Exit(direction, _require_str(ex, "to", ewhere).strip(), _require_str(ex, "description", ewhere, optional=True))
                exits.append(e)
                raw_exits.append((ewhere, rid, e))
            locations[address] = Location(address, rid, lid, _require_str(loc, "name", where),
                                          _require_str(loc, "description", where), exits)

    for where, rid, e in raw_exits:
        target = resolve_address(e.to, rid)
        if target not in locations:
            raise WorldError(f"{where}: exit target {e.to!r} does not exist (looked for {target!r})")
        e.to = target

    for rid, start in region_starts.items():
        if f"{rid}:{start}" not in locations:
            raise WorldError(f"{rid}.json: start location {start!r} does not exist in region {rid!r}")
    if start_region not in regions:
        raise WorldError(f"world.json: start_region {start_region!r} has no matching file in regions/")

    return World(start=f"{start_region}:{region_starts[start_region]}", regions=regions, locations=locations)
