// Port of tests/test_worlds.py (several worlds, saving/rendering, changes, doors and views).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WorldError, load_world } from '../../plugin/world.mjs';
import { RIVERTON, SQUARE, TAVERN, YARD, TestClient, copytree, read, tmpPath, write } from './helpers.mjs';

function setup() {
    const wd = tmpPath();
    copytree(RIVERTON, path.join(wd, 'riverton'));
    return { wd, client: new TestClient({ worldsDir: wd }) };
}
const P = (...a) => path.join(...a);
const ids = c => new Set(c.get('/worlds').json().worlds.map(w => w.id));
const exits = (w, a) => w.get(a).exits;
const bytes = p => fs.readFileSync(p);
const editJson = (p, fn) => { const d = JSON.parse(read(p)); fn(d); write(p, JSON.stringify(d)); };

test('list worlds and default', () => {
    const { client } = setup();
    const r = client.get('/worlds').json();
    assert.equal(r.default, 'riverton');
    assert.equal(r.worlds.length, 1);
    const [w] = r.worlds;
    assert.ok(w.id === 'riverton' && w.start_region === 'riverton' && w.map_version.length === 12);
    assert.equal(client.get('/start').json().address, TAVERN);
    assert.equal(client.get('/start?world=riverton').json().address, TAVERN);
    assert.equal(client.get('/health?world=riverton').headers.get('X-WorldScrawl-Map-Version'), w.map_version);
});

test('bad world ids rejected', () => {
    const { client } = setup();
    for (const bad of ['../riverton', '..', 'a/b', 'riverton%2F..', 'a_b', 'a b', '-x']) assert.equal(client.get('/start', { params: { world: bad } }).status_code, 400, bad);
    assert.equal(client.get('/start?world=nope').status_code, 404);
    for (const bad of ['../evil', 'x/y', '..', 'a_b', '']) assert.equal(client.post('/worlds/render', { json: { id: bad } }).status_code, 400, bad);
});

test('render copy identical new id', () => {
    const { client, wd } = setup();
    const r = client.post('/worlds/render', { json: { base: 'riverton', id: 'my-copy', name: 'My Copy' } });
    assert.ok(r.status_code === 200 && r.json().id === 'my-copy' && r.json().name === 'My Copy');
    const a = load_world(RIVERTON), b = load_world(P(wd, 'my-copy'));
    assert.deepEqual([...a.locations.keys()], [...b.locations.keys()]);
    for (const k of a.locations.keys()) assert.deepEqual(a.to_dict(a.get(k)), b.to_dict(b.get(k)));
    assert.deepEqual(ids(client), new Set(['riverton', 'my-copy']));
    assert.equal(client.get(`/location/${SQUARE}?world=my-copy`).status_code, 200);
    const text = read(P(wd, 'my-copy', 'regions', 'riverton.json'));
    assert.ok(!text.includes('to_label') && !/(?<!in)door_/.test(text) && read(P(wd, 'my-copy', 'world.json')).includes('"name": "My Copy"'));
});

test('render refuses overwrite', () => {
    const { client, wd } = setup();
    const before = bytes(P(wd, 'riverton', 'regions', 'riverton.json'));
    assert.equal(client.post('/worlds/render', { json: { id: 'w2' } }).status_code, 200);
    const r = client.post('/worlds/render', { json: { id: 'w2' } });
    assert.ok(r.status_code === 409 && r.json().detail.error === 'needs_overwrite' && r.json().detail.message.includes('overwrite=true'));
    assert.equal(client.post('/worlds/render', { json: { id: 'w2', overwrite: true } }).json().overwritten, true);
    assert.equal(client.post('/worlds/render', { json: { base: 'w2', id: 'w2' } }).json().overwritten, true);
    assert.equal(client.post('/worlds/render', { json: { id: 'riverton' } }).status_code, 409);
    assert.equal(client.post('/worlds/render', { json: { id: 'riverton', overwrite: true } }).status_code, 409);
    assert.equal(client.post('/worlds/render', { json: { id: 'Riverton' } }).status_code, 409);
    assert.equal(client.get('/worlds').json().worlds[0].id, 'riverton');
    assert.deepEqual(bytes(P(wd, 'riverton', 'regions', 'riverton.json')), before);
});

