// Barrier inheritance (one side defines it), inspector source labels, and loader warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load_world } from '../../plugin/world.mjs';
import { RIVERTON, caplog, client, makeWorld, tmpPath } from './helpers.mjs';
import { isClosed } from '../../plugin/ui/mapdata.mjs';

const two = (aEx, bEx, extra = {}) => ({ name: 'R', start: 's/a', exposure: 'outdoor', ...extra, subregions: { s: { name: 'S', exposure: 'sheltered', indoor_temp: 60, locations: {
    a: { name: 'A', description: 'da', exits: [{ direction: 'east', to: 'b', ...aEx }] },
    b: { name: 'B', description: 'db', exits: [{ direction: 'west', to: 'a', ...bEx }] },
} } } });
const dir = (a, b) => makeWorld(tmpPath(), { r: two(a, b) });
const E = (w, addr, d) => w.get(addr).exits.find(e => e.direction === d);
const A = 'r:s/a', B = 'r:s/b';
const get = (c, target) => { const r = c.get('/inspect', { params: { target } }); return [r.status_code, r.status_code === 200 ? r.json() : null]; };
const row = (d, key) => d.resolved.find(r => r.key === key);

test('the reverse exit inherits the barrier defined on one side', () => {
    const w = load_world(dir({ barrier: { locked: true } }, { travel_time: '5m', sight: 'clear' }));
    const back = E(w, B, 'west');
    assert.ok(back.barrier);
    assert.equal(back.barrier.locked, true);
    assert.equal(back.door, E(w, A, 'east').door);
    assert.equal(back.barrier_from, A);
    assert.equal(back.barrier_own, false);
    assert.equal(back.travel_time, 300); // own fields stay its own
    assert.equal(back.sight, 'clear');
    assert.equal(isClosed(back, [], []), true);
});

test('disagreeing barriers: the first wins and a warning names both exits', () => {
    const [w, logs] = caplog(() => load_world(dir({ barrier: { locked: true } }, { barrier: { locked: false } })));
    assert.equal(E(w, B, 'west').barrier.locked, true);
    assert.match(logs, /disagree|differ/i);
    assert.ok(w.warnings.some(x => x.refs.includes(`exit:${A}|east`) && x.refs.includes(`exit:${B}|west`)));
});

test('inspector labels sources: inherited place fields and the inherited barrier', () => {
    const c = client(dir({ barrier: { locked: true } }, {}));
    let [s, d] = get(c, A);
    assert.equal(s, 200);
    assert.equal(row(d, 'exposure').source, 'from subregion');
    [s, d] = get(c, `exit:${B}|west`);
    assert.equal(s, 200);
    assert.equal(d.kind, 'exit');
    assert.deepEqual(d.raw, { direction: 'west', to: 'a' });
    assert.match(row(d, 'barrier.locked').source, /^from A side/);
    [s, d] = get(c, 'sub:r:s');
    assert.equal(row(d, 'exposure').source, 'from file');
    assert.equal(row(d, 'fixed_weather').value, null);
    assert.equal(get(c, 'exit:r:s/a|nowhere')[0], 404);
    assert.equal(get(c, 'world')[1].kind, 'world');
});

test('warnings are served per target', () => {
    const c = client(dir({ barrier: { locked: true } }, { barrier: { locked: false } }));
    const [, d] = get(c, `exit:${B}|west`);
    assert.ok(d.warnings.length >= 1);
    const [, other] = get(c, 'world');
    assert.ok(Array.isArray(other.warnings));
    const idx = c.get('/inspect/index').json();
    assert.deepEqual(idx.addresses.sort(), [A, B]);
    assert.equal(idx.doors.length, 1);
    assert.ok(idx.warnings >= 1);
});

test('Riverton loads with no barrier disagreements and every room inspects', () => {
    const [w, logs] = caplog(() => load_world(RIVERTON));
    assert.doesNotMatch(logs, /disagree/i);
    const c = client(RIVERTON);
    for (const a of c.get('/inspect/index').json().addresses) assert.equal(get(c, a)[0], 200, a);
    void w;
});
