import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.world import WorldError, load_world

ROOT = Path(__file__).resolve().parent.parent / "worlds" / "riverton"
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
    # a hidden exit says nothing about where it leads; a normal one carries its destination's data
    assert not {"to", "to_name", "to_display_name", "to_subregion", "to_region"} & ex[0].keys()
    assert ex[1]["to"] == "r:t/x" and ex[1]["to_display_name"] == "X (T)" and ex[1]["to_region"]["name"] == "R"


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
    assert r["address"] == TAVERN and r["name"] == "Common Room"
    assert r["subregion"]["id"] == "drowned_rat" and r["subregion"]["name"] == "The Drowned Rat" and r["subregion"]["notes"]
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
    assert bad.status_code == 400 and set(bad.json()["detail"]["valid_directions"]) == {"out", "up", "back"}
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


def test_entrances(tmp_path):
    w = load(tmp_path, region())
    assert w.subregions["r:s"].entrance == "r:s/a"  # default: first room
    assert w.regions["r"].entrance == "r:s/a"  # default: region start
    r = region()
    r["entrance"] = "t/x"
    r["subregions"]["t"]["entrance"] = "y"
    (tmp_path / "e").mkdir()
    w = load(tmp_path / "e", r)
    assert w.regions["r"].entrance == "r:t/x" and w.subregions["r:t"].entrance == "r:t/y"


def test_bad_entrances(tmp_path):
    r = region()
    r["subregions"]["s"]["entrance"] = "zzz"
    with pytest.raises(WorldError, match="entrance 'zzz' is not a room in this subregion"):
        load(tmp_path, r)
    r = region()
    r["entrance"] = "s/zzz"
    (tmp_path / "b").mkdir()
    with pytest.raises(WorldError, match="entrance 's/zzz' does not exist"):
        load(tmp_path / "b", r)


def test_sample_entrances(client):
    d = client.get("/location/riverton:drowned_rat/upstairs").json()
    assert d["subregion"]["entrance"] == TAVERN and d["region"]["entrance"] == SQUARE
    lane = client.get("/location/riverton:streets/market_lane").json()
    goose = next(e for e in lane["exits"] if e["direction"] == "inn")
    assert goose["to_subregion"]["entrance"] == "riverton:gilded_goose/common_room"


def test_two_common_rooms(client):
    a = client.get("/location/riverton:drowned_rat/common_room").json()
    b = client.get("/location/riverton:gilded_goose/common_room").json()
    assert a["name"] == b["name"] == "Common Room"
    assert {a["subregion"]["name"], b["subregion"]["name"]} == {"The Drowned Rat", "The Gilded Goose"}


def test_stable_gate_onto_market_lane(client):
    stable = client.get("/location/riverton:drowned_rat/stable").json()
    gate = next(e for e in stable["exits"] if e["direction"] == "gate")
    assert gate["to"] == "riverton:streets/market_lane"  # not the square the front door opens onto
    lane = client.get("/location/riverton:streets/market_lane").json()
    assert any(e["to"] == "riverton:drowned_rat/stable" for e in lane["exits"])


def test_drowned_rat_back_rooms(client):
    yard = client.get("/location/riverton:drowned_rat/courtyard").json()
    assert {e["to"] for e in yard["exits"] if "to" in e} == {TAVERN, "riverton:drowned_rat/kitchens", "riverton:drowned_rat/stable"}
    assert client.get("/location/riverton:drowned_rat/kitchens").json()["name"] == "Kitchens"


def test_travel_whole_route(client):
    r = client.post("/travel", json={"from": TAVERN, "steps": ["out", "west", "inn", "up"]})
    b = r.json()
    assert r.status_code == 200 and b["location"]["address"] == "riverton:gilded_goose/upstairs"
    assert [p["address"] for p in b["path"]] == [SQUARE, "riverton:streets/market_lane", "riverton:gilded_goose/common_room", "riverton:gilded_goose/upstairs"]
    assert b["steps_completed"] == 4 and b["stopped"] is False and b["reason"] is None


def test_travel_stops_at_last_valid_room(client):
    b = client.post("/travel", json={"from": TAVERN, "steps": ["out", "sideways", "north"]}).json()
    assert b["location"]["address"] == SQUARE and b["steps_completed"] == 1
    assert b["stopped"] is True and b["reason"] == "blocked" and "sideways" in b["error"]
    assert client.post("/travel", json={"from": "x:y/z", "steps": ["out"]}).status_code == 404