test('render with changes and unknown type', () => {
    const { client, wd } = setup();
    const ch = [{ type: 'add_exit', from: SQUARE, direction: 'dig', to: YARD }, { type: 'remove_exit', from: TAVERN, direction: 'up' }];
    assert.equal(client.post('/worlds/render', { json: { id: 'dug', changes: ch } }).status_code, 200);
    const w = load_world(P(wd, 'dug'));
    assert.ok(exits(w, SQUARE).some(e => e.direction === 'dig' && e.to === YARD));
    assert.ok(!exits(w, TAVERN).some(e => e.direction === 'up'));
    // A change that cannot apply is skipped on its own (lenient replay): the save still works, without it.
    assert.equal(client.post('/worlds/render', { json: { id: 'bad', changes: [{ type: 'teleport' }] } }).status_code, 200);
    assert.equal(client.post('/worlds/render', { json: { id: 'bad2', changes: [{ type: 'remove_exit', from: TAVERN, direction: 'nope' }] } }).status_code, 200);
    assert.ok(exits(load_world(P(wd, 'bad2')), TAVERN).some(e => e.direction === 'up'));
});

test('move and travel with changes', () => {
    const { client } = setup();
    const dig = [{ type: 'add_exit', from: SQUARE, direction: 'dig', to: YARD }];
    assert.equal(client.post('/move', { json: { from: SQUARE, direction: 'dig' } }).status_code, 400);
    assert.equal(client.post('/move', { json: { from: SQUARE, direction: 'dig', changes: dig } }).json().address, YARD);
    const r = client.post('/travel', { json: { from: TAVERN, steps: ['out', 'dig'], changes: dig } }).json();
    assert.ok(r.location.address === YARD && !r.stopped);
    const rm = [{ type: 'remove_exit', from: TAVERN, direction: 'out' }];
    assert.ok(client.post('/travel', { json: { from: TAVERN, steps: ['out'], changes: rm } }).json().stopped);
});

test('single folder mode still works', () => {
    const c = new TestClient({ worldDir: RIVERTON });
    assert.ok(c.get('/worlds').json().default === 'default' && c.get('/start').json().address === TAVERN);
    assert.equal(c.post('/worlds/render', { json: { id: 'x' } }).status_code, 400);
});

test('render pristine has no knowledge', () => {
    const { client, wd } = setup();
    const r = client.post('/worlds/render', { json: { id: 'fresh' } }).json();
    assert.ok(r.has_knowledge === false && !fs.existsSync(P(wd, 'fresh', 'knowledge.json')));
    assert.equal(client.get('/worlds/fresh/knowledge').json().knowledge, null);
});

test('render with knowledge', () => {
    const { client, wd } = setup();
    const grate = client.get('/location/riverton:temple/nave').json().exits.find(e => e.direction === 'grate').door;
    const k = { location: 'riverton:temple/catacombs', stood: [TAVERN, SQUARE, 'riverton:temple/nave', 'riverton:temple/catacombs', 'riverton:no/where'],
        seen: ['riverton:docks/piers'], doors: [grate, 'door_bogus'] };
    const r = client.post('/worlds/render', { json: { id: 'known', knowledge: k } }).json();
    assert.ok(r.has_knowledge === true && fs.existsSync(P(wd, 'known', 'knowledge.json')));
    const got = client.get('/worlds/known/knowledge').json().knowledge;
    assert.ok(got.location === 'riverton:temple/catacombs' && !got.stood.includes('riverton:no/where'));
    assert.deepEqual(got.doors, [grate]);
    assert.ok(!read(P(wd, 'known', 'regions', 'riverton.json')).includes('stood'));
    assert.deepEqual(new TestClient({ worldsDir: wd }).get('/worlds/known/knowledge').json().knowledge, got);
});

