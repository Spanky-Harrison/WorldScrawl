// The WorldScrawl window: static serving (plugin/ui.mjs, mount) and the play-map helpers (plugin/ui/mapdata.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uiFile, UI_DIR } from '../../plugin/ui.mjs';
import { mount } from '../../plugin/index.mjs';
import { buildGraph, knownRoom, layoutGraph, dirVector, expandChanges, newRooms, isClosed, layerGraph, layerOf, breadcrumb, crossings } from '../../plugin/ui/mapdata.mjs';
import { ROOT, SQUARE, TAVERN, YARD, client, makeWorld, tmpPath } from './helpers.mjs';

test('uiFile serves plugin/ui files with their type, redirects /ui and refuses anything else', () => {
    assert.deepEqual(uiFile('/ui'), { redirect: 'ui/' });
    assert.equal(uiFile('/ui/').file, path.join(UI_DIR, 'index.html'));
    assert.match(uiFile('/ui/').type, /text\/html/);
    assert.match(uiFile('/ui/app.js').type, /javascript/);
    assert.match(uiFile('/ui/mapdata.mjs').type, /javascript/);
    assert.match(uiFile('/ui/app.css?v=2').type, /text\/css/);
    for (const bad of ['/ui/../index.mjs', '/ui/%2e%2e/index.mjs', '/ui/..%2fserver.mjs', '/ui/nope.js', '/ui/.hidden', '/ui/%E0%A4%A']) assert.equal(uiFile(bad).status, 404, bad);
    assert.equal(uiFile('/rooms'), null);
    assert.equal(uiFile('/health'), null);
});

test('mount answers UI paths with files and hands everything else to the map API', () => {
    let handler;
    mount({ use: h => { handler = h; } }, { handle: (m, u) => ({ status: 200, headers: {}, body: { api: `${m} ${u}` } }) });
    const res = () => { const r = { headers: {}, setHeader: (k, v) => { r.headers[k] = v; }, status: s => { r.code = s; return r; }, type: () => r, json: b => { r.body = b; return r; }, send: b => { r.body = b; return r; }, redirect: u => { r.redirected = u; return r; } }; return r; };
    const req = (method, url) => ({ method, url, path: url.split('?')[0], is: () => false });
    let r = res(); handler(req('GET', '/ui/'), r);
    assert.match(r.headers['Content-Type'], /html/); assert.match(String(r.body), /WorldScrawl/);
    r = res(); handler(req('GET', '/ui'), r); assert.equal(r.redirected, 'ui/');
    r = res(); handler(req('GET', '/ui/../world.mjs'), r); assert.equal(r.code, 404);
    r = res(); handler(req('GET', '/health'), r); assert.deepEqual(r.body, { api: 'GET /health' });
    r = res(); handler(req('POST', '/ui/'), r); assert.deepEqual(r.body, { api: 'POST /ui/' }); // only GET serves files
});

const rooms = (c, addrs) => new Map(c.get('/rooms', { params: { addresses: addrs.join(',') } }).json().rooms.map(r => [r.address, r]));

test('play map shows only stood + seen rooms; unrevealed exits are label-only stubs', () => {
    const c = client(ROOT);
    const all = rooms(c, [TAVERN, YARD]);
    const st = { location: YARD, stood: [TAVERN, YARD], seen: [], doors_open: [] };
    const g = buildGraph(st, all);
    const flagged = [...all.values()].flatMap(r => r.exits.filter(e => e.hidden || e.obscured).map(e => [r.address, e]));
    assert.ok(flagged.length, 'riverton has an obscured exit next to the courtyard');
    const json = JSON.stringify(g);
    for (const [from, e] of flagged) {
        assert.equal(e.to, undefined, 'the server never sends the destination');
        const stub = g.nodes.find(n => n.id === `stub:${from}|${e.direction.toLowerCase()}`);
        assert.equal(stub.kind, 'stub'); assert.equal(stub.name, e.direction);
    }
    const ids = JSON.stringify([...g.nodes.map(n => n.id), ...g.edges.map(e => e.to)]);
    assert.ok(!/cellar|tunnel|catacomb/i.test(ids), 'no hidden place is a node or an edge target');
    assert.ok(!/riverton:drowned_rat\/cellar/.test(json));
    // seen-only rooms (neighbours) appear without their own exits
    const square = g.nodes.find(n => n.id === SQUARE);
    assert.equal(square.kind, 'seen');
    assert.ok(!g.edges.some(e => e.from === SQUARE), 'no exits drawn from a room only seen');
    assert.ok(g.nodes.find(n => n.id === YARD).here);
    for (const n of g.nodes) if (n.kind !== 'stub') assert.ok(st.stood.includes(n.id) || all.get(st.stood[0]).exits.concat(all.get(YARD).exits).some(e => e.to === n.id), n.id);
});