def test_map_version_header(client, tmp_path):
    v = client.get("/start").headers["x-worldscrawl-map-version"]
    assert v and client.post("/move", json={"from": TAVERN, "direction": "nope"}).headers["x-worldscrawl-map-version"] == v
    assert client.get("/health").json()["map_version"] == v
    w = make_world(tmp_path, {"r": region()})
    v1 = TestClient(create_app(w)).get("/start").headers["x-worldscrawl-map-version"]
    (w / "regions" / "r.json").write_text(json.dumps(region(notes="changed")))
    v2 = TestClient(create_app(w)).get("/start").headers["x-worldscrawl-map-version"]
    assert v1 != v2


def test_version_header_exposed_to_browser(client):
    r = client.get("/start", headers={"Origin": "http://127.0.0.1:8000"})
    assert "x-worldscrawl-map-version" in r.headers.get("access-control-expose-headers", "").lower()


def test_move_and_travel_logged(client, caplog):
    import logging
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        client.post("/move", json={"from": TAVERN, "direction": "out"})
        client.post("/travel", json={"from": TAVERN, "steps": ["out", "north"]})
    text = caplog.text
    assert "move riverton:drowned_rat/common_room -out-> riverton:streets/square" in text
    assert "travel riverton:drowned_rat/common_room steps=['out', 'north'] -> riverton:temple/nave (2/2 steps)" in text


def test_exits_carry_destination_data(client):
    loc = client.get(f"/location/{SQUARE}").json()
    assert loc["display_name"] == "Village Square (Riverton Streets)"
    rat = next(e for e in loc["exits"] if e["to"] == TAVERN)
    assert rat["to_display_name"] == "Common Room (The Drowned Rat)"
    assert rat["to_subregion"] == {"id": "drowned_rat", "name": "The Drowned Rat", "entrance": TAVERN, "label_rooms": False}
    assert rat["to_region"]["name"] == "Riverton" and rat["to_region"]["entrance"]


def test_rooms_batch(client):
    b = client.get("/rooms", params={"addresses": f"{TAVERN},{SQUARE},{TAVERN},nowhere:x/y"}).json()
    assert [r["address"] for r in b["rooms"]] == [TAVERN, SQUARE]
    assert b["unknown"] == ["nowhere:x/y"] and b["start"]["address"] == TAVERN
    assert client.get("/rooms").json()["rooms"] == []


def test_exit_labels_name_the_building(client, tmp_path):
    lane = {e["direction"]: e for e in client.get("/location/riverton:streets/market_lane").json()["exits"]}
    assert lane["east"]["to_label"] == "Village Square"            # same building: room name
    assert lane["inn"]["to_label"] == "The Gilded Goose"           # other building, its entrance
    assert lane["gate"]["to_label"] == "The Drowned Rat, Stable"   # other building, not its entrance
    rat = {e["direction"]: e for e in client.get(f"/location/{TAVERN}").json()["exits"]}
    assert rat["out"]["to_label"] == "Village Square"  # streets have label_rooms: the room is the place
    # crossing into another region adds the region name; hidden exits say nothing
    r = region()
    r["subregions"]["s"]["locations"]["b"]["exits"].append({"direction": "road", "to": "q:m/n"})
    r["subregions"]["s"]["locations"]["b"]["exits"].append({"direction": "crack", "to": "a", "hidden": True})
    q = {"name": "Q", "start": "m/n", "subregions": {"m": {"name": "M", "locations": {
        "n": {"name": "N", "description": "dn", "exits": []}, "o": {"name": "O", "description": "do", "exits": []}}}}}
    c = TestClient(create_app(make_world(tmp_path, {"r": r, "q": q})))
    ex = {e["direction"]: e for e in c.get("/location/r:s/b").json()["exits"]}
    assert ex["road"]["to_label"] == "M, Q" and ex["west"]["to_label"] == "A"
    assert "to_label" not in ex["crack"] and "to" not in ex["crack"]


def test_subregion_entrance_name(client):
    sub = client.get("/location/riverton:drowned_rat/stable").json()["subregion"]
    assert sub["entrance"] == TAVERN and sub["entrance_name"] == "Common Room"


