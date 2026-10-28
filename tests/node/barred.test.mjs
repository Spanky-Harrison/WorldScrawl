// One-sided barred doors: door.barred_from ("this_side" / "other_side") measured from the side the door is written on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RIVERTON, YARD } from './helpers.mjs';
import './ststub.mjs';
import { apply_changes } from '../../plugin/changes.mjs';
import { build_world, read_world_raw, WorldError, flipBar } from '../../plugin/world.mjs';
import { applyPatch, getRoom } from '../../plugin/ui/patches.mjs';
import { editContext } from '../../plugin/editctx.mjs';
import { DOOR_FIELDS } from '../../plugin/ui/placeform.mjs';
const X = await import('../../extension/index.js');

const CELLAR = 'riverton:drowned_rat/cellar';
const patch = ops => ({ type: 'patch', id: 'p1', note: 'test', at: 0, ops });
const worldWith = changes => build_world(...apply_changes(...read_world_raw(RIVERTON), changes, { now: null }));
const exit = (w, a, d) => w.get(a).exits.find(e => e.direction.toLowerCase() === d);
const rawExit = (raw, a, d) => getRoom(raw, a).exits.find(e => e.direction === d);
const barOn = (a, side, extra = {}) => patch([{ op: 'set_exit', loc: a, direction: 'trapdoor', fields: { barrier: { barred_from: side, ...extra } } }]);

test('flipBar swaps the two sides and leaves no-bar doors alone', () => {
    assert.equal(flipBar({ barred_from: 'this_side' }).barred_from, 'other_side');
    assert.equal(flipBar({ barred_from: 'other_side' }).barred_from, 'this_side');
    assert.deepEqual(flipBar({ locked: true }), { locked: true });
    assert.equal(flipBar(null), null);
});

test('world: each side sees barred_from from its own side; missing = no bar', () => {
    let w = worldWith([barOn(YARD, 'this_side')]);
    assert.equal(exit(w, YARD, 'trapdoor').barrier.barred_from, 'this_side');
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.barred_from, 'other_side');
    w = worldWith([barOn(YARD, 'other_side')]);
    assert.equal(exit(w, YARD, 'trapdoor').barrier.barred_from, 'other_side');
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.barred_from, 'this_side');
    w = worldWith([barOn(YARD, undefined)]);
    assert.equal(exit(w, YARD, 'trapdoor').barrier.barred_from, undefined);
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.barred_from, undefined);
});

test('world and patches reject a bad barred_from', () => {
    const [wj, raw] = read_world_raw(RIVERTON);
    rawExit(raw, YARD, 'trapdoor').barrier = { barred_from: 'inside' };
    assert.throws(() => build_world(wj, raw), WorldError);
    assert.throws(() => applyPatch(read_world_raw(RIVERTON)[1], barOn(YARD, 'here')), /barred_from/);
});

test('moving the definition to the other side flips the value (editor save from the other side)', () => {
    const [wj, r] = read_world_raw(RIVERTON);
    applyPatch(r, barOn(YARD, 'this_side'));
    const w = build_world(wj, r);
    // The Edit form, opened from the cellar, shows the bar as on the other side...
    const ctx = editContext(w, wj, r, `loc:${CELLAR}`);
    const door = ctx.exits.find(e => e.direction === 'trapdoor').barrier;
    assert.equal(door.barred_from, 'other_side');
    // ...and saving it from there writes the door on the cellar side, flipped, and the bar stays on the yard side.
    applyPatch(r, patch([{ op: 'set_exit', loc: CELLAR, direction: 'trapdoor', fields: { barrier: door } }]));
    assert.equal(rawExit(r, CELLAR, 'trapdoor').barrier.barred_from, 'other_side');
    assert.equal(rawExit(r, YARD, 'trapdoor').barrier, undefined);
    const w2 = build_world(wj, r);
    assert.equal(exit(w2, YARD, 'trapdoor').barrier.barred_from, 'this_side');
    assert.equal(exit(w2, CELLAR, 'trapdoor').barrier.barred_from, 'other_side');
});

test('a map edit from the other side (lock) moves the door definition and flips barred_from', () => {
    const w = worldWith([barOn(YARD, 'this_side'), patch([{ op: 'lock_exit', loc: CELLAR, direction: 'trapdoor' }])]);
    assert.equal(exit(w, YARD, 'trapdoor').barrier.barred_from, 'this_side');
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.barred_from, 'other_side');
    assert.equal(exit(w, CELLAR, 'trapdoor').barrier.locked, true);
});

test('Edit form Door block has the Barred from setting', () => {
    const f = DOOR_FIELDS.find(x => x.k === 'barred_from');
    assert.deepEqual(f.options.map(o => o.value), ['this_side', 'other_side']);
});

test('extension: barred from the other side is stuck; from the bar side it opens (lifting the bar)', () => {
    const door = (side, extra = {}) => ({ direction: 'trapdoor', door: 'd1', barrier: { openable: true, locked: false, starts_open: false, barred_from: side, ...extra } });
    const none = new Map();
    assert.equal(X.isBarredNow(door('other_side'), none), true);
    assert.equal(X.isStuck(door('other_side'), none, none), true);
    assert.equal(X.isStuck(door('this_side'), none, none), false);
    assert.equal(X.isStuck(door(undefined), none, none), false);
    const unbarred = new Map([['d1', { type: 'unbar_door', door: 'd1' }]]);
    assert.equal(X.isStuck(door('other_side'), none, unbarred), false, 'unbarred from the bar side: opens from here too');
    assert.equal(X.isBarredNow(door('other_side'), new Map([['d1', { type: 'bar_door', door: 'd1' }]])), true);
    const chat = [{ extra: { worldscrawl_change: [{ type: 'unbar_door', door: 'd1' }] } }, { extra: { worldscrawl_change: [{ type: 'bar_door', door: 'd1' }] } }];
    assert.equal(X.barStates(chat).get('d1').type, 'bar_door');
    const here = { address: 'a' };
    assert.deepEqual(X.openChanges(here, door('this_side')).map(c => c.type), ['unbar_door', 'open_door']);
    assert.deepEqual(X.openChanges(here, door('other_side')).map(c => c.type), ['open_door']);
});