test('a passed door reveals its destination; dug exits and new rooms appear; removed exits go', () => {
    const c = client(ROOT);
    const raw = rooms(c, [TAVERN, YARD]);
    const yard = raw.get(YARD), hidden = yard.exits.find(e => e.hidden || e.obscured);
    const reveals = c.post('/doors', { json: { doors: [hidden.door] } }).json().exits;
    const known = new Map([...raw].map(([a, r]) => [a, knownRoom(r, { reveals, rooms: raw })]));
    const g = buildGraph({ location: YARD, stood: [TAVERN, YARD], seen: [], doors_open: [] }, known);
    const to = reveals.find(x => x.from === YARD).to;
    assert.ok(g.edges.some(e => e.from === YARD && e.to === to), 'revealed exit leads to its room');
    assert.ok(!g.nodes.some(n => n.id.startsWith(`stub:${YARD}|`)));
    // dig + add_room + remove_exit
    const changes = [{ type: 'add_room', address: 'riverton:drowned_rat/pantry', name: 'Pantry', description: 'Shelves.', from: TAVERN },
        { type: 'dig', from: TAVERN, direction: 'hatch', to: 'riverton:drowned_rat/pantry', return_direction: 'up' },
        { type: 'remove_exit', from: TAVERN, direction: 'up' }];
    const base = new Map(raw); for (const [a, r] of newRooms(changes, base)) base.set(a, r);
    const k2 = new Map([...base].map(([a, r]) => [a, knownRoom(r, { changes, rooms: base })]));
    const tav = k2.get(TAVERN);
    assert.ok(tav.exits.some(e => e.direction === 'hatch' && e.dug));
    assert.ok(!tav.exits.some(e => e.direction === 'up'));
    assert.deepEqual(k2.get('riverton:drowned_rat/pantry').exits.map(e => e.direction), ['up']);
    const g2 = buildGraph({ location: TAVERN, stood: [TAVERN], seen: [], doors_open: [] }, k2);
    assert.equal(g2.nodes.find(n => n.id === 'riverton:drowned_rat/pantry').kind, 'seen');
    assert.equal(expandChanges([{ type: 'dig', from: 'a', direction: 'x', to: 'b', return_direction: 'y' }]).length, 2);
});

test('closed doors, open doors and pairs of exits', () => {
    assert.equal(isClosed({ view: 'closed', door: 'd1' }), true);
    assert.equal(isClosed({ view: 'closed', door: 'd1' }, ['d1']), false);
    assert.equal(isClosed({ view: 'open' }), false);
    const c = client(ROOT);
    const raw = rooms(c, [TAVERN, SQUARE]);
    const g = buildGraph({ location: TAVERN, stood: [TAVERN, SQUARE], seen: [], doors_open: [] }, raw);
    const e = g.edges.find(x => (x.from === TAVERN && x.to === SQUARE) || (x.from === SQUARE && x.to === TAVERN));
    assert.ok(e.back, 'out and its return exit are one line');
    assert.equal(e.closed, true, 'the tavern front door is closed');
    const tavDoor = raw.get(TAVERN).exits.find(x => x.to === SQUARE).door;
    const g2 = buildGraph({ location: TAVERN, stood: [TAVERN, SQUARE], seen: [], doors_open: [tavDoor] }, raw);
    assert.equal(g2.edges.find(x => x.to === SQUARE || x.from === SQUARE).closed, false);
});