test('render never touches existing folder', () => {
    const { client, wd } = setup();
    const r = client.post('/worlds/render', { json: { id: 'riverton', overwrite: true, changes: [{ type: 'remove_exit', from: TAVERN, direction: 'up' }] } });
    assert.equal(r.status_code, 409);
    assert.ok(exits(load_world(P(wd, 'riverton')), TAVERN).some(e => e.direction === 'up'));
    fs.mkdirSync(P(wd, 'stray'));
    assert.equal(client.post('/worlds/render', { json: { id: 'stray' } }).status_code, 409);
});

test('display names and slugs', () => {
    const { client, wd } = setup();
    const r = client.post('/worlds/render', { json: { name: 'My Riverton!' } }).json();
    assert.ok(r.id === 'my-riverton' && r.name === 'My Riverton!');
    assert.ok(read(P(wd, 'my-riverton', 'world.json')).includes('"name": "My Riverton!"'));
    assert.equal(client.post('/worlds/render', { json: { name: '  my riverton!  ' } }).json().detail.error, 'needs_overwrite');
    const again = client.post('/worlds/render', { json: { name: '  my riverton!  ', overwrite: true } }).json();
    assert.ok(again.overwritten === true && again.id === 'my-riverton' && again.name === 'My Riverton!');
    const r2 = client.post('/worlds/render', { json: { name: 'My Riverton?' } }).json();
    assert.ok(r2.id === 'my-riverton-2' && r2.name === 'My Riverton?');
    assert.equal(client.post('/worlds/render', { json: { name: 'Riverton' } }).status_code, 409);
});

test('auto names', () => {
    const { client } = setup();
    const body = { name: 'Riverton - Desirae - Oct 19, 4:14 PM', auto: true, id_hint: 'riverton-desirae-oct-19' };
    const a = client.post('/worlds/render', { json: body }).json(), b = client.post('/worlds/render', { json: body }).json();
    assert.ok(a.id === 'riverton-desirae-oct-19' && a.name === 'Riverton - Desirae - Oct 19, 4:14 PM');
    assert.ok(b.id === 'riverton-desirae-oct-19-2' && b.name === 'Riverton - Desirae - Oct 19, 4:14 PM (2)');
    const c = client.post('/worlds/render', { json: {} }).json();
    assert.ok(c.name.startsWith('Riverton - ') && c.id.startsWith('riverton-'));
});

test('living flag validated', () => {
    const tmp = tmpPath();
    copytree(RIVERTON, P(tmp, 'riverton'));
    editJson(P(tmp, 'riverton', 'world.json'), d => { d.living = 'yes'; });
    assert.throws(() => load_world(P(tmp, 'riverton')), e => e instanceof WorldError && e.message.includes('"living" must be true or false'));
});

test('riverton is protected', () => {
    const { client, wd } = setup();
    assert.equal(client.get('/worlds').json().worlds[0].living, false);
    const before = bytes(P(wd, 'riverton', 'regions', 'riverton.json'));
    for (const body of [{ name: 'Riverton' }, { name: ' riverton ' }, { id: 'riverton' }, { id: 'Riverton', name: 'Other' }]) {
        assert.equal(client.post('/worlds/render', { json: body }).status_code, 409, JSON.stringify(body));
        assert.equal(client.post('/worlds/render', { json: { ...body, overwrite: true } }).status_code, 409, JSON.stringify(body));
    }
    assert.ok(bytes(P(wd, 'riverton', 'regions', 'riverton.json')).equals(before) && !fs.existsSync(P(wd, '.backups')));
});

test('missing living is protected', () => {
    const { wd } = setup();
    copytree(P(wd, 'riverton'), P(wd, 'old-save'));
    editJson(P(wd, 'old-save', 'world.json'), d => { delete d.living; d.name = 'Old Save'; });
    const c = new TestClient({ worldsDir: wd });
    assert.equal(c.post('/worlds/render', { json: { name: 'Old Save' } }).status_code, 409);
});

