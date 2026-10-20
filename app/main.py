"""WorldScrawl API: stateless, read-only maps (one per world folder). Run: uvicorn app.main:app --port 5100"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import tempfile
from datetime import datetime
from collections import OrderedDict
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .changes import apply_changes
from .world import World, WorldError, build_world, load_world, read_world_raw

DEFAULT_WORLDS_DIR = Path(__file__).resolve().parent.parent / "worlds"
DEFAULT_WORLD_ID = "riverton"
VERSION_HEADER = "X-WorldScrawl-Map-Version"
WORLD_ID = re.compile(r"^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$")  # world ids = folder names: letters, digits, dashes
log = logging.getLogger("uvicorn.error")  # shows up in the normal server console


def map_version(root: Path) -> str:
    """Short hash of world.json + every region file, computed at load. Changes whenever the map files change."""
    h = hashlib.sha256()
    for p in [root / "world.json", *sorted((root / "regions").glob("*.json"))]:
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


def slugify(text: str) -> str:
    """Readable folder id from a name: "Riverton - Desirae - Oct 19" -> "riverton-desirae-oct-19"."""
    s = re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:48].strip("-")
    return s or "world"


def valid_world_id(wid: str) -> bool:
    return isinstance(wid, str) and len(wid) <= 64 and bool(WORLD_ID.match(wid))


class MoveRequest(BaseModel):
    from_: str = Field(alias="from")
    direction: str
    changes: list = []  # this chat's world changes (see app/changes.py), applied for this request only


class TravelRequest(BaseModel):
    from_: str = Field(alias="from")
    steps: list[str]
    changes: list = []


class DoorsRequest(BaseModel):
    doors: list[str]


class RenderRequest(BaseModel):
    base: str | None = None  # world to copy (default world if omitted)
    id: str | None = None  # exact folder id (letters, digits, dashes); refused if taken. Usually omitted:
    id_hint: str | None = None  # folder id is made from this (or the name) as a readable slug, with -2, -3... if taken
    name: str | None = None  # display name, stored exactly as typed in world.json
    auto: bool = False
    overwrite: bool = False  # needed to save over a living world other than the base (the chat's current world)  # the name was generated (not typed): a clash gets " (2)" instead of being refused
    changes: list = []
    # "with knowledge" saves: what the chat knew, written to knowledge.json (region files stay clean). None = pristine.
    knowledge: dict | None = None


class LoadedWorld:
    def __init__(self, wid: str, root: Path):
        self.id, self.root = wid, root
        self.raw = read_world_raw(root)
        self.world: World = build_world(*self.raw)
        self.version = map_version(root)
        self.name = self.raw[0].get("name") if isinstance(self.raw[0].get("name"), str) else wid
        self.living = self.raw[0].get("living") is True  # living saves may be saved over; missing/false = protected
        kf = root / "knowledge.json"
        self.knowledge = None
        if kf.is_file():
            try:
                self.knowledge = clean_knowledge(json.loads(kf.read_text(encoding="utf-8")), self.world)
            except (ValueError, WorldError) as e:
                log.warning("world %s: ignoring knowledge.json (%s)", wid, e)

    def info(self) -> dict:
        return {"id": self.id, "name": self.name, "start_region": self.world.start.split(":")[0], "start": self.world.start,
                "map_version": self.version, "has_knowledge": self.knowledge is not None, "living": self.living}


def clean_knowledge(k, world: World) -> dict:
    """Keep only what exists in this world: {location, stood: [...], seen: [...], doors: [...]}."""
    if not isinstance(k, dict):
        raise WorldError("knowledge must be an object")
    addrs = lambda key: [a for a in dict.fromkeys(k.get(key) or []) if isinstance(a, str) and world.get(a)]
    doors = {e.door for l in world.locations.values() for e in l.exits if e.door}
    loc = k.get("location")
    return {"location": loc if isinstance(loc, str) and world.get(loc) else None, "stood": addrs("stood"), "seen": addrs("seen"),
            "doors": [d for d in dict.fromkeys(k.get("doors") or []) if d in doors]}


def create_app(world_dir: str | Path | None = None, worlds_dir: str | Path | None = None) -> FastAPI:
    """Serve every world folder in `worlds_dir` (default ./worlds). `world_dir` (or WORLDSCRAWL_WORLD_DIR) instead
    serves that single folder as world "default" (tests, old setups)."""
    single = world_dir or os.environ.get("WORLDSCRAWL_WORLD_DIR")
    worlds: dict[str, LoadedWorld] = {}
    if single:
        root_dir = None
        worlds["default"] = LoadedWorld("default", Path(single))
        default_id = "default"
    else:
        root_dir = Path(worlds_dir or os.environ.get("WORLDSCRAWL_WORLDS_DIR") or DEFAULT_WORLDS_DIR)
        for d in sorted(root_dir.iterdir()) if root_dir.is_dir() else []:
            if d.name.startswith(".") or not (d / "world.json").is_file():  # .backups, temp folders
                continue
            if not valid_world_id(d.name):
                log.warning("worlds: skipping folder %r (world ids are letters, digits and dashes)", d.name)
                continue
            worlds[d.name] = LoadedWorld(d.name, d)  # a broken world fails loudly at startup, like before
        if not worlds:
            raise WorldError(f"no worlds found in {root_dir}")
        want = os.environ.get("WORLDSCRAWL_DEFAULT_WORLD") or DEFAULT_WORLD_ID
        default_id = want if want in worlds else next(iter(worlds))
    app = FastAPI(title="WorldScrawl", version="0.2.0")

    def rescan():
        """Pick up world folders added, changed or deleted since startup (the default world is never dropped).
        A broken folder found on a rescan is skipped with a warning instead of failing."""
        if root_dir is None:
            return
        seen = set()
        for d in sorted(root_dir.iterdir()) if root_dir.is_dir() else []:
            if d.name.startswith(".") or not (d / "world.json").is_file() or not valid_world_id(d.name):
                continue
            seen.add(d.name)
            try:
                if d.name not in worlds or worlds[d.name].version != map_version(d):
                    worlds[d.name] = LoadedWorld(d.name, d)
                    log.info("worlds: loaded %s", d.name)
            except (WorldError, OSError) as e:
                log.warning("worlds: skipping %s (%s)", d.name, e)
        for wid in [w for w in worlds if w not in seen and w != default_id]:
            log.info("worlds: %s is gone", wid)
            del worlds[wid]

    def get_world(wid: str | None) -> LoadedWorld:
        if wid in (None, ""):
            return worlds[default_id]
        if not valid_world_id(wid):
            raise HTTPException(400, detail=f"Invalid world id {wid!r} (letters, digits and dashes only).")
        if wid not in worlds:
            rescan()
        if wid not in worlds:
            raise HTTPException(404, detail={"error": "world_not_found", "world": wid, "message": f"World {wid!r} not found (its folder may have been deleted or renamed)."})
        return worlds[wid]

    changed_cache: OrderedDict = OrderedDict()

    def world_for(wid: str | None, changes: list) -> World:
        """The world with this chat's changes applied (cached; most requests have none)."""
        lw = get_world(wid)
        if not changes:
            return lw.world
        key = (lw.id, lw.version, json.dumps(changes, sort_keys=True))
        if key not in changed_cache:
            try:
                changed_cache[key] = build_world(*apply_changes(*lw.raw, changes))
            except WorldError as e:
                raise HTTPException(400, detail={"error": str(e)})
            while len(changed_cache) > 32:
                changed_cache.popitem(last=False)
        changed_cache.move_to_end(key)
        return changed_cache[key]

    @app.middleware("http")
    async def add_version(request: Request, call_next):
        response = await call_next(request)
        wid = request.query_params.get("world")
        lw = worlds.get(wid) if wid else worlds.get(default_id)
        if lw:
            response.headers[VERSION_HEADER] = lw.version
        return response

    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=[VERSION_HEADER])
    app.state.worlds = worlds
    app.state.default_world = default_id
    app.state.world = worlds[default_id].world
    app.state.map_version = worlds[default_id].version

    def step(world: World, loc, direction: str):
        wanted = direction.strip().lower()
        for e in loc.exits:
            if e.direction.lower() == wanted:
                return world.get(e.to)
        return None

    def find(world: World, address: str):
        loc = world.get(address)
        if loc is None:
            raise HTTPException(404, detail=f"Unknown location {address!r}. Addresses look like 'region:subregion/location'.")
        return loc

    @app.get("/health")
    def health(world: str | None = None):
        lw = get_world(world)
        w = lw.world
        return {"ok": True, "world": lw.id, "map_version": lw.version, "regions": len(w.regions), "locations": len(w.locations), "subregions": len(w.subregions), "start": w.start}

    def open_path(path: Path):
        """Open a folder in the system file browser (WORLDSCRAWL_NO_OPEN=1 skips it, for tests)."""
        if os.environ.get("WORLDSCRAWL_NO_OPEN"):
            return
        import subprocess
        import sys
        if sys.platform.startswith("win"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    app.state.open_path = open_path

    @app.post("/open-folder")
    def open_folder(world: str | None = None):
        """Open the worlds folder (no id) or one world's folder. Takes only a world id, never a path."""
        if root_dir is None:
            raise HTTPException(400, detail="No worlds folder (single WORLDSCRAWL_WORLD_DIR mode).")
        base = root_dir.resolve()
        path = base if world in (None, "") else get_world(world).root.resolve()
        if path != base and base not in path.parents:
            raise HTTPException(400, detail="Refusing to open a folder outside worlds/.")
        app.state.open_path(path)
        return {"opened": str(path)}

    @app.get("/worlds")
    def list_worlds():
        rescan()  # folders added/removed by hand show up without a restart
        return {"default": default_id, "worlds": [lw.info() for lw in worlds.values()]}

    @app.get("/worlds/{wid}/knowledge")
    def knowledge(wid: str):
        """The chat knowledge saved with a world ("with knowledge" save), or null for a pristine world."""
        return {"knowledge": get_world(wid).knowledge}

    @app.post("/worlds/render")
    def render(req: RenderRequest):
        """Write a full new world folder (base world + changes, normal hand-written JSON) and load it right away."""
        if root_dir is None:
            raise HTTPException(400, detail="Saving worlds needs a worlds folder (not a single WORLDSCRAWL_WORLD_DIR).")
        base = get_world(req.base)
        names = {lw.name.strip().lower() for lw in worlds.values()}
        name = (req.name or "").strip()
        over = None  # the living world being saved over, if any
        if not name or req.auto:  # generated name ("<base> - <Mon D, h:mm AM>" if none was sent), made unique
            auto = name or f"{base.name} - {datetime.now().strftime('%b %d, %I:%M %p').replace(' 0', ' ')}"
            name, n = auto, 1
            while name.lower() in names:
                n += 1
                name = f"{auto} ({n})"
        elif name.lower() in names:
            over = next(lw for lw in worlds.values() if lw.name.strip().lower() == name.lower())
            if not over.living:
                raise HTTPException(409, detail=f"A world named {name!r} already exists and is protected (not a living save). Pick another name.")
        taken = {w.lower() for w in worlds} | {d.name.lower() for d in root_dir.iterdir()}
        if over is not None and over.id != base.id and not req.overwrite:
            raise HTTPException(409, detail={"error": "needs_overwrite", "world": over.id, "name": over.name,
                                             "message": f"A world named {over.name!r} already exists. Add overwrite=true to save over it."})
        if over is not None:
            wid, name = over.id, over.name
        elif req.id is not None:
            if not valid_world_id(req.id):
                raise HTTPException(400, detail=f"Invalid world id {req.id!r} (letters, digits and dashes only).")
            existing = next((lw for lw in worlds.values() if lw.id.lower() == req.id.lower()), None)
            if existing is not None and existing.living:
                if existing.id != base.id and not req.overwrite:
                    raise HTTPException(409, detail={"error": "needs_overwrite", "world": existing.id, "name": existing.name,
                                                     "message": f"World {existing.id!r} already exists. Add overwrite=true to save over it."})
                over, wid, name = existing, existing.id, existing.name
            elif req.id.lower() in taken:  # never write into a protected or unknown existing folder
                raise HTTPException(409, detail=f"World {req.id!r} already exists and is protected (not a living save). Pick another name.")
            else:
                wid = req.id
        else:
            stem = slugify(req.id_hint or name)
            wid, n = stem, 1
            while wid.lower() in taken:
                n += 1
                wid = f"{stem}-{n}"
        target = root_dir / wid
        try:
            wj, raw = apply_changes(*base.raw, req.changes)
            wj["name"] = name
            wj["living"] = True  # saves are living: they can be saved over later
            new_world = build_world(wj, raw)  # validate before writing anything
            know = clean_knowledge(req.knowledge, new_world) if req.knowledge is not None else None
        except WorldError as e:
            raise HTTPException(400, detail={"error": str(e)})
        tmp = Path(tempfile.mkdtemp(prefix=f".{wid}-", dir=root_dir))
        try:
            (tmp / "regions").mkdir()
            (tmp / "world.json").write_text(json.dumps(wj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            for rid, data in raw.items():
                (tmp / "regions" / f"{rid}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            if know is not None:
                (tmp / "knowledge.json").write_text(json.dumps(know, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            if over is None:
                if target.exists():
                    raise HTTPException(409, detail=f"World {wid!r} already exists.")
                tmp.rename(target)
            else:  # swap: the previous version becomes the one backup in .backups/<id>
                backups = root_dir / ".backups"
                backups.mkdir(exist_ok=True)
                old = backups / wid
                if old.exists():
                    shutil.rmtree(old)
                target.rename(old)
                try:
                    tmp.rename(target)
                except OSError:
                    old.rename(target)  # put the previous version back
                    raise
        finally:
            if tmp.exists():
                shutil.rmtree(tmp, ignore_errors=True)
        worlds[wid] = LoadedWorld(wid, target)
        for k in [k for k in changed_cache if k[0] == wid]:
            del changed_cache[k]
        log.info("render world %s -> %s (%d changes%s)", base.id, wid, len(req.changes), ", saved over the previous version" if over else "")
        return {**worlds[wid].info(), "overwritten": over is not None}

    @app.get("/start")
    def start(world: str | None = None):
        w = get_world(world).world
        return w.to_dict(w.get(w.start))

    @app.get("/location/{address:path}")
    def location(address: str, world: str | None = None):
        w = get_world(world).world
        return w.to_dict(find(w, address))

    @app.get("/rooms")
    def rooms(addresses: str = "", world: str | None = None):
        """Several rooms in one request (comma-separated addresses), plus the start room. Used to rebuild the
        extension's room cache after a reload in a single call. Unknown addresses are listed, not an error."""
        w = get_world(world).world
        wanted = [a.strip() for a in addresses.split(",") if a.strip()]
        found = {a: w.get(a) for a in dict.fromkeys(wanted)}
        return {
            "start": w.to_dict(w.get(w.start)),
            "rooms": [w.to_dict(l) for l in found.values() if l is not None],
            "unknown": [a for a, l in found.items() if l is None],
        }

    @app.post("/move")
    def move(req: MoveRequest, world: str | None = None):
        w = world_for(world, req.changes)
        loc = find(w, req.from_)
        to = step(w, loc, req.direction)
        if to is not None:
            log.info("move %s -%s-> %s", loc.address, req.direction.strip(), to.address)
            return w.to_dict(to)
        log.info("move %s -%s-> refused (no such exit)", loc.address, req.direction.strip())
        valid = [e.direction for e in loc.exits]
        raise HTTPException(400, detail={
            "error": f"There is no exit {req.direction!r} from {loc.name}.",
            "valid_directions": valid,
        })

    @app.post("/doors")
    def doors(req: DoorsRequest, world: str | None = None):
        """Where hidden/obscured exits lead, only for doors the client has passed through (from its own history)."""
        return {"exits": get_world(world).world.door_reveals(req.doors)}

    @app.post("/travel")
    def travel(req: TravelRequest, world: str | None = None):
        """Walk a whole route in one request, one step at a time with the same rules as /move.

        The walk can stop early: today only when a step has no matching exit (reason "blocked");
        later, per-step events/encounters may stop it too. Callers must place the party at
        `location` (the room actually reached), not at the requested destination.
        """
        w = world_for(world, req.changes)
        at = find(w, req.from_)
        path, stopped, reason, error = [], False, None, None
        for i, direction in enumerate(req.steps):
            nxt = step(w, at, direction)
            if nxt is None:
                stopped, reason = True, "blocked"
                error = f"There is no exit {direction!r} from {at.name}."
                break
            at = nxt
            path.append(w.to_dict(at))
        log.info("travel %s steps=%s -> %s (%d/%d steps%s)", req.from_, req.steps, at.address, len(path), len(req.steps),
                 f", stopped: {reason}" if stopped else "")
        return {
            "location": w.to_dict(at),
            "path": path,  # every room entered, in order (the last one is `location` unless no step succeeded)
            "steps_completed": len(path),
            "steps_requested": len(req.steps),
            "stopped": stopped,
            "reason": reason,  # null when the whole route was walked
            **({"error": error} if error else {}),
        }

    return app


app = create_app()
