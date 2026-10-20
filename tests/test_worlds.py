import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.world import load_world

RIVERTON = Path(__file__).resolve().parent.parent / "worlds" / "riverton"
TAVERN, SQUARE, YARD = "riverton:drowned_rat/common_room", "riverton:streets/square", "riverton:drowned_rat/courtyard"


@pytest.fixture
def wd(tmp_path):
    shutil.copytree(RIVERTON, tmp_path / "riverton")
    return tmp_path


@pytest.fixture
def client(wd):
    return TestClient(create_app(worlds_dir=wd))


def test_list_worlds_and_default(client):
    r = client.get("/worlds").json()
    assert r["default"] == "riverton"
    (w,) = r["worlds"]
    assert w["id"] == "riverton" and w["start_region"] == "riverton" and len(w["map_version"]) == 12
    assert client.get("/start").json()["address"] == TAVERN == client.get("/start?world=riverton").json()["address"]
    assert client.get("/health?world=riverton").headers["X-WorldScrawl-Map-Version"] == w["map_version"]


def test_bad_world_ids_rejected(client):
    for bad in ["../riverton", "..", "a/b", "riverton%2F..", "a_b", "a b", "-x"]:
        assert client.get("/start", params={"world": bad}).status_code == 400, bad
    assert client.get("/start?world=nope").status_code == 404
    for bad in ["../evil", "x/y", "..", "a_b", ""]:
        assert client.post("/worlds/render", json={"id": bad}).status_code == 400, bad


def test_render_copy_identical_new_id(client, wd):
    r = client.post("/worlds/render", json={"base": "riverton", "id": "my-copy", "name": "My Copy"})
    assert r.status_code == 200 and r.json()["id"] == "my-copy" and r.json()["name"] == "My Copy"
    a, b = load_world(RIVERTON), load_world(wd / "my-copy")
    assert a.locations.keys() == b.locations.keys()
    assert all(a.to_dict(a.get(k)) == b.to_dict(b.get(k)) for k in a.locations)
    # loaded right away, own version, listed
    assert {w["id"] for w in client.get("/worlds").json()["worlds"]} == {"riverton", "my-copy"}
    assert client.get(f"/location/{SQUARE}?world=my-copy").status_code == 200
    # normal hand-written files: no derived data written
    text = (wd / "my-copy" / "regions" / "riverton.json").read_text()
    assert "to_label" not in text and "door_" not in text and '"name": "My Copy"' in (wd / "my-copy" / "world.json").read_text()


def test_render_refuses_overwrite(client, wd):
    before = (wd / "riverton" / "regions" / "riverton.json").read_bytes()
    assert client.post("/worlds/render", json={"id": "w2"}).status_code == 200
    r = client.post("/worlds/render", json={"id": "w2"})  # another living world: needs overwrite=true
    assert r.status_code == 409 and r.json()["detail"]["error"] == "needs_overwrite" and "overwrite=true" in r.json()["detail"]["message"]
    assert client.post("/worlds/render", json={"id": "w2", "overwrite": True}).json()["overwritten"] is True
    assert client.post("/worlds/render", json={"base": "w2", "id": "w2"}).json()["overwritten"] is True  # its own world: no flag needed
    assert client.post("/worlds/render", json={"id": "riverton"}).status_code == 409
    assert client.post("/worlds/render", json={"id": "riverton", "overwrite": True}).status_code == 409
    assert client.post("/worlds/render", json={"id": "Riverton"}).status_code == 409
    assert client.get("/worlds").json()["worlds"][0]["id"] == "riverton"
    assert (wd / "riverton" / "regions" / "riverton.json").read_bytes() == before


def test_render_with_changes_and_unknown_type(client, wd):
    ch = [{"type": "add_exit", "from": SQUARE, "direction": "dig", "to": YARD}, {"type": "remove_exit", "from": TAVERN, "direction": "up"}]
    assert client.post("/worlds/render", json={"id": "dug", "changes": ch}).status_code == 200
    w = load_world(wd / "dug")
    assert any(e.direction == "dig" and e.to == YARD for e in w.get(SQUARE).exits)
    assert not any(e.direction == "up" for e in w.get(TAVERN).exits)
    assert client.post("/worlds/render", json={"id": "bad", "changes": [{"type": "teleport"}]}).status_code == 400
    assert client.post("/worlds/render", json={"id": "bad", "changes": [{"type": "remove_exit", "from": TAVERN, "direction": "nope"}]}).status_code == 400
    assert not (wd / "bad").exists()