test('save over living world keeps one backup', () => {
    const { client, wd } = setup();
    const first = client.post('/worlds/render', { json: { name: 'Mine' } }).json();
    assert.ok(first.living === true && read(P(wd, 'mine', 'world.json')).includes('"living": true'));
    const dig = [{ type: 'add_exit', from: SQUARE, direction: 'dig', to: YARD }];
    const second = client.post('/worlds/render', { json: { base: 'mine', name: 'Mine', changes: dig } }).json();
    assert.ok(second.overwritten && second.id === 'mine' && second.map_version !== first.map_version);
    assert.ok(exits(load_world(P(wd, 'mine')), SQUARE).some(e => e.direction === 'dig'));
    assert.ok(!exits(load_world(P(wd, '.backups', 'mine')), SQUARE).some(e => e.direction === 'dig'));
    client.post('/worlds/render', { json: { base: 'mine', name: 'Mine', changes: [{ type: 'remove_exit', from: SQUARE, direction: 'dig' }] } });
    assert.deepEqual(fs.readdirSync(P(wd, '.backups')), ['mine']);
    assert.ok(exits(load_world(P(wd, '.backups', 'mine')), SQUARE).some(e => e.direction === 'dig'));
    assert.deepEqual(ids(client), new Set(['riverton', 'mine']));
    assert.deepEqual(ids(new TestClient({ worldsDir: wd })), new Set(['riverton', 'mine']));
    assert.equal(client.post('/move', { json: { from: SQUARE, direction: 'dig' }, params: { world: 'mine' } }).status_code, 400);
});

test('rescan and world not found', () => {
    const { client, wd } = setup();
    copytree(P(wd, 'riverton'), P(wd, 'by-hand'));
    assert.ok(ids(client).has('by-hand'));
    assert.equal(client.get('/start?world=by-hand').status_code, 200);
    fs.rmSync(P(wd, 'by-hand'), { recursive: true });
    assert.ok(!ids(client).has('by-hand'));
    const r = client.get('/start?world=by-hand');
    assert.ok(r.status_code === 404 && r.json().detail.error === 'world_not_found' && r.json().detail.world === 'by-hand');
    copytree(P(wd, 'riverton'), P(wd, 'later'));
    assert.equal(client.get('/start?world=later').status_code, 200);
    fs.mkdirSync(P(wd, 'broken')); write(P(wd, 'broken', 'world.json'), '{nope');
    assert.equal(client.get('/worlds').status_code, 200);
});

test('open folder', () => {
    const { client, wd } = setup();
    const opened = [];
    client.server.state.openPath = p => opened.push(p);
    assert.equal(client.post('/open-folder').json().opened, path.resolve(wd));
    assert.ok(client.post('/open-folder?world=riverton').status_code === 200 && opened.at(-1) === P(wd, 'riverton'));
    for (const bad of ['../x', '..', 'a/b', 'C:\\\\x']) assert.equal(client.post('/open-folder', { params: { world: bad } }).status_code, 400, bad);
    assert.equal(client.post('/open-folder?world=nope').status_code, 404);
    assert.equal(client.post('/open-folder', { params: { path: '/etc' } }).json().opened, path.resolve(wd));
    assert.equal(opened.length, 3);
});

