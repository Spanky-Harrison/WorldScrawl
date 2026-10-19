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
    assert client.post("/worlds/render", json={"id": "w2"}).status_code == 409
    assert client.post("/worlds/render", json={"id": "riverton"}).status_code == 409
    assert client.post("/worlds/render", json={"id": "w2", "overwrite": True}).status_code == 409
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
    assert client.post("/worlds/render", json={"name": "  my riverton!  "}).status_code == 409  # same display name
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
