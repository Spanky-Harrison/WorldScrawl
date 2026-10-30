// Port of tests/test_world.py (map loading, validation, rooms, moves, doors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorldError, load_world } from '../../plugin/world.mjs';
import { ROOT, SQUARE, TAVERN, TestClient, caplog, client, makeWorld, mkdir, tmpPath, write } from './helpers.mjs';

const region = (start = 's/a', subs = null, notes = 'region lore') => ({ name: 'R', lore: notes, start, subregions: subs ?? {
    s: { name: 'S', lore: 'sub notes', locations: {
        a: { name: 'A', description: 'da', exits: [{ direction: 'east', to: 'b' }, { direction: 'out', to: 't/x' }] },
        b: { name: 'B', description: 'db', exits: [{ direction: 'west', to: 'a' }] },
    } },
    t: { name: 'T', lore: 't notes', inherit_lore: false, locations: {
        x: { name: 'X', description: 'dx', exits: [{ direction: 'in', to: 's/a' }] },
        y: { name: 'Y', description: 'dy', inherit_region_lore: true, inherit_subregion_lore: false, exits: [] },
    } },
} });
const load = (dir, r, startRegion) => load_world(makeWorld(dir, { r }, startRegion));
const raises = (fn, re) => assert.throws(fn, e => e instanceof WorldError && re.test(e.message));
const C = () => client(ROOT);
const ex = (room, direction) => room.exits.find(e => e.direction === direction);
const exitOf = (w, a, d) => w.get(a).exits.find(e => e.direction === d);

test('sample world loads', () => {
    const w = load_world(ROOT);
    assert.equal(w.start, TAVERN);
    assert.ok(w.locations.size >= 10);
    assert.ok([...w.locations.values()].every(l => l.address.split('/').length === 2));
});

test('minimal and exit resolution', () => {
    const w = load(tmpPath(), region());
    assert.equal(w.get('r:s/a').exits[0].to, 'r:s/b'); // bare = same subregion
    assert.equal(w.get('r:s/a').exits[1].to, 'r:t/x'); // sub/loc = same region
    assert.equal(w.start, 'r:s/a');
});

test('notes inheritance', () => {
    const w = load(tmpPath(), region());
    assert.deepEqual(w.effective_lore(w.get('r:s/a')), { region: 'region lore', subregion: 'sub notes' });
    assert.deepEqual(w.effective_lore(w.get('r:t/x')), { region: null, subregion: 't notes' });
    assert.deepEqual(w.effective_lore(w.get('r:t/y')), { region: 'region lore', subregion: null });
});

test('location can drop region notes', () => {
    const r = region();
    r.subregions.s.locations.b.inherit_region_lore = false;
    const w = load(tmpPath(), r);
    assert.deepEqual(w.effective_lore(w.get('r:s/b')), { region: null, subregion: 'sub notes' });
});