// ---- Layers and layout, on a made-up two-region world (nothing Riverton-specific).
const ISLES = {
    harbor: { name: 'Harbor Town', start: 'quay/dock', subregions: {
        quay: { name: 'The Quay', locations: {
            dock: { name: 'Dock', description: 'Boats.', exits: [{ direction: 'north', to: 'market' }, { direction: 'ferry', to: 'isle:beach/sand' }] },
            market: { name: 'Fish Market', description: 'Fish.', exits: [{ direction: 'south', to: 'dock' }, { direction: 'shop', to: 'shop/counter' }, { direction: 'warehouse', to: 'warehouse/floor' }] } } },
        shop: { name: 'Chandlery', locations: {
            counter: { name: 'Counter', description: 'Rope.', exits: [{ direction: 'out', to: 'quay/market' }, { direction: 'back', to: 'store' }] },
            store: { name: 'Back Store', description: 'Crates.', exits: [{ direction: 'front', to: 'counter' }] } } },
        warehouse: { name: 'Warehouse', locations: {
            floor: { name: 'Warehouse Floor', description: 'Bales.', exits: [{ direction: 'out', to: 'quay/market' }, { direction: 'loose plank', to: 'den/hole', hidden: true }] } } },
        den: { name: 'Smugglers Den', locations: {
            hole: { name: 'Den', description: 'Contraband.', exits: [{ direction: 'plank', to: 'warehouse/floor', hidden: true }] } } } } },
    isle: { name: 'The Isle', start: 'beach/sand', subregions: {
        beach: { name: 'Beach', locations: {
            sand: { name: 'Sand', description: 'Sand.', exits: [{ direction: 'ferry', to: 'harbor:quay/dock' }, { direction: 'crevice', to: 'cave/dark', obscured: true }] } } },
        cave: { name: 'Sea Cave', locations: { dark: { name: 'Dark Cave', description: 'Dark.', exits: [{ direction: 'crevice', to: 'beach/sand', obscured: true }] } } } } },
};
const isles = (() => { let c; return () => c ??= client(makeWorld(tmpPath(), ISLES, 'harbor')); })();
const A = { dock: 'harbor:quay/dock', market: 'harbor:quay/market', counter: 'harbor:shop/counter', store: 'harbor:shop/store', floor: 'harbor:warehouse/floor', hole: 'harbor:den/hole', sand: 'isle:beach/sand', dark: 'isle:cave/dark' };
const islesGraph = (stood, here = stood[0], reveals = []) => {
    const c = isles(), raw = rooms(c, Object.values(A));
    const known = new Map([...raw].map(([a, r]) => [a, knownRoom(r, { reveals })]));
    return buildGraph({ location: here, stood, seen: [], doors_open: [] }, known);
};
const ids = g => g.nodes.map(n => n.id).sort();
const linked = (g, a, b) => g.edges.some(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));

