import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.world import WorldError, load_world

ROOT = Path(__file__).resolve().parent.parent / "world"
TAVERN = "riverton:drowned_rat/common_room"
SQUARE = "riverton:streets/square"


def make_world(tmp_path, regions, start_region="r", raw=None):
    (tmp_path / "regions").mkdir()
    (tmp_path / "world.json").write_text(json.dumps({"start_region": start_region}))
    for rid, data in regions.items():
        (tmp_path / "regions" / f"{rid}.json").write_text(json.dumps(data))
    for name, text in (raw or {}).items():
        (tmp_path / "regions" / name).write_text(text)
    return tmp_path


def region(start="s/a", subs=None, notes="region notes"):
    return {"name": "R", "notes": notes, "start": start, "subregions": subs or {
        "s": {"name": "S", "notes": "sub notes", "locations": {
            "a": {"name": "A", "description": "da", "exits": [{"direction": "east", "to": "b"}, {"direction": "out", "to": "t/x"}]},
            "b": {"name": "B", "description": "db", "exits": [{"direction": "west", "to": "a"}]},
        }},
        "t": {"name": "T", "notes": "t notes", "inherit_notes": False, "locations": {
            "x": {"name": "X", "description": "dx", "exits": [{"direction": "in", "to": "s/a"}]},
            "y": {"name": "Y", "description": "dy", "inherit_region_notes": True, "inherit_subregion_notes": False, "exits": []},
        }},
    }}


def load(tmp_path, r, **kw):
    return load_world(make_world(tmp_path, {"r": r}, **kw))


def test_sample_world_loads():
    w = load_world(ROOT)
    assert w.start == TAVERN
    assert len(w.locations) >= 10
    assert all(loc.address.count("/") == 1 for loc in w.locations.values())


def test_minimal_and_exit_resolution(tmp_path):
    w = load(tmp_path, region())
    assert w.get("r:s/a").exits[0].to == "r:s/b"  # bare = same subregion
    assert w.get("r:s/a").exits[1].to == "r:t/x"  # sub/loc = same region
    assert w.start == "r:s/a"


def test_notes_inheritance(tmp_path):
    w = load(tmp_path, region())
    assert w.effective_notes(w.get("r:s/a")) == {"region": "region notes", "subregion": "sub notes"}
    # subregion inherit_notes false drops region notes for its rooms
    assert w.effective_notes(w.get("r:t/x")) == {"region": None, "subregion": "t notes"}
    # explicit location flags override the subregion
    assert w.effective_notes(w.get("r:t/y")) == {"region": "region notes", "subregion": None}


