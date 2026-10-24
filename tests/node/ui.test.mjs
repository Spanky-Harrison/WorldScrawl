// The WorldScrawl window: static serving (plugin/ui.mjs, mount) and the play-map helpers (plugin/ui/mapdata.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uiFile, UI_DIR } from '../../plugin/ui.mjs';
import { mount } from '../../plugin/index.mjs';
import { buildGraph, knownRoom, layoutGraph, dirVector, expandChanges, newRooms, isClosed } from '../../plugin/ui/mapdata.mjs';
import { ROOT, SQUARE, TAVERN, YARD, client } from './helpers.mjs';

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

test('layout: directions map to grid steps, no two rooms share a cell, pos is kept', () => {
    assert.deepEqual(dirVector('north'), [0, -1]);
    assert.deepEqual(dirVector('Up'), [1, -1]);
    assert.deepEqual(dirVector('go north'), [0, -1]);
    assert.equal(dirVector('narrow door'), null);
    const graph = { nodes: ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, pos: id === 'e' ? { x: 9, y: 9 } : null })),
        edges: [{ from: 'a', to: 'b', direction: 'north' }, { from: 'a', to: 'c', direction: 'east' }, { from: 'a', to: 'd', direction: 'north' }] };
    const p = layoutGraph(graph, 'a');
    assert.deepEqual(p.get('a'), { x: 0, y: 0 });
    assert.deepEqual(p.get('b'), { x: 0, y: -1 });
    assert.deepEqual(p.get('c'), { x: 1, y: 0 });
    assert.deepEqual(p.get('e'), { x: 9, y: 9 });
    const cells = [...p.values()].map(q => `${q.x},${q.y}`);
    assert.equal(new Set(cells).size, cells.length);
    // the whole of Riverton, every room stood in, lays out without overlaps
    const c = client(ROOT);
    const addrs = []; const todo = [TAVERN];
    while (todo.length) { const a = todo.pop(); if (addrs.includes(a)) continue; addrs.push(a); for (const e of c.get(`/location/${a}`).json().exits) if (e.to) todo.push(e.to); }
    const g = buildGraph({ location: TAVERN, stood: addrs, seen: [], doors_open: [] }, rooms(c, addrs));
    const q = layoutGraph(g, TAVERN), all = [...q.values()].map(v => `${v.x},${v.y}`);
    assert.equal(q.size, g.nodes.length);
    assert.equal(new Set(all).size, all.length);
});

test('ui files have no external dependencies', () => {
    for (const f of fs.readdirSync(UI_DIR)) {
        const s = fs.readFileSync(path.join(UI_DIR, f), 'utf8');
        assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(s), `${f} loads nothing from the internet`);
        for (const m of s.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('./'), `${f} imports only local files`);
    }
});