test('layers: world = regions, region = its areas (+ linked outside areas), subregion = its rooms (+ outside stubs)', () => {
    const g = islesGraph([A.dock, A.market, A.counter, A.sand], A.market);
    assert.deepEqual(layerOf(g, A.market), { level: 'subregion', region: 'harbor', subregion: 'quay' });
    assert.deepEqual(breadcrumb(g, layerOf(g, A.market)).map(c => c.label), ['World', 'Harbor Town', 'The Quay']);
    const w = layerGraph(g, { level: 'world' });
    assert.deepEqual(ids(w), ['region:harbor', 'region:isle']);
    assert.ok(linked(w, 'region:harbor', 'region:isle'));
    assert.equal(w.nodes.find(n => n.id === 'region:harbor').here, true);
    const r = layerGraph(g, { level: 'region', region: 'harbor' });
    assert.deepEqual(ids(r), ['region:isle', 'sub:harbor:quay', 'sub:harbor:shop', 'sub:harbor:warehouse']);
    assert.equal(r.nodes.find(n => n.id === 'region:isle').kind, 'outside');
    assert.equal(r.nodes.find(n => n.id === 'sub:harbor:warehouse').kind, 'seen'); // seen through the market's exit, never entered
    assert.ok(linked(r, 'sub:harbor:quay', 'sub:harbor:shop') && linked(r, 'sub:harbor:quay', 'region:isle'));
    assert.deepEqual(r.nodes.find(n => n.id === 'sub:harbor:shop').layer, { level: 'subregion', region: 'harbor', subregion: 'shop' });
    const s = layerGraph(g, layerOf(g, A.market));
    assert.deepEqual(ids(s), [A.dock, A.market, 'region:isle', 'sub:harbor:shop', 'sub:harbor:warehouse']);
    assert.equal(s.edges.find(e => e.to === 'sub:harbor:shop' || e.from === 'sub:harbor:shop').direction, 'shop');
    assert.ok(s.edges.some(e => e.direction === 'north' || e.back?.direction === 'north'));
});

test('discovery holds at every layer: hidden exits skipped until revealed, obscured label-only, seen rooms keep their exits secret', () => {
    // Only the dock and market stood in: the counter is seen, its back store unknown at every layer.
    const g = islesGraph([A.dock, A.market]);
    for (const l of [{ level: 'world' }, { level: 'region', region: 'harbor' }, layerOf(g, A.dock), { level: 'subregion', region: 'harbor', subregion: 'shop' }]) {
        const lg = layerGraph(g, l);
        assert.ok(!lg.nodes.some(n => n.id === A.store || (n.rooms ?? []).includes(A.store)), `store leaked at ${l.level}`);
        assert.ok(!lg.nodes.some(n => /den/.test(n.id)), `den leaked at ${l.level}`);
    }
    assert.equal(layerGraph(g, { level: 'world' }).nodes.find(n => n.id === 'region:isle').kind, 'seen');
    // The hidden plank: absent from every layer while unrevealed, there once revealed.
    const g2 = islesGraph([A.dock, A.market, A.floor], A.floor);
    for (const l of [{ level: 'world' }, { level: 'region', region: 'harbor' }, layerOf(g2, A.floor)]) {
        const lg = layerGraph(g2, l);
        assert.ok(!lg.nodes.some(n => /den|plank/.test(n.id)) && !lg.edges.some(e => /plank/.test(e.direction)), `hidden exit leaked at ${l.level}`);
    }
    const g3 = islesGraph([A.dock, A.market, A.floor], A.floor, [{ from: A.floor, direction: 'loose plank', to: A.hole, to_name: 'Den', to_subregion: { id: 'den', name: 'Smugglers Den' }, to_region: { id: 'harbor', name: 'Harbor Town' } }]);
    assert.ok(ids(layerGraph(g3, { level: 'region', region: 'harbor' })).includes('sub:harbor:den'));
    assert.ok(ids(layerGraph(g3, layerOf(g3, A.floor))).includes('sub:harbor:den'));
    // Obscured crevice: a label-only stub in the beach's own layer, nothing about the cave anywhere.
    const g4 = islesGraph([A.sand]);
    const beach = layerGraph(g4, layerOf(g4, A.sand));
    assert.ok(beach.nodes.some(n => n.kind === 'stub' && n.name === 'crevice'));
    for (const l of [{ level: 'world' }, { level: 'region', region: 'isle' }, layerOf(g4, A.sand)]) assert.ok(!layerGraph(g4, l).nodes.some(n => /cave/.test(n.id)));
    assert.ok(!layerGraph(g4, { level: 'region', region: 'isle' }).nodes.some(n => n.kind === 'stub'));
});