test('two way dig and new room', () => {
    const { client, wd } = setup();
    const hole = 'riverton:drowned_rat/hole_1';
    const ch = [{ type: 'add_room', address: hole, name: 'Dusty Cellar', description: 'A cramped, dusty space.', from: TAVERN },
        { type: 'dig', from: TAVERN, direction: 'hole', to: hole, description: 'A ragged hole in the wall.', return_direction: 'back' }];
    const r = client.post('/move', { json: { from: TAVERN, direction: 'hole', changes: ch } }).json();
    assert.ok(r.address === hole && r.name === 'Dusty Cellar');
    assert.deepEqual(r.exits.map(e => e.direction), ['back']);
    assert.equal(client.post('/move', { json: { from: hole, direction: 'back', changes: ch } }).json().address, TAVERN);
    assert.equal(client.post('/worlds/render', { json: { id: 'holey', changes: ch } }).status_code, 200);
    const w = load_world(P(wd, 'holey'));
    assert.ok(w.get(hole).name === 'Dusty Cellar' && exits(w, TAVERN).some(e => e.direction === 'hole' && e.to === hole));
    const ok = [{ type: 'dig', from: SQUARE, direction: 'crack', to: YARD, return_direction: 'crack' }];
    assert.equal(client.post('/move', { json: { from: YARD, direction: 'crack', changes: ok } }).json().address, SQUARE);
    for (const bad of [[{ type: 'dig', from: TAVERN, direction: 'up', to: YARD, return_direction: 'x' }],
        [{ type: 'dig', from: SQUARE, direction: 'x', to: TAVERN, return_direction: 'up' }],
        [{ type: 'dig', from: SQUARE, direction: 'x', to: SQUARE, return_direction: 'y' }],
        [ch[0], ch[0]],
        [{ type: 'add_room', address: 'riverton:nowhere/x', name: 'A', description: 'B' }],
        [{ type: 'add_room', address: 'riverton:drowned_rat/../x', name: 'A', description: 'B' }],
        [{ type: 'add_room', address: hole, name: 'A'.repeat(61), description: 'B' }]])
        assert.equal(client.post('/move', { json: { from: TAVERN, direction: 'out', changes: bad } }).status_code, 200, JSON.stringify(bad));
});

test('nearby rooms', () => {
    const { client } = setup();
    const up = 'riverton:drowned_rat/upstairs';
    const rooms = client.post('/nearby', { json: { from: up } }).json().rooms;
    assert.ok(rooms[0].address === TAVERN && rooms[0].steps === 1);
    assert.ok(rooms.some(r => r.address === SQUARE && r.steps === 2));
    const keys = ['address', 'area', 'display_name', 'name', 'steps', 'summary'];
    assert.ok(rooms.length <= 12 && rooms.every(r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(keys)));
    assert.ok(rooms.every(r => r.steps <= 3) && !rooms.map(r => r.address).includes(up));
    assert.equal(client.post('/nearby', { json: { from: up, limit: 2 } }).json().rooms.length, 2);
});

const regionFile = wd => P(wd, 'riverton', 'regions', 'riverton.json');
const _exit = (d, sub, loc, direction) => d.subregions[sub].locations[loc].exits.find(e => e.direction === direction);

test('view defaults and validation', () => {
    const { client, wd } = setup();
    const tav = client.get(`/location/${TAVERN}`).json();
    const out = tav.exits.find(e => e.direction === 'out');
    assert.ok(out.view === 'closed' && out.stays_open === false && out.to_summary);
    assert.equal(tav.exits.find(e => e.direction === 'up').view, 'open');
    assert.deepEqual(tav.views, []);
    const grate = client.get('/location/riverton:temple/nave').json().exits.find(e => e.direction === 'grate');
    assert.ok(grate.view === 'closed' && !('to' in grate) && !('to_summary' in grate));
    editJson(regionFile(wd), d => { _exit(d, 'drowned_rat', 'common_room', 'out').view = 'ajar'; });
    assert.throws(() => load_world(P(wd, 'riverton')), e => e instanceof WorldError && e.message.includes('"view" must be one of'));
});

test('stays open precedence and views', () => {
    const { wd } = setup();
    editJson(regionFile(wd), d => {
        d.stays_open = true;
        d.subregions.drowned_rat.stays_open = false;
        _exit(d, 'drowned_rat', 'common_room', 'out').barrier = {};
        Object.assign(_exit(d, 'streets', 'square', 'east'), { barrier: {}, stays_open: false });
        _exit(d, 'temple', 'nave', 'south').barrier = {};
        d.subregions.drowned_rat.locations.upstairs.views = ['streets/square'];
    });
    const c = new TestClient({ worldsDir: wd });
    const ex = (a, dr) => c.get(`/location/${a}`).json().exits.find(e => e.direction === dr);
    assert.equal(ex(TAVERN, 'out').stays_open, false);
    assert.equal(ex('riverton:temple/nave', 'south').stays_open, true);
    assert.equal(ex(SQUARE, 'east').stays_open, false);
    assert.ok(ex(TAVERN, 'out').view === 'closed' && ex(TAVERN, 'out').door === ex(SQUARE, 'in').door);
    const up = c.get('/location/riverton:drowned_rat/upstairs').json();
    assert.deepEqual(up.views.map(v => v.address), [SQUARE]);
    assert.equal(up.views[0].name, 'Village Square');
});