def test_label_rooms_flag(tmp_path):
    r = region()
    r["subregions"]["t"]["label_rooms"] = True
    c = TestClient(create_app(make_world(tmp_path, {"r": r})))
    out = {e["direction"]: e for e in c.get("/location/r:s/a").json()["exits"]}["out"]
    assert out["to_label"] == "X" and out["to_subregion"]["label_rooms"] is True
    r["subregions"]["t"]["label_rooms"] = "yes"
    bad = tmp_path / "bad"
    bad.mkdir()
    with pytest.raises(WorldError, match="label_rooms"):
        load(bad, r)


# ---- obscured / hidden doors
COURTYARD, CELLAR = "riverton:drowned_rat/courtyard", "riverton:drowned_rat/cellar"
NAVE, CATA, TUNNEL = "riverton:temple/nave", "riverton:temple/catacombs", "riverton:secret_tunnel/tunnel"
DEST_KEYS = {"to", "to_name", "to_display_name", "to_label", "to_subregion", "to_region"}


def _exit(room, direction):
    return next(e for e in room["exits"] if e["direction"] == direction)


def test_riverton_obscured_exits_reveal_nothing():
    c = TestClient(create_app(ROOT))
    for addr, d, flag in [(COURTYARD, "trapdoor", "obscured"), (NAVE, "grate", "obscured"), (CELLAR, "narrow door", "hidden"), (TUNNEL, "narrow door", "hidden")]:
        e = _exit(c.get(f"/location/{addr}").json(), d)
        assert e[flag] is True and e["door"].startswith("door_") and not DEST_KEYS & e.keys()
        dest = load_world(ROOT).get(next(x.to for x in load_world(ROOT).get(addr).exits if x.direction == d))
        assert dest.address not in json.dumps(e) and dest.name not in json.dumps(e)


def test_doors_paired_with_return_exit():
    w = load_world(ROOT)
    door = lambda a, d: next(e for e in w.get(a).exits if e.direction == d).door
    assert door(COURTYARD, "trapdoor") == door(CELLAR, "trapdoor")
    assert door(NAVE, "grate") == door(CATA, "up")
    assert door(CELLAR, "narrow door") == door(TUNNEL, "narrow door")
    assert door(CATA, "tunnel") is None and door(COURTYARD, "in") is None
    assert len({door(COURTYARD, "trapdoor"), door(NAVE, "grate"), door(CELLAR, "narrow door")}) == 3
    # the normal return side still names where it goes
    up = _exit(TestClient(create_app(ROOT)).get(f"/location/{CATA}").json(), "up")
    assert up["to"] == NAVE and up["door"] == door(NAVE, "grate")


def test_doors_endpoint_reveals_only_requested_doors():
    c = TestClient(create_app(ROOT))
    grate = _exit(c.get(f"/location/{NAVE}").json(), "grate")["door"]
    ex = c.post("/doors", json={"doors": [grate]}).json()["exits"]
    assert len(ex) == 1 and ex[0]["from"] == NAVE and ex[0]["direction"] == "grate" and ex[0]["to"] == CATA
    assert ex[0]["to_label"] == "Temple Catacombs"
    assert c.post("/doors", json={"doors": ["door_nope"]}).json()["exits"] == []
    both = c.post("/doors", json={"doors": [_exit(c.get(f"/location/{CELLAR}").json(), "narrow door")["door"]]}).json()["exits"]
    assert {(x["from"], x["to"]) for x in both} == {(CELLAR, TUNNEL), (TUNNEL, CELLAR)}


def test_move_and_travel_through_obscured_exits():
    c = TestClient(create_app(ROOT))
    assert c.post("/move", json={"from": COURTYARD, "direction": "trapdoor"}).json()["address"] == CELLAR
    r = c.post("/travel", json={"from": CELLAR, "steps": ["narrow door", "catacombs", "up"]}).json()
    assert r["location"]["address"] == NAVE and r["steps_completed"] == 3


def test_one_way_flagged_exit_warns(tmp_path, caplog):
    r = region()
    r["subregions"]["t"]["locations"]["y"]["exits"] = [{"direction": "chute", "to": "s/b", "obscured": True}]
    with caplog.at_level("WARNING"):
        w = load(tmp_path, r)
    assert "no return exit" in caplog.text
    assert w.get("r:t/y").exits[0].door


def test_cellar_trapdoor_obscured_both_sides():
    c = TestClient(create_app(ROOT))
    e = _exit(c.get(f"/location/{CELLAR}").json(), "trapdoor")
    assert e["obscured"] is True and "to" not in e
    assert c.post("/move", json={"from": CELLAR, "direction": "trapdoor"}).json()["address"] == COURTYARD