def test_move_and_travel_with_changes(client):
    dig = [{"type": "add_exit", "from": SQUARE, "direction": "dig", "to": YARD}]
    assert client.post("/move", json={"from": SQUARE, "direction": "dig"}).status_code == 400
    assert client.post("/move", json={"from": SQUARE, "direction": "dig", "changes": dig}).json()["address"] == YARD
    r = client.post("/travel", json={"from": TAVERN, "steps": ["out", "dig"], "changes": dig}).json()
    assert r["location"]["address"] == YARD and not r["stopped"]
    rm = [{"type": "remove_exit", "from": TAVERN, "direction": "out"}]
    assert client.post("/travel", json={"from": TAVERN, "steps": ["out"], "changes": rm}).json()["stopped"]


def test_single_folder_mode_still_works():
    c = TestClient(create_app(RIVERTON))
    assert c.get("/worlds").json()["default"] == "default" and c.get("/start").json()["address"] == TAVERN
    assert c.post("/worlds/render", json={"id": "x"}).status_code == 400


def test_render_pristine_has_no_knowledge(client, wd):
    r = client.post("/worlds/render", json={"id": "fresh"}).json()
    assert r["has_knowledge"] is False and not (wd / "fresh" / "knowledge.json").exists()
    assert client.get("/worlds/fresh/knowledge").json()["knowledge"] is None


def test_render_with_knowledge(client, wd):
    grate = next(e for e in client.get("/location/riverton:temple/nave").json()["exits"] if e["direction"] == "grate")["door"]
    k = {"location": "riverton:temple/catacombs", "stood": [TAVERN, SQUARE, "riverton:temple/nave", "riverton:temple/catacombs", "riverton:no/where"],
         "seen": ["riverton:docks/piers"], "doors": [grate, "door_bogus"]}
    r = client.post("/worlds/render", json={"id": "known", "knowledge": k}).json()
    assert r["has_knowledge"] is True and (wd / "known" / "knowledge.json").exists()
    got = client.get("/worlds/known/knowledge").json()["knowledge"]
    assert got["location"] == "riverton:temple/catacombs" and "riverton:no/where" not in got["stood"] and got["doors"] == [grate]
    # region files stay clean
    assert "stood" not in (wd / "known" / "regions" / "riverton.json").read_text()
    # reload from disk keeps it
    assert TestClient(create_app(worlds_dir=wd)).get("/worlds/known/knowledge").json()["knowledge"] == got


def test_render_never_touches_existing_folder(client, wd):
    r = client.post("/worlds/render", json={"id": "riverton", "overwrite": True, "changes": [{"type": "remove_exit", "from": TAVERN, "direction": "up"}]})
    assert r.status_code == 409
    assert any(e.direction == "up" for e in load_world(wd / "riverton").get(TAVERN).exits)
    (wd / "stray").mkdir()
    assert client.post("/worlds/render", json={"id": "stray"}).status_code == 409


def test_display_names_and_slugs(client, wd):
    r = client.post("/worlds/render", json={"name": "My Riverton!"}).json()
    assert r["id"] == "my-riverton" and r["name"] == "My Riverton!"
    assert '"name": "My Riverton!"' in (wd / "my-riverton" / "world.json").read_text()
    assert client.post("/worlds/render", json={"name": "  my riverton!  "}).json()["detail"]["error"] == "needs_overwrite"
    again = client.post("/worlds/render", json={"name": "  my riverton!  ", "overwrite": True}).json()  # same display name, living -> saved over
    assert again["overwritten"] is True and again["id"] == "my-riverton" and again["name"] == "My Riverton!"
    r2 = client.post("/worlds/render", json={"name": "My Riverton?"}).json()  # different name, same slug
    assert r2["id"] == "my-riverton-2" and r2["name"] == "My Riverton?"
    assert client.post("/worlds/render", json={"name": "Riverton"}).status_code == 409  # the default world's name


def test_auto_names(client):
    a = client.post("/worlds/render", json={"name": "Riverton - Desirae - Oct 19, 4:14 PM", "auto": True, "id_hint": "riverton-desirae-oct-19"}).json()
    b = client.post("/worlds/render", json={"name": "Riverton - Desirae - Oct 19, 4:14 PM", "auto": True, "id_hint": "riverton-desirae-oct-19"}).json()
    assert a["id"] == "riverton-desirae-oct-19" and a["name"] == "Riverton - Desirae - Oct 19, 4:14 PM"
    assert b["id"] == "riverton-desirae-oct-19-2" and b["name"] == "Riverton - Desirae - Oct 19, 4:14 PM (2)"
    c = client.post("/worlds/render", json={}).json()  # nothing sent: "<base> - <date>"
    assert c["name"].startswith("Riverton - ") and c["id"].startswith("riverton-")


