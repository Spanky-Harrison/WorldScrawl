"""WorldScrawl API: a stateless, read-only static map. Run: uvicorn app.main:app --port 5100"""
from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .world import World, load_world

DEFAULT_WORLD_DIR = Path(__file__).resolve().parent.parent / "world"
VERSION_HEADER = "X-WorldScrawl-Map-Version"
log = logging.getLogger("uvicorn.error")  # shows up in the normal server console


def map_version(root: Path) -> str:
    """Short hash of world.json + every region file, computed at load. Changes whenever the map files change."""
    h = hashlib.sha256()
    for p in [root / "world.json", *sorted((root / "regions").glob("*.json"))]:
        h.update(p.name.encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:12]


class MoveRequest(BaseModel):
    from_: str = Field(alias="from")
    direction: str


class TravelRequest(BaseModel):
    from_: str = Field(alias="from")
    steps: list[str]


def create_app(world_dir: str | Path | None = None) -> FastAPI:
    root = Path(world_dir or os.environ.get("WORLDSCRAWL_WORLD_DIR") or DEFAULT_WORLD_DIR)
    world: World = load_world(root)
    version = map_version(root)
    app = FastAPI(title="WorldScrawl", version="0.1.0")

    @app.middleware("http")
    async def add_version(request: Request, call_next):
        response = await call_next(request)
        response.headers[VERSION_HEADER] = version
        return response

    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"], expose_headers=[VERSION_HEADER])
    app.state.world = world
    app.state.map_version = version

    def step(loc, direction: str):
        wanted = direction.strip().lower()
        for e in loc.exits:
            if e.direction.lower() == wanted:
                return world.get(e.to)
        return None

    def find(address: str):
        loc = world.get(address)
        if loc is None:
            raise HTTPException(404, detail=f"Unknown location {address!r}. Addresses look like 'region:subregion/location'.")
        return loc

    @app.get("/health")
    def health():
        return {"ok": True, "map_version": version, "regions": len(world.regions), "locations": len(world.locations), "subregions": len(world.subregions), "start": world.start}

    @app.get("/start")
    def start():
        return world.to_dict(world.get(world.start))

    @app.get("/location/{address:path}")
    def location(address: str):
        return world.to_dict(find(address))

    @app.get("/rooms")
    def rooms(addresses: str = ""):
        """Several rooms in one request (comma-separated addresses), plus the start room. Used to rebuild the
        extension's room cache after a reload in a single call. Unknown addresses are listed, not an error."""
        wanted = [a.strip() for a in addresses.split(",") if a.strip()]
        found = {a: world.get(a) for a in dict.fromkeys(wanted)}
        return {
            "start": world.to_dict(world.get(world.start)),
            "rooms": [world.to_dict(l) for l in found.values() if l is not None],
            "unknown": [a for a, l in found.items() if l is None],
        }

    @app.post("/move")
    def move(req: MoveRequest):
        loc = find(req.from_)
        to = step(loc, req.direction)
        if to is not None:
            log.info("move %s -%s-> %s", loc.address, req.direction.strip(), to.address)
            return world.to_dict(to)
        log.info("move %s -%s-> refused (no such exit)", loc.address, req.direction.strip())
        valid = [e.direction for e in loc.exits]
        raise HTTPException(400, detail={
            "error": f"There is no exit {req.direction!r} from {loc.name}.",
            "valid_directions": valid,
        })

    @app.post("/travel")
    def travel(req: TravelRequest):
        """Walk a whole route in one request, one step at a time with the same rules as /move.

        The walk can stop early: today only when a step has no matching exit (reason "blocked");
        later, per-step events/encounters may stop it too. Callers must place the party at
        `location` (the room actually reached), not at the requested destination.
        """
        at = find(req.from_)
        path, stopped, reason, error = [], False, None, None
        for i, direction in enumerate(req.steps):
            nxt = step(at, direction)
            if nxt is None:
                stopped, reason = True, "blocked"
                error = f"There is no exit {direction!r} from {at.name}."
                break
            at = nxt
            path.append(world.to_dict(at))
        log.info("travel %s steps=%s -> %s (%d/%d steps%s)", req.from_, req.steps, at.address, len(path), len(req.steps),
                 f", stopped: {reason}" if stopped else "")
        return {
            "location": world.to_dict(at),
            "path": path,  # every room entered, in order (the last one is `location` unless no step succeeded)
            "steps_completed": len(path),
            "steps_requested": len(req.steps),
            "stopped": stopped,
            "reason": reason,  # null when the whole route was walked
            **({"error": error} if error else {}),
        }

    return app


app = create_app()