test('bad flag types', () => {
    const tmp = tmpPath();
    let r = region();
    r.subregions.s.inherit_lore = 'no';
    raises(() => load(tmp, r), /inherit_lore" must be true or false/);
    r = region();
    r.subregions.s.locations.a.exits[0].hidden = 1;
    raises(() => load(mkdir(path.join(tmp, 'x')), r), /hidden" must be true or false/);
});

test('exit flags exposed', () => {
    const r = region();
    r.subregions.s.locations.a.exits[0].hidden = true;
    const c = client(makeWorld(tmpPath(), { r }));
    const e = c.get('/location/r:s/a').json().exits;
    assert.ok(e[0].hidden === true && !('hidden' in e[1]));
    assert.ok(['to', 'to_name', 'to_display_name', 'to_subregion', 'to_region'].every(k => !(k in e[0])));
    assert.ok(e[1].to === 'r:t/x' && e[1].to_display_name === 'X (T)' && e[1].to_region.name === 'R');
});

test('duplicate keys rejected', () => {
    const text = '{"name":"R","start":"s/a","subregions":{"s":{"name":"S","locations":{"a":{"name":"A","description":"x"},"a":{"name":"A2","description":"y"}}}}}';
    raises(() => load_world(makeWorld(tmpPath(), {}, 'r', { 'r.json': text })), /r\.json: duplicate key 'a'/);
});

test('missing exit target', () => {
    const r = region();
    r.subregions.s.locations.a.exits.push({ direction: 'north', to: 'nowhere' });
    raises(() => load(tmpPath(), r), /exit target 'nowhere' does not exist \(looked for 'r:s\/nowhere'\)/);
});

test('cross region exit', () => {
    const tmp = tmpPath();
    const r = region();
    r.subregions.s.locations.a.exits.push({ direction: 'north', to: 'q:z/x' });
    const q = { name: 'Q', start: 'z/x', subregions: { z: { name: 'Z', locations: { x: { name: 'X', description: 'dx', exits: [{ direction: 'south', to: 'r:s/a' }] } } } } };
    const w = load_world(makeWorld(tmp, { r, q }));
    assert.equal(w.get('r:s/a').exits[2].to, 'q:z/x');
    r.subregions.s.locations.a.exits[2].to = 'nope:z/x';
    raises(() => load_world(makeWorld(mkdir(path.join(tmp, '2')), { r, q })), /'nope:z\/x'/);
});

test('bad slug', () => {
    const r = region();
    r.subregions.s.locations['Bad Name'] = { name: 'x', description: 'x', exits: [] };
    raises(() => load(tmpPath(), r), /not a valid id/);
});

test('region id must match file', () => {
    const r = region();
    r.id = 'other';
    raises(() => load(tmpPath(), r), /must match the file name/);
});

test('bad start', () => {
    const tmp = tmpPath();
    raises(() => load(tmp, region('s/zzz')), /start location 's\/zzz'/);
    raises(() => load(mkdir(path.join(tmp, 'x')), region('a')), /must look like/);
    raises(() => load(mkdir(path.join(tmp, 'y')), region(), 'nope'), /start_region 'nope'/);
});

test('missing field', () => {
    const r = region();
    delete r.subregions.s.locations.a.description;
    raises(() => load(tmpPath(), r), /location s\/a: missing "description"/);
});

test('duplicate direction', () => {
    const r = region();
    r.subregions.s.locations.a.exits.push({ direction: 'East', to: 'a' });
    raises(() => load(tmpPath(), r), /used twice/);
});

test('start', () => {
    const r = C().get('/start').json();
    assert.ok(r.address === TAVERN && r.name === 'Common Room');
    assert.ok(r.subregion.id === 'drowned_rat' && r.subregion.name === 'The Drowned Rat' && r.subregion.lore);
    assert.ok(r.region.name === 'Riverton' && r.region.lore);
    const out = ex(r, 'out');
    assert.ok(out.to === SQUARE && out.to_name === 'Village Square' && out.to_subregion.name === 'Riverton Streets');
});

test('sample notes', () => {
    const c = C();
    const up = c.get('/location/riverton:drowned_rat/upstairs').json().effective_lore;
    assert.ok(up.region && up.subregion === null); // quiet room drops the tavern's noise
    const nave = c.get('/location/riverton:temple/nave').json().effective_lore;
    assert.ok(nave.region === null && nave.subregion); // temple drops village notes
});

test('two upstairs rooms', () => {
    const c = C();
    const a = c.get('/location/riverton:drowned_rat/upstairs').json(), b = c.get('/location/riverton:gilded_goose/upstairs').json();
    assert.ok(a.name === b.name && b.name === 'Upstairs Rooms');
    assert.notEqual(a.subregion.name, b.subregion.name);
});

test('shops are separate subregions', () => {
    const lane = C().get('/location/riverton:streets/market_lane').json();
    const subs = new Set(lane.exits.map(e => e.to_subregion?.id));
    assert.ok(['gilded_goose', 'general_store', 'smithy', 'streets'].every(s => subs.has(s)));
});

test('location 404', () => {
    const c = C();
    assert.equal(c.get('/location/riverton:docks/piers').json().name, 'River Docks');
    assert.equal(c.get('/location/riverton:nope/x').status_code, 404);
    // the extension sends the address URL-encoded
    assert.equal(c.get('/location/' + encodeURIComponent('riverton:docks/piers')).json().name, 'River Docks');
});

test('move', () => {
    const c = C();
    const r = c.post('/move', { json: { from: TAVERN, direction: ' OUT ' } });
    assert.ok(r.status_code === 200 && r.json().address === SQUARE);
    const bad = c.post('/move', { json: { from: TAVERN, direction: 'west' } });
    assert.equal(bad.status_code, 400);
    assert.deepEqual(new Set(bad.json().detail.valid_directions), new Set(['out', 'up', 'back']));
    assert.equal(c.post('/move', { json: { from: 'x:y/z', direction: 'west' } }).status_code, 404);
});

// Was test_cors: the browser must be able to read the version header. The plugin is same-origin (no CORS
// needed), so the intent is now: the header is on every response, errors included.
test('version header on every response (was: cors)', () => {
    const c = C();
    for (const r of [c.get('/start'), c.get('/location/riverton:nope/x'), c.post('/move', { json: {} }), c.get('/nope')]) assert.ok(r.headers.get('x-worldscrawl-map-version'));
});

test('route tavern to goose upstairs', () => {
    const c = C();
    let at = TAVERN;
    for (const d of ['out', 'west', 'inn', 'up']) at = c.post('/move', { json: { from: at, direction: d } }).json().address;
    assert.equal(at, 'riverton:gilded_goose/upstairs');
});

test('temple not adjacent to tavern', () => {
    const tavern = C().get(`/location/${TAVERN}`).json();
    assert.ok(!tavern.exits.map(e => e.to).includes('riverton:temple/nave'));
});

test('entrances', () => {
    const tmp = tmpPath();
    let w = load(tmp, region());
    assert.equal(w.subregions.get('r:s').entrance, 'r:s/a');
    assert.equal(w.regions.get('r').entrance, 'r:s/a');
    const r = region();
    r.entrance = 't/x';
    r.subregions.t.entrance = 'y';
    w = load(mkdir(path.join(tmp, 'e')), r);
    assert.ok(w.regions.get('r').entrance === 'r:t/x' && w.subregions.get('r:t').entrance === 'r:t/y');
});

test('bad entrances', () => {
    const tmp = tmpPath();
    let r = region();
    r.subregions.s.entrance = 'zzz';
    raises(() => load(tmp, r), /entrance 'zzz' is not a room in this subregion/);
    r = region();
    r.entrance = 's/zzz';
    raises(() => load(mkdir(path.join(tmp, 'b')), r), /entrance 's\/zzz' does not exist/);
});

test('sample entrances', () => {
    const c = C();
    const d = c.get('/location/riverton:drowned_rat/upstairs').json();
    assert.ok(d.subregion.entrance === TAVERN && d.region.entrance === SQUARE);
    const lane = c.get('/location/riverton:streets/market_lane').json();
    assert.equal(ex(lane, 'inn').to_subregion.entrance, 'riverton:gilded_goose/common_room');
});

test('two common rooms', () => {
    const c = C();
    const a = c.get('/location/riverton:drowned_rat/common_room').json(), b = c.get('/location/riverton:gilded_goose/common_room').json();
    assert.ok(a.name === b.name && a.name === 'Common Room');
    assert.deepEqual(new Set([a.subregion.name, b.subregion.name]), new Set(['The Drowned Rat', 'The Gilded Goose']));
});

test('stable gate onto market lane', () => {
    const c = C();
    const stable = c.get('/location/riverton:drowned_rat/stable').json();
    assert.equal(ex(stable, 'gate').to, 'riverton:streets/market_lane');
    const lane = c.get('/location/riverton:streets/market_lane').json();
    assert.ok(lane.exits.some(e => e.to === 'riverton:drowned_rat/stable'));
});

test('drowned rat back rooms', () => {
    const c = C();
    const yard = c.get('/location/riverton:drowned_rat/courtyard').json();
    assert.deepEqual(new Set(yard.exits.filter(e => 'to' in e).map(e => e.to)), new Set([TAVERN, 'riverton:drowned_rat/kitchens', 'riverton:drowned_rat/stable']));
    assert.equal(c.get('/location/riverton:drowned_rat/kitchens').json().name, 'Kitchens');
});

test('travel whole route', () => {
    const r = C().post('/travel', { json: { from: TAVERN, steps: ['out', 'west', 'inn', 'up'] } });
    const b = r.json();
    assert.ok(r.status_code === 200 && b.location.address === 'riverton:gilded_goose/upstairs');
    assert.deepEqual(b.path.map(p => p.address), [SQUARE, 'riverton:streets/market_lane', 'riverton:gilded_goose/common_room', 'riverton:gilded_goose/upstairs']);
    assert.ok(b.steps_completed === 4 && b.stopped === false && b.reason === null);
});

test('travel stops at last valid room', () => {
    const c = C();
    const b = c.post('/travel', { json: { from: TAVERN, steps: ['out', 'sideways', 'north'] } }).json();
    assert.ok(b.location.address === SQUARE && b.steps_completed === 1);
    assert.ok(b.stopped === true && b.reason === 'blocked' && b.error.includes('sideways'));
    assert.equal(c.post('/travel', { json: { from: 'x:y/z', steps: ['out'] } }).status_code, 404);
});

test('map version header', () => {
    const c = C();
    const v = c.get('/start').headers.get('x-worldscrawl-map-version');
    assert.ok(v && c.post('/move', { json: { from: TAVERN, direction: 'nope' } }).headers.get('x-worldscrawl-map-version') === v);
    assert.equal(c.get('/health').json().map_version, v);
    const w = makeWorld(tmpPath(), { r: region() });
    const v1 = client(w).get('/start').headers.get('x-worldscrawl-map-version');
    write(path.join(w, 'regions', 'r.json'), JSON.stringify(region('s/a', null, 'changed')));
    const v2 = client(w).get('/start').headers.get('x-worldscrawl-map-version');
    assert.notEqual(v1, v2);
});

// Was test_version_header_exposed_to_browser (CORS expose-headers). Same-origin needs no CORS; the intent kept
// is that the header matches the world the request named.
test('version header follows ?world (was: exposed to browser)', () => {
    const tmp = tmpPath();
    fs.cpSync(ROOT, path.join(tmp, 'riverton'), { recursive: true });
    const c = new TestClient({ worldsDir: tmp });
    const mine = c.post('/worlds/render', { json: { id: 'mine', changes: [{ type: 'remove_exit', from: TAVERN, direction: 'up' }] } }).json();
    assert.equal(c.get('/start?world=mine').headers.get('x-worldscrawl-map-version'), mine.map_version);
    assert.notEqual(c.get('/start').headers.get('x-worldscrawl-map-version'), mine.map_version);
});

test('move and travel logged', () => {
    const c = C();
    const [, text] = caplog(() => {
        c.post('/move', { json: { from: TAVERN, direction: 'out' } });
        c.post('/travel', { json: { from: TAVERN, steps: ['out', 'north'] } });
    });
    assert.ok(text.includes('move riverton:drowned_rat/common_room -out-> riverton:streets/square'));
    assert.ok(text.includes("travel riverton:drowned_rat/common_room steps=['out', 'north'] -> riverton:temple/nave (2/2 steps)"));
});

test('exits carry destination data', () => {
    const loc = C().get(`/location/${SQUARE}`).json();
    assert.equal(loc.display_name, 'Village Square (Riverton Streets)');
    const rat = loc.exits.find(e => e.to === TAVERN);
    assert.equal(rat.to_display_name, 'Common Room (The Drowned Rat)');
    assert.deepEqual(rat.to_subregion, { id: 'drowned_rat', name: 'The Drowned Rat', entrance: TAVERN, label_rooms: false });
    assert.ok(rat.to_region.name === 'Riverton' && rat.to_region.entrance);
});

test('rooms batch', () => {
    const c = C();
    const b = c.get('/rooms', { params: { addresses: `${TAVERN},${SQUARE},${TAVERN},nowhere:x/y` } }).json();
    assert.deepEqual(b.rooms.map(r => r.address), [TAVERN, SQUARE]);
    assert.ok(JSON.stringify(b.unknown) === '["nowhere:x/y"]' && b.start.address === TAVERN);
    assert.deepEqual(c.get('/rooms').json().rooms, []);
});

test('exit labels name the building', () => {
    const c = C();
    const byDir = room => Object.fromEntries(room.exits.map(e => [e.direction, e]));
    const lane = byDir(c.get('/location/riverton:streets/market_lane').json());
    assert.equal(lane.east.to_label, 'Village Square');
    assert.equal(lane.inn.to_label, 'The Gilded Goose');
    assert.equal(lane.gate.to_label, 'The Drowned Rat, Stable');
    const rat = byDir(c.get(`/location/${TAVERN}`).json());
    assert.equal(rat.out.to_label, 'Village Square');
    const r = region();
    r.subregions.s.locations.b.exits.push({ direction: 'road', to: 'q:m/n' });
    r.subregions.s.locations.b.exits.push({ direction: 'crack', to: 'a', hidden: true });
    const q = { name: 'Q', start: 'm/n', subregions: { m: { name: 'M', locations: {
        n: { name: 'N', description: 'dn', exits: [] }, o: { name: 'O', description: 'do', exits: [] } } } } };
    const e = byDir(client(makeWorld(tmpPath(), { r, q })).get('/location/r:s/b').json());
    assert.ok(e.road.to_label === 'M, Q' && e.west.to_label === 'A');
    assert.ok(!('to_label' in e.crack) && !('to' in e.crack));
});

test('subregion entrance name', () => {
    const sub = C().get('/location/riverton:drowned_rat/stable').json().subregion;
    assert.ok(sub.entrance === TAVERN && sub.entrance_name === 'Common Room');
});

test('label rooms flag', () => {
    const tmp = tmpPath();
    const r = region();
    r.subregions.t.label_rooms = true;
    const out = ex(client(makeWorld(tmp, { r })).get('/location/r:s/a').json(), 'out');
    assert.ok(out.to_label === 'X' && out.to_subregion.label_rooms === true);
    r.subregions.t.label_rooms = 'yes';
    raises(() => load(mkdir(path.join(tmp, 'bad')), r), /label_rooms/);
});

// ---- obscured / hidden doors
const COURTYARD = 'riverton:drowned_rat/courtyard', CELLAR = 'riverton:drowned_rat/cellar';
const NAVE = 'riverton:temple/nave', CATA = 'riverton:temple/catacombs', TUNNEL = 'riverton:secret_tunnel/tunnel';
const DEST_KEYS = ['to', 'to_name', 'to_display_name', 'to_label', 'to_subregion', 'to_region'];

test('riverton obscured exits reveal nothing', () => {
    const c = C(), w = load_world(ROOT);
    for (const [addr, d, flag] of [[COURTYARD, 'trapdoor', 'obscured'], [NAVE, 'grate', 'obscured'], [CELLAR, 'narrow door', 'hidden'], [TUNNEL, 'narrow door', 'hidden']]) {
        const e = ex(c.get(`/location/${addr}`).json(), d);
        assert.ok(e[flag] === true && e.door.startsWith('door_') && DEST_KEYS.every(k => !(k in e)));
        const dest = w.get(exitOf(w, addr, d).to);
        assert.ok(!JSON.stringify(e).includes(dest.address) && !JSON.stringify(e).includes(dest.name));
    }
});

test('doors paired with return exit', () => {
    const w = load_world(ROOT);
    const door = (a, d) => exitOf(w, a, d).door;
    assert.equal(door(COURTYARD, 'trapdoor'), door(CELLAR, 'trapdoor'));
    assert.equal(door(NAVE, 'grate'), door(CATA, 'up'));
    assert.equal(door(CELLAR, 'narrow door'), door(TUNNEL, 'narrow door'));
    assert.ok(door(CATA, 'tunnel') === null && door(TAVERN, 'up') === null);
    assert.ok(door(COURTYARD, 'in') === door(TAVERN, 'back') && door(TAVERN, 'back') !== null);
    assert.ok(door(TAVERN, 'out') === door(SQUARE, 'in') && door(SQUARE, 'in') !== null);
    assert.equal(new Set([door(COURTYARD, 'trapdoor'), door(NAVE, 'grate'), door(CELLAR, 'narrow door')]).size, 3);
    const up = ex(C().get(`/location/${CATA}`).json(), 'up');
    assert.ok(up.to === NAVE && up.door === door(NAVE, 'grate'));
});

test('doors endpoint reveals only requested doors', () => {
    const c = C();
    const grate = ex(c.get(`/location/${NAVE}`).json(), 'grate').door;
    const e = c.post('/doors', { json: { doors: [grate] } }).json().exits;
    assert.ok(e.length === 1 && e[0].from === NAVE && e[0].direction === 'grate' && e[0].to === CATA);
    assert.equal(e[0].to_label, 'Temple Catacombs');
    assert.deepEqual(c.post('/doors', { json: { doors: ['door_nope'] } }).json().exits, []);
    const both = c.post('/doors', { json: { doors: [ex(c.get(`/location/${CELLAR}`).json(), 'narrow door').door] } }).json().exits;
    assert.deepEqual(new Set(both.map(x => `${x.from}>${x.to}`)), new Set([`${CELLAR}>${TUNNEL}`, `${TUNNEL}>${CELLAR}`]));
});

test('move and travel through obscured exits', () => {
    const c = C();
    assert.equal(c.post('/move', { json: { from: COURTYARD, direction: 'trapdoor' } }).json().address, CELLAR);
    const r = c.post('/travel', { json: { from: CELLAR, steps: ['narrow door', 'catacombs', 'up'] } }).json();
    assert.ok(r.location.address === NAVE && r.steps_completed === 3);
});

test('one way flagged exit warns', () => {
    const r = region();
    r.subregions.t.locations.y.exits = [{ direction: 'chute', to: 's/b', obscured: true }];
    const [w, text] = caplog(() => load(tmpPath(), r));
    assert.ok(text.includes('no return exit'));
    assert.ok(w.get('r:t/y').exits[0].door);
});

test('cellar trapdoor obscured both sides', () => {
    const c = C();
    const e = ex(c.get(`/location/${CELLAR}`).json(), 'trapdoor');
    assert.ok(e.obscured === true && !('to' in e));
    assert.equal(c.post('/move', { json: { from: CELLAR, direction: 'trapdoor' } }).json().address, COURTYARD);
});

test('staircases are open never doors', () => {
    const w = load_world(ROOT);
    const up = exitOf(w, TAVERN, 'up'), down = exitOf(w, 'riverton:drowned_rat/upstairs', 'down');
    assert.ok(up.view === null && !up.flagged && up.effective_view === 'open' && up.door === null);
    assert.ok(down.effective_view === 'open' && down.door === null);
    assert.equal(exitOf(w, TAVERN, 'out').effective_view, 'closed');
});