def test_living_flag_validated(tmp_path):
    import json as _j
    shutil.copytree(RIVERTON, tmp_path / "riverton")
    wj = tmp_path / "riverton" / "world.json"
    data = _j.loads(wj.read_text()); data["living"] = "yes"; wj.write_text(_j.dumps(data))
    from app.world import WorldError
    with pytest.raises(WorldError, match='"living" must be true or false'):
        load_world(tmp_path / "riverton")


def test_riverton_is_protected(client, wd):
    assert client.get("/worlds").json()["worlds"][0]["living"] is False
    before = (wd / "riverton" / "regions" / "riverton.json").read_bytes()
    for body in [{"name": "Riverton"}, {"name": " riverton "}, {"id": "riverton"}, {"id": "Riverton", "name": "Other"}]:
        assert client.post("/worlds/render", json=body).status_code == 409, body
        assert client.post("/worlds/render", json={**body, "overwrite": True}).status_code == 409, body  # protected even with the flag
    assert (wd / "riverton" / "regions" / "riverton.json").read_bytes() == before and not (wd / ".backups").exists()


def test_missing_living_is_protected(client, wd):
    shutil.copytree(wd / "riverton", wd / "old-save")
    import json as _j
    wj = wd / "old-save" / "world.json"; d = _j.loads(wj.read_text()); d.pop("living", None); d["name"] = "Old Save"; wj.write_text(_j.dumps(d))
    c = TestClient(create_app(worlds_dir=wd))
    assert c.post("/worlds/render", json={"name": "Old Save"}).status_code == 409


def test_save_over_living_world_keeps_one_backup(client, wd):
    first = client.post("/worlds/render", json={"name": "Mine"}).json()
    assert first["living"] is True and '"living": true' in (wd / "mine" / "world.json").read_text()
    dig = [{"type": "add_exit", "from": SQUARE, "direction": "dig", "to": YARD}]
    second = client.post("/worlds/render", json={"base": "mine", "name": "Mine", "changes": dig}).json()
    assert second["overwritten"] and second["id"] == "mine" and second["map_version"] != first["map_version"]
    assert any(e.direction == "dig" for e in load_world(wd / "mine").get(SQUARE).exits)
    assert not any(e.direction == "dig" for e in load_world(wd / ".backups" / "mine").get(SQUARE).exits)  # previous version
    rm = [{"type": "remove_exit", "from": SQUARE, "direction": "dig"}]
    client.post("/worlds/render", json={"base": "mine", "name": "Mine", "changes": rm})
    assert [p.name for p in (wd / ".backups").iterdir()] == ["mine"]  # exactly one backup
    assert any(e.direction == "dig" for e in load_world(wd / ".backups" / "mine").get(SQUARE).exits)
    # the backup folder is never a world
    assert {w["id"] for w in client.get("/worlds").json()["worlds"]} == {"riverton", "mine"}
    assert {w["id"] for w in TestClient(create_app(worlds_dir=wd)).get("/worlds").json()["worlds"]} == {"riverton", "mine"}
    # moves on the saved-over world see the new version
    assert client.post("/move", json={"from": SQUARE, "direction": "dig"}, params={"world": "mine"}).status_code == 400


def test_rescan_and_world_not_found(client, wd):
    shutil.copytree(wd / "riverton", wd / "by-hand")
    assert "by-hand" in {w["id"] for w in client.get("/worlds").json()["worlds"]}
    assert client.get("/start?world=by-hand").status_code == 200
    shutil.rmtree(wd / "by-hand")
    assert "by-hand" not in {w["id"] for w in client.get("/worlds").json()["worlds"]}
    r = client.get("/start?world=by-hand")
    assert r.status_code == 404 and r.json()["detail"]["error"] == "world_not_found" and r.json()["detail"]["world"] == "by-hand"
    # a folder added by hand is found even without listing first
    shutil.copytree(wd / "riverton", wd / "later")
    assert client.get("/start?world=later").status_code == 200
    # a broken folder on rescan is skipped, not fatal
    (wd / "broken").mkdir(); (wd / "broken" / "world.json").write_text("{nope")
    assert client.get("/worlds").status_code == 200