test('layout is deterministic, keeps pinned rooms, and barely moves when a room is added', () => {
    const g = islesGraph([A.dock, A.market, A.counter, A.store, A.floor, A.sand]);
    const lg = layerGraph(g, { level: 'region', region: 'harbor' });
    const p1 = layoutGraph(lg), p2 = layoutGraph({ nodes: [...lg.nodes].reverse(), edges: [...lg.edges].reverse() });
    assert.deepEqual([...p1].sort(), [...p2].sort());
    // pinned pos (in link lengths)
    const pinned = { nodes: lg.nodes.map(n => n.id === 'sub:harbor:shop' ? { ...n, pos: { x: 2, y: -1 } } : n), edges: lg.edges };
    assert.deepEqual(layoutGraph(pinned, { L: 100 }).get('sub:harbor:shop'), { x: 200, y: -100 });
    // a new linked node with the old layout as prev: the others stay close
    const more = { nodes: [...lg.nodes, { id: 'zz', kind: 'seen', name: 'New', subregion: { id: '', name: '' } }], edges: [...lg.edges, { from: 'sub:harbor:shop', to: 'zz', direction: 'east' }] };
    const p3 = layoutGraph(more, { prev: p1 });
    for (const [id, q] of p1) assert.ok(Math.hypot(p3.get(id).x - q.x, p3.get(id).y - q.y) < 60, `${id} jumped`);
});

test('layout root: graph.root if present, else the most connected node (ties: lowest id); compass exits bias, others do not', () => {
    const n = (id, extra = {}) => ({ id, kind: 'stood', name: id, subregion: { id: '', name: '' }, ...extra });
    const star = { nodes: ['a', 'b', 'c', 'd', 'e'].map(id => n(id)), edges: [{ from: 'c', to: 'a', direction: 'door' }, { from: 'c', to: 'b', direction: 'door' }, { from: 'c', to: 'd', direction: 'gate' }, { from: 'd', to: 'e', direction: 'path' }] };
    assert.deepEqual(layoutGraph(star).get('c'), { x: 0, y: 0 });
    assert.deepEqual(layoutGraph({ ...star, root: 'e' }).get('e'), { x: 0, y: 0 });
    assert.deepEqual(layoutGraph({ ...star, root: 'not-discovered' }).get('c'), { x: 0, y: 0 }); // fallback
    const tie = { nodes: ['q', 'p'].map(id => n(id)), edges: [{ from: 'q', to: 'p', direction: 'x' }] };
    assert.deepEqual(layoutGraph(tie).get('p'), { x: 0, y: 0 });
    // compass bias
    const ns = { nodes: [n('a'), n('b'), n('c')], edges: [{ from: 'a', to: 'b', direction: 'north' }, { from: 'a', to: 'c', direction: 'east' }] };
    const p = layoutGraph(ns);
    assert.ok(p.get('b').y < p.get('a').y - 50 && Math.abs(p.get('b').x - p.get('a').x) < 60);
    assert.ok(p.get('c').x > p.get('a').x + 50 && Math.abs(p.get('c').y - p.get('a').y) < 60);
    assert.equal(dirVector('narrow door'), null);
    assert.deepEqual(dirVector('go north'), [0, -1]);
});