def test_location_can_drop_region_notes(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["b"]["inherit_region_notes"] = False
    w = load(tmp_path, r)
    assert w.effective_notes(w.get("r:s/b")) == {"region": None, "subregion": "sub notes"}


def test_bad_flag_types(tmp_path):
    r = region()
    r["subregions"]["s"]["inherit_notes"] = "no"
    with pytest.raises(WorldError, match="inherit_notes\" must be true or false"):
        load(tmp_path, r)
    r = region()
    r["subregions"]["s"]["locations"]["a"]["exits"][0]["hidden"] = 1
    with pytest.raises(WorldError, match="hidden\" must be true or false"):
        (tmp_path / "x").mkdir()
        load(tmp_path / "x", r)


def test_exit_flags_exposed(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["a"]["exits"][0]["hidden"] = True
    c = TestClient(create_app(make_world(tmp_path, {"r": r})))
    ex = c.get("/location/r:s/a").json()["exits"]
    assert ex[0]["hidden"] is True and "hidden" not in ex[1]


def test_duplicate_keys_rejected(tmp_path):
    text = '{"name":"R","start":"s/a","subregions":{"s":{"name":"S","locations":{"a":{"name":"A","description":"x"},"a":{"name":"A2","description":"y"}}}}}'
    with pytest.raises(WorldError, match="r.json: duplicate key 'a'"):
        load_world(make_world(tmp_path, {}, raw={"r.json": text}))


def test_missing_exit_target(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["a"]["exits"].append({"direction": "north", "to": "nowhere"})
    with pytest.raises(WorldError, match="exit target 'nowhere' does not exist \\(looked for 'r:s/nowhere'\\)"):
        load(tmp_path, r)


def test_cross_region_exit(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["a"]["exits"].append({"direction": "north", "to": "q:z/x"})
    q = {"name": "Q", "start": "z/x", "subregions": {"z": {"name": "Z", "locations": {"x": {"name": "X", "description": "dx", "exits": [{"direction": "south", "to": "r:s/a"}]}}}}}
    w = load_world(make_world(tmp_path, {"r": r, "q": q}))
    assert w.get("r:s/a").exits[2].to == "q:z/x"
    r["subregions"]["s"]["locations"]["a"]["exits"][2]["to"] = "nope:z/x"
    (tmp_path / "2").mkdir()
    with pytest.raises(WorldError, match="'nope:z/x'"):
        load_world(make_world(tmp_path / "2", {"r": r, "q": q}))


def test_bad_slug(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["Bad Name"] = {"name": "x", "description": "x", "exits": []}
    with pytest.raises(WorldError, match="not a valid id"):
        load(tmp_path, r)


def test_region_id_must_match_file(tmp_path):
    r = region()
    r["id"] = "other"
    with pytest.raises(WorldError, match="must match the file name"):
        load(tmp_path, r)


def test_bad_start(tmp_path):
    with pytest.raises(WorldError, match="start location 's/zzz'"):
        load(tmp_path, region(start="s/zzz"))
    (tmp_path / "x").mkdir()
    with pytest.raises(WorldError, match="must look like"):
        load(tmp_path / "x", region(start="a"))
    (tmp_path / "y").mkdir()
    with pytest.raises(WorldError, match="start_region 'nope'"):
        load(tmp_path / "y", region(), start_region="nope")


def test_missing_field(tmp_path):
    r = region()
    del r["subregions"]["s"]["locations"]["a"]["description"]
    with pytest.raises(WorldError, match="location s/a: missing \"description\""):
        load(tmp_path, r)


def test_duplicate_direction(tmp_path):
    r = region()
    r["subregions"]["s"]["locations"]["a"]["exits"].append({"direction": "East", "to": "a"})
    with pytest.raises(WorldError, match="used twice"):
        load(tmp_path, r)


@pytest.fixture
def client():
    return TestClient(create_app(ROOT))


def test_start(client):
    r = client.get("/start").json()
    assert r["address"] == TAVERN and r["name"] == "The Drowned Rat"
    assert r["subregion"] == {"id": "drowned_rat", "name": "The Drowned Rat", "notes": r["subregion"]["notes"]}
    assert r["region"]["name"] == "Riverton" and r["region"]["notes"]
    out = next(e for e in r["exits"] if e["direction"] == "out")
    assert out["to"] == SQUARE and out["to_name"] == "Village Square" and out["to_subregion"]["name"] == "Riverton Streets"


def test_sample_notes(client):
    up = client.get("/location/riverton:drowned_rat/upstairs").json()["effective_notes"]
    assert up["region"] and up["subregion"] is None  # quiet room drops the tavern's noise
    nave = client.get("/location/riverton:temple/nave").json()["effective_notes"]
    assert nave["region"] is None and nave["subregion"]  # temple drops village notes


def test_two_upstairs_rooms(client):
    a = client.get("/location/riverton:drowned_rat/upstairs").json()
    b = client.get("/location/riverton:gilded_goose/upstairs").json()
    assert a["name"] == b["name"] == "Upstairs Rooms"
    assert a["subregion"]["name"] != b["subregion"]["name"]


def test_shops_are_separate_subregions(client):
    lane = client.get("/location/riverton:streets/market_lane").json()
    subs = {e["to_subregion"]["id"] for e in lane["exits"]}
    assert {"gilded_goose", "general_store", "smithy", "streets"} <= subs


def test_location_404(client):
    assert client.get("/location/riverton:docks/piers").json()["name"] == "River Docks"
    assert client.get("/location/riverton:nope/x").status_code == 404


def test_move(client):
    r = client.post("/move", json={"from": TAVERN, "direction": " OUT "})
    assert r.status_code == 200 and r.json()["address"] == SQUARE
    bad = client.post("/move", json={"from": TAVERN, "direction": "west"})
    assert bad.status_code == 400 and set(bad.json()["detail"]["valid_directions"]) == {"out", "up"}
    assert client.post("/move", json={"from": "x:y/z", "direction": "west"}).status_code == 404


def test_cors(client):
    r = client.get("/start", headers={"Origin": "http://127.0.0.1:8000"})
    assert r.headers.get("access-control-allow-origin") in ("*", "http://127.0.0.1:8000")


def test_route_tavern_to_goose_upstairs(client):
    # tavern -out-> square -west-> market lane -inn-> goose common room -up-> goose upstairs
    at = TAVERN
    for d in ["out", "west", "inn", "up"]:
        at = client.post("/move", json={"from": at, "direction": d}).json()["address"]
    assert at == "riverton:gilded_goose/upstairs"


def test_temple_not_adjacent_to_tavern(client):
    tavern = client.get(f"/location/{TAVERN}").json()
    assert "riverton:temple/nave" not in [e["to"] for e in tavern["exits"]]