def test_open_folder(client, wd):
    opened = []
    client.app.state.open_path = opened.append
    assert client.post("/open-folder").json()["opened"] == str(wd.resolve())
    assert client.post("/open-folder?world=riverton").status_code == 200 and opened[-1] == (wd / "riverton").resolve()
    for bad in ["../x", "..", "a/b", "C:\\\\x"]:
        assert client.post("/open-folder", params={"world": bad}).status_code == 400, bad
    assert client.post("/open-folder?world=nope").status_code == 404
    assert client.post("/open-folder", params={"path": "/etc"}).json()["opened"] == str(wd.resolve())  # no path parameter exists
    assert len(opened) == 3


def test_two_way_dig_and_new_room(client, wd):
    hole = "riverton:drowned_rat/hole_1"
    ch = [{"type": "add_room", "address": hole, "name": "Dusty Cellar", "description": "A cramped, dusty space.", "from": TAVERN},
          {"type": "dig", "from": TAVERN, "direction": "hole", "to": hole, "description": "A ragged hole in the wall.",
           "return_direction": "back"}]
    r = client.post("/move", json={"from": TAVERN, "direction": "hole", "changes": ch}).json()
    assert r["address"] == hole and r["name"] == "Dusty Cellar" and [e["direction"] for e in r["exits"]] == ["back"]
    assert client.post("/move", json={"from": hole, "direction": "back", "changes": ch}).json()["address"] == TAVERN
    assert client.post("/worlds/render", json={"id": "holey", "changes": ch}).status_code == 200
    w = load_world(wd / "holey")
    assert w.get(hole).name == "Dusty Cellar" and any(e.direction == "hole" and e.to == hole for e in w.get(TAVERN).exits)
    # two-way dig into existing rooms; refused if either side already has that exit name
    ok = [{"type": "dig", "from": SQUARE, "direction": "crack", "to": YARD, "return_direction": "crack"}]
    assert client.post("/move", json={"from": YARD, "direction": "crack", "changes": ok}).json()["address"] == SQUARE
    for bad in ([{"type": "dig", "from": TAVERN, "direction": "up", "to": YARD, "return_direction": "x"}],
                [{"type": "dig", "from": SQUARE, "direction": "x", "to": TAVERN, "return_direction": "up"}],
                [{"type": "dig", "from": SQUARE, "direction": "x", "to": SQUARE, "return_direction": "y"}],
                [ch[0], ch[0]],
                [{"type": "add_room", "address": "riverton:nowhere/x", "name": "A", "description": "B"}],
                [{"type": "add_room", "address": "riverton:drowned_rat/../x", "name": "A", "description": "B"}],
                [{"type": "add_room", "address": hole, "name": "A" * 61, "description": "B"}]):
        assert client.post("/move", json={"from": TAVERN, "direction": "out", "changes": bad}).status_code == 400, bad


def test_nearby_rooms(client):
    up = "riverton:drowned_rat/upstairs"
    rooms = client.post("/nearby", json={"from": up}).json()["rooms"]
    assert rooms[0]["address"] == TAVERN and rooms[0]["steps"] == 1
    assert any(r["address"] == SQUARE and r["steps"] == 2 for r in rooms)
    assert len(rooms) <= 12 and all(set(r) == {"address", "name", "area", "display_name", "summary", "steps"} for r in rooms)
    assert all(r["steps"] <= 3 for r in rooms) and up not in [r["address"] for r in rooms]
    assert len(client.post("/nearby", json={"from": up, "limit": 2}).json()["rooms"]) == 2


def _edit(wd, fn):
    import json
    p = wd / "riverton" / "regions" / "riverton.json"
    d = json.loads(p.read_text())
    fn(d)
    p.write_text(json.dumps(d))


def _exit(d, sub, loc, direction):
    return next(e for e in d["subregions"][sub]["locations"][loc]["exits"] if e["direction"] == direction)


def test_view_defaults_and_validation(client, wd):
    tav = client.get(f"/location/{TAVERN}").json()
    out = next(e for e in tav["exits"] if e["direction"] == "out")
    assert out["view"] == "open" and out["stays_open"] is False and out["to_summary"]
    assert tav["views"] == []
    nave = client.get("/location/riverton:temple/nave").json()
    grate = next(e for e in nave["exits"] if e["direction"] == "grate")
    assert grate["view"] == "closed" and "to" not in grate and "to_summary" not in grate  # nothing about the destination
    _edit(wd, lambda d: _exit(d, "drowned_rat", "common_room", "out").update(view="ajar"))
    from app.world import WorldError
    with pytest.raises(WorldError, match='"view" must be one of'):
        load_world(wd / "riverton")


