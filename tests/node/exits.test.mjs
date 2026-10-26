// Exit types, sight/sound, barriers, traversal (extensible exits).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorldError, load_world, EXIT_TYPES, BARRIER_DEFAULTS } from '../../plugin/world.mjs';
import { ROOT, caplog, client, makeWorld, tmpPath } from './helpers.mjs';
import { isClosed, isBlocked } from '../../plugin/ui/mapdata.mjs';

const two = (aEx, bEx) => ({ name: 'R', start: 's/a', subregions: { s: { name: 'S', locations: {
    a: { name: 'A', description: 'da', exits: [{ direction: 'east', to: 'b', ...aEx }] },
    b: { name: 'B', description: 'db', exits: [{ direction: 'west', to: 'a', ...bEx }] },
} } } });
const W = (a = {}, b = {}) => load_world(makeWorld(tmpPath(), { r: two(a, b) }));
const E = (w, addr, d) => w.get(addr).exits.find(e => e.direction === d);
const A = 'r:s/a', B = 'r:s/b';

test('type presets come from exit_types.json; portal is the default', () => {
    assert.deepEqual(EXIT_TYPES.portal, { sight: 'partial', sound: 'partial' });
    assert.deepEqual(EXIT_TYPES.open, { sight: 'clear', sound: 'clear' });
    const w = W({}, { type: 'open' });
    assert.equal(E(w, A, 'east').type, 'portal');
    assert.equal(E(w, A, 'east').sight, 'partial');
    assert.equal(E(w, B, 'west').sight, 'clear');
    assert.equal(E(w, B, 'west').sound, 'clear');
});

test('exit fields override the type preset', () => {
    const w = W({ type: 'open', sound: 'none' }, { sight: 'none' });
    assert.equal(E(w, A, 'east').sight, 'clear');
    assert.equal(E(w, A, 'east').sound, 'none');
    assert.equal(E(w, B, 'west').sight, 'none');
    assert.equal(E(w, B, 'west').sound, 'partial');
});

test('bad type / level / barrier field is an error', () => {
    for (const bad of [{ type: 'wormhole' }, { sight: 'murky' }, { barrier: { closed_sight: 'x' } }, { barrier: { openable: false, starts_open: true } }, { barrier: 'door' }])
        assert.throws(() => W(bad), WorldError, JSON.stringify(bad));
});

test('barrier {} is an ordinary closed door shared by both sides', () => {
    const w = W({ barrier: {} });
    const a = E(w, A, 'east'), b = E(w, B, 'west');
    assert.ok(a.door && a.door === b.door);
    for (const [k, v] of Object.entries(BARRIER_DEFAULTS)) { assert.equal(a.barrier[k], v); assert.equal(b.barrier[k], v); }
    assert.equal(a.effective_view, 'closed');
    assert.equal(a.blocked, false);
});

test('barrier set on both sides and disagreeing warns; first read wins', () => {
    const [w, logs] = caplog(() => W({ barrier: { closed_sight: 'clear' } }, { barrier: { closed_sight: 'partial' } }));
    assert.match(logs, /disagree on closed_sight/);
    assert.equal(E(w, B, 'west').barrier.closed_sight, 'clear');
    const [, quiet] = caplog(() => W({ barrier: { locked: true } }, { barrier: { locked: true } }));
    assert.doesNotMatch(quiet, /disagree/);
});

test('legacy view maps onto sight/sound/barrier', () => {
    let w = W({ view: 'closed' }, { view: 'closed' });
    assert.ok(E(w, A, 'east').barrier);
    assert.equal(E(w, A, 'east').door, E(w, B, 'west').door);
    w = W({ view: 'none' }, { view: 'open' });
    assert.equal(E(w, A, 'east').sight, 'none');
    assert.equal(E(w, A, 'east').sound, 'none');
    assert.equal(E(w, A, 'east').barrier, null);
    assert.equal(E(w, B, 'west').sight, 'partial');
    w = W({ view: 'closed', stays_open: true });
    assert.equal(w.stays_open(E(w, A, 'east'), w.get(A)), true);
    assert.equal(w.stays_open(E(w, B, 'west'), w.get(B)), true);
});

test('openable:false and locked block movement; starts_open does not', () => {
    for (const bar of [{ openable: false }, { locked: true }]) {
        const dir = makeWorld(tmpPath(), { r: two({ barrier: bar }, {}) });
        const c = client(dir);
        const r = c.post('/move', { json: { from: A, direction: 'east' } });
        assert.equal(r.status_code, 400);
        assert.equal(r.json().detail.blocked, true);
        assert.equal(c.post('/move', { json: { from: B, direction: 'west' } }).status_code, 400);
        assert.equal(c.post('/travel', { json: { from: A, steps: ['east'] } }).json().address ?? A, A);
    }
    const c = client(makeWorld(tmpPath(), { r: two({ barrier: { locked: true, starts_open: true } }, {}) }));
    assert.equal(c.post('/move', { json: { from: A, direction: 'east' } }).status_code, 200);
});

