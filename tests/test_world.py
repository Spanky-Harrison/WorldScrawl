import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.world import WorldError, load_world

ROOT = Path(__file__).resolve().parent.parent / "world"


def make_world(tmp_path, regions, start_region="r", raw=None):
    (tmp_path / "regions").mkdir()
    (tmp_path / "world.json").write_text(json.dumps({"start_region": start_region}))
    for rid, data in regions.items():
        (tmp_path / "regions" / f"{rid}.json").write_text(json.dumps(data))
    for name, text in (raw or {}).items():
        (tmp_path / "regions" / name).write_text(text)
    return tmp_path


def region(rid="r", start="a", locations=None):
    return {"id": rid, "name": rid.title(), "start": start, "locations": locations or {
        "a": {"name": "A", "description": "da", "exits": [{"direction": "east", "to": "b"}]},
        "b": {"name": "B", "description": "db", "exits": [{"direction": "west", "to": "a"}]},
    }}


def test_sample_world_loads():
    w = load_world(ROOT)
    assert w.start == "riverton:tavern"
    assert len(w.locations) >= 5


def test_minimal_ok(tmp_path):
    w = load_world(make_world(tmp_path, {"r": region()}))
    assert w.get("r:a").exits[0].to == "r:b"


def test_duplicate_keys_rejected(tmp_path):
    text = '{"id":"r","name":"R","start":"a","locations":{"a":{"name":"A","description":"x","exits":[]},"a":{"name":"A2","description":"y","exits":[]}}}'
    with pytest.raises(WorldError, match="r.json: duplicate key 'a'"):
        load_world(make_world(tmp_path, {}, raw={"r.json": text}))


def test_missing_exit_target(tmp_path):
    r = region()
    r["locations"]["a"]["exits"].append({"direction": "north", "to": "nowhere"})
    with pytest.raises(WorldError, match="exit target 'nowhere' does not exist"):
        load_world(make_world(tmp_path, {"r": r}))


def test_cross_region_exit(tmp_path):
    r = region()
    r["locations"]["a"]["exits"].append({"direction": "north", "to": "s:x"})
    s = region("s", "x", {"x": {"name": "X", "description": "dx", "exits": [{"direction": "south", "to": "r:a"}]}})
    w = load_world(make_world(tmp_path, {"r": r, "s": s}))
    assert w.get("r:a").exits[1].to == "s:x"
    r["locations"]["a"]["exits"][1]["to"] = "q:x"
    with pytest.raises(WorldError, match="'q:x'"):
        (tmp_path / "2").mkdir()
        load_world(make_world(tmp_path / "2", {"r": r, "s": s}))


def test_bad_slug(tmp_path):
    r = region()
    r["locations"]["Bad Name"] = {"name": "x", "description": "x", "exits": []}
    with pytest.raises(WorldError, match="not a valid id"):
        load_world(make_world(tmp_path, {"r": r}))


def test_region_id_must_match_file(tmp_path):
    with pytest.raises(WorldError, match="must match the file name"):
        load_world(make_world(tmp_path, {"r": region(rid="other")}))


def test_bad_start(tmp_path):
    with pytest.raises(WorldError, match="start location 'zzz'"):
        load_world(make_world(tmp_path, {"r": region(start="zzz")}))
    with pytest.raises(WorldError, match="start_region 'nope'"):
        (tmp_path / "x").mkdir()
        load_world(make_world(tmp_path / "x", {"r": region()}, start_region="nope"))


def test_missing_field(tmp_path):
    r = region()
    del r["locations"]["a"]["description"]
    with pytest.raises(WorldError, match="location 'a': missing \"description\""):
        load_world(make_world(tmp_path, {"r": r}))


def test_duplicate_direction(tmp_path):
    r = region()
    r["locations"]["a"]["exits"].append({"direction": "East", "to": "a"})
    with pytest.raises(WorldError, match="used twice"):
        load_world(make_world(tmp_path, {"r": r}))


@pytest.fixture
def client():
    return TestClient(create_app(ROOT))


def test_start(client):
    r = client.get("/start").json()
    assert r["address"] == "riverton:tavern"
    assert r["name"] == "The Drowned Rat"
    out = next(e for e in r["exits"] if e["direction"] == "out")
    assert out["to"] == "riverton:square" and out["to_name"] == "Village Square"


def test_location(client):
    assert client.get("/location/riverton:docks").json()["name"] == "River Docks"
    assert client.get("/location/riverton:nope").status_code == 404


def test_move(client):
    r = client.post("/move", json={"from": "riverton:tavern", "direction": "OUT"})
    assert r.status_code == 200 and r.json()["address"] == "riverton:square"
    bad = client.post("/move", json={"from": "riverton:tavern", "direction": "west"})
    assert bad.status_code == 400
    assert set(bad.json()["detail"]["valid_directions"]) == {"out", "up"}
    assert client.post("/move", json={"from": "x:y", "direction": "west"}).status_code == 404


def test_cors(client):
    r = client.get("/start", headers={"Origin": "http://127.0.0.1:8000"})
    assert r.headers.get("access-control-allow-origin") in ("*", "http://127.0.0.1:8000")