def test_stays_open_precedence_and_views(wd):
    def setup(d):
        d["stays_open"] = True
        d["subregions"]["drowned_rat"]["stays_open"] = False
        _exit(d, "drowned_rat", "common_room", "out").update(view="closed")
        _exit(d, "streets", "square", "east").update(view="closed", stays_open=False)
        _exit(d, "temple", "nave", "south").update(view="closed")
        d["subregions"]["drowned_rat"]["locations"]["upstairs"]["views"] = ["streets/square"]
    _edit(wd, setup)
    c = TestClient(create_app(worlds_dir=wd))
    ex = lambda a, dr: next(e for e in c.get(f"/location/{a}").json()["exits"] if e["direction"] == dr)
    assert ex(TAVERN, "out")["stays_open"] is False  # subregion beats region
    assert ex("riverton:temple/nave", "south")["stays_open"] is True  # region
    assert ex(SQUARE, "east")["stays_open"] is False  # exit beats region
    assert ex(TAVERN, "out")["view"] == "closed" and ex(TAVERN, "out")["door"] == ex(SQUARE, "in")["door"]  # paired
    up = c.get("/location/riverton:drowned_rat/upstairs").json()
    assert [v["address"] for v in up["views"]] == [SQUARE] and up["views"][0]["name"] == "Village Square"


def test_door_and_view_link_changes(client, wd):
    up = "riverton:drowned_rat/upstairs"
    ch = [{"type": "open_door", "from": TAVERN, "direction": "out", "stays_open": False},
          {"type": "close_door", "from": TAVERN, "direction": "out"},
          {"type": "view_link", "from": up, "to": SQUARE}]
    assert client.post("/move", json={"from": TAVERN, "direction": "up", "changes": ch}).json()["views"][0]["address"] == SQUARE
    assert client.post("/move", json={"from": TAVERN, "direction": "up", "changes": [{"type": "open_door", "from": TAVERN, "direction": "nope"}]}).status_code == 400
    assert client.post("/move", json={"from": TAVERN, "direction": "up", "changes": [{"type": "view_link", "from": up, "to": up}]}).status_code == 400
    assert client.post("/worlds/render", json={"id": "viewy", "changes": ch}).status_code == 200
    import json
    raw = (wd / "viewy" / "regions" / "riverton.json").read_text()
    d = json.loads(raw)
    assert d["subregions"]["drowned_rat"]["locations"]["upstairs"]["views"] == [SQUARE]
    assert "stays_open" not in raw and '"view"' not in raw  # door changes never written; no defaults added


def test_stays_open_per_door_across_a_boundary(wd):
    """Crypt (temple, stays_open) <-> bandit tunnel: the same answer from both sides."""
    CAT, TUN = "riverton:temple/catacombs", "riverton:secret_tunnel/tunnel"

    def world(temple=None, tunnel=None, ex_cat=None, ex_tun=None):
        def setup(d):
            for sid, v in (("temple", temple), ("secret_tunnel", tunnel)):
                d["subregions"][sid].pop("stays_open", None)
                if v is not None:
                    d["subregions"][sid]["stays_open"] = v
            for sid, loc, dr, v in (("temple", "catacombs", "tunnel", ex_cat), ("secret_tunnel", "tunnel", "catacombs", ex_tun)):
                e = _exit(d, sid, loc, dr)
                e["view"] = "closed"
                e.pop("stays_open", None)
                if v is not None:
                    e["stays_open"] = v
        _edit(wd, setup)
        w = load_world(wd / "riverton")
        a = next(e for e in w.get(CAT).exits if e.direction == "tunnel")
        b = next(e for e in w.get(TUN).exits if e.direction == "catacombs")
        assert a.door == b.door and sorted(w.doors[a.door]["rooms"]) == sorted([CAT, TUN])
        return w.stays_open(a, w.get(CAT)), w.stays_open(b, w.get(TUN))

    assert world(temple=True) == (False, False)  # only one side inherits true
    assert world(temple=True, tunnel=True) == (True, True)  # both inherit true
    assert world(temple=True, tunnel=True, ex_tun=False) == (False, False)  # explicit exit on either side wins
    assert world(ex_cat=True) == (True, True)  # explicit beats inherited false
    assert world(ex_cat=True, ex_tun=False) == (False, False)  # conflict: false wins


def test_door_rooms_are_opaque(client):
    yard = client.get("/location/riverton:drowned_rat/courtyard").json()
    trap = next(e for e in yard["exits"] if e["direction"] == "trapdoor")
    cellar = client.get("/location/riverton:drowned_rat/cellar").json()
    assert "to" not in trap and "drowned_rat/cellar" not in str(trap) and "to_name" not in trap
    assert sorted(trap["door_rooms"]) == sorted([yard["room_token"], cellar["room_token"]])
