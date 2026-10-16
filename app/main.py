"""WorldScrawl API: a stateless, read-only static map. Run: uvicorn app.main:app --port 5100"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .world import World, load_world

DEFAULT_WORLD_DIR = Path(__file__).resolve().parent.parent / "world"


class MoveRequest(BaseModel):
    from_: str = Field(alias="from")
    direction: str


def create_app(world_dir: str | Path | None = None) -> FastAPI:
    world: World = load_world(world_dir or os.environ.get("WORLDSCRAWL_WORLD_DIR") or DEFAULT_WORLD_DIR)
    app = FastAPI(title="WorldScrawl", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    app.state.world = world

    def find(address: str):
        loc = world.get(address)
        if loc is None:
            raise HTTPException(404, detail=f"Unknown location {address!r}. Addresses look like 'region:subregion/location'.")
        return loc

    @app.get("/health")
    def health():
        return {"ok": True, "regions": len(world.regions), "locations": len(world.locations), "subregions": len(world.subregions), "start": world.start}

    @app.get("/start")
    def start():
        return world.to_dict(world.get(world.start))

    @app.get("/location/{address:path}")
    def location(address: str):
        return world.to_dict(find(address))

    @app.post("/move")
    def move(req: MoveRequest):
        loc = find(req.from_)
        wanted = req.direction.strip().lower()
        for e in loc.exits:
            if e.direction.lower() == wanted:
                return world.to_dict(world.get(e.to))
        valid = [e.direction for e in loc.exits]
        raise HTTPException(400, detail={
            "error": f"There is no exit {req.direction!r} from {loc.name}.",
            "valid_directions": valid,
        })

    return app


app = create_app()