test('organic layout: shops sit by their lane, no crossings, no overlaps (synthetic + all of Riverton)', () => {
    const n = id => ({ id, kind: 'stood', name: id, subregion: { id: '', name: '' } });
    const shops = ['baker', 'cooper', 'tanner', 'weaver', 'stable'];
    const town = { nodes: ['square', 'lane', 'docks', 'hill', 'road', ...shops].map(n),
        edges: [{ from: 'square', to: 'lane', direction: 'west', back: { from: 'lane', to: 'square', direction: 'east' } }, { from: 'square', to: 'docks', direction: 'south' },
            { from: 'square', to: 'hill', direction: 'north' }, { from: 'square', to: 'road', direction: 'east' }, ...shops.map(s => ({ from: 'lane', to: s, direction: s }))] };
    const p = layoutGraph(town), d = (a, b) => Math.hypot(p.get(a).x - p.get(b).x, p.get(a).y - p.get(b).y);
    for (const s of shops) assert.ok(d(s, 'lane') < d(s, 'square'), `${s} far from its lane`);
    assert.equal(crossings(town, p), 0);
    const noOverlap = (pos, w = 170, h = 56) => { const v = [...pos.values()]; for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) assert.ok(Math.abs(v[i].x - v[j].x) >= w || Math.abs(v[i].y - v[j].y) >= h, 'overlap'); };
    noOverlap(p);
    const c = client(ROOT);
    const addrs = []; const todo = [TAVERN];
    while (todo.length) { const a = todo.pop(); if (addrs.includes(a)) continue; addrs.push(a); for (const e of c.get(`/location/${a}`).json().exits) if (e.to) todo.push(e.to); }
    const g = buildGraph({ location: TAVERN, stood: addrs, seen: [], doors_open: [] }, rooms(c, addrs));
    const layers = [{ level: 'world' }, { level: 'region', region: 'riverton' }, ...new Set(g.nodes.filter(x => x.kind !== 'stub').map(x => x.subregion.id))].map(l => typeof l === 'string' ? { level: 'subregion', region: 'riverton', subregion: l } : l);
    for (const l of layers) { const lg = layerGraph(g, l), q = layoutGraph(lg); assert.equal(q.size, lg.nodes.length); noOverlap(q); assert.equal(crossings(lg, q), 0, JSON.stringify(l)); }
});

test('layout root = the entrance: subregion entrance room, region entrance subregion, world start region', () => {
    const at = [A.dock, A.market, A.counter, A.store, A.sand];
    const roots = w => {
        const c = client(makeWorld(tmpPath(), w, 'harbor'));
        const start = c.get(`/rooms?addresses=${A.dock}`).json().start.address;
        const g = buildGraph({ location: A.dock, stood: at, seen: [], doors_open: [], start }, rooms(c, at));
        return [{ level: 'subregion', region: 'harbor', subregion: 'quay' }, { level: 'subregion', region: 'harbor', subregion: 'shop' }, { level: 'region', region: 'harbor' }, { level: 'world' }]
            .map(l => { const lg = layerGraph(g, l), p = layoutGraph(lg), r = [...p].find(([, q]) => q.x === 0 && q.y === 0)?.[0]; assert.equal(r, lg.root); return lg.root; });
    };
    // defaults: first room of the subregion; the region's start subregion; the world's start region
    assert.deepEqual(roots(ISLES), [A.dock, A.counter, 'sub:harbor:quay', 'region:harbor']);
    const w = structuredClone(ISLES);
    w.harbor.subregions.quay.entrance = 'market'; w.harbor.subregions.shop.entrance = 'store'; w.harbor.entrance = 'shop/counter';
    assert.deepEqual(roots(w), [A.market, A.store, 'sub:harbor:shop', 'region:harbor']);
    // the entrance isn't discovered: the most connected discovered node is the root
    const h = structuredClone(ISLES); h.harbor.subregions.shop.locations.store.exits = [{ direction: 'front', to: 'counter', hidden: true }, { direction: 'hatch', to: 'store2' }, { direction: 'ladder', to: 'store3' }];
    Object.assign(h.harbor.subregions.shop.locations, { store2: { name: 'Loft', description: 'Dust.', exits: [{ direction: 'hatch', to: 'store' }] }, store3: { name: 'Cellar', description: 'Damp.', exits: [{ direction: 'ladder', to: 'store' }] } });
    const ch = client(makeWorld(tmpPath(), h, 'harbor'));
    const g = buildGraph({ location: A.store, stood: [A.store], seen: [], doors_open: [], start: A.dock }, rooms(ch, [A.store, 'harbor:shop/store2', 'harbor:shop/store3']));
    const lg = layerGraph(g, layerOf(g, A.store));
    assert.equal(lg.root, A.counter); assert.ok(!lg.nodes.some(x => x.id === A.counter));
    assert.deepEqual(layoutGraph(lg).get(A.store), { x: 0, y: 0 });
});