test('door and view link changes', () => {
    const { client, wd } = setup();
    const up = 'riverton:drowned_rat/upstairs';
    const ch = [{ type: 'open_door', from: TAVERN, direction: 'out', stays_open: false },
        { type: 'close_door', from: TAVERN, direction: 'out' },
        { type: 'view_link', from: up, to: SQUARE }];
    assert.equal(client.post('/move', { json: { from: TAVERN, direction: 'up', changes: ch } }).json().views[0].address, SQUARE);
    assert.equal(client.post('/move', { json: { from: TAVERN, direction: 'up', changes: [{ type: 'open_door', from: TAVERN, direction: 'nope' }] } }).status_code, 200);
    assert.equal(client.post('/move', { json: { from: TAVERN, direction: 'up', changes: [{ type: 'view_link', from: up, to: up }] } }).status_code, 200);
    assert.equal(client.post('/worlds/render', { json: { id: 'viewy', changes: ch } }).status_code, 200);
    const raw = read(P(wd, 'viewy', 'regions', 'riverton.json'));
    assert.deepEqual(JSON.parse(raw).subregions.drowned_rat.locations.upstairs.views, [SQUARE]);
    const count = s => s.split('"view"').length - 1;
    assert.ok(!raw.includes('stays_open') && count(raw) === count(read(P(RIVERTON, 'regions', 'riverton.json'))));
});

test('stays open per door across a boundary', () => {
    const { wd } = setup();
    const CAT = 'riverton:temple/catacombs', TUN = 'riverton:secret_tunnel/tunnel';
    const world = ({ temple, tunnel, ex_cat, ex_tun } = {}) => {
        editJson(regionFile(wd), d => {
            for (const [sid, v] of [['temple', temple], ['secret_tunnel', tunnel]]) {
                delete d.subregions[sid].stays_open;
                if (v !== undefined) d.subregions[sid].stays_open = v;
            }
            for (const [sid, loc, dr, v] of [['temple', 'catacombs', 'tunnel', ex_cat], ['secret_tunnel', 'tunnel', 'catacombs', ex_tun]]) {
                const e = _exit(d, sid, loc, dr);
                e.barrier = {};
                delete e.stays_open;
                if (v !== undefined) e.stays_open = v;
            }
        });
        const w = load_world(P(wd, 'riverton'));
        const a = exits(w, CAT).find(e => e.direction === 'tunnel'), b = exits(w, TUN).find(e => e.direction === 'catacombs');
        assert.ok(a.door === b.door);
        assert.deepEqual([...w.doors.get(a.door).rooms].sort(), [CAT, TUN].sort());
        return [w.stays_open(a, w.get(CAT)), w.stays_open(b, w.get(TUN))];
    };
    assert.deepEqual(world({ temple: true }), [false, false]);
    assert.deepEqual(world({ temple: true, tunnel: true }), [true, true]);
    assert.deepEqual(world({ temple: true, tunnel: true, ex_tun: false }), [false, false]);
    assert.deepEqual(world({ ex_cat: true }), [true, true]);
    assert.deepEqual(world({ ex_cat: true, ex_tun: false }), [false, false]);
});

test('door rooms are opaque', () => {
    const { client } = setup();
    const yard = client.get('/location/riverton:drowned_rat/courtyard').json();
    const trap = yard.exits.find(e => e.direction === 'trapdoor');
    const cellar = client.get('/location/riverton:drowned_rat/cellar').json();
    assert.ok(!('to' in trap) && !JSON.stringify(trap).includes('drowned_rat/cellar') && !('to_name' in trap));
    assert.deepEqual([...trap.door_rooms].sort(), [yard.room_token, cellar.room_token].sort());
});