test('starts_open shows the door open on the map until closed', () => {
    const w = W({ barrier: { starts_open: true } });
    const d = w.get(A).exits[0].door;
    const e = { barrier: { starts_open: true }, door: d, view: 'closed' };
    assert.equal(isClosed(e, [], []), false);
    assert.equal(isClosed(e, [], [d]), true);
    assert.equal(isClosed({ view: 'closed', door: 'd1' }, ['d1']), false);
    assert.equal(isBlocked({ barrier: { openable: false } }), true);
    assert.equal(isBlocked({ barrier: {} }), false);
});

test('traversal text is returned only on the move through that exit', () => {
    const c = client(makeWorld(tmpPath(), { r: two({ traversal: 'A tight squeeze.' }, {}) }));
    assert.equal(c.post('/move', { json: { from: A, direction: 'east' } }).json().traversal, 'A tight squeeze.');
    assert.ok(!c.post('/move', { json: { from: B, direction: 'west' } }).json().traversal);
    const t = c.post('/travel', { json: { from: A, steps: ['east'] } }).json();
    assert.ok(JSON.stringify(t).includes('A tight squeeze.'));
});

test('Riverton: gate, door and open street sight/sound', () => {
    const w = load_world(ROOT);
    const grate = w.get('riverton:temple/nave').exits.find(e => e.barrier && e.to.includes('catacombs'));
    assert.equal(grate.barrier.closed_sight, 'none'); // obscured: forced
    assert.equal(grate.sight, 'none');
    assert.equal(grate.barrier.closed_sound, 'clear');
    const up = w.get('riverton:temple/catacombs').exits.find(e => e.to.includes('nave'));
    assert.equal(up.door, grate.door);
    assert.equal(up.barrier.closed_sight, 'clear'); // from below you can see up into the nave
    const lane = w.get('riverton:streets/square').exits.find(e => e.direction === 'west');
    assert.equal(lane.type, 'open');
    assert.equal(lane.sight, 'clear');
    const store = w.get('riverton:streets/market_lane').exits.find(e => e.barrier?.starts_open);
    assert.ok(store, 'general store door starts open');
    const back = w.get(store.to.includes(':') ? store.to : 'riverton:' + store.to);
    assert.ok(back);
    const door = w.get('riverton:drowned_rat/common_room').exits.find(e => e.direction === 'out');
    if (door.barrier) assert.equal(door.barrier.closed_sight, 'none');
});

test('a curtain: barrier that hides but lets sound through', () => {
    const w = W({ barrier: { closed_sight: 'none', closed_sound: 'clear' } });
    assert.equal(E(w, B, 'west').barrier.closed_sound, 'clear');
    assert.equal(E(w, B, 'west').barrier.closed_sight, 'none');
});

test('Riverton: the temple grate stays obscured (no destination) but has a near-side description; long roads are sight/sound none', () => {
    const c = client(ROOT);
    const g = c.get('/location/riverton:temple/nave').json().exits.find(e => e.direction === 'grate');
    assert.equal(g.obscured, true);
    assert.equal(g.to, undefined);
    assert.match(g.description, /stair that descends into darkness/);
    assert.equal(g.barrier.closed_sight, 'none');
    assert.equal(g.sight, 'none');
    for (const [a, d] of [['riverton:east_road/road', 'east'], ['larkspur:west_road/road', 'west']]) {
        const r = c.get(`/location/${a}`).json().exits.find(e => e.direction === d);
        assert.equal(r.sight, 'none'); assert.equal(r.sound, 'none'); assert.ok(r.description);
    }
});

test('obscured forces sight none (and closed_sight none), warning on explicit other values; sight none does not imply obscured', () => {
    let [w, logs] = caplog(() => W({ obscured: true, sight: 'clear', barrier: { closed_sight: 'clear' } }));
    assert.match(logs, /is obscured, so its sight is none; ignoring "sight": 'clear' and barrier "closed_sight": 'clear'/);
    assert.equal(E(w, A, 'east').sight, 'none');
    assert.equal(E(w, A, 'east').barrier.closed_sight, 'none');
    assert.equal(E(w, B, 'west').barrier.closed_sight, 'clear'); // the return side keeps its own view
    [w, logs] = caplog(() => W({ obscured: true }));
    assert.doesNotMatch(logs, /is obscured, so/);
    assert.equal(E(w, A, 'east').sight, 'none');
    w = W({ sight: 'none' });
    assert.ok(!E(w, A, 'east').flags.obscured);
    const d = client(makeWorld(tmpPath(), { r: two({ sight: 'none' }, {}) })).get('/location/' + A).json().exits[0];
    assert.equal(d.to, B); assert.equal(d.to_name, 'B'); // still known where it goes
});