test('pos in the world files reaches the map data and pins the room', () => {
    const w = structuredClone(ISLES);
    Object.assign(w.harbor.subregions.quay.locations.dock, { pos: { x: 1, y: 2 } });
    const c = client(makeWorld(tmpPath(), w, 'harbor'));
    const dock = c.get(`/location/${A.dock}`).json(), market = c.get(`/location/${A.market}`).json();
    assert.deepEqual(dock.pos, { x: 1, y: 2 }); assert.equal(market.pos, undefined); assert.equal(dock.map_root, undefined);
    const g = buildGraph({ location: A.dock, stood: [A.dock, A.market, A.counter], seen: [], doors_open: [] }, rooms(c, [A.dock, A.market, A.counter]));
    assert.deepEqual(layoutGraph(layerGraph(g, layerOf(g, A.dock)), { L: 100 }).get(A.dock), { x: 100, y: 200 });
    const bad = structuredClone(ISLES); bad.harbor.subregions.quay.locations.dock.pos = { x: 'a' };
    assert.throws(() => client(makeWorld(tmpPath(), bad, 'harbor')).get('/health'), /pos/);
});

test('ui files have no external dependencies', () => {
    for (const f of fs.readdirSync(UI_DIR)) {
        const s = fs.readFileSync(path.join(UI_DIR, f), 'utf8');
        assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(s), `${f} loads nothing from the internet`);
        for (const m of s.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f} imports only local files`);
    }
});

test('an unrevealed hidden exit is absent from the map (not even a stub); it appears once revealed; obscured stays a stub', () => {
    const cellar = { address: 'w:a/cellar', name: 'Cellar', subregion: { id: 'a', name: 'A' }, description: 'Damp.', exits: [
        { direction: 'up', to: 'w:a/hall', to_name: 'Hall', to_subregion: { id: 'a', name: 'A' } },
        { direction: 'narrow door', hidden: true, door: 'd1', description: 'A narrow door.' },
        { direction: 'grate', obscured: true, door: 'd2' }] };
    const st = { location: cellar.address, stood: [cellar.address], seen: [], doors_open: [] };
    const g = buildGraph(st, new Map([[cellar.address, knownRoom(cellar)]]));
    assert.ok(!g.edges.some(e => /narrow door/i.test(e.direction)), 'hidden exit leaked');
    assert.ok(!g.nodes.some(n => /narrow door/i.test(n.id + n.name)), 'hidden stub leaked');
    assert.ok(g.nodes.some(n => n.id === 'stub:w:a/cellar|grate'), 'obscured exit stays a label-only stub');
    const reveals = [{ from: cellar.address, direction: 'narrow door', to: 'w:b/tunnel', to_name: 'Tunnel', to_subregion: { id: 'b', name: 'B' } }];
    const g2 = buildGraph(st, new Map([[cellar.address, knownRoom(cellar, { reveals })]]));
    assert.ok(g2.edges.some(e => e.direction === 'narrow door' && e.to === 'w:b/tunnel'));
    assert.ok(g2.nodes.some(n => n.id === 'w:b/tunnel' && n.kind === 'seen'));
});

test('region entrance may be just a subregion id (its own entrance); sub/loc still works; bad ones fail at load', () => {
    const ent = w => client(makeWorld(tmpPath(), w, 'harbor')).get(`/location/${A.dock}`).json().region.entrance;
    assert.equal(ent(ISLES), A.dock); // default: the region's start
    const w = structuredClone(ISLES); w.harbor.entrance = 'shop'; w.harbor.subregions.shop.entrance = 'store';
    assert.equal(ent(w), A.store);
    w.harbor.entrance = 'quay/market'; assert.equal(ent(w), A.market);
    for (const [bad, re] of [['nowhere', /entrance 'nowhere' is not a subregion/], ['quay/nowhere', /entrance/], ['a/b/c', /subregion id or "subregion\/location"/]]) {
        const b = structuredClone(ISLES); b.harbor.entrance = bad;
        assert.throws(() => client(makeWorld(tmpPath(), b, 'harbor')).get('/health'), re, bad);
    }
    // Riverton: "streets" resolves to the same square as before
    assert.equal(client(ROOT).get(`/location/${TAVERN}`).json().region.entrance, 'riverton:streets/square');
});
