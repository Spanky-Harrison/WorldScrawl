// The change call (the model's map edits): its op list comes from the engine's OPS, story-made places get engine ids,
// several new places work in one change, and "can't express this" is a plain answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { client, RIVERTON, TAVERN } from './helpers.mjs';
import { OPS, OP_DOCS, opDocs, readChangeAnswer, applyPatch } from '../../plugin/ui/patches.mjs';
import { read_world_raw } from '../../plugin/world.mjs';

const src = readFileSync(new URL('../../extension/index.js', import.meta.url), 'utf8');
const c = client(RIVERTON);

test('change prompt: every editor op is documented, generated from OPS (create_place included)', () => {
    for (const o of OPS) if (o !== 'discover') assert.ok(OP_DOCS[o], `no prompt line for ${o}`);
    const d = opDocs();
    for (const o of ['create_place', 'create_subregion', 'create_region', 'add_exit', 'move_location', 'remove_area', 'set_exit']) assert.match(d, new RegExp(`"op":"${o}"`));
    assert.doesNotMatch(d, /"op":"discover"/);
    assert.match(src, /\$\{pl\.opDocs\(\)\}/, 'the extension prompt uses the generated list');
    assert.doesNotMatch(src, /\{"op":"block_exit"\|"open_exit"/, 'no hand-written op list left');
    assert.match(src, /"cant"/);
});

test('change answer: ops, nothing, or cant; model-written create_place ids are dropped', () => {
    assert.deepEqual(readChangeAnswer({ ops: [] }), { nothing: true });
    assert.deepEqual(readChangeAnswer({ cant: 'The room floats in the sky.' }), { cant: 'The room floats in the sky.' });
    assert.equal(readChangeAnswer('x'), null);
    assert.equal(readChangeAnswer({ foo: 1 }), null);
    const r = readChangeAnswer({ ops: [{ op: 'create_place', id: 'riverton:drowned_rat/common_room', name: 'X', description: 'y', exits: [] }] });
    assert.equal(r.ops[0].id, undefined);
    assert.equal(r.ops[0].story, true);
});

const hub = (names, dirs) => readChangeAnswer({ ops: names.map((n, i) => ({ op: 'create_place', name: n, description: `The ${n.toLowerCase()}, made by magic.`,
    exits: [{ to: TAVERN, direction: 'hub', return_direction: dirs[i], door: true }] })) }).ops;

test('three new rooms off a hub in one change: engine ids, one linked door pair each', () => {
    const ops = hub(['Crystal Room', 'Ember Room', 'Tide Room'], ['crystal arch', 'ember arch', 'tide arch']);
    const r = c.post('/patch/preview', { json: { patch: { ops } } }).json();
    assert.ok(r.ops, JSON.stringify(r));
    const ids = r.ops.map(o => o.id);
    assert.deepEqual(ids, ['crystal_room', 'ember_room', 'tide_room']);
    const area = TAVERN.slice(0, TAVERN.indexOf('/'));
    for (const id of ids) {
        const a = `${area}/${id}`, room = r.after[a];
        assert.equal(room.exits.length, 1); assert.equal(room.exits[0].to, TAVERN);
        const back = r.after[TAVERN].exits.filter(x => x.to === a);
        assert.equal(back.length, 1, 'one exit pair');
        assert.equal([room.exits[0], back[0]].filter(x => x.barrier).length, 1, 'one shared door');
    }
    const moved = c.post('/move', { json: { from: TAVERN, direction: 'ember arch', changes: [{ type: 'patch', id: 'h', note: 'hub', at: 0, ops: r.ops }] } }).json();
    assert.equal(moved.address, `${area}/ember_room`);
});

test('story-made places: same name twice gets a fresh id; a later new room can link to an earlier one', () => {
    const ops = hub(['Vault', 'Vault'], ['vault', 'second vault']);
    const r = c.post('/patch/preview', { json: { patch: { ops } } }).json();
    assert.deepEqual(r.ops.map(o => o.id), ['vault', 'vault_2']);
    const chain = readChangeAnswer({ ops: [
        { op: 'create_place', name: 'Antechamber', description: 'A small stone room.', exits: [{ to: TAVERN, direction: 'out', return_direction: 'stone door' }] },
        { op: 'create_place', name: 'Inner Sanctum', description: 'A domed room.', exits: [{ to: 'antechamber', direction: 'out', return_direction: 'inner door' }] }] }).ops;
    const r2 = c.post('/patch/preview', { json: { patch: { ops: chain } } }).json();
    assert.ok(r2.ops, JSON.stringify(r2));
    assert.match(r2.ops[1].exits[0].to, /\/antechamber$/);
});

test('story-made places respect "expandable"; editor-made ones keep the id clash check', () => {
    const [, raw] = read_world_raw(RIVERTON);
    const r0 = structuredClone(raw);
    const [rid, rest] = TAVERN.split(':'), [sid, lid] = rest.split('/');
    r0[rid].subregions[sid].locations[lid].expandable = false;
    assert.throws(() => applyPatch(r0, { ops: hub(['Crystal Room'], ['crystal arch']) }), /can't be expanded/);
    assert.throws(() => applyPatch(structuredClone(raw), { ops: [{ op: 'create_place', area: `${rid}:${sid}`, name: raw[rid].subregions[sid].locations[lid].name, description: 'x', exits: [{ to: TAVERN, direction: 'a', return_direction: 'b' }] }] }), /suggested/);
});

test('old chats: a stamped "discover" op still reads, as a create_place', () => {
    const UP = 'riverton:drowned_rat/upstairs';
    const old = { type: 'patch', id: 'd', note: 'x', at: 0, ops: [{ op: 'discover', loc: UP, id: 'guest_room', direction: 'guest door', return_direction: 'hallway', name: 'Guest Room', description: 'A bed.' }] };
    const got = c.post('/rooms', { json: { addresses: ['riverton:drowned_rat/guest_room'], changes: [old] } }).json();
    assert.equal(got.rooms[0].name, 'Guest Room');
});
